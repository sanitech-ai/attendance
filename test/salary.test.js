'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };

test('staff see their salary live, then the final payslip', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  const b = await admin('POST', '/api/admin/branches', { name: 'HQ', ...HQ, radius_m: 150, geofence_mode: 'flag' });
  const e = await admin('POST', '/api/admin/employees', {
    code: 'E1', name: 'Ravi', branch_id: b.data.id, salary_type: 'monthly', salary: 31000, shift_start: '09:00', shift_end: '18:00',
    weekly_offs: ['0'], joined_on: '2026-10-01', pin: '1234',
  });
  await admin('POST', `/api/admin/employees/${e.data.id}/pay-items`, { kind: 'deduction', label: 'PF', amount: 1800 });
  await admin('POST', `/api/admin/employees/${e.data.id}/pay-items`, { kind: 'deduction', label: 'Professional Tax', amount: 200 });
  await admin('POST', '/api/admin/advances', { employee_id: e.data.id, amount: 1000, given_on: '2026-10-01', deduct_month: '2026-10' });
  const staff = s.client();
  await staff('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  const punch = async (date, time, kind) => {
    s.clock.now = ist(date, time);
    assert.equal((await staff('POST', '/api/employee/punch', { kind, ...HQ, accuracy: 10, selfie: JPEG })).status, 200);
  };

  // Day 1 worked, plus 2 h overtime awaiting approval
  await punch('2026-10-01', '09:00', 'IN');
  await punch('2026-10-01', '18:00', 'OUT');
  await punch('2026-10-01', '18:30', 'OT_IN');
  await punch('2026-10-01', '20:30', 'OT_OUT');
  s.clock.now = ist('2026-10-02', '10:00');
  let r = await staff('GET', '/api/employee/salary');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.month, '2026-10');
  assert.equal(r.data.status, 'live');
  assert.equal(r.data.counted_until, '2026-10-02');
  const row = r.data.row;
  assert.equal(row.paid_days, 1, 'one present day so far (today not punched yet)');
  assert.equal(row.per_day_paise, 100000, 'Rs 31,000 / 31 days');
  assert.equal(row.base_paise, 100000);
  assert.equal(row.ot_paise, 0, 'pending overtime is not paid yet');
  assert.equal(row.attendance.ot_pending_minutes, 120);
  assert.deepEqual(row.deductions.map((d) => [d.label, d.amount_paise]), [['PF', 180000], ['Professional Tax', 20000]]);
  assert.equal(row.net_paise, 100000 - 180000 - 20000 - 100000);

  // Approving overtime shows up immediately
  await admin('POST', '/api/admin/overtime/decision', { employee_id: e.data.id, date: '2026-10-01', status: 'approved' });
  r = await staff('GET', '/api/employee/salary?month=2026-10');
  assert.equal(r.data.row.ot_hours, 2);
  assert.equal(r.data.row.ot_paise, Math.round((100000 / 9) * 2));

  // Limits
  assert.equal((await staff('GET', '/api/employee/salary?month=2026-11')).status, 400, 'future month');
  assert.equal((await staff('GET', '/api/employee/salary?month=2026-09')).status, 400, 'before joining');

  // After the month is finalized, the snapshot is shown as final
  s.clock.now = ist('2026-11-02', '10:00');
  await admin('POST', '/api/admin/login', { username: 'owner', password: 'password123' });
  assert.equal((await admin('POST', '/api/admin/payroll/2026-10/finalize', {})).status, 200);
  await staff('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  r = await staff('GET', '/api/employee/salary?month=2026-10');
  assert.equal(r.data.status, 'final');
  const final = (await admin('GET', '/api/admin/payroll?month=2026-10')).data.rows[0];
  assert.equal(r.data.row.net_paise, final.net_paise, 'staff see exactly what payroll finalized');
  r = await staff('GET', '/api/employee/salary');
  assert.equal(r.data.month, '2026-11');
  assert.equal(r.data.status, 'live');

  // Admin preview shows the same statement
  r = await admin('GET', `/api/admin/preview/${e.data.id}/salary?month=2026-10`);
  assert.equal(r.data.row.net_paise, final.net_paise);
});
