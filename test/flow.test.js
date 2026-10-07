'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG, PDF } = require('./helpers');
const { weekday, monthDates } = require('../server/util');

const OFFICE = { lat: 19.076, lng: 72.8777 };
const FAR = { lat: 19.2, lng: 72.9 };

test('end-to-end: punches, leaves, documents and payroll', async (t) => {
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
    code: 'E002', name: 'Sita', branch_id: strictBranch, salary_type: 'monthly', salary: 24000,
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
  assert.deepEqual(r.data.allowed, ['IN']);

  // Day 1: on time, full day (overtime punches no longer exist)
  s.clock.now = ist('2026-09-01', '09:28');
  r = await staff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...OFFICE, accuracy: 12, selfie: JPEG });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'ok');
  assert.equal((await staff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'OUT', ...OFFICE, accuracy: 12, selfie: JPEG })).status, 409, 'double tap blocked');
  assert.equal((await staff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'OT_IN', ...OFFICE, accuracy: 12, selfie: JPEG })).status, 400, 'overtime removed');
  assert.equal((await staff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...OFFICE, accuracy: 12, selfie: 'data:image/png;base64,AAAA' })).status, 400);
  s.clock.now = ist('2026-09-01', '18:30');
  assert.equal((await staff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'OUT', ...OFFICE, accuracy: 12, selfie: JPEG })).status, 200);
  r = await staff('GET', '/api/employee/today');
  assert.deepEqual(r.data.allowed, ['IN']);

  // Day 2: late, half day, punch OUT from far away (flag mode -> flagged, not blocked)
  s.clock.now = ist('2026-09-02', '10:00');
  await staff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...OFFICE, accuracy: 300, selfie: JPEG });
  s.clock.now = ist('2026-09-02', '15:00');
  r = await staff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'OUT', ...FAR, accuracy: 10, selfie: JPEG });
  assert.equal(r.data.status, 'flagged');
  assert.match(r.data.flag_reason, /outside geofence/);

  // Block-mode branch refuses punches from outside
  const strict = s.client();
  await strict('POST', '/api/employee/login', { code: 'E002', pin: '5678' });
  r = await strict('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...FAR, accuracy: 10, selfie: JPEG });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /Punch from inside one of your sites/);

  // Selfie is stored encrypted and served to admin only
  const punchRes = await admin('GET', '/api/admin/punches?employee_id=' + empId);
  const punches = punchRes.data;
  assert.equal(punchRes.status, 200, JSON.stringify(punches));
  assert.equal(punches.length, 4);
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
  assert.equal(byDate['2026-09-02'].status, 'half_day');
  assert.equal(byDate['2026-09-02'].late_minutes, 30);
  assert.equal(byDate['2026-09-03'].status, 'holiday');
  assert.equal(byDate['2026-09-04'].status, 'paid_leave');


  // Manual correction: mark 2026-09-05 as present (e.g. forgot phone)
  await admin('PUT', '/api/admin/attendance/override', { employee_id: empId, date: '2026-09-05', status: 'present', note: 'Forgot phone' });

  r = await admin('GET', '/api/admin/payroll?month=2026-09');
  const row = r.data.rows.find((x) => x.employee_id === empId);
  const sundays = monthDates('2026-09').filter((d) => weekday(d) === 0 && d !== '2026-09-03' && d !== '2026-09-04' && d !== '2026-09-05').length;
  // present(1 + override 1) + half(0.5) + holiday(1) + paid leave(1) + Sundays
  const paidDays = 2 + 0.5 + 1 + 1 + sundays;
  assert.equal(row.paid_days, paidDays);
  assert.equal(row.base_paise, Math.round((3000000 / 30) * paidDays));
  assert.equal(row.ot_paise, undefined, 'no overtime pay');
  assert.ok(row.late_minutes > 0);
  assert.equal(row.net_paise, row.base_paise + 25000 - 50000);
  const sita = r.data.rows.find((x) => x.employee_id === strictEmp);
  assert.equal(sita.attendance.present, 0, 'no attendance: only week offs / holidays are paid');
  assert.equal(sita.paid_days, sita.attendance.week_off + sita.attendance.holiday);

  r = await admin('POST', '/api/admin/payroll/2026-09/finalize', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin('PUT', '/api/admin/attendance/override', { employee_id: empId, date: '2026-09-06', status: 'present' })).status, 409, 'finalized month is locked');

  // Salary before the "visible from" month (default Oct 2026) is hidden from staff
  assert.deepEqual((await staff('GET', '/api/employee/payslips')).data, []);
  assert.equal((await staff('GET', '/api/employee/payslips/2026-09')).status, 404);
  assert.match((await staff('GET', '/api/employee/salary?month=2026-09')).data.error, /available from October 2026/);
  await admin('PUT', '/api/admin/settings', { salary_visible_from: '2026-09' });

  // Employee sees payslip
  r = await staff('GET', '/api/employee/payslips');
  assert.deepEqual(r.data, [{ month: '2026-09', net_paise: row.net_paise }]);
  r = await staff('GET', '/api/employee/payslips/2026-09');
  assert.equal(r.data.company_name, 'Acme');

  // CSV exports
  r = await admin('GET', '/api/admin/payroll.csv?month=2026-09');
  assert.match(r.data.toString(), /E001,Ravi,Andheri,30000.00,/);
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
    code: 'E9', name: 'A', branch_id: b.data.id, salary_type: 'monthly', salary: 30000, shift_start: '09:00', shift_end: '17:00', joined_on: '2026-09-01', pin: '1234',
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
    code: 'N1', name: 'Night', branch_id: b.data.id, salary_type: 'monthly', salary: 30000, shift_start: '22:00', shift_end: '06:00', weekly_offs: [], joined_on: '2026-09-01', pin: '1234',
  });
  const staff = s.client();
  await staff('POST', '/api/employee/login', { code: 'N1', pin: '1234' });
  s.clock.now = ist('2026-09-01', '22:00');
  await staff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...OFFICE, accuracy: 10, selfie: JPEG });
  s.clock.now = ist('2026-09-02', '06:00');
  await staff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'OUT', ...OFFICE, accuracy: 10, selfie: JPEG });
  const r = await staff('GET', '/api/employee/attendance?month=2026-09');
  const d1 = r.data.days.find((d) => d.date === '2026-09-01');
  assert.equal(d1.status, 'present');
  assert.equal(d1.worked_minutes, 480);
  assert.equal(r.data.days.find((d) => d.date === '2026-09-02').status, 'not_marked');
  const pay = (await admin('GET', '/api/admin/payroll?month=2026-09')).data.rows[0];
  assert.equal(pay.attendance.present, 1);
});

test('late rules: every 3rd late is a half day; over 1 hour late goes to the admin instead', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  const settings = (await admin('GET', '/api/admin/settings')).data;
  assert.equal(settings.company_name, 'Sanitech');
  assert.equal(settings.grace_minutes, 15);
  assert.equal(settings.late_warnings, 2);
  assert.equal(settings.late_max_minutes, 60);
  const b = await admin('POST', '/api/admin/branches', { name: 'HQ', ...OFFICE, radius_m: 150, geofence_mode: 'flag' });
  const emp = await admin('POST', '/api/admin/employees', {
    code: 'D1', name: 'Default', branch_id: b.data.id, salary_type: 'monthly', salary: 31000, shift_start: '09:00', shift_end: '18:00', weekly_offs: ['0'], joined_on: '2026-09-01', pin: '1234',
  });
  const staff = s.client();
  await staff('POST', '/api/employee/login', { code: 'D1', pin: '1234' });
  const punch = async (date, time, kind) => {
    s.clock.now = ist(date, time);
    const r = await staff('POST', '/api/employee/punch', { note: 'Client office',  kind, ...OFFICE, accuracy: 10, selfie: JPEG });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const day = async (date, inAt, outAt) => {
    const r = await punch(date, inAt, 'IN');
    await punch(date, outAt, 'OUT');
    return r;
  };

  assert.equal((await day('2026-10-01', '09:14', '18:00')).late, null, 'within grace');
  let r = await day('2026-10-02', '09:20', '18:00');
  assert.deepEqual(r.late, { minutes: 20, mark: 1, every: 3, half_day: false, month_days: 1, month_minutes: 20 });
  await day('2026-10-03', '09:40', '18:00');                    // late #2
  r = await day('2026-10-05', '09:16', '18:05');                // late #3 -> half day
  assert.deepEqual(r.late, { minutes: 16, mark: 3, every: 3, half_day: true, month_days: 3, month_minutes: 20 + 40 + 16 });
  await day('2026-10-06', '09:30', '18:00');                    // late #4 -> warning again
  await day('2026-10-07', '09:30', '18:00');                    // late #5
  await day('2026-10-08', '09:30', '18:00');                    // late #6 -> half day
  r = await day('2026-10-09', '10:30', '18:00');                // 90 min late -> admin decides
  assert.deepEqual(r.late, { minutes: 90, review: true, month_days: 7, month_minutes: 256 });
  await day('2026-10-10', '10:05', '18:00');                    // 65 min late -> admin decides
  await day('2026-10-12', '09:20', '18:00');                    // late #7 (very-late days are not counted)

  const get = async () => Object.fromEntries((await staff('GET', '/api/employee/attendance?month=2026-10')).data.days.map((x) => [x.date.slice(8), x]));
  let d = await get();
  assert.equal(d['01'].status, 'present');
  assert.equal(d['02'].status, 'present');
  assert.ok(d['02'].flags.includes('late_warning'));
  assert.equal(d['03'].status, 'present');
  assert.equal(d['05'].status, 'half_day', '3rd late');
  assert.ok(d['05'].flags.includes('late_penalty'));
  assert.equal(d['06'].status, 'present', '4th late is a warning');
  assert.equal(d['07'].status, 'present');
  assert.equal(d['08'].status, 'half_day', '6th late');
  assert.equal(d['09'].late_review, 'pending');
  assert.ok(d['09'].flags.includes('late_approval'));
  assert.equal(d['09'].late_mark, null, 'very late days are not in the every-3rd count');
  assert.equal(d['12'].late_mark, 7);
  assert.equal(d['12'].status, 'present');

  // Admin sees both very-late days and decides
  s.clock.now = ist('2026-10-12', '19:00');
  await admin('POST', '/api/admin/login', { username: 'owner', password: 'password123' });
  assert.equal((await admin('GET', '/api/admin/pending')).data.late_approvals, 2);
  r = await admin('GET', '/api/admin/late-approvals?month=2026-10');
  assert.deepEqual(r.data.rows.map((x) => [x.date, x.late_review]), [['2026-10-10', 'pending'], ['2026-10-09', 'pending']]);
  await admin('POST', '/api/admin/late-approvals/decision', { employee_id: emp.data.id, date: '2026-10-09', status: 'present' });
  await admin('POST', '/api/admin/late-approvals/decision', { employee_id: emp.data.id, date: '2026-10-10', status: 'half_day' });
  assert.equal((await admin('GET', '/api/admin/pending')).data.late_approvals, 0);
  d = await get();
  assert.equal(d['09'].status, 'present', 'admin granted a full day');
  assert.equal(d['09'].late_review, 'present');
  assert.equal(d['10'].status, 'half_day', 'admin gave a half day');
  assert.ok(!d['09'].flags.includes('late_approval'));

  // Undecided very-late days count from the hours worked (stayed till 18:00 = full day) and don't hold up payroll
  await admin('POST', '/api/admin/late-approvals/decision', { employee_id: emp.data.id, date: '2026-10-10', status: null });
  d = await get();
  assert.equal(d['10'].status, 'present', 'over 1 hour late but stayed until shift end: full day until reviewed');
  assert.equal(d['10'].late_review, 'pending');
  s.clock.now = ist('2026-11-02', '10:00');
  await admin('POST', '/api/admin/login', { username: 'owner', password: 'password123' });
  r = await admin('POST', '/api/admin/payroll/2026-10/finalize', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test('bulk mark: 1-3 October present for everyone', async (t) => {
  const s = await startServer(ist('2026-10-04', '10:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  const b = await admin('POST', '/api/admin/branches', { name: 'HQ', ...OFFICE, radius_m: 150, geofence_mode: 'flag' });
  for (const [code, joined] of [['A1', ''], ['A2', '2026-10-02']]) {
    await admin('POST', '/api/admin/employees', { code, name: code, branch_id: b.data.id, salary_type: 'monthly', salary: 31000, shift_start: '09:00', shift_end: '18:00', weekly_offs: ['0'], joined_on: joined, pin: '1234' });
  }
  const r = await admin('POST', '/api/admin/attendance/bulk-override', { from: '2026-10-01', to: '2026-10-04', status: 'present', note: 'Before app went live' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { ok: true, employees: 2, days: 5 }, 'Sunday 4th skipped; A2 only from joining');
  const reg = (await admin('GET', '/api/admin/attendance?month=2026-10')).data.rows;
  const a1 = reg.find((x) => x.code === 'A1').days;
  assert.deepEqual(a1.slice(0, 4).map((x) => x.status), ['present', 'present', 'present', 'week_off']);
  assert.equal(a1[0].override.note, 'Before app went live');
  assert.equal((await admin('POST', '/api/admin/attendance/bulk-override', { from: '2026-10-01', to: '2026-12-01', status: 'present' })).status, 400);
});

test('everyone is paid monthly: other salary types are refused', async (t) => {
  const s = await startServer(ist('2026-09-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });
  const b = await admin('POST', '/api/admin/branches', { name: 'HQ', ...OFFICE, radius_m: 150, geofence_mode: 'flag' });
  const base = { branch_id: b.data.id, salary: 100, weekly_offs: [], joined_on: '', pin: '1234' };
  let r = await admin('POST', '/api/admin/employees', { ...base, code: 'H1', name: 'H', salary_type: 'hourly' });
  assert.equal(r.status, 400);
  r = await admin('POST', '/api/admin/employees', { ...base, code: 'M1', name: 'M', salary: 30000 });
  assert.equal(r.status, 200);
  assert.equal((await admin('GET', '/api/admin/employees')).data[0].salary_type, 'monthly');
});
