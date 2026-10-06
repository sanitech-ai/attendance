'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };

test('monthly late & overtime report; no late on the joining day or first app day', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  await admin('PUT', '/api/admin/settings', { ot_requires_approval: false });
  const base = { branch_id: b, salary_type: 'monthly', salary: 30000, weekly_offs: [], pin: '1234' };
  await admin('POST', '/api/admin/employees', { ...base, code: 'A1', name: 'Asha', joined_on: '' });
  await admin('POST', '/api/admin/employees', { ...base, code: 'J1', name: 'Joiner', joined_on: '2026-10-02' });
  const login = async (code) => { const c = s.client(); await c('POST', '/api/employee/login', { code, pin: '1234' }); return c; };
  const a = await login('A1');
  const j = await login('J1');
  const day = async (c, date, inAt, outAt, ot) => {
    s.clock.now = ist(date, inAt); await c('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
    s.clock.now = ist(date, outAt); await c('POST', '/api/employee/punch', { kind: 'OUT', ...HQ, accuracy: 10, selfie: JPEG });
    if (ot) {
      s.clock.now = ist(date, ot[0]); await c('POST', '/api/employee/punch', { kind: 'OT_IN', ...HQ, accuracy: 10, selfie: JPEG });
      s.clock.now = ist(date, ot[1]); await c('POST', '/api/employee/punch', { kind: 'OT_OUT', ...HQ, accuracy: 10, selfie: JPEG });
    }
  };
  // Asha's first day on the app: installed it at 14:00 — not late, full day
  await day(a, '2026-10-01', '14:00', '18:00');
  await day(a, '2026-10-02', '09:10', '18:00'); // within grace
  await day(a, '2026-10-03', '09:20', '18:00', ['18:30', '20:30']); // late 20 min + 2h OT
  await day(a, '2026-10-05', '10:30', '18:00'); // late 90 min (over 1 hour)
  // Joiner: late on joining day (not counted), late next day (counted)
  await day(j, '2026-10-02', '11:00', '18:00');
  await day(j, '2026-10-03', '09:40', '18:00');
  s.clock.now = ist('2026-10-06', '08:00');

  const r = await admin('GET', '/api/admin/late-ot?month=2026-10');
  assert.equal(r.status, 200);
  const asha = r.data.rows.find((x) => x.code === 'A1');
  assert.equal(asha.first_day, '2026-10-01');
  assert.equal(asha.late_days, 2);
  assert.equal(asha.late_hour_days, 1);
  assert.equal(asha.late_minutes, 20 + 90);
  assert.deepEqual(asha.late.map((l) => l.date), ['2026-10-03', '2026-10-05']);
  assert.equal(asha.ot_days, 1);
  assert.equal(asha.ot_minutes, 120);
  const reg = (await admin('GET', '/api/admin/attendance/' + asha.employee_id + '?month=2026-10')).data.days;
  assert.equal(reg.find((d) => d.date === '2026-10-01').status, 'present');
  assert.ok(reg.find((d) => d.date === '2026-10-01').flags.includes('first_day'));

  const joiner = r.data.rows.find((x) => x.code === 'J1');
  assert.equal(joiner.late_days, 1);
  assert.deepEqual(joiner.late.map((l) => l.date), ['2026-10-03']);

  // Late time is taken off approved overtime: 120 min OT − 110 min late = 10 min paid
  assert.equal(asha.ot_after_late_minutes, 10);
  let pay = (await admin('GET', '/api/admin/payroll?month=2026-10')).data.rows.find((x) => x.code === 'A1');
  assert.deepEqual([pay.ot_approved_minutes, pay.late_minutes, pay.late_offset_minutes, pay.ot_paid_minutes], [120, 110, 110, 10]);
  assert.equal(pay.ot_paise, Math.round(pay.hourly_rate_paise * 10 / 60));
  // Staff see the same numbers
  const mine = (await a('GET', '/api/employee/salary?month=2026-10')).data;
  assert.equal(mine.row.ot_paid_minutes, 10);
  assert.equal((await a('GET', '/api/employee/me')).data.late_offsets_ot, true);
  // Joiner has late time but no overtime: nothing to take it from, never negative
  pay = (await admin('GET', '/api/admin/payroll?month=2026-10')).data.rows.find((x) => x.code === 'J1');
  assert.deepEqual([pay.late_offset_minutes, pay.ot_paise], [0, 0]);
  // Switched off: full overtime is paid
  await admin('PUT', '/api/admin/settings', { late_offsets_ot: false });
  pay = (await admin('GET', '/api/admin/payroll?month=2026-10')).data.rows.find((x) => x.code === 'A1');
  assert.equal(pay.ot_paid_minutes, 120);

  const csv = await admin('GET', '/api/admin/late-ot.csv?month=2026-10');
  assert.equal(csv.status, 200);
  assert.match(String(csv.data), /Asha/);
});
