'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };

test('monthly late report; no late on the joining day or first app day', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const base = { branch_id: b, salary_type: 'monthly', salary: 30000, weekly_offs: [], pin: '1234' };
  await admin('POST', '/api/admin/employees', { ...base, code: 'A1', name: 'Asha', joined_on: '' });
  await admin('POST', '/api/admin/employees', { ...base, code: 'J1', name: 'Joiner', joined_on: '2026-10-02' });
  const login = async (code) => { const c = s.client(); await c('POST', '/api/employee/login', { code, pin: '1234' }); return c; };
  const a = await login('A1');
  const j = await login('J1');
  const day = async (c, date, inAt, outAt) => {
    s.clock.now = ist(date, inAt); await c('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
    s.clock.now = ist(date, outAt); await c('POST', '/api/employee/punch', { kind: 'OUT', ...HQ, accuracy: 10, selfie: JPEG });
  };
  // Asha's first day on the app: installed it at 14:00 — not late, full day
  await day(a, '2026-10-01', '14:00', '18:00');
  await day(a, '2026-10-02', '09:10', '18:00'); // within grace
  await day(a, '2026-10-03', '09:20', '18:00'); // late 20 min
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
  assert.equal(asha.late_short_days, 1, 'a day over 1 hour is not also counted as 15 min – 1 hour');
  assert.equal(asha.late_minutes, 20 + 90);
  assert.deepEqual(asha.late.map((l) => l.date), ['2026-10-03', '2026-10-05']);
  const reg = (await admin('GET', '/api/admin/attendance/' + asha.employee_id + '?month=2026-10')).data.days;
  assert.equal(reg.find((d) => d.date === '2026-10-01').status, 'present');
  assert.ok(reg.find((d) => d.date === '2026-10-01').flags.includes('first_day'));

  const joiner = r.data.rows.find((x) => x.code === 'J1');
  assert.equal(joiner.late_days, 1);
  assert.deepEqual(joiner.late.map((l) => l.date), ['2026-10-03']);

  // Late time is shown in payroll (no overtime pay any more)
  const pay = (await admin('GET', '/api/admin/payroll?month=2026-10')).data.rows.find((x) => x.code === 'A1');
  assert.equal(pay.late_minutes, 110);
  assert.equal(pay.ot_paise, undefined);

  const csv = await admin('GET', '/api/admin/late-ot.csv?month=2026-10');
  assert.equal(csv.status, 200);
  assert.match(String(csv.data), /Asha/);
});

test('over 1 hour late goes to the admin: shown and totalled, not a late mark, not a half day by itself', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { branch_id: b, salary: 30000, weekly_offs: [], pin: '1234', code: 'A1', name: 'Asha', joined_on: '' })).data.id;
  const a = s.client();
  await a('POST', '/api/employee/login', { code: 'A1', pin: '1234' });
  const day = async (date, inAt) => {
    s.clock.now = ist(date, inAt); const r = await a('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
    s.clock.now = ist(date, '18:00'); await a('POST', '/api/employee/punch', { kind: 'OUT', ...HQ, accuracy: 10, selfie: JPEG });
    return r.data;
  };
  await day('2026-10-01', '09:00'); // first day on the app
  let r = await day('2026-10-02', '10:30'); // 90 min late
  assert.equal(r.late.review, true);
  assert.equal(r.late.mark, undefined);
  assert.deepEqual([r.late.month_days, r.late.month_minutes], [1, 90]);
  r = await day('2026-10-03', '09:30');
  assert.deepEqual([r.late.month_days, r.late.month_minutes], [2, 120]);
  s.clock.now = ist('2026-10-04', '08:00');

  const days = (await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days;
  const d2 = days.find((d) => d.date === '2026-10-02');
  assert.equal(d2.status, 'present', 'stayed till shift end: full day until the admin decides');
  assert.equal(d2.late_review, 'pending');
  assert.equal(d2.late_mark, null);
  assert.ok(d2.late_over_max);
  assert.equal((await admin('GET', '/api/admin/pending')).data.late_approvals, 1);
  assert.equal(days.find((d) => d.date === '2026-10-03').late_mark, 1, 'the next ordinary late is late #1');
  const row = (await admin('GET', '/api/admin/late-ot?month=2026-10')).data.rows[0];
  assert.deepEqual([row.late_days, row.late_short_days, row.late_hour_days, row.late_minutes], [2, 1, 1, 120]);
  assert.deepEqual(row.late.map((l) => l.cumulative), [90, 120]);
});

