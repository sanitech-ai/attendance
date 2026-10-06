'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG, PDF } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };

test('punch-in locks after 2 days on the app until details are complete', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'), { profileRule: true });
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  assert.equal((await admin('GET', '/api/admin/settings')).data.profile_grace_days, 2);
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  await admin('POST', '/api/admin/employees', { code: 'E1', name: 'Asha', branch_id: b, salary: 30000, weekly_offs: [], joined_on: '', pin: '1234' });
  const e = s.client();
  const punchDay = async (date) => {
    s.clock.now = ist(date, '09:00');
    await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
    const r = await e('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
    if (r.status === 200) {
      s.clock.now = ist(date, '18:00');
      await e('POST', '/api/employee/punch', { kind: 'OUT', ...HQ, accuracy: 10, selfie: JPEG });
    }
    return r;
  };
  // Day 1 and 2: allowed, with a countdown
  s.clock.now = ist('2026-10-01', '08:30');
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  assert.equal((await e('GET', '/api/employee/me')).data.profile_deadline.days_left, 2);
  assert.equal((await punchDay('2026-10-01')).status, 200);
  assert.equal((await punchDay('2026-10-02')).status, 200);

  // Day 3: locked
  s.clock.now = ist('2026-10-03', '08:30');
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  const today = (await e('GET', '/api/employee/today')).data;
  assert.deepEqual(today.profile_block.missing, ['phone', 'aadhaar', 'pan', 'payment']);
  const r = await punchDay('2026-10-03');
  assert.equal(r.status, 403);
  assert.match(r.data.error, /Please add your mobile number, Aadhaar card, PAN card, bank account or UPI ID first/);
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  assert.equal((await admin('GET', '/api/admin/employees')).data[0].punch_locked, true);

  // Filling in the details unlocks it straight away
  s.clock.now = ist('2026-10-03', '09:10');
  assert.equal((await e('POST', '/api/employee/profile', { phone: '9876543210', upi_id: '9876543210@ybl' })).status, 200);
  assert.equal((await e('POST', '/api/employee/documents', { doc_type: 'aadhaar', doc_number: '123412341234', file: PDF })).status, 200);
  assert.equal((await e('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG })).status, 403, 'PAN still missing');
  assert.equal((await e('POST', '/api/employee/documents', { doc_type: 'pan', doc_number: 'ABCDE1234F', file: PDF })).status, 200);
  assert.equal((await e('GET', '/api/employee/today')).data.profile_block, null);
  assert.equal((await e('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG })).status, 200);
});

test('punch-out is never locked, and 0 days turns the lock off', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'), { profileRule: true });
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { code: 'E1', name: 'Asha', branch_id: b, salary: 30000, weekly_offs: [], joined_on: '', pin: '1234' })).data.id;
  const ins = s.db.prepare("INSERT INTO punches (employee_id, kind, at, work_date, lat, lng, accuracy_m, inside_geofence, selfie_file, status) VALUES (?, ?, ?, ?, 17.41, 78.44, 10, 1, 'x.bin', 'ok')");
  ins.run(id, 'IN', ist('2026-09-29', '09:00'), '2026-09-29');
  ins.run(id, 'IN', ist('2026-09-30', '09:00'), '2026-09-30');
  ins.run(id, 'IN', ist('2026-10-01', '09:00'), '2026-10-01'); // on duty today
  s.clock.now = ist('2026-10-01', '17:00');
  const e = s.client();
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  assert.equal((await e('GET', '/api/employee/today')).data.profile_block, null, 'only Punch In is locked');
  assert.equal((await e('POST', '/api/employee/punch', { kind: 'OUT', ...HQ, accuracy: 10, selfie: JPEG })).status, 200);
  s.clock.now = ist('2026-10-02', '09:00');
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  assert.equal((await e('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG })).status, 403);
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  await admin('PUT', '/api/admin/settings', { profile_grace_days: 0 });
  assert.equal((await e('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG })).status, 200);
});
