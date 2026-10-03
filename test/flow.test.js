'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG, PDF } = require('./helpers');
const { weekday, monthDates } = require('../server/util');

const OFFICE = { lat: 19.076, lng: 72.8777 };
const FAR = { lat: 19.2, lng: 72.9 };

test('end-to-end: punches, overtime, leaves, documents and payroll', async (t) => {
  const s = await startServer(ist('2026-09-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  const staff = s.client();

  // First-run setup
  assert.equal((await admin('GET', '/api/admin/setup-status')).data.needs_setup, true);
  assert.equal((await admin('GET', '/api/admin/dashboard')).status, 401);
  let r = await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner', company_name: 'Acme' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin('POST', '/api/admin/setup', { username: 'x2', password: 'password123', name: 'X' })).status, 409);

  // Branches: one flag-mode, one block-mode
  r = await admin('POST', '/api/admin/branches', { name: 'Andheri', ...OFFICE, radius_m: 150, geofence_mode: 'flag' });
  const branchId = r.data.id;
  r = await admin('POST', '/api/admin/branches', { name: 'Thane', lat: 19.2183, lng: 72.9781, radius_m: 100, geofence_mode: 'block' });
  const strictBranch = r.data.id;

  // Employees
  r = await admin('POST', '/api/admin/employees', {
    code: 'E001', name: 'Ravi', branch_id: branchId, salary_type: 'monthly', salary: 30000,
    shift_start: '09:30', shift_end: '18:30', weekly_offs: ['0'], joined_on: '2026-09-01', pin: '1234',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const empId = r.data.id;
  r = await admin('POST', '/api/admin/employees', {
    code: 'E002', name: 'Sita', branch_id: strictBranch, salary_type: 'daily', salary: 800,
    shift_start: '09:00', shift_end: '17:00', weekly_offs: '0', joined_on: '2026-09-01', pin: '5678',
  });
  const strictEmp = r.data.id;
  assert.equal((await admin('POST', '/api/admin/employees', {
    code: 'e001', name: 'Dup', branch_id: branchId, salary_type: 'monthly', salary: 1, shift_start: '09:00', shift_end: '17:00', joined_on: '2026-09-01', pin: '1111',
  })).status, 409, 'employee codes are case-insensitively unique');

  // Login
  assert.equal((await staff('POST', '/api/employee/login', { code: 'E001', pin: '9999' })).status, 401);
  assert.equal((await staff('POST', '/api/employee/login', { code: 'e001', pin: '1234' })).status, 200);
  r = await staff('GET', '/api/employee/today');
  assert.deepEqual(r.data.allowed, ['IN', 'OT_IN']);

  // Day 1: on time, full day, 2h overtime
  s.clock.now = ist('2026-09-01', '09:28');
  r = await staff('POST', '/api/employee/punch', { kind: 'IN', ...OFFICE, accuracy: 12, selfie: JPEG });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'ok');
  assert.equal((await staff('POST', '/api/employee/punch', { kind: 'OUT', ...OFFICE, accuracy: 12, selfie: JPEG })).status, 409, 'double tap blocked');
  assert.equal((await staff('POST', '/api/employee/punch', { kind: 'OT_IN', ...OFFICE, accuracy: 12, selfie: JPEG })).status, 409, 'OT needs regular OUT first');
  assert.equal((await staff('POST', '/api/employee/punch', { kind: 'IN', ...OFFICE, accuracy: 12, selfie: 'data:image/png;base64,AAAA' })).status, 400);
  s.clock.now = ist('2026-09-01', '18:30');
  assert.equal((await staff('POST', '/api/employee/punch', { kind: 'OUT', ...OFFICE, accuracy: 12, selfie: JPEG })).status, 200);
  s.clock.now = ist('2026-09-01', '19:00');
  assert.equal((await staff('POST', '/api/employee/punch', { kind: 'OT_IN', ...OFFICE, accuracy: 12, selfie: JPEG })).status, 200);
  r = await staff('GET', '/api/employee/today');
  assert.deepEqual(r.data.allowed, ['OT_OUT']);
  s.clock.now = ist('2026-09-01', '21:00');
  assert.equal((await staff('POST', '/api/employee/punch', { kind: 'OT_OUT', ...OFFICE, accuracy: 12, selfie: JPEG })).status, 200);

  // Day 2: late, half day, punch OUT from far away (flag mode -> flagged, not blocked)
  s.clock.now = ist('2026-09-02', '10:00');
  await staff('POST', '/api/employee/punch', { kind: 'IN', ...OFFICE, accuracy: 300, selfie: JPEG });
  s.clock.now = ist('2026-09-02', '15:00');
  r = await staff('POST', '/api/employee/punch', { kind: 'OUT', ...FAR, accuracy: 10, selfie: JPEG });
  assert.equal(r.data.status, 'flagged');
  assert.match(r.data.flag_reason, /outside geofence/);

  // Block-mode branch refuses punches from outside
  const strict = s.client();
  await strict('POST', '/api/employee/login', { code: 'E002', pin: '5678' });
  r = await strict('POST', '/api/employee/punch', { kind: 'IN', ...FAR, accuracy: 10, selfie: JPEG });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /Punch from inside the branch/);

  // Selfie is stored encrypted and served to admin only
  const punchRes = await admin('GET', '/api/admin/punches?employee_id=' + empId);
  const punches = punchRes.data;
  assert.equal(punchRes.status, 200, JSON.stringify(punches));
  assert.equal(punches.length, 6);
  r = await admin('GET', `/api/admin/punches/${punches[0].id}/selfie`);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.data[0], 0xff);
  assert.equal((await strict('GET', `/api/employee/punches/${punches[0].id}/selfie`)).status, 404, 'cannot see other staff selfies');
  const flagged = (await admin('GET', '/api/admin/punches?status=flagged')).data;
  assert.equal(flagged.length, 2, 'low accuracy IN and far-away OUT');
  for (const p of flagged) assert.equal((await admin('POST', `/api/admin/punches/${p.id}/review`, { status: 'approved' })).status, 200);

  // Holiday, leave request, advance
  await admin('POST', '/api/admin/holidays', { date: '2026-09-03', name: 'Festival' });
  r = await staff('POST', '/api/employee/leaves', { from_date: '2026-09-04', to_date: '2026-09-04', leave_type: 'paid', reason: 'Family' });
  const leaveId = r.data.id;
  await admin('POST', `/api/admin/leaves/${leaveId}/decision`, { status: 'approved' });
  await admin('POST', '/api/admin/advances', { employee_id: empId, amount: 500, given_on: '2026-09-10', deduct_month: '2026-09' });
  await admin('POST', '/api/admin/adjustments', { employee_id: empId, month: '2026-09', kind: 'addition', amount: 250, label: 'Bonus' });

  // Attendance
  s.clock.now = ist('2026-10-02', '10:00');
  await admin('POST', '/api/admin/login', { username: 'owner', password: 'password123' });
  await staff('POST', '/api/employee/login', { code: 'E001', pin: '1234' });
  r = await staff('GET', '/api/employee/attendance?month=2026-09');
  const byDate = Object.fromEntries(r.data.days.map((d) => [d.date, d]));
  assert.equal(byDate['2026-09-01'].status, 'present');
  assert.equal(byDate['2026-09-01'].worked_minutes, 542);
  assert.equal(byDate['2026-09-01'].late_minutes, 0);
  assert.equal(byDate['2026-09-01'].ot_minutes, 120);
  assert.equal(byDate['2026-09-01'].ot_status, 'pending');
  assert.equal(byDate['2026-09-02'].status, 'half_day');
  assert.equal(byDate['2026-09-02'].late_minutes, 30);
  assert.equal(byDate['2026-09-03'].status, 'holiday');
  assert.equal(byDate['2026-09-04'].status, 'paid_leave');

  // Finalize blocked while OT is pending; approve it, then finalize
  r = await admin('POST', '/api/admin/payroll/2026-09/finalize', {});
  assert.equal(r.status, 409);
  assert.match(r.data.error, /overtime/);
  r = await admin('GET', '/api/admin/overtime?month=2026-09');
  assert.equal(r.data.rows.length, 1);
  await admin('POST', '/api/admin/overtime/decision', { employee_id: empId, date: '2026-09-01', status: 'approved' });

  // Manual correction: mark 2026-09-05 as present (e.g. forgot phone)
  await admin('PUT', '/api/admin/attendance/override', { employee_id: empId, date: '2026-09-05', status: 'present', note: 'Forgot phone' });

  r = await admin('GET', '/api/admin/payroll?month=2026-09');
  const row = r.data.rows.find((x) => x.employee_id === empId);
  const sundays = monthDates('2026-09').filter((d) => weekday(d) === 0 && d !== '2026-09-03' && d !== '2026-09-04' && d !== '2026-09-05').length;
  // present(1 + override 1) + half(0.5) + holiday(1) + paid leave(1) + Sundays
  const paidDays = 2 + 0.5 + 1 + 1 + sundays;
  assert.equal(row.paid_days, paidDays);
  assert.equal(row.base_paise, Math.round((3000000 / 30) * paidDays));
  assert.equal(row.ot_paise, Math.round((100000 / 9) * 2), 'OT at the same hourly rate: per-day / shift hours');
  assert.equal(row.net_paise, row.base_paise + row.ot_paise + 25000 - 50000);
  const sita = r.data.rows.find((x) => x.employee_id === strictEmp);
  assert.equal(sita.base_paise, 0, 'daily-wage employee with no attendance earns nothing');

  r = await admin('POST', '/api/admin/payroll/2026-09/finalize', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin('PUT', '/api/admin/attendance/override', { employee_id: empId, date: '2026-09-06', status: 'present' })).status, 409, 'finalized month is locked');

  // Employee sees payslip
  r = await staff('GET', '/api/employee/payslips');
  assert.deepEqual(r.data, [{ month: '2026-09', net_paise: row.net_paise }]);
  r = await staff('GET', '/api/employee/payslips/2026-09');
  assert.equal(r.data.company_name, 'Acme');

  // CSV exports
  r = await admin('GET', '/api/admin/payroll.csv?month=2026-09');
  assert.match(r.data.toString(), /E001,Ravi,Andheri,monthly/);
  r = await admin('GET', '/api/admin/attendance.csv?month=2026-09');
  assert.match(r.data.toString(), /E001,Ravi,Andheri,P,HD,H,PL,P/);

  // Documents: Aadhaar masked, file encrypted at rest and readable by admin
  r = await staff('POST', '/api/employee/documents', { doc_type: 'aadhaar', doc_number: '1234-5678-9012', file: PDF });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const docId = r.data.id;
  assert.equal((await staff('POST', '/api/employee/documents', { doc_type: 'pan', doc_number: 'ABCDE1234F', file: 'data:application/pdf;base64,' + Buffer.from('<html>').toString('base64') })).status, 400, 'content sniffing rejects fake PDFs');
  r = await staff('GET', '/api/employee/documents');
  assert.equal(r.data[0].doc_number, 'XXXX XXXX 9012');
  assert.ok(!('stored_file' in r.data[0]));
  r = await admin('GET', `/api/admin/documents/${docId}/file`);
  assert.equal(r.data.toString().slice(0, 5), '%PDF-');
  const raw = s.db.prepare('SELECT stored_file FROM documents WHERE id = ?').get(docId);
  assert.ok(raw.stored_file.endsWith('.bin'));
  const audit = (await admin('GET', '/api/admin/audit')).data;
  assert.ok(audit.some((a) => a.action === 'document.viewed'));

  // Employee cannot use admin APIs
  assert.equal((await staff('GET', '/api/admin/employees')).status, 401);
});

test('lockout after repeated wrong PINs', async (t) => {
  const s = await startServer(ist('2026-09-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  const b = await admin('POST', '/api/admin/branches', { name: 'HQ', ...OFFICE, radius_m: 150, geofence_mode: 'flag' });
  await admin('POST', '/api/admin/employees', {
    code: 'E9', name: 'A', branch_id: b.data.id, salary_type: 'hourly', salary: 100, shift_start: '09:00', shift_end: '17:00', joined_on: '2026-09-01', pin: '1234',
  });
  const staff = s.client();
  for (let i = 0; i < 5; i++) await staff('POST', '/api/employee/login', { code: 'E9', pin: '0000' });
  const r = await staff('POST', '/api/employee/login', { code: 'E9', pin: '1234' });
  assert.equal(r.status, 429);
  s.clock.now += 16 * 60 * 1000;
  assert.equal((await staff('POST', '/api/employee/login', { code: 'E9', pin: '1234' })).status, 200);
});

test('overnight shift: OUT after midnight counts for the day the shift started', async (t) => {
  const s = await startServer(ist('2026-09-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  const b = await admin('POST', '/api/admin/branches', { name: 'HQ', ...OFFICE, radius_m: 150, geofence_mode: 'flag' });
  await admin('POST', '/api/admin/employees', {
    code: 'N1', name: 'Night', branch_id: b.data.id, salary_type: 'hourly', salary: 100, shift_start: '22:00', shift_end: '06:00', weekly_offs: [], joined_on: '2026-09-01', pin: '1234',
  });
  const staff = s.client();
  await staff('POST', '/api/employee/login', { code: 'N1', pin: '1234' });
  s.clock.now = ist('2026-09-01', '22:00');
  await staff('POST', '/api/employee/punch', { kind: 'IN', ...OFFICE, accuracy: 10, selfie: JPEG });
  s.clock.now = ist('2026-09-02', '06:00');
  await staff('POST', '/api/employee/punch', { kind: 'OUT', ...OFFICE, accuracy: 10, selfie: JPEG });
  const r = await staff('GET', '/api/employee/attendance?month=2026-09');
  const d1 = r.data.days.find((d) => d.date === '2026-09-01');
  assert.equal(d1.status, 'present');
  assert.equal(d1.worked_minutes, 480);
  assert.equal(r.data.days.find((d) => d.date === '2026-09-02').status, 'not_marked');
  const pay = (await admin('GET', '/api/admin/payroll?month=2026-09')).data.rows[0];
  assert.equal(pay.base_paise, 80000, '8 hours x Rs 100');
});
