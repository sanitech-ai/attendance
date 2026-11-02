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

test('staff only ever see their own records: no team view, no other people\'s selfies, documents or visits', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const site = await admin('POST', '/api/admin/branches', { name: 'M3M Golf Hills', lat: 28.4, lng: 77.0, radius_m: 300, geofence_mode: 'flag', field_visits: true });
  const mk = async (code, extra = {}) => (await admin('POST', '/api/admin/employees', {
    code, name: code, branch_id: site.data.id, salary_type: 'monthly', salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234', ...extra,
  })).data.id;
  // Even if the old "manager" option is sent, nobody becomes a manager any more
  const mgrId = await mk('MGR', { is_manager: true, manager_scope: 'all' });
  await mk('MEM');
  assert.equal((await admin('GET', '/api/admin/employees')).data.find((e) => e.id === mgrId).is_manager, 0);
  // ...and anyone who already was one is switched off on start-up
  s.db.prepare('UPDATE employees SET is_manager = 1 WHERE id = ?').run(mgrId);
  require('../server/db').openDb(require('node:path').join(s.dataDir, 'attendance.db')).close();
  assert.equal(s.db.prepare('SELECT is_manager FROM employees WHERE id = ?').get(mgrId).is_manager, 0);

  const login = async (code) => { const c = s.client(); await c('POST', '/api/employee/login', { code, pin: '1234' }); return c; };
  const mgr = await login('MGR');
  const mem = await login('MEM');
  s.clock.now = ist('2026-10-05', '09:00');
  const p = (await mem('POST', '/api/employee/punch', { kind: 'IN', lat: 28.45, lng: 77.0, accuracy: 10, selfie: JPEG, note: 'Client office' })).data;
  const doc = (await mem('POST', '/api/employee/documents', { doc_type: 'photo', file: JPEG })).data;
  s.clock.now = ist('2026-10-05', '11:00');
  const v = (await mem('POST', '/api/employee/visit', { lat: 28.45, lng: 77.0, accuracy: 10, selfie: JPEG, note: 'HDFC Bank' })).data;
  assert.ok(p.id && doc.id && v.id, JSON.stringify([p, doc, v]));

  // The team view is gone
  for (const url of ['/api/employee/team', `/api/employee/team/punches/${p.id}/selfie`]) assert.equal((await mgr('GET', url)).status, 404, url);
  assert.equal((await mgr('POST', '/api/employee/team/verify', { kind: 'punch', punch_id: p.id, verdict: 'ok' })).status, 404);
  // Another employee's selfie, document or visit can't be opened by its number
  assert.equal((await mgr('GET', `/api/employee/punches/${p.id}/selfie`)).status, 404);
  assert.equal((await mgr('GET', `/api/employee/documents/${doc.id}/file`)).status, 404);
  assert.equal((await mgr('GET', `/api/employee/visits/${v.id}/selfie`)).status, 404);
  assert.equal((await mem('GET', `/api/employee/punches/${p.id}/selfie`)).status, 200, 'their own is fine');
  // Lists only ever contain their own records
  assert.deepEqual((await mgr('GET', '/api/employee/documents')).data, []);
  assert.equal((await mgr('GET', '/api/employee/today')).data.punches.length, 0);
  // No admin powers either
  assert.equal((await mgr('GET', '/api/admin/employees')).status, 401);
});
