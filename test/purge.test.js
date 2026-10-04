'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };

test('admin deletes selfies: photos only, or whole punches', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag', field_visits: true })).data.id;
  await admin('POST', '/api/admin/employees', { code: 'E1', name: 'E', branch_id: b, salary_type: 'monthly', salary: 1, weekly_offs: [], joined_on: '', pin: '1234' });
  const e = s.client();
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  s.clock.now = ist('2026-10-05', '09:00');
  await e('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
  s.clock.now = ist('2026-10-05', '11:00');
  assert.equal((await e('POST', '/api/employee/visit', { ...HQ, accuracy: 10, selfie: JPEG, note: 'Bank' })).status, 200);
  s.clock.now = ist('2026-10-05', '18:00');
  await e('POST', '/api/employee/punch', { kind: 'OUT', ...HQ, accuracy: 10, selfie: JPEG });
  const files = () => fs.readdirSync(path.join(s.dataDir, 'files')).length;
  assert.equal(files(), 3);

  // Needs the password and DELETE
  assert.equal((await admin('POST', '/api/admin/punches/purge', { confirm: 'DELETE', password: 'nope' })).status, 403);
  assert.equal((await admin('POST', '/api/admin/punches/purge', { password: 'password123' })).status, 400);

  let r = await admin('POST', '/api/admin/punches/purge', { confirm: 'DELETE', password: 'password123', mode: 'photos', include_visits: true });
  assert.deepEqual([r.data.punches, r.data.visits], [2, 1]);
  assert.equal(files(), 0);
  const punches = (await admin('GET', '/api/admin/punches?date=2026-10-05')).data;
  assert.equal(punches.length, 2); // times kept
  assert.equal((await admin('GET', `/api/admin/punches/${punches[0].id}/selfie`)).status, 404);
  const day = (await e('GET', '/api/employee/today')).data;
  assert.equal(day.punches.length, 2);

  r = await admin('POST', '/api/admin/punches/purge', { confirm: 'DELETE', password: 'password123', mode: 'punches', up_to: '2026-10-05' });
  assert.equal(r.data.punches, 2);
  assert.equal((await admin('GET', '/api/admin/punches?date=2026-10-05')).data.length, 0);
});
