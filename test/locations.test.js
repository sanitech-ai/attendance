'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };
const PASHA = { lat: 17.53, lng: 78.18 };

test('extra punch locations and per-office timings', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const hq = (await admin('POST', '/api/admin/branches', { name: 'Head Office', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const pasha = (await admin('POST', '/api/admin/branches', {
    name: 'Pashamylaram', ...PASHA, radius_m: 300, geofence_mode: 'block', shift_start: '08:30', shift_end: '17:30',
  })).data.id;
  const base = { salary_type: 'monthly', salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234' };
  // Follows its branch timing (08:30-17:30) automatically
  const site = (await admin('POST', '/api/admin/employees', { ...base, code: 'P1', name: 'Site guy', branch_id: pasha, follow_branch_shift: true })).data.id;
  // Office person, no extra locations; and one allowed at Pashamylaram too
  await admin('POST', '/api/admin/employees', { ...base, code: 'H1', name: 'Office only', branch_id: hq, follow_branch_shift: true });
  const roam = (await admin('POST', '/api/admin/employees', { ...base, code: 'H2', name: 'Roamer', branch_id: hq, follow_branch_shift: true, extra_locations: [pasha] })).data.id;
  // Personal shift
  const night = (await admin('POST', '/api/admin/employees', { ...base, code: 'N1', name: 'Night', branch_id: pasha, follow_branch_shift: false, shift_start: '20:00', shift_end: '05:00' })).data.id;

  let emps = (await admin('GET', '/api/admin/employees')).data;
  const by = (code) => emps.find((e) => e.code === code);
  assert.deepEqual([by('P1').shift_start, by('P1').shift_end], ['08:30', '17:30']);
  assert.deepEqual([by('H1').shift_start, by('H1').shift_end], ['09:00', '18:00']);
  assert.equal(by('H2').extra_location_ids, String(pasha));

  const login = async (code) => { const c = s.client(); await c('POST', '/api/employee/login', { code, pin: '1234' }); return c; };
  const officeOnly = await login('H1');
  const roamer = await login('H2');
  const siteGuy = await login('P1');

  s.clock.now = ist('2026-10-05', '09:00');
  // Office-only staff punching at Pashamylaram: flagged as not one of their sites
  let r = await officeOnly('POST', '/api/employee/punch', { kind: 'IN', ...PASHA, accuracy: 10, selfie: JPEG });
  assert.equal(r.data.status, 'flagged');
  assert.match(r.data.flag_reason, /at Pashamylaram, which is not one of their locations/);
  // The roamer is allowed there
  r = await roamer('POST', '/api/employee/punch', { kind: 'IN', ...PASHA, accuracy: 10, selfie: JPEG });
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.branch_name, 'Pashamylaram');
  // Site staff (block mode) can't punch from the head office
  r = await siteGuy('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
  assert.equal(r.status, 403);
  // ...and their app only lists their own sites
  assert.deepEqual((await siteGuy('GET', '/api/employee/today')).data.branches.map((b) => b.name), ['Pashamylaram']);
  assert.deepEqual((await roamer('GET', '/api/employee/today')).data.branches.map((b) => b.name).sort(), ['Head Office', 'Pashamylaram']);

  // Late is measured against the branch timing: 09:00 at Pashamylaram (opens 08:30) is 30 min late
  r = await siteGuy('POST', '/api/employee/punch', { kind: 'IN', ...PASHA, accuracy: 10, selfie: JPEG });
  assert.equal(r.status, 200);
  assert.equal(r.data.late.minutes, 30);

  // Changing the office timing updates staff who follow it, not personal shifts
  r = await admin('PUT', `/api/admin/branches/${pasha}`, { name: 'Pashamylaram', ...PASHA, radius_m: 300, geofence_mode: 'block', shift_start: '08:00', shift_end: '17:00' });
  assert.equal(r.status, 200);
  emps = (await admin('GET', '/api/admin/employees')).data;
  assert.deepEqual([by('P1').shift_start, by('P1').shift_end], ['08:00', '17:00']);
  assert.deepEqual([by('N1').shift_start, by('N1').shift_end], ['20:00', '05:00']);

  // Removing the extra location takes the permission away
  const h2 = by('H2');
  await admin('PUT', `/api/admin/employees/${roam}`, { ...base, code: 'H2', name: 'Roamer', branch_id: hq, follow_branch_shift: true, extra_locations: [], shift_start: h2.shift_start, shift_end: h2.shift_end });
  assert.deepEqual((await roamer('GET', '/api/employee/today')).data.branches.map((b) => b.name), ['Head Office']);
  assert.ok(site && night);
});

test('import without shift columns follows the branch timing', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  await admin('POST', '/api/admin/branches', { name: 'Pashamylaram', ...PASHA, radius_m: 300, geofence_mode: 'flag', shift_start: '08:30', shift_end: '17:30' });
  const r = await admin('POST', '/api/admin/employees/import', {
    csv: 'employee_id,name,branch,salary,shift_start,shift_end\nA1,A,Pashamylaram,10000,,\nA2,B,Pashamylaram,10000,10:00,19:00',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const emps = (await admin('GET', '/api/admin/employees')).data;
  const a1 = emps.find((e) => e.code === 'A1');
  const a2 = emps.find((e) => e.code === 'A2');
  assert.deepEqual([a1.shift_start, a1.follow_branch_shift], ['08:30', 1]);
  assert.deepEqual([a2.shift_start, a2.follow_branch_shift], ['10:00', 0]);
});
