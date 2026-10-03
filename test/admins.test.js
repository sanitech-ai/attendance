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
  // Only admins with the attendance permission may change markings
  let o = await amit('PUT', '/api/admin/attendance/override', { employee_id: e.data.id, date: '2026-10-01', status: 'present', note: 'ok' });
  assert.equal(o.status, 403);
  assert.equal((await amit('PUT', `/api/admin/admins/${amitId}/permissions`, { can_edit_attendance: true })).status, 403, "can't grant it to yourself");
  assert.equal((await owner('PUT', `/api/admin/admins/${amitId}/permissions`, { can_edit_attendance: true })).status, 200);
  o = await amit('PUT', '/api/admin/attendance/override', { employee_id: e.data.id, date: '2026-10-01', status: 'present', note: 'ok' });
  assert.equal(o.status, 200);

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

test('staff preview: admin sees the employee app read-only', async (t) => {
  const { JPEG } = require('./helpers');
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  const b = await admin('POST', '/api/admin/branches', { name: 'HQ', lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'flag' });
  const e = await admin('POST', '/api/admin/employees', { code: 'E1', name: 'Ravi', branch_id: b.data.id, salary_type: 'monthly', salary: 30000, shift_start: '09:00', shift_end: '18:00', weekly_offs: ['0'], joined_on: '', pin: '1234' });
  const staff = s.client();
  await staff('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  s.clock.now = ist('2026-10-01', '09:05');
  const punch = await staff('POST', '/api/employee/punch', { kind: 'IN', lat: 17.41, lng: 78.44, accuracy: 10, selfie: JPEG });

  const base = `/api/admin/preview/${e.data.id}`;
  let r = await admin('GET', `${base}/me`);
  assert.equal(r.data.employee.name, 'Ravi');
  assert.equal(r.data.employee.pin_hash, undefined);
  r = await admin('GET', `${base}/today`);
  assert.deepEqual(r.data.allowed, ['OUT'], 'same view the employee has');
  assert.equal(r.data.punches.length, 1);
  r = await admin('GET', `${base}/punches/${punch.data.id}/selfie`);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal((await admin('GET', `${base}/attendance?month=2026-10`)).status, 200);

  // Read-only
  r = await admin('POST', `${base}/punch`, { kind: 'OUT', lat: 17.41, lng: 78.44, accuracy: 10, selfie: JPEG });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /preview/);
  assert.equal((await admin('POST', `${base}/leaves`, { from_date: '2026-10-05', to_date: '2026-10-05', leave_type: 'paid' })).status, 403);
  assert.equal((await admin('POST', `${base}/logout`)).status, 403);
  assert.equal((await staff('GET', '/api/employee/me')).status, 200, 'employee session untouched');

  // Staff can't use the preview; unknown employee is 404; preview is audited
  assert.equal((await staff('GET', `${base}/me`)).status, 401);
  assert.equal((await admin('GET', '/api/admin/preview/999/me')).status, 404);
  assert.ok((await admin('GET', '/api/admin/audit')).data.some((a) => a.action === 'employee.previewed'));
});

test('buttons that send no data (logout, cancel) work; forms posting other types are refused', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  const empty = await fetch(`${s.base}/api/admin/logout`, { method: 'POST', headers: { 'Content-Length': '0' } });
  assert.equal(empty.status, 200);
  const form = await fetch(`${s.base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner&password=password123' });
  assert.equal(form.status, 415, 'cross-site HTML form posts are still blocked');
});
