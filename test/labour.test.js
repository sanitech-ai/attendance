'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const SITE = { lat: 28.40, lng: 77.00 };

test('labour: imported by the office, daily wage, Aadhaar kept masked, short login, never locked', async (t) => {
  const s = await startServer(ist('2026-10-12', '08:00'), { profileRule: true });
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  await admin('POST', '/api/admin/branches', { name: 'M3M Golf Hills', ...SITE, radius_m: 300, geofence_mode: 'flag' });
  const csv = [
    'employee_id,name,branch,designation,category,salary,phone,aadhaar,upi_id,bank_account,ifsc,pin,weekly_off',
    'SECPL/LAB/016,SUSHIL KUMAR,M3M Golf Hills,Plumber,Labour,760,9318397366,6231 8337 6864,"9318397366, PHONE PE",,,7366,Sun',
    'SECPL/LAB/002,MD SOHRAB KHAN,M3M Golf Hills,Plumber,Labour,800,8801760492,8848 0064 4792,,50100461244161,HDFC0004277,0492,Sun',
    'SECPL/LAB/099,BAD ROW,M3M Golf Hills,Helper,Labour,550,12345,1234,,,,,Sun',
  ].join('\n');
  let r = await admin('POST', '/api/admin/employees/import', { csv, dry_run: true });
  assert.equal(r.data.error_count, 1);
  assert.match(r.data.rows[2].errors.join(' '), /mobile number|Aadhaar/);
  assert.equal(r.data.rows[0].aadhaar_no, 'XXXX XXXX 6864');
  assert.equal(r.data.rows[0].payment, '9318397366 (PhonePe)');
  r = await admin('POST', '/api/admin/employees/import', { csv: csv.split('\n').slice(0, 3).join('\n') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const emps = (await admin('GET', '/api/admin/employees')).data;
  const sushil = emps.find((e) => e.code === 'SECPL/LAB/016');
  assert.deepEqual([sushil.category, sushil.salary_type, sushil.salary_paise, sushil.aadhaar_no, sushil.upi_id], ['labour', 'daily', 76000, 'XXXX XXXX 6864', '9318397366 (PhonePe)']);
  assert.deepEqual(sushil.profile_missing, [], 'no PAN needed; Aadhaar entered by the office');
  assert.equal(emps.find((e) => e.code === 'SECPL/LAB/002').bank_ifsc, 'HDFC0004277');

  // Logs in with the short ID and the last 4 digits of their mobile
  const lab = s.client();
  assert.equal((await lab('POST', '/api/employee/login', { code: 'lab016', pin: '7366' })).status, 200);
  assert.equal((await s.client()('POST', '/api/employee/login', { code: 'SECPL/LAB/016', pin: '7366' })).status, 200);
  assert.equal((await s.client()('POST', '/api/employee/login', { code: 'LAB/016', pin: '0000' })).status, 401);
  assert.deepEqual((await lab('GET', '/api/employee/me')).data.profile_missing, []);

  // Works 3 days (incl. a Sunday) — never locked; paid per day worked, Sunday paid, no comp-off
  for (const d of ['2026-10-12', '2026-10-13', '2026-10-18']) {
    s.clock.now = ist(d, '09:00');
    await lab('POST', '/api/employee/login', { code: 'LAB016', pin: '7366' });
    assert.equal((await lab('POST', '/api/employee/punch', { kind: 'IN', ...SITE, accuracy: 10, selfie: JPEG })).status, 200, d);
    s.clock.now = ist(d, '18:00');
    await lab('POST', '/api/employee/punch', { kind: 'OUT', ...SITE, accuracy: 10, selfie: JPEG });
  }
  s.clock.now = ist('2026-10-19', '08:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  const pay = (await admin('GET', '/api/admin/payroll?month=2026-10')).data.rows.find((x) => x.code === 'SECPL/LAB/016');
  assert.equal(pay.paid_days, 3, 'days worked only: weekly offs not paid, the Sunday worked is');
  assert.equal(pay.base_paise, 3 * 76000);
  assert.equal(pay.attendance.comp_off_earned, 0);

  // Admin edits keep the masked Aadhaar; a new number replaces it
  const e = (await admin('GET', '/api/admin/employees')).data.find((x) => x.code === 'SECPL/LAB/016');
  r = await admin('PUT', `/api/admin/employees/${e.id}`, { ...e, weekly_offs: ['0'], salary: 760 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin('GET', '/api/admin/employees')).data.find((x) => x.code === 'SECPL/LAB/016').aadhaar_no, 'XXXX XXXX 6864');
  assert.equal((await admin('PUT', `/api/admin/employees/${e.id}`, { ...e, weekly_offs: ['0'], salary: 760, aadhaar_no: '1234' })).status, 400);
});

test('weekly offs can be specific weeks: 2nd & 4th Sunday', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  await admin('POST', '/api/admin/branches', { name: 'M3M Golf Hills', ...SITE, radius_m: 300, geofence_mode: 'flag' });
  const csv = ['employee_id,name,branch,category,salary,weekly_off', 'SECPL/LAB/050,Aditya Kumar,M3M Golf Hills,Labour,600,2nd & 4th Sun'].join('\n');
  assert.equal((await admin('POST', '/api/admin/employees/import', { csv })).status, 200);
  const e = (await admin('GET', '/api/admin/employees')).data[0];
  assert.equal(e.weekly_offs, '0#2,0#4');
  s.clock.now = ist('2026-10-31', '20:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  const days = (await admin('GET', `/api/admin/attendance/${e.id}?month=2026-10`)).data.days;
  const st = (d) => days.find((x) => x.date === d).status;
  assert.deepEqual(['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25'].map(st), ['absent', 'week_off', 'absent', 'week_off']);
  // Admin form sends days + weeks
  assert.equal((await admin('PUT', `/api/admin/employees/${e.id}`, { ...e, salary: 600, weekly_offs: ['0#1', '0#3'] })).status, 200);
  assert.equal((await admin('GET', '/api/admin/employees')).data[0].weekly_offs, '0#1,0#3');
});
