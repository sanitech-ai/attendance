'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.4100, lng: 78.4400 };
const PASHA = { lat: 17.5300, lng: 78.1800 };

test('editing a branch keeps its pin; moving a pin re-measures recent punches', async (t) => {
  // Google answers the short link with a different spot every time (as it can for a server).
  let calls = 0;
  const fakeFetch = async (url) => {
    if (url.startsWith('https://nominatim')) return { ok: true, status: 200, json: async () => ({ address: { city: 'Hyderabad', state: 'Telangana' } }) };
    calls++;
    const lat = calls === 1 ? HQ.lat : 18.9;
    return { headers: new Map([['location', `https://www.google.com/maps/place/@${lat},78.44,17z`]]), text: async () => '' };
  };
  const s = await startServer(ist('2026-10-05', '08:00'), { fetchImpl: fakeFetch });
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const link = 'https://maps.app.goo.gl/qTqM3pv4PTZNZ3xe9';
  const hq = (await admin('POST', '/api/admin/branches', { name: 'Head Office', maps_link: link, radius_m: 150, geofence_mode: 'flag' })).data.id;
  await admin('POST', '/api/admin/branches', { name: 'Pashamylaram', ...PASHA, radius_m: 300, geofence_mode: 'flag' });
  const branch = async () => (await admin('GET', '/api/admin/branches')).data.find((b) => b.id === hq);
  assert.equal((await branch()).lat, HQ.lat);

  // Ticking "field visit selfies" (same link, same pin) must not move the pin
  const b = await branch();
  let r = await admin('PUT', `/api/admin/branches/${hq}`, { ...b, field_visits: true, active: true });
  assert.equal(r.status, 200);
  assert.equal((await branch()).lat, HQ.lat);
  assert.equal(calls, 1);

  // A wrongly placed head office pin: staff at the office look closer to Pashamylaram
  s.db.prepare('UPDATE branches SET lat = 17.60, lng = 78.10 WHERE id = ?').run(hq);
  await admin('POST', '/api/admin/employees', { code: 'H1', name: 'Office', branch_id: hq, salary_type: 'monthly', salary: 1, weekly_offs: [], joined_on: '', pin: '1234' });
  const staff = s.client();
  await staff('POST', '/api/employee/login', { code: 'H1', pin: '1234' });
  s.clock.now = ist('2026-10-05', '09:00');
  r = await staff('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
  assert.equal(r.data.status, 'flagged');
  assert.equal(r.data.branch_name, 'Pashamylaram');
  assert.match(r.data.flag_reason, /km from their branch Head Office/);

  // Admin moves the pin to where staff punch: the punch is measured again and cleared
  r = await admin('POST', `/api/admin/branches/${hq}/pin`, HQ);
  assert.equal(r.status, 200);
  assert.equal(r.data.remeasured, 1);
  const p = (await admin('GET', '/api/admin/punches?date=2026-10-05')).data[0];
  assert.equal(p.status, 'ok');
  assert.equal(p.branch_name, 'Head Office');
  assert.equal(p.inside_geofence, 1);
  assert.equal(p.flag_reason, null);
});
