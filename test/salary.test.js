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
  await admin('POST', `/api/admin/employees/${e.data.id}/pay-items`, { kind: 'deduction', label: 'Professional Tax', amount: 200, prorate: false });
  await admin('POST', '/api/admin/advances', { employee_id: e.data.id, amount: 1000, given_on: '2026-10-01', deduct_month: '2026-10' });
  const staff = s.client();
  await staff('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  const punch = async (date, time, kind) => {
    s.clock.now = ist(date, time);
    assert.equal((await staff('POST', '/api/employee/punch', { note: 'Client office',  kind, ...HQ, accuracy: 10, selfie: JPEG })).status, 200);
  };

  // Day 1 worked
  await punch('2026-10-01', '09:00', 'IN');
  await punch('2026-10-01', '18:00', 'OUT');
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
  assert.equal(row.ot_paise, undefined, 'no overtime pay');
  // PF is in proportion to attendance (1 of 31 days); PT was marked as a full amount every month
  assert.deepEqual(row.deductions.map((d) => [d.label, d.amount_paise]), [['PF (₹1,800 × 1/31 days)', 5806], ['Professional Tax', 20000]]);
  assert.equal(row.net_paise, 100000 - 5806 - 20000 - 100000);

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

test('fixed monthly items are in proportion to attendance: ₹9,000 room rent for 25 of 30 days = ₹7,500', async (t) => {
  const s = await startServer(ist('2026-11-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HQ', lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const staff = (await admin('POST', '/api/admin/employees', { code: 'S1', name: 'Staff', branch_id: b, salary: 30000, weekly_offs: [], joined_on: '', pin: '1234' })).data.id;
  const lab = (await admin('POST', '/api/admin/employees', { code: 'L1', name: 'Labour', category: 'labour', salary_type: 'daily', branch_id: b, salary: 800, weekly_offs: ['0#2', '0#4'], joined_on: '', pin: '1234' })).data.id;
  for (const e of [staff, lab]) {
    await admin('POST', `/api/admin/employees/${e}/pay-items`, { kind: 'addition', label: 'Room Rent', amount: 9000 });
    await admin('POST', `/api/admin/employees/${e}/pay-items`, { kind: 'deduction', label: 'TDS', amount: 1000, prorate: false });
  }
  // November 2026 has 30 days. Everyone present all month, then the staff member absent on the last 5 days
  // and the labourer on one day. Labour's 2nd and 4th Sundays (8th, 22nd) are off: 28 working days.
  await admin('POST', '/api/admin/attendance/bulk-override', { from: '2026-11-01', to: '2026-11-30', status: 'present' });
  for (const d of ['26', '27', '28', '29', '30']) await admin('PUT', '/api/admin/attendance/override', { employee_id: staff, date: `2026-11-${d}`, status: 'absent' });
  s.clock.now = ist('2026-12-01', '10:00');
  await admin('POST', '/api/admin/login', { username: 'owner', password: 'password123' });
  let rows = (await admin('GET', '/api/admin/payroll?month=2026-11')).data.rows;
  let st = rows.find((x) => x.code === 'S1');
  let lb = rows.find((x) => x.code === 'L1');
  assert.equal(st.paid_days, 25);
  assert.deepEqual(st.additions.map((x) => [x.label, x.amount_paise]), [['Room Rent (₹9,000 × 25/30 days)', 750000]]);
  assert.deepEqual(st.deductions.map((x) => [x.label, x.amount_paise]), [['TDS', 100000]], 'marked as full amount');
  assert.equal(st.base_paise, 2500000);
  assert.equal(st.net_paise, 2500000 + 750000 - 100000);
  assert.equal(lb.paid_days, 28);
  assert.deepEqual(lb.additions.map((x) => [x.label, x.amount_paise]), [['Room Rent', 900000]], 'labour present on every working day: full amount');

  // The labourer misses one day; the room rent is switched to a full amount for the staff member
  await admin('PUT', '/api/admin/attendance/override', { employee_id: lab, date: '2026-11-30', status: 'absent' });
  const item = (await admin('GET', `/api/admin/employees/${staff}/pay-items`)).data.find((x) => x.label === 'Room Rent');
  assert.equal((await admin('PUT', `/api/admin/pay-items/${item.id}`, { prorate: false })).status, 200);
  rows = (await admin('GET', '/api/admin/payroll?month=2026-11')).data.rows;
  st = rows.find((x) => x.code === 'S1');
  lb = rows.find((x) => x.code === 'L1');
  assert.deepEqual(st.additions.map((x) => [x.label, x.amount_paise]), [['Room Rent', 900000]]);
  assert.deepEqual(lb.additions.map((x) => [x.label, x.amount_paise]), [['Room Rent (₹9,000 × 27/28 days)', 867857]]);
});

test('Professional Tax is always the full amount; existing PT items switched once', async (t) => {
  const s = await startServer(ist('2026-11-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HQ', lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const e = (await admin('POST', '/api/admin/employees', { code: 'S1', name: 'Staff', branch_id: b, salary: 30000, weekly_offs: [], joined_on: '', pin: '1234' })).data.id;
  await admin('POST', `/api/admin/employees/${e}/pay-items`, { kind: 'deduction', label: 'Professional Tax', amount: 200, prorate: true });
  await admin('POST', `/api/admin/employees/${e}/pay-items`, { kind: 'deduction', label: 'TDS', amount: 1000, prorate: true });
  let items = (await admin('GET', `/api/admin/employees/${e}/pay-items`)).data;
  assert.deepEqual(items.map((x) => [x.label, x.prorate]), [['Professional Tax', 0], ['TDS', 1]], 'PT fixed even if ticked; TDS by attendance');
  await admin('POST', '/api/admin/attendance/bulk-override', { from: '2026-11-01', to: '2026-11-15', status: 'present' });
  await admin('POST', '/api/admin/attendance/bulk-override', { from: '2026-11-16', to: '2026-11-30', status: 'absent' });
  s.clock.now = ist('2026-12-01', '10:00');
  await admin('POST', '/api/admin/login', { username: 'owner', password: 'password123' });
  const row = (await admin('GET', '/api/admin/payroll?month=2026-11')).data.rows[0];
  assert.deepEqual(row.deductions.map((x) => [x.label, x.amount_paise]), [['Professional Tax', 20000], ['TDS (₹1,000 × 15/30 days)', 50000]]);

  // A database from before: PT items that follow attendance are switched to fixed once, on start-up
  s.db.prepare("UPDATE pay_items SET prorate = 1 WHERE label = 'Professional Tax'").run();
  s.db.prepare("DELETE FROM settings WHERE key = 'pt_fixed_done'").run();
  const { openDb } = require('../server/db');
  const path = require('node:path');
  openDb(path.join(s.dataDir, 'attendance.db')).close();
  items = (await admin('GET', `/api/admin/employees/${e}/pay-items`)).data;
  assert.equal(items.find((x) => x.label === 'Professional Tax').prorate, 0);
  // ...but only once: if the admin later ticks it, it stays ticked
  s.db.prepare("UPDATE pay_items SET prorate = 1 WHERE label = 'Professional Tax'").run();
  openDb(path.join(s.dataDir, 'attendance.db')).close();
  items = (await admin('GET', `/api/admin/employees/${e}/pay-items`)).data;
  assert.equal(items.find((x) => x.label === 'Professional Tax').prorate, 1);
});
