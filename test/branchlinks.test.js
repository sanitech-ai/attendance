'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const OFFICE = { lat: 28.4000, lng: 77.0000 };
const SITE = { lat: 28.4300, lng: 77.0100 }; // ~3.5 km away

test('staff of a branch can punch at its linked site', async (t) => {
  const s = await startServer(ist('2026-10-06', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const site = (await admin('POST', '/api/admin/branches', { name: 'Golf Hills site', ...SITE, radius_m: 300, geofence_mode: 'block' })).data.id;
  const office = (await admin('POST', '/api/admin/branches', { name: 'Golf Hills office', ...OFFICE, radius_m: 200, geofence_mode: 'block' })).data.id;
  await admin('POST', '/api/admin/employees', { code: 'G1', name: 'Guard', branch_id: office, salary_type: 'monthly', salary: 1, weekly_offs: [], joined_on: '', pin: '1234' });
  const g = s.client();
  await g('POST', '/api/employee/login', { code: 'G1', pin: '1234' });
  s.clock.now = ist('2026-10-06', '09:00');

  // Not linked yet: the site is off-limits
  assert.equal((await g('POST', '/api/employee/punch', { kind: 'IN', ...SITE, accuracy: 10, selfie: JPEG })).status, 403);

  const b = (await admin('GET', '/api/admin/branches')).data.find((x) => x.id === office);
  assert.equal((await admin('PUT', `/api/admin/branches/${office}`, { ...b, linked_branches: [String(site)] })).status, 200);
  assert.equal((await admin('GET', '/api/admin/branches')).data.find((x) => x.id === office).linked_ids, String(site));

  const r = await g('POST', '/api/employee/punch', { kind: 'IN', ...SITE, accuracy: 10, selfie: JPEG });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.branch_name, 'Golf Hills site');
  assert.ok((await g('GET', '/api/employee/today')).data.branches.find((x) => x.id === site).mine);

  // Saving the branch without the field keeps the links
  const b2 = (await admin('GET', '/api/admin/branches')).data.find((x) => x.id === office);
  const { linked_ids, ...rest } = b2;
  assert.equal((await admin('PUT', `/api/admin/branches/${office}`, rest)).status, 200);
  assert.equal((await admin('GET', '/api/admin/branches')).data.find((x) => x.id === office).linked_ids, String(site));
  void linked_ids;
});
