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
  // Genuine late meeting elsewhere: the admin approves that punch, so the day counts in full
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
  assert.equal(days['06'].status, 'present', 'approved punch');
  assert.equal(days['06'].late_out, null);

  const row = (await admin('GET', '/api/admin/late-ot?month=2026-10')).data.rows[0];
  assert.deepEqual(row.late_out.map((l) => [l.date, l.last_out]), [['2026-10-02', '21:00']]);
  assert.match(String((await admin('GET', '/api/admin/late-ot.csv?month=2026-10')).data), /02 \(out 21:00\)/);
  const staff = (await a('GET', '/api/employee/attendance?month=2026-10')).data;
  assert.equal(staff.summary.late_out_days, 1);

  // The admin can change the allowance
  assert.equal((await admin('PUT', '/api/admin/settings', { late_out_minutes: 240 })).status, 200);
  const again = (await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days.find((d) => d.date === '2026-10-02');
  assert.equal(again.status, 'present', '3 hours is within a 4-hour allowance');
});
