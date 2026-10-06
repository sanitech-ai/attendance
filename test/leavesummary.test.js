'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist } = require('./helpers');

test('staff and admins see paid and unpaid leave taken (month and year)', async (t) => {
  const s = await startServer(ist('2026-09-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'flag' })).data.id;
  await admin('POST', '/api/admin/employees', { code: 'E1', name: 'Asha', branch_id: b, salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234' });
  const e = s.client();
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  const ask = async (from, to, type) => {
    const id = (await e('POST', '/api/employee/leaves', { from_date: from, to_date: to, leave_type: type, reason: 'x' })).data.id;
    await admin('POST', `/api/admin/leaves/${id}/decision`, { status: 'approved' });
  };
  await ask('2026-09-08', '2026-09-09', 'paid'); // 2 paid in September
  await ask('2026-10-05', '2026-10-05', 'unpaid'); // 1 unpaid in October
  await ask('2026-10-06', '2026-10-06', 'paid'); // 1 paid in October
  const pending = (await e('POST', '/api/employee/leaves', { from_date: '2026-10-07', to_date: '2026-10-07', leave_type: 'paid' })).data.id;
  assert.ok(pending); // not approved: not counted
  s.clock.now = ist('2026-10-08', '10:00');
  // Sessions expire over five weeks: log in again
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });

  const mine = (await e('GET', '/api/employee/leave-summary')).data;
  assert.deepEqual([mine.year, mine.paid, mine.unpaid, mine.month, mine.month_paid, mine.month_unpaid], [2026, 3, 1, '2026-10', 1, 1]);
  const row = (await admin('GET', '/api/admin/leave-summary?year=2026')).data.rows[0];
  assert.deepEqual([row.paid, row.unpaid, row.month_paid, row.month_unpaid], [3, 1, 1, 1]);
  assert.deepEqual([(await admin('GET', '/api/admin/leave-summary?year=2025')).data.rows[0].paid], [0]);
});

test('leave is only counted from the day the employee started using the app', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { code: 'E1', name: 'Asha', branch_id: b, salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234' })).data.id;
  // Before they used the app, an admin marked a day as leave in the register
  await admin('PUT', '/api/admin/attendance/override', { employee_id: id, date: '2026-10-02', status: 'paid_leave' });
  let row = (await admin('GET', '/api/admin/leave-summary')).data.rows[0];
  assert.deepEqual([row.since, row.paid], [null, 0], 'not on the app yet: nothing shown');
  // First punch on 5 Oct; later leave counts, the earlier day does not
  s.db.prepare("INSERT INTO punches (employee_id, kind, at, work_date, lat, lng, accuracy_m, inside_geofence, selfie_file, status) VALUES (?, 'IN', ?, '2026-10-05', 17.41, 78.44, 10, 1, 'x.bin', 'ok')").run(id, ist('2026-10-05', '09:00'));
  await admin('PUT', '/api/admin/attendance/override', { employee_id: id, date: '2026-10-06', status: 'unpaid_leave' });
  s.clock.now = ist('2026-10-08', '10:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  row = (await admin('GET', '/api/admin/leave-summary')).data.rows[0];
  assert.deepEqual([row.since, row.paid, row.unpaid], ['2026-10-05', 0, 1]);
});

