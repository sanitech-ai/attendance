'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

// Stands in for OpenStreetMap: names the area by latitude.
async function fakeFetch(url) {
  const u = new URL(url);
  assert.equal(u.hostname, 'nominatim.openstreetmap.org');
  const lat = Number(u.searchParams.get('lat'));
  const address = lat > 25 ? { city: 'Gurugram', state: 'Haryana' } : { suburb: 'Banjara Hills', city: 'Hyderabad', state: 'Telangana' };
  return { ok: true, status: 200, json: async () => ({ address }) };
}

test('branch location check flags pins that disagree with their link or with where staff punch', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'), { fetchImpl: fakeFetch });
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const hq = (await admin('POST', '/api/admin/branches', { name: 'Head Office', maps_link: 'https://www.google.com/maps/place/@17.4100,78.4400,17z', radius_m: 150, geofence_mode: 'flag' })).data.id;
  const site = (await admin('POST', '/api/admin/branches', { name: 'M3M Golf Hills', lat: 28.40, lng: 77.00, radius_m: 300, geofence_mode: 'flag' })).data.id;
  await admin('POST', '/api/admin/branches', { name: 'Fine', lat: 17.45, lng: 78.38, radius_m: 300, geofence_mode: 'flag' });
  // Someone later moved the head office pin ~2 km by hand
  s.db.prepare('UPDATE branches SET lat = 17.428 WHERE id = ?').run(hq);
  // Golf Hills staff always punch ~3 km away from its pin
  const emp = (await admin('POST', '/api/admin/employees', { code: 'G1', name: 'Guard', branch_id: site, salary_type: 'monthly', salary: 1, weekly_offs: [], joined_on: '', pin: '1234' })).data.id;
  const ins = s.db.prepare("INSERT INTO punches (employee_id, kind, at, work_date, lat, lng, accuracy_m, inside_geofence, selfie_file, status) VALUES (?, 'IN', ?, '2026-10-01', ?, ?, 15, 0, 'x.bin', 'flagged')");
  for (let i = 0; i < 4; i++) ins.run(emp, ist('2026-10-01', '09:00') + i * 86400000, 28.427 + i * 0.0001, 77.0);
  void JPEG;

  const r = await admin('GET', '/api/admin/branches/check');
  assert.equal(r.status, 200);
  const by = (n) => r.data.find((b) => b.name === n);
  assert.equal(by('Head Office').verdict, 'bad');
  assert.match(by('Head Office').issues[0], /2\.\d+ km away from where the Google Maps link points/);
  assert.equal(by('Head Office').place, 'Banjara Hills, Hyderabad, Telangana');
  assert.equal(by('M3M Golf Hills').verdict, 'bad');
  assert.match(by('M3M Golf Hills').issues[0], /usually punch 3\.\d+ km from the pin/);
  assert.equal(by('M3M Golf Hills').place, 'Gurugram, Haryana');
  assert.equal(by('Fine').verdict, 'check'); // no maps link saved
  assert.equal(by('Fine').issues.length, 0);
});
