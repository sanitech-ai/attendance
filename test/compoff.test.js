'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };

test('working on the weekly off earns a comp-off to take on a weekday; no overtime', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { code: 'E1', name: 'Asha', branch_id: b, salary: 31000, weekly_offs: ['0'], joined_on: '', pin: '1234' })).data.id;
  const e = s.client();
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  const day = async (date, inAt, outAt) => {
    s.clock.now = ist(date, inAt);
    await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' }); // sessions expire over the test's weeks
    const r = await e('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    s.clock.now = ist(date, outAt); await e('POST', '/api/employee/punch', { kind: 'OUT', ...HQ, accuracy: 10, selfie: JPEG });
    return r;
  };
  assert.deepEqual((await e('GET', '/api/employee/today')).data.allowed, ['IN']);
  assert.equal((await e('POST', '/api/employee/punch', { kind: 'OT_IN', ...HQ, accuracy: 10, selfie: JPEG })).status, 400);

  await day('2026-10-01', '09:00', '18:00');
  const sun = await day('2026-10-04', '09:30', '18:30'); // Sunday, full day (9 h): never "late" on a weekly off
  assert.equal(sun.data.late, null);
  await day('2026-10-11', '09:00', '13:30'); // Sunday, half day
  s.clock.now = ist('2026-10-12', '08:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });

  let sum = (await e('GET', '/api/employee/leave-summary')).data.comp_off;
  assert.deepEqual([sum.earned, sum.used, sum.balance], [1.5, 0, 1.5]);
  assert.deepEqual(sum.earned_days.map((d) => [d.date, d.earned]), [['2026-10-04', 1], ['2026-10-11', 0.5]]);
  const days = (await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days;
  const d4 = days.find((d) => d.date === '2026-10-04');
  assert.deepEqual([d4.status, d4.late_minutes, d4.comp_off_earned], ['present', 0, 1]);
  assert.ok(d4.flags.includes('worked_week_off'));

  // Comp-off only on working days, and only as much as earned
  const ask = (from, to) => e('POST', '/api/employee/leaves', { from_date: from, to_date: to, leave_type: 'comp_off', reason: 'family' });
  assert.equal((await ask('2026-10-18', '2026-10-18')).status, 400, 'a Sunday');
  assert.match((await ask('2026-10-14', '2026-10-15')).data.error, /1.5 comp-off day\(s\) left; these dates need 2/);
  const ok = await ask('2026-10-14', '2026-10-14');
  assert.equal(ok.status, 200);
  sum = (await e('GET', '/api/employee/leave-summary')).data.comp_off;
  assert.deepEqual([sum.used, sum.balance], [1, 0.5], 'a pending request already uses the balance');

  await admin('POST', `/api/admin/leaves/${ok.data.id}/decision`, { status: 'approved' });
  s.clock.now = ist('2026-10-15', '08:00');
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  const d14 = (await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days.find((d) => d.date === '2026-10-14');
  assert.equal(d14.status, 'paid_leave');
  assert.ok(d14.flags.includes('comp_off'));
  const row = (await admin('GET', '/api/admin/leave-summary')).data.rows[0];
  assert.deepEqual([row.paid, row.comp_off.earned, row.comp_off.used, row.comp_off.balance], [1, 1.5, 1, 0.5]);

  // Payroll: no overtime; the Sundays worked are paid days like any week off
  const pay = (await admin('GET', '/api/admin/payroll?month=2026-10')).data.rows[0];
  assert.equal(pay.ot_paise, undefined);
  assert.equal(pay.attendance.comp_off_earned, 1.5);

  // If the admin corrects a worked Sunday to a plain week off, the balance shrinks
  await admin('PUT', '/api/admin/attendance/override', { employee_id: id, date: '2026-10-11', status: 'week_off' });
  assert.equal((await admin('GET', '/api/admin/leave-summary')).data.rows[0].comp_off.balance, 0);
});

test('leave never uses up a weekly off or holiday', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { code: 'E1', name: 'Asha', branch_id: b, salary: 31000, weekly_offs: ['0'], joined_on: '', pin: '1234' })).data.id;
  const e = s.client();
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  const r = await e('POST', '/api/employee/leaves', { from_date: '2026-10-03', to_date: '2026-10-05', leave_type: 'paid' }); // Sat–Mon
  await admin('POST', `/api/admin/leaves/${r.data.id}/decision`, { status: 'approved' });
  s.clock.now = ist('2026-10-06', '08:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  const days = (await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days;
  assert.deepEqual(['2026-10-03', '2026-10-04', '2026-10-05'].map((d) => days.find((x) => x.date === d).status), ['paid_leave', 'week_off', 'paid_leave']);
});
