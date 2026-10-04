'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };

test('admins delete single punches and field visits with their selfies', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  await admin('POST', '/api/admin/admins', { name: 'Accounts', username: 'accounts', password: 'acc12345' });
  const b = (await admin('POST', '/api/admin/branches', { name: 'HO', ...HQ, radius_m: 150, geofence_mode: 'flag', field_visits: true })).data.id;
  await admin('POST', '/api/admin/employees', { code: 'E1', name: 'E', branch_id: b, salary_type: 'monthly', salary: 1, weekly_offs: [], joined_on: '', pin: '1234' });
  const e = s.client();
  await e('POST', '/api/employee/login', { code: 'E1', pin: '1234' });
  s.clock.now = ist('2026-10-05', '09:00');
  await e('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
  s.clock.now = ist('2026-10-05', '11:00');
  await e('POST', '/api/employee/visit', { ...HQ, accuracy: 10, selfie: JPEG, note: 'Bank' });
  const files = () => fs.readdirSync(path.join(s.dataDir, 'files')).length;
  assert.equal(files(), 2);
  const [p] = (await admin('GET', '/api/admin/punches?date=2026-10-05')).data;
  const [v] = (await admin('GET', '/api/admin/visits')).data;

  // Admins without attendance-edit permission can't
  const acc = s.client();
  await acc('POST', '/api/admin/login', { username: 'accounts', password: 'acc12345' });
  assert.equal((await acc('DELETE', `/api/admin/punches/${p.id}`)).status, 403);

  assert.equal((await admin('DELETE', `/api/admin/punches/${p.id}`)).status, 200);
  assert.equal((await admin('DELETE', `/api/admin/visits/${v.id}`)).status, 200);
  assert.equal((await admin('DELETE', `/api/admin/visits/${v.id}`)).status, 404);
  assert.equal(files(), 0);
  assert.equal((await admin('GET', '/api/admin/punches?date=2026-10-05')).data.length, 0);
  assert.equal((await e('GET', '/api/employee/today')).data.punches.length, 0);
});
