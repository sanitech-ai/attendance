'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };
const HOME = { lat: 17.45, lng: 78.48 }; // ~6 km away

test('punching out away from the site long after shift end counts as a half day', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  assert.equal((await admin('GET', '/api/admin/settings')).data.late_out_minutes, 30);
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { branch_id: b, salary: 30000, weekly_offs: [], pin: '1234', code: 'A1', name: 'Asha', joined_on: '' })).data.id;
  const a = s.client();
  await a('POST', '/api/employee/login', { code: 'A1', pin: '1234' });
  const punch = async (date, time, kind, where = HQ) => {
    s.clock.now = ist(date, time);
    const r = await a('POST', '/api/employee/punch', { kind, ...where, accuracy: 10, selfie: JPEG, note: where === HQ ? '' : 'forgot to punch out' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };

  await punch('2026-10-01', '09:00', 'IN'); await punch('2026-10-01', '18:00', 'OUT'); // first day on the app
  // Left early, punched out from home at 21:00
  await punch('2026-10-02', '09:00', 'IN');
  s.clock.now = ist('2026-10-02', '17:50');
  const today = (await a('GET', '/api/employee/today')).data;
  assert.equal(today.late_out_after, ist('2026-10-02', '18:30'));
  const out = await punch('2026-10-02', '21:00', 'OUT', HOME);
  assert.deepEqual(out.late_out, { minutes: 180, shift_end: '18:00' });
  // Punched out from a client office 20 minutes after the shift: within the 30 minutes, counts normally
  await punch('2026-10-03', '09:00', 'IN'); assert.equal((await punch('2026-10-03', '18:20', 'OUT', HOME)).late_out, null);
  // Stayed late at the site: real time counts
  await punch('2026-10-05', '09:00', 'IN'); await punch('2026-10-05', '21:00', 'OUT');
  // Even if the admin approves that punch, it stays a half day (no exceptions — corrected only in the register)
  await punch('2026-10-06', '09:00', 'IN'); const approved = await punch('2026-10-06', '20:00', 'OUT', HOME);

  s.clock.now = ist('2026-10-07', '08:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  assert.equal((await admin('POST', `/api/admin/punches/${approved.id}/review`, { status: 'approved' })).status, 200);
  const days = Object.fromEntries((await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days.map((d) => [d.date.slice(8), d]));
  assert.equal(days['02'].status, 'half_day', 'punched out from home 3 hours after shift');
  assert.ok(days['02'].flags.includes('late_out'));
  assert.equal(days['02'].late_out.minutes, 180);
  assert.equal(days['03'].status, 'present');
  assert.equal(days['05'].status, 'present', 'at the site: real time counts');
  assert.equal(days['06'].status, 'half_day', 'approving the punch does not change it');
  assert.match(days['02'].half_day_reasons[0].text, /^Punched out at 21:00 away from the site \(6\.\d+ km away\), 3h after the shift ended \(18:00\) — “forgot to punch out”$/);

  const row = (await admin('GET', '/api/admin/late-ot?month=2026-10')).data.rows[0];
  assert.deepEqual(row.late_out.map((l) => [l.date, l.last_out]), [['2026-10-02', '21:00'], ['2026-10-06', '20:00']]);
  assert.match(String((await admin('GET', '/api/admin/late-ot.csv?month=2026-10')).data), /02 \(out 21:00\)/);
  const staff = (await a('GET', '/api/employee/attendance?month=2026-10')).data;
  assert.equal(staff.summary.late_out_days, 2);

  // The admin can change the allowance
  assert.equal((await admin('PUT', '/api/admin/settings', { late_out_minutes: 240 })).status, 200);
  const again = (await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days.find((d) => d.date === '2026-10-02');
  assert.equal(again.status, 'present', '3 hours is within a 4-hour allowance');
});

test('punching in from home counts only if approved; punching in again at the site starts the day there', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { branch_id: b, salary: 30000, weekly_offs: [], pin: '1234', code: 'A1', name: 'Asha', joined_on: '' })).data.id;
  const a = s.client();
  await a('POST', '/api/employee/login', { code: 'A1', pin: '1234' });
  const punch = async (date, time, kind, where = HQ) => {
    s.clock.now = ist(date, time);
    return a('POST', '/api/employee/punch', { kind, ...where, accuracy: 10, selfie: JPEG, note: where === HQ ? '' : 'on the way' });
  };
  const ok = async (...args) => { const r = await punch(...args); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };

  await ok('2026-10-01', '09:00', 'IN'); await ok('2026-10-01', '18:00', 'OUT'); // first day on the app
  // 02: punched in from home at 08:50, never at the site -> half day
  await ok('2026-10-02', '08:50', 'IN', HOME);
  s.clock.now = ist('2026-10-02', '09:30');
  assert.ok((await a('GET', '/api/employee/today')).data.away_in, 'offered to punch in again at the site');
  await ok('2026-10-02', '18:00', 'OUT');
  // 03: punched in from home at 08:50, reached the site at 09:40 and punched in again there
  const home = await ok('2026-10-03', '08:50', 'IN', HOME);
  s.clock.now = ist('2026-10-03', '09:10');
  assert.equal((await punch('2026-10-03', '09:10', 'IN', HOME)).status, 400, 'still not at the site');
  const site = await ok('2026-10-03', '09:40', 'IN');
  assert.equal(site.late.minutes, 40, 'late counted from the punch at the site');
  assert.equal((await a('GET', '/api/employee/today')).data.away_in, null);
  await ok('2026-10-03', '18:00', 'OUT');
  // 05: genuine bank visit in the morning, approved by the admin
  const bank = await ok('2026-10-05', '09:00', 'IN', HOME); await ok('2026-10-05', '18:00', 'OUT');
  // A normal Punch In at the site can't be repeated
  await ok('2026-10-06', '09:00', 'IN');
  assert.equal((await punch('2026-10-06', '09:05', 'IN')).status, 409);

  s.clock.now = ist('2026-10-07', '08:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  await admin('POST', `/api/admin/punches/${bank.id}/review`, { status: 'approved' });
  const days = Object.fromEntries((await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days.map((d) => [d.date.slice(8), d]));
  assert.equal(days['02'].status, 'half_day', 'punched in from home, not approved');
  assert.ok(days['02'].flags.includes('offsite_in'));
  assert.equal(days['03'].first_in, '09:40', 'the day starts at the site punch');
  assert.equal(days['03'].late_minutes, 40);
  assert.equal(days['03'].offsite_in, null);
  assert.equal(days['05'].status, 'present', 'approved: counts in full');
  const punches = (await admin('GET', `/api/admin/punches?date=2026-10-03&employee_id=${id}`)).data;
  const old = (punches.rows || punches).find((p) => p.id === home.id);
  assert.equal(old.status, 'rejected');
  assert.match(old.flag_reason, /replaced by Punch In at the site at 09:40/);
  const row = (await admin('GET', '/api/admin/late-ot?month=2026-10')).data.rows[0];
  assert.deepEqual(row.offsite_in.map((l) => [l.date, l.at]), [['2026-10-02', '08:50']]);
  assert.equal((await a('GET', '/api/employee/attendance?month=2026-10')).data.summary.offsite_in_days, 1);
});

test('away-from-site rules wait until the branch has a GPS location', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  // Imported with a new branch whose location isn't set yet
  assert.equal((await admin('POST', '/api/admin/employees/import', { csv: 'employee_id,name,branch,salary,pin,weekly_off\nA1,Asha,New site,30000,1234,none' })).status, 200);
  const id = (await admin('GET', '/api/admin/employees')).data[0].id;
  const a = s.client();
  await a('POST', '/api/employee/login', { code: 'A1', pin: '1234' });
  for (const [d, inAt, outAt] of [['2026-10-01', '09:00', '18:00'], ['2026-10-02', '09:00', '21:00']]) {
    s.clock.now = ist(d, inAt); assert.equal((await a('POST', '/api/employee/punch', { kind: 'IN', ...HOME, accuracy: 10, selfie: JPEG, note: 'site' })).status, 200);
    s.clock.now = ist(d, outAt); assert.equal((await a('POST', '/api/employee/punch', { kind: 'OUT', ...HOME, accuracy: 10, selfie: JPEG, note: 'site' })).status, 200);
  }
  s.clock.now = ist('2026-10-03', '08:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  const d2 = (await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days.find((d) => d.date === '2026-10-02');
  assert.equal(d2.status, 'present');
  assert.deepEqual([d2.offsite_in, d2.late_out], [null, null]);
});

test('no punch-out by midnight: Punch Out closes and the day is a half day', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { branch_id: b, salary: 30000, weekly_offs: [], pin: '1234', code: 'A1', name: 'Asha', joined_on: '' })).data.id;
  const a = s.client();
  await a('POST', '/api/employee/login', { code: 'A1', pin: '1234' });
  const punch = async (date, time, kind, where = HQ) => {
    s.clock.now = ist(date, time);
    return a('POST', '/api/employee/punch', { kind, ...where, accuracy: 10, selfie: JPEG, note: where === HQ ? '' : 'home' });
  };
  // 01 (first day on the app): punched in, never punched out
  assert.equal((await punch('2026-10-01', '09:00', 'IN')).status, 200);
  s.clock.now = ist('2026-10-01', '23:30');
  assert.deepEqual((await a('GET', '/api/employee/today')).data.allowed, ['OUT'], 'still open before midnight');
  s.clock.now = ist('2026-10-02', '00:10');
  const today = (await a('GET', '/api/employee/today')).data;
  assert.deepEqual(today.allowed, ['IN'], 'closed at midnight');
  assert.equal(today.missed_out.date, '2026-10-01');
  assert.equal((await punch('2026-10-02', '00:15', 'OUT', HOME)).status, 409, 'too late to punch out from home');
  // 02: worked late at the site until 23:00 — counts in full
  assert.equal((await punch('2026-10-02', '09:00', 'IN')).status, 200);
  assert.equal((await punch('2026-10-02', '23:00', 'OUT')).status, 200);

  s.clock.now = ist('2026-10-03', '08:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  const days = Object.fromEntries((await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days.map((d) => [d.date.slice(8), d]));
  assert.equal(days['01'].status, 'half_day', 'no punch-out, even on the first day');
  assert.ok(days['01'].flags.includes('missing_out'));
  assert.equal(days['02'].status, 'present');
});

test('night shift: Punch Out stays open until an hour after the shift ends', async (t) => {
  const s = await startServer(ist('2026-10-01', '20:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { branch_id: b, salary: 30000, weekly_offs: [], pin: '1234', code: 'N1', name: 'Night', joined_on: '', follow_branch_shift: false, shift_start: '22:00', shift_end: '06:00' })).data.id;
  const a = s.client();
  await a('POST', '/api/employee/login', { code: 'N1', pin: '1234' });
  s.clock.now = ist('2026-10-01', '21:55');
  assert.equal((await a('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG })).status, 200);
  s.clock.now = ist('2026-10-02', '03:00');
  const mid = (await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days.find((d) => d.date === '2026-10-01');
  assert.equal(mid.status, 'working', 'still on the night shift after midnight');
  s.clock.now = ist('2026-10-02', '06:05');
  assert.equal((await a('POST', '/api/employee/punch', { kind: 'OUT', ...HQ, accuracy: 10, selfie: JPEG })).status, 200);
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  const d1 = (await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days.find((d) => d.date === '2026-10-01');
  assert.equal(d1.status, 'present');
});

test('half-day review: every half day with its reason, for admin and staff; full day given at month end', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { branch_id: b, salary: 30000, weekly_offs: [], pin: '1234', code: 'A1', name: 'Asha', joined_on: '' })).data.id;
  const a = s.client();
  await a('POST', '/api/employee/login', { code: 'A1', pin: '1234' });
  const punch = async (date, time, kind, where = HQ) => {
    s.clock.now = ist(date, time);
    const r = await a('POST', '/api/employee/punch', { kind, ...where, accuracy: 10, selfie: JPEG, note: where === HQ ? '' : 'home' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  await punch('2026-10-01', '09:00', 'IN'); await punch('2026-10-01', '18:00', 'OUT');
  await punch('2026-10-02', '10:30', 'IN'); await punch('2026-10-02', '18:00', 'OUT');        // 90 min late
  await punch('2026-10-03', '09:00', 'IN');                                                    // no punch-out
  await punch('2026-10-05', '09:00', 'IN'); await punch('2026-10-05', '13:30', 'OUT');        // short hours

  s.clock.now = ist('2026-10-06', '08:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  let r = (await admin('GET', '/api/admin/half-days?month=2026-10')).data;
  assert.deepEqual(r.rows.map((x) => [x.date, x.reasons.map((y) => y.code)]), [['2026-10-02', ['very_late']], ['2026-10-03', ['missing_out']], ['2026-10-05', ['short_hours']]]);
  assert.equal(r.rows[0].reasons[0].text, 'Arrived 1h 30m late (in at 10:30, shift starts 09:00) — more than 1h late');
  assert.equal(r.rows[1].reasons[0].text, 'Punched in at 09:00 and did not punch out by midnight');
  assert.equal(r.rows[2].reasons[0].text, 'Worked only 4h 30m (in 09:00, out 13:30) — a full day needs 8h 45m');
  // Staff see the same reasons
  const days = (await a('GET', '/api/employee/attendance?month=2026-10')).data.days;
  assert.equal(days.find((d) => d.date === '2026-10-03').half_day_reasons[0].code, 'missing_out');
  // Month end: the admin gives 03 a full day
  assert.equal((await admin('PUT', '/api/admin/attendance/override', { employee_id: id, date: '2026-10-03', status: 'present', note: `${r.review_note} — was: no punch-out` })).status, 200);
  r = (await admin('GET', '/api/admin/half-days?month=2026-10')).data;
  assert.deepEqual(r.rows.map((x) => x.date), ['2026-10-02', '2026-10-05']);
  assert.deepEqual(r.given.map((x) => x.date), ['2026-10-03']);
  const csv = String((await admin('GET', '/api/admin/half-days.csv?month=2026-10')).data);
  assert.match(csv, /2026-10-05,A1,Asha,HO,09:00,13:30,4\.50,Half day,"Worked only 4h 30m/);
  assert.match(csv, /2026-10-03,A1,Asha,HO,.*Full day given/);
});
