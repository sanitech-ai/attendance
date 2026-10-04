'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist } = require('./helpers');

test('admin gives many staff new PINs at once; logins are tracked', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const base = { branch_id: b, salary_type: 'monthly', salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234' };
  const a = (await admin('POST', '/api/admin/employees', { ...base, code: 'A1', name: 'Asha', phone: '9876543210' })).data.id;
  const c = (await admin('POST', '/api/admin/employees', { ...base, code: 'C1', name: 'Chetan' })).data.id;

  const asha = s.client();
  assert.equal((await asha('POST', '/api/employee/login', { code: 'A1', pin: '1234' })).status, 200);
  const emps = (await admin('GET', '/api/admin/employees')).data;
  assert.ok(emps.find((e) => e.code === 'A1').last_login_at);
  assert.equal(emps.find((e) => e.code === 'C1').last_login_at, null);

  const r = await admin('POST', '/api/admin/employees/reset-pins', { ids: [a, c] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map((e) => e.code), ['A1', 'C1']);
  assert.ok(r.data.every((e) => /^\d{4}$/.test(e.pin)));
  assert.equal(r.data[0].phone, '9876543210');
  assert.ok(!('pin_hash' in r.data[0]));
  // old session ended, old PIN gone, new PIN works
  assert.equal((await asha('GET', '/api/employee/me')).status, 401);
  if (r.data[0].pin !== '1234') assert.equal((await s.client()('POST', '/api/employee/login', { code: 'A1', pin: '1234' })).status, 401);
  assert.equal((await s.client()('POST', '/api/employee/login', { code: 'C1', pin: r.data[1].pin })).status, 200);
  // staff can't call it
  assert.equal((await asha('POST', '/api/admin/employees/reset-pins', { ids: [a] })).status, 401);
  assert.equal((await admin('POST', '/api/admin/employees/reset-pins', { ids: [] })).status, 400);
});
