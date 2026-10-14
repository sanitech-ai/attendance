'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };

test('out-of-step punches (Out in the morning, In in the evening) can no longer happen and can be fixed', async (t) => {
  const s = await startServer(ist('2026-10-10', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const id = (await admin('POST', '/api/admin/employees', { branch_id: b, salary: 30000, weekly_offs: ['0'], pin: '1234', code: 'SECPL0025', name: 'Amit Rout', joined_on: '' })).data.id;
  const a = s.client();
  await a('POST', '/api/employee/login', { code: 'SECPL0025', pin: '1234' });

  // Now: an evening Punch In left open is closed at midnight, so the next morning starts with Punch In
  s.clock.now = ist('2026-10-10', '18:40');
  assert.equal((await a('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG })).status, 200);
  s.clock.now = ist('2026-10-12', '09:05');
  assert.deepEqual((await a('GET', '/api/employee/today')).data.allowed, ['IN']);
  assert.equal((await a('POST', '/api/employee/punch', { kind: 'OUT', ...HQ, accuracy: 10, selfie: JPEG })).status, 409, 'no Punch Out before Punch In');

  // What happened before the fix: the morning punch was saved as an Out (closing the evening before)
  // and the evening punch as an In
  const add = s.db.prepare(`INSERT INTO punches (employee_id, kind, at, work_date, lat, lng, accuracy_m, branch_id, distance_m, inside_geofence, selfie_file, status)
    VALUES (?, ?, ?, ?, ?, ?, 10, ?, 0, 1, 'x.bin', 'ok')`);
  s.db.prepare('DELETE FROM punches').run();
  add.run(id, 'IN', ist('2026-10-10', '18:40'), '2026-10-10', HQ.lat, HQ.lng, b);
  add.run(id, 'OUT', ist('2026-10-12', '09:05'), '2026-10-10', HQ.lat, HQ.lng, b);
  add.run(id, 'IN', ist('2026-10-12', '18:10'), '2026-10-12', HQ.lat, HQ.lng, b);
  add.run(id, 'OUT', ist('2026-10-13', '09:02'), '2026-10-12', HQ.lat, HQ.lng, b);
  add.run(id, 'IN', ist('2026-10-13', '18:05'), '2026-10-13', HQ.lat, HQ.lng, b);

  s.clock.now = ist('2026-10-14', '08:00');
  await admin('POST', '/api/admin/login', { username: 'firefueled', password: 'password123' });
  const r = await admin('POST', '/api/admin/punches/fix-order', { employee_id: id, month: '2026-10' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.changed.map((x) => [x.date, x.time, x.to]), [
    ['2026-10-12', '09:05', 'IN'], ['2026-10-12', '18:10', 'OUT'], ['2026-10-13', '09:02', 'IN'], ['2026-10-13', '18:05', 'OUT'],
  ]);
  const days = Object.fromEntries((await admin('GET', `/api/admin/attendance/${id}?month=2026-10`)).data.days.map((d) => [d.date.slice(8), d]));
  assert.deepEqual([days['12'].first_in, days['12'].last_out, days['12'].status], ['09:05', '18:10', 'present']);
  assert.deepEqual([days['13'].first_in, days['13'].last_out, days['13'].status], ['09:02', '18:05', 'present']);
  assert.equal(days['10'].status, 'half_day', 'the evening Punch In of the 10th was never closed');
  // Running it again changes nothing
  assert.deepEqual((await admin('POST', '/api/admin/punches/fix-order', { employee_id: id, month: '2026-10' })).data.changed, []);
});
