'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist } = require('./helpers');

test('manage admins: edit, reset password, remove', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const owner = s.client();
  await owner('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  let r = await owner('POST', '/api/admin/admins', { name: 'Amit', username: 'amit', password: 'amit12345' });
  const amitId = r.data.id;
  const amit = s.client();
  assert.equal((await amit('POST', '/api/admin/login', { username: 'amit', password: 'amit12345' })).status, 200);

  // Edit name/username
  r = await owner('PUT', `/api/admin/admins/${amitId}`, { name: 'Amit Sharma (MD)', username: 'amit.sharma' });
  assert.equal(r.status, 200);
  assert.equal((await owner('PUT', `/api/admin/admins/${amitId}`, { name: 'X', username: 'owner' })).status, 409, 'usernames stay unique');
  assert.deepEqual((await owner('GET', '/api/admin/admins')).data.map((a) => [a.name, a.username]), [['Owner', 'owner'], ['Amit Sharma (MD)', 'amit.sharma']]);

  // Reset password: needs the acting admin's password, logs the other admin out
  r = await owner('POST', `/api/admin/admins/${amitId}/password`, { new_password: 'newpass123', password: 'wrong-pass' });
  assert.equal(r.status, 403);
  assert.equal((await owner('GET', '/api/admin/me')).status, 200, 'wrong confirmation is not a logout');
  assert.equal((await owner('POST', `/api/admin/admins/${amitId}/password`, { new_password: 'short', password: 'password123' })).status, 400);
  r = await owner('POST', `/api/admin/admins/${amitId}/password`, { new_password: 'newpass123', password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal((await amit('GET', '/api/admin/me')).status, 401, 'old session ended');
  assert.equal((await amit('POST', '/api/admin/login', { username: 'amit.sharma', password: 'amit12345' })).status, 401);
  assert.equal((await amit('POST', '/api/admin/login', { username: 'amit.sharma', password: 'newpass123' })).status, 200);

  // Records approved by an admin survive their removal
  const b = await amit('POST', '/api/admin/branches', { name: 'HQ', lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'flag' });
  const e = await amit('POST', '/api/admin/employees', { code: 'E1', name: 'A', branch_id: b.data.id, salary_type: 'monthly', salary: 1000, shift_start: '09:00', shift_end: '18:00', joined_on: '', pin: '1234' });
  await amit('PUT', '/api/admin/attendance/override', { employee_id: e.data.id, date: '2026-10-01', status: 'present', note: 'ok' });

  // Remove: not yourself, needs password
  assert.equal((await owner('DELETE', `/api/admin/admins/${s.db.prepare("SELECT id FROM admins WHERE username='owner'").get().id}`, { password: 'password123' })).status, 400);
  assert.equal((await owner('DELETE', `/api/admin/admins/${amitId}`, { password: 'nope-nope' })).status, 403);
  r = await owner('DELETE', `/api/admin/admins/${amitId}`, { password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await amit('GET', '/api/admin/me')).status, 401);
  assert.equal((await owner('GET', '/api/admin/admins')).data.length, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM day_overrides').get().n, 1, 'their corrections are kept');
  assert.ok((await owner('GET', '/api/admin/audit')).data.some((a) => a.action === 'admin.removed'));
});
