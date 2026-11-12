'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, ist, JPEG } = require('./helpers');
const { openDb } = require('../server/db');

test('upgrade gives the attendance permission to firefueled and amitsharma only', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'a.db');
  let db = openDb(file);
  for (const u of ['owner', 'firefueled', 'amit.sharma', 'someone']) {
    db.prepare("INSERT INTO admins (username, name, password_hash, created_at) VALUES (?, ?, 'x', 1)").run(u, u);
  }
  db.exec('ALTER TABLE admins DROP COLUMN can_edit_attendance'); // simulate a database from before this feature
  db.close();
  db = openDb(file);
  assert.deepEqual(db.prepare('SELECT username FROM admins WHERE can_edit_attendance = 1 ORDER BY id').all().map((a) => a.username), ['firefueled', 'amit.sharma']);
  db.close();
});

test('staff only ever see their own records: no team view, no other people\'s selfies, documents or visits', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const site = await admin('POST', '/api/admin/branches', { name: 'M3M Golf Hills', lat: 28.4, lng: 77.0, radius_m: 300, geofence_mode: 'flag', field_visits: true });
  const mk = async (code, extra = {}) => (await admin('POST', '/api/admin/employees', {
    code, name: code, branch_id: site.data.id, salary_type: 'monthly', salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234', ...extra,
  })).data.id;
  // Even if the old "manager" option is sent, nobody becomes a manager any more
  const mgrId = await mk('MGR', { is_manager: true, manager_scope: 'all' });
  await mk('MEM');
  assert.equal((await admin('GET', '/api/admin/employees')).data.find((e) => e.id === mgrId).is_manager, 0);
  // ...and anyone who already was one is switched off on start-up
  s.db.prepare('UPDATE employees SET is_manager = 1 WHERE id = ?').run(mgrId);
  require('../server/db').openDb(require('node:path').join(s.dataDir, 'attendance.db')).close();
  assert.equal(s.db.prepare('SELECT is_manager FROM employees WHERE id = ?').get(mgrId).is_manager, 0);

  const login = async (code) => { const c = s.client(); await c('POST', '/api/employee/login', { code, pin: '1234' }); return c; };
  const mgr = await login('MGR');
  const mem = await login('MEM');
  s.clock.now = ist('2026-10-05', '09:00');
  const p = (await mem('POST', '/api/employee/punch', { kind: 'IN', lat: 28.45, lng: 77.0, accuracy: 10, selfie: JPEG, note: 'Client office' })).data;
  const doc = (await mem('POST', '/api/employee/documents', { doc_type: 'photo', file: JPEG })).data;
  s.clock.now = ist('2026-10-05', '11:00');
  const v = (await mem('POST', '/api/employee/visit', { lat: 28.45, lng: 77.0, accuracy: 10, selfie: JPEG, note: 'HDFC Bank' })).data;
  assert.ok(p.id && doc.id && v.id, JSON.stringify([p, doc, v]));

  // The team view is gone
  for (const url of ['/api/employee/team', `/api/employee/team/punches/${p.id}/selfie`]) assert.equal((await mgr('GET', url)).status, 404, url);
  assert.equal((await mgr('POST', '/api/employee/team/verify', { kind: 'punch', punch_id: p.id, verdict: 'ok' })).status, 404);
  // Another employee's selfie, document or visit can't be opened by its number
  assert.equal((await mgr('GET', `/api/employee/punches/${p.id}/selfie`)).status, 404);
  assert.equal((await mgr('GET', `/api/employee/documents/${doc.id}/file`)).status, 404);
  assert.equal((await mgr('GET', `/api/employee/visits/${v.id}/selfie`)).status, 404);
  assert.equal((await mem('GET', `/api/employee/punches/${p.id}/selfie`)).status, 200, 'their own is fine');
  // Lists only ever contain their own records
  assert.deepEqual((await mgr('GET', '/api/employee/documents')).data, []);
  assert.equal((await mgr('GET', '/api/employee/today')).data.punches.length, 0);
  // No admin powers either
  assert.equal((await mgr('GET', '/api/admin/employees')).status, 401);
});

test('payroll login: changes pay, corrects attendance, decides leaves, nothing else', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const owner = s.client();
  await owner('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await owner('POST', '/api/admin/branches', { name: 'HO', lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const emp = (await owner('POST', '/api/admin/employees', { code: 'E1', name: 'Ravi', branch_id: b, salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234' })).data.id;
  assert.equal((await owner('POST', '/api/admin/admins', { username: 'accounts', password: 'password123', name: 'Suresh', role: 'salary' })).status, 200);
  const acc = s.client();
  assert.equal((await acc('POST', '/api/admin/login', { username: 'accounts', password: 'password123' })).status, 200);
  assert.equal((await acc('GET', '/api/admin/me')).data.admin.role, 'salary');

  // Pay: salary, PF / allowances, advances, bonus & deductions, the salary sheet
  assert.equal((await acc('PUT', `/api/admin/employees/${emp}/salary`, { salary: 32000 })).status, 200);
  assert.equal((await acc('GET', '/api/admin/employees')).data[0].salary_paise, 3200000);
  assert.equal((await acc('PUT', `/api/admin/employees/${emp}/salary`, { salary: 0 })).status, 400);
  assert.equal((await acc('POST', `/api/admin/employees/${emp}/pay-items`, { kind: 'deduction', label: 'PF', amount: 1800 })).status, 200);
  assert.equal((await acc('POST', '/api/admin/adjustments', { employee_id: emp, month: '2026-10', kind: 'addition', label: 'Bonus', amount: 500 })).status, 200);
  for (const url of ['/api/admin/payroll?month=2026-10', '/api/admin/payroll.csv?month=2026-10', '/api/admin/advances?month=2026-10', '/api/admin/adjustments?month=2026-10']) {
    assert.equal((await acc('GET', url)).status, 200, url);
  }
  // View: attendance and leaves
  for (const url of ['/api/admin/attendance?month=2026-10', `/api/admin/attendance/${emp}?month=2026-10`, '/api/admin/attendance.csv?month=2026-10',
    '/api/admin/half-days?month=2026-10', '/api/admin/late-ot?month=2026-10', '/api/admin/leaves', '/api/admin/leave-summary']) {
    assert.equal((await acc('GET', url)).status, 200, url);
  }
  // Attendance corrections and leave decisions
  assert.equal((await acc('PUT', '/api/admin/attendance/override', { employee_id: emp, date: '2026-10-05', status: 'present', note: 'checked' })).status, 200);
  assert.equal((await acc('POST', '/api/admin/punches/fix-order', { employee_id: emp, month: '2026-10' })).status, 200);
  const ravi = s.client(); await ravi('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  const leave = (await ravi('POST', '/api/employee/leaves', { from_date: '2026-10-07', to_date: '2026-10-07', leave_type: 'paid', reason: 'family' })).data;
  assert.equal((await acc('POST', `/api/admin/leaves/${leave.id}/decision`, { status: 'approved' })).status, 200);
  assert.equal((await owner('GET', '/api/admin/leaves')).data[0].status, 'approved');
  // Nothing else: other changes to employees, finalizing, selfies, documents, settings, admins
  const denied = [
    ['PUT', `/api/admin/employees/${emp}`, { code: 'E1', name: 'Changed', branch_id: b, salary: 99999 }],
    ['POST', '/api/admin/employees', { code: 'E2', name: 'New', branch_id: b, salary: 1, pin: '1234' }],
    ['DELETE', `/api/admin/employees/${emp}`],
    ['POST', `/api/admin/employees/${emp}/reset-pin`, {}],
    ['POST', '/api/admin/payroll/2026-09/finalize', {}],
    ['GET', '/api/admin/punches'], ['GET', '/api/admin/documents'], ['GET', '/api/admin/visits'], ['GET', '/api/admin/dashboard'],
    ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings', { company_name: 'X' }], ['GET', '/api/admin/admins'],
    ['POST', '/api/admin/admins', { username: 'sneaky', password: 'password123', name: 'S' }], ['GET', '/api/admin/audit'],
  ];
  for (const [m, url, body] of denied) assert.equal((await acc(m, url, body)).status, 403, `${m} ${url}`);
  assert.equal((await owner('GET', '/api/admin/employees')).data[0].name, 'Ravi');

  // The owner can switch the login between full and payroll; a payroll login always includes attendance
  const id = (await owner('GET', '/api/admin/admins')).data.find((a) => a.username === 'accounts').id;
  assert.equal((await owner('GET', '/api/admin/admins')).data.find((a) => a.id === id).can_edit_attendance, 1);
  assert.equal((await owner('PUT', `/api/admin/admins/${id}/permissions`, { can_edit_attendance: false })).status, 400);
  assert.equal((await owner('PUT', `/api/admin/admins/${id}/permissions`, { role: 'full' })).status, 200);
  assert.equal((await acc('GET', '/api/admin/settings')).status, 200);
  // ...and the last full admin can't be limited
  const me = (await owner('GET', '/api/admin/admins')).data.find((a) => a.username === 'firefueled').id;
  assert.equal((await owner('PUT', `/api/admin/admins/${me}/permissions`, { role: 'salary' })).status, 400);
});

test('payroll access lent to an existing employee: own staff login, revoked in one click', async (t) => {
  const s = await startServer(ist('2026-11-10', '08:00'));
  t.after(() => s.close());
  const owner = s.client();
  await owner('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await owner('POST', '/api/admin/branches', { name: 'HO', lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const suresh = (await owner('POST', '/api/admin/employees', { code: 'SECPL0031', name: 'Suresh', branch_id: b, salary: 25000, weekly_offs: ['0'], joined_on: '', pin: '4321' })).data.id;
  const ravi = (await owner('POST', '/api/admin/employees', { code: 'SECPL0032', name: 'Ravi', branch_id: b, salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234' })).data.id;

  const staff = s.client();
  await staff('POST', '/api/employee/login', { code: 'SECPL0031', pin: '4321' });
  assert.equal((await staff('GET', '/api/employee/me')).data.payroll_access, false);
  assert.equal((await staff('POST', '/api/employee/payroll-session')).status, 403, 'not before access is given');
  assert.equal((await staff('GET', '/api/admin/employees')).status, 401);

  // The owner gives Suresh payroll access
  assert.equal((await owner('POST', '/api/admin/admins/employee', { employee_id: suresh })).status, 200);
  assert.equal((await owner('POST', '/api/admin/admins/employee', { employee_id: suresh })).status, 409);
  const row = (await owner('GET', '/api/admin/admins')).data.find((a) => a.employee_id === suresh);
  assert.deepEqual([row.role, row.employee_code, row.name], ['salary', 'SECPL0031', 'Suresh']);

  // He opens it from his staff app with his existing login — no new password
  assert.equal((await staff('GET', '/api/employee/me')).data.payroll_access, true);
  assert.equal((await staff('POST', '/api/employee/payroll-session')).status, 200);
  assert.equal((await staff('GET', '/api/admin/me')).data.admin.name, 'Suresh');
  assert.equal((await staff('PUT', `/api/admin/employees/${ravi}/salary`, { salary: 31000 })).status, 200);
  assert.equal((await staff('GET', '/api/admin/attendance?month=2026-11')).status, 200);
  assert.equal((await staff('GET', '/api/admin/punches')).status, 403, 'payroll only');
  assert.equal((await staff('GET', '/api/employee/today')).status, 200, 'his staff app still works');
  // It stays payroll-only, and has no password of its own
  assert.equal((await owner('PUT', `/api/admin/admins/${row.id}/permissions`, { role: 'full' })).status, 400);
  assert.equal((await owner('POST', `/api/admin/admins/${row.id}/password`, { new_password: 'password123', password: 'password123' })).status, 400);

  // Revoked in one click: logged out of payroll at once, staff app unaffected
  assert.equal((await owner('DELETE', `/api/admin/admins/${row.id}`)).status, 200);
  assert.equal((await staff('GET', '/api/admin/employees')).status, 401);
  assert.equal((await staff('POST', '/api/employee/payroll-session')).status, 403);
  assert.equal((await staff('GET', '/api/employee/me')).data.payroll_access, false);
  assert.equal((await staff('GET', '/api/employee/today')).status, 200);
  // The salary change he made stays, and is in the audit log
  assert.equal((await owner('GET', '/api/admin/employees')).data.find((e) => e.id === ravi).salary_paise, 3100000);
  const log = (await owner('GET', '/api/admin/audit')).data;
  assert.ok(log.some((l) => l.action === 'employee.salary_changed' && l.actor_name === 'Suresh'));
  assert.ok(log.some((l) => l.action === 'admin.payroll_access_revoked'));

  // Deactivating the employee also ends payroll access
  await owner('POST', '/api/admin/admins/employee', { employee_id: suresh });
  await staff('POST', '/api/employee/payroll-session');
  assert.equal((await staff('GET', '/api/admin/me')).status, 200);
  s.db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(suresh);
  assert.equal((await staff('GET', '/api/admin/me')).status, 401);
});

test('admins and payroll logins type in staff details (mobile, Aadhaar, PAN, bank / UPI)', async (t) => {
  const s = await startServer(ist('2026-11-12', '08:00'));
  t.after(() => s.close());
  const owner = s.client();
  await owner('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await owner('POST', '/api/admin/branches', { name: 'HO', lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const emp = (await owner('POST', '/api/admin/employees', { code: 'E1', name: 'Ravi', branch_id: b, salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234' })).data.id;
  const missing = async () => (await owner('GET', '/api/admin/employees')).data[0].profile_missing;
  assert.deepEqual(await missing(), ['phone', 'aadhaar', 'pan', 'payment']);

  await owner('POST', '/api/admin/admins', { username: 'accounts', password: 'password123', name: 'Suresh', role: 'salary' });
  const acc = s.client();
  await acc('POST', '/api/admin/login', { username: 'accounts', password: 'password123' });
  assert.equal((await acc('PUT', `/api/admin/employees/${emp}/details`, { pan_no: 'ABC123' })).status, 400, 'PAN format checked');
  let r = await acc('PUT', `/api/admin/employees/${emp}/details`, { phone: '9876543210', aadhaar_no: '1234 5678 9012', pan_no: 'abcde1234f' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.profile_missing, ['payment']);
  r = await acc('PUT', `/api/admin/employees/${emp}/details`, { bank_account: '50100461244161', bank_ifsc: 'hdfc0004277' });
  assert.deepEqual(r.data.profile_missing, []);
  const e = (await owner('GET', '/api/admin/employees')).data[0];
  assert.deepEqual([e.phone, e.aadhaar_no, e.pan_no, e.bank_account, e.bank_ifsc], ['9876543210', 'XXXX XXXX 9012', 'ABCDE1234F', '50100461244161', 'HDFC0004277']);
  // The staff member's app no longer asks for them
  const staff = s.client(); await staff('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  assert.deepEqual((await staff('GET', '/api/employee/me')).data.profile_missing, []);
  // Admins can type the PAN on the employee form too
  assert.equal((await owner('PUT', `/api/admin/employees/${emp}`, { ...e, weekly_offs: ['0'], salary: 30000, pan_no: 'PQRSX6789K' })).status, 200);
  assert.equal((await owner('GET', '/api/admin/employees')).data[0].pan_no, 'PQRSX6789K');
  assert.ok((await owner('GET', '/api/admin/audit')).data.some((l) => l.action === 'employee.details_entered' && l.actor_name === 'Suresh'));
});
