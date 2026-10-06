'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, ist, JPEG } = require('./helpers');
const { openDb } = require('../server/db');

test('upgrade gives the attendance permission to firefueled and amitsharma only', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'a.db');
  let db = openDb(file);
  for (const u of ['owner', 'firefueled', 'amit.sharma', 'someone']) {
    db.prepare("INSERT INTO admins (username, name, password_hash, created_at) VALUES (?, ?, 'x', 1)").run(u, u);
  }
  db.exec('ALTER TABLE admins DROP COLUMN can_edit_attendance'); // simulate a database from before this feature
  db.close();
  db = openDb(file);
  assert.deepEqual(db.prepare('SELECT username FROM admins WHERE can_edit_attendance = 1 ORDER BY id').all().map((a) => a.username), ['firefueled', 'amit.sharma']);
  db.close();
});

test('managers check flagged items for their team but cannot change anything', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const site = await admin('POST', '/api/admin/branches', { name: 'M3M Golf Hills', lat: 28.4, lng: 77.0, radius_m: 300, geofence_mode: 'flag' });
  const other = await admin('POST', '/api/admin/branches', { name: 'Palakollu', lat: 16.5, lng: 81.7, radius_m: 300, geofence_mode: 'flag' });
  const mk = async (code, branch, extra = {}) => (await admin('POST', '/api/admin/employees', {
    code, name: code, branch_id: branch, salary_type: 'monthly', salary: 30000, shift_start: '09:00', shift_end: '18:00', weekly_offs: ['0'], joined_on: '', pin: '1234', ...extra,
  })).data.id;
  const mgrId = await mk('MGR', site.data.id, { is_manager: true });
  const memberId = await mk('MEM', site.data.id);
  await mk('FAR', other.data.id);

  const login = async (code) => { const c = s.client(); await c('POST', '/api/employee/login', { code, pin: '1234' }); return c; };
  const mgr = await login('MGR');
  const mem = await login('MEM');
  const far = await login('FAR');
  const punch = async (c, time, kind, where) => {
    s.clock.now = ist('2026-10-05', time);
    return (await c('POST', '/api/employee/punch', { note: 'Client office',  kind, ...where, accuracy: 10, selfie: JPEG })).data;
  };
  // An earlier day on the app (no late marks on someone's first day)
  s.db.prepare("INSERT INTO punches (employee_id, kind, at, work_date, lat, lng, accuracy_m, inside_geofence, selfie_file, status) VALUES (?, 'IN', ?, ?, 0, 0, 10, 1, 'x.bin', 'ok')").run(Number((await admin('GET', '/api/admin/employees')).data.find((e) => e.code === 'MEM').id), ist('2026-10-01', '09:00'), '2026-10-01');
  // Member: punch from 5 km away (flagged), 90 min late, overtime
  const flagged = await punch(mem, '10:30', 'IN', { lat: 28.45, lng: 77.0 });
  assert.equal(flagged.status, 'flagged');
  await punch(mem, '18:00', 'OUT', { lat: 28.4, lng: 77.0 });
  await punch(mem, '18:30', 'OT_IN', { lat: 28.4, lng: 77.0 });
  await punch(mem, '20:30', 'OT_OUT', { lat: 28.4, lng: 77.0 });
  // Someone at another branch and the manager himself also get flagged
  await punch(far, '09:00', 'IN', { lat: 16.6, lng: 81.7 });
  const own = await punch(mgr, '09:00', 'IN', { lat: 28.45, lng: 77.0 });

  // Non-managers can't see the team view
  assert.equal((await mem('GET', '/api/employee/team')).status, 403);
  // Manager sees only their branch's team, not themself
  s.clock.now = ist('2026-10-05', '21:00');
  let r = await mgr('GET', '/api/employee/team');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.punches.map((p) => p.id), [flagged.id]);
  assert.deepEqual(r.data.late.map((x) => [x.employee_id, x.date]), [[memberId, '2026-10-05']]);
  assert.deepEqual(r.data.overtime.map((x) => x.ot_minutes), [120]);
  assert.equal((await mgr('GET', `/api/employee/team/punches/${flagged.id}/selfie`)).headers.get('content-type'), 'image/jpeg');

  // Verify: punch looks fine, late doubtful
  assert.equal((await mgr('POST', '/api/employee/team/verify', { kind: 'punch', punch_id: flagged.id, verdict: 'ok', note: 'Was at gate 2' })).status, 200);
  assert.equal((await mgr('POST', '/api/employee/team/verify', { kind: 'late', employee_id: memberId, date: '2026-10-05', verdict: 'doubt' })).status, 200);
  assert.equal((await mgr('POST', '/api/employee/team/verify', { kind: 'overtime', employee_id: memberId, date: '2026-10-05', verdict: 'ok' })).status, 200);
  // ...but not their own punch, nor things that aren't flagged
  assert.equal((await mgr('POST', '/api/employee/team/verify', { kind: 'punch', punch_id: own.id, verdict: 'ok' })).status, 404);
  assert.equal((await mgr('POST', '/api/employee/team/verify', { kind: 'late', employee_id: memberId, date: '2026-10-04', verdict: 'ok' })).status, 404);

  // Nothing actually changed: punch still flagged, late still pending, overtime still pending
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  const p = (await admin('GET', '/api/admin/punches?status=flagged')).data.find((x) => x.id === flagged.id);
  assert.equal(p.status, 'flagged');
  assert.deepEqual([p.verification.verdict, p.verification.manager_name, p.verification.note], ['ok', 'MGR', 'Was at gate 2']);
  const late = (await admin('GET', '/api/admin/late-approvals?month=2026-10')).data.rows[0];
  assert.equal(late.late_review, 'pending');
  assert.equal(late.verification.verdict, 'doubt');
  const ot = (await admin('GET', '/api/admin/overtime?month=2026-10')).data.rows[0];
  assert.equal(ot.ot_status, 'pending');
  assert.equal(ot.verification.verdict, 'ok');

  // Managers have no admin powers
  assert.equal((await mgr('POST', `/api/admin/punches/${flagged.id}/review`, { status: 'approved' })).status, 401);
  assert.equal((await mgr('PUT', '/api/admin/attendance/override', { employee_id: memberId, date: '2026-10-05', status: 'present' })).status, 401);

  // Once the admin decides, it leaves the manager's list
  await admin('POST', `/api/admin/punches/${flagged.id}/review`, { status: 'approved' });
  r = await mgr('GET', '/api/employee/team');
  assert.equal(r.data.punches.length, 0);

  // "All branches" managers also see other branches
  await admin('PUT', `/api/admin/employees/${mgrId}`, {
    code: 'MGR', name: 'MGR', branch_id: site.data.id, salary_type: 'monthly', salary: 30000, shift_start: '09:00', shift_end: '18:00', weekly_offs: ['0'], joined_on: '', is_manager: true, manager_scope: 'all',
  });
  r = await mgr('GET', '/api/employee/team');
  assert.equal(r.data.scope, 'all');
  assert.equal(r.data.punches.length, 1, 'the far branch punch');
});
