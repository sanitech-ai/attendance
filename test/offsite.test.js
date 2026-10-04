'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };
const BANK = { lat: 17.4256, lng: 78.4482 }; // ~1.8 km away

async function fakeFetch(url) {
  assert.match(url, /^https:\/\/nominatim\.openstreetmap\.org\/reverse/);
  return { ok: true, status: 200, json: async () => ({ name: 'HDFC Bank', address: { road: 'Road No. 1', suburb: 'Banjara Hills', city: 'Hyderabad' } }) };
}

test('off-site punches need a note, get the address attached and wait for approval', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'), { fetchImpl: fakeFetch });
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const hq = (await admin('POST', '/api/admin/branches', { name: 'Head Office', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const site = (await admin('POST', '/api/admin/branches', { name: 'Site', lat: 17.0, lng: 78.0, radius_m: 300, geofence_mode: 'block' })).data.id;
  const base = { salary_type: 'monthly', salary: 30000, weekly_offs: [], joined_on: '', pin: '1234' };
  await admin('POST', '/api/admin/employees', { ...base, code: 'H1', name: 'Accounts', branch_id: hq });
  const sid = (await admin('POST', '/api/admin/employees', { ...base, code: 'S1', name: 'Site', branch_id: site })).data.id;
  const login = async (code) => { const c = s.client(); await c('POST', '/api/employee/login', { code, pin: '1234' }); return c; };
  const h1 = await login('H1');
  const s1 = await login('S1');
  s.clock.now = ist('2026-10-05', '09:05');

  assert.equal((await h1('GET', '/api/employee/today')).data.offsite_allowed, true);
  let r = await h1('POST', '/api/employee/punch', { kind: 'IN', ...BANK, accuracy: 12, selfie: JPEG });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Write where you are punching from/);
  r = await h1('POST', '/api/employee/punch', { kind: 'IN', ...BANK, accuracy: 12, selfie: JPEG, note: 'HDFC Bank — depositing cheques' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'flagged');
  assert.match(r.data.flag_reason, /^off-site: “HDFC Bank — depositing cheques”/);
  await new Promise((done) => setTimeout(done, 50)); // address is looked up in the background

  let p = (await admin('GET', '/api/admin/punches?status=flagged')).data[0];
  assert.equal(p.note, 'HDFC Bank — depositing cheques');
  assert.equal(p.place, 'HDFC Bank, Road No. 1, Banjara Hills, Hyderabad');
  const today = (await h1('GET', '/api/employee/today')).data;
  assert.equal(today.punches[0].note, 'HDFC Bank — depositing cheques');
  assert.equal((await admin('POST', `/api/admin/punches/${p.id}/review`, { status: 'approved' })).status, 200);

  // Inside their site no note is needed or stored
  s.clock.now = ist('2026-10-05', '18:05');
  r = await h1('POST', '/api/employee/punch', { kind: 'OUT', ...BANK, accuracy: 12, selfie: JPEG, note: 'Back at bank' });
  assert.equal(r.data.status, 'flagged');
  s.clock.now = ist('2026-10-06', '09:00');
  r = await h1('POST', '/api/employee/punch', { kind: 'IN', ...HQ, accuracy: 12, selfie: JPEG, note: 'ignored' });
  assert.equal(r.data.status, 'ok');
  p = (await admin('GET', '/api/admin/punches?date=2026-10-06')).data[0];
  assert.equal(p.note, null);

  // Site staff (block mode) can't punch off-site unless allowed
  assert.equal((await s1('GET', '/api/employee/today')).data.offsite_allowed, false);
  r = await s1('POST', '/api/employee/punch', { kind: 'IN', ...BANK, accuracy: 12, selfie: JPEG, note: 'Client office' });
  assert.equal(r.status, 403);
  const emp = (await admin('GET', '/api/admin/employees')).data.find((e) => e.id === sid);
  assert.equal((await admin('PUT', `/api/admin/employees/${sid}`, { ...emp, weekly_offs: [], salary: 30000, allow_offsite: true })).status, 200);
  assert.equal((await s1('GET', '/api/employee/today')).data.offsite_allowed, true);
  r = await s1('POST', '/api/employee/punch', { kind: 'IN', ...BANK, accuracy: 12, selfie: JPEG, note: 'Client office' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'flagged');
});
