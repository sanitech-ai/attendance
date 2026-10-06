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
  let r = await officeOnly('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...PASHA, accuracy: 10, selfie: JPEG });
  assert.equal(r.data.status, 'flagged');
  assert.match(r.data.flag_reason, /at Pashamylaram, which is not one of their locations/);
  // The roamer is allowed there
  r = await roamer('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...PASHA, accuracy: 10, selfie: JPEG });
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.branch_name, 'Pashamylaram');
  // Site staff (block mode) can't punch from the head office
  r = await siteGuy('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
  assert.equal(r.status, 403);
  // ...their app marks which sites are theirs (all sites are listed so distances make sense)
  const mine = async (c) => (await c('GET', '/api/employee/today')).data.branches.filter((b) => b.mine).map((b) => b.name).sort();
  assert.deepEqual(await mine(siteGuy), ['Pashamylaram']);
  assert.deepEqual(await mine(roamer), ['Head Office', 'Pashamylaram']);

  // Late is measured against the branch timing: 09:00 at Pashamylaram (opens 08:30) is 30 min late
  // (after a first day on the app, which never counts as late)
  s.db.prepare("INSERT INTO punches (employee_id, kind, at, work_date, lat, lng, accuracy_m, inside_geofence, selfie_file, status) VALUES (?, 'IN', ?, ?, 0, 0, 10, 1, 'x.bin', 'ok')").run(site, ist('2026-10-01', '09:00'), '2026-10-01');
  r = await siteGuy('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...PASHA, accuracy: 10, selfie: JPEG });
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
  assert.deepEqual(await mine(roamer), ['Head Office']);
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

test('distance is reported from the closest site, not just the closest allowed one', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const hq = (await admin('POST', '/api/admin/branches', { name: 'Head Office', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const far = (await admin('POST', '/api/admin/branches', { name: 'Palakollu', lat: 16.52, lng: 81.73, radius_m: 300, geofence_mode: 'flag' })).data.id;
  const pasha = (await admin('POST', '/api/admin/branches', { name: 'Pashamylaram', ...PASHA, radius_m: 300, geofence_mode: 'flag' })).data.id;
  const base = { salary_type: 'monthly', salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234', follow_branch_shift: true };
  // Home is a far site; also allowed at Pashamylaram, but not at the head office
  await admin('POST', '/api/admin/employees', { ...base, code: 'M1', name: 'Multi', branch_id: far, extra_locations: [pasha] });
  // A big radius at one allowed site must not hide being inside another
  await admin('POST', '/api/admin/employees', { ...base, code: 'M2', name: 'Office + site', branch_id: hq, extra_locations: [pasha] });
  const login = async (code) => { const c = s.client(); await c('POST', '/api/employee/login', { code, pin: '1234' }); return c; };

  s.clock.now = ist('2026-10-05', '09:00');
  const nearHq = { lat: HQ.lat + 0.003, lng: HQ.lng }; // ~330 m north of the head office
  let r = await (await login('M1'))('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...nearHq, accuracy: 15, selfie: JPEG });
  assert.equal(r.data.status, 'flagged');
  assert.equal(r.data.branch_name, 'Head Office');
  assert.ok(r.data.distance_m > 300 && r.data.distance_m < 360, String(r.data.distance_m));
  assert.match(r.data.flag_reason, /0\.3\d km from Head Office, not one of their locations/);

  r = await (await login('M2'))('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...HQ, accuracy: 15, selfie: JPEG });
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.branch_name, 'Head Office');
  void hq;
});

