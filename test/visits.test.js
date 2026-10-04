'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG, PDF } = require('./helpers');

const HQ = { lat: 17.41, lng: 78.44 };
const BANK = { lat: 17.43, lng: 78.45 };

test('head office staff add visit selfies during the day; admin reviews them', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const ho = (await admin('POST', '/api/admin/branches', { name: 'Head Office', ...HQ, radius_m: 150, geofence_mode: 'flag', field_visits: true })).data.id;
  const site = (await admin('POST', '/api/admin/branches', { name: 'Site', lat: 16.5, lng: 81.7, radius_m: 300, geofence_mode: 'flag' })).data.id;
  const base = { salary_type: 'monthly', salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234' };
  const acct = (await admin('POST', '/api/admin/employees', { ...base, code: 'H1', name: 'Accounts', branch_id: ho })).data.id;
  await admin('POST', '/api/admin/employees', { ...base, code: 'S1', name: 'Site staff', branch_id: site });
  const login = async (code) => { const c = s.client(); await c('POST', '/api/employee/login', { code, pin: '1234' }); return c; };
  const staff = await login('H1');
  const siteStaff = await login('S1');

  assert.equal((await staff('GET', '/api/employee/me')).data.can_visit, true);
  assert.equal((await siteStaff('GET', '/api/employee/me')).data.can_visit, false);

  // Needs to be on duty
  s.clock.now = ist('2026-10-05', '09:00');
  let r = await staff('POST', '/api/employee/visit', { ...BANK, accuracy: 10, selfie: JPEG, note: 'HDFC Bank' });
  assert.equal(r.status, 409);
  await staff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', ...HQ, accuracy: 10, selfie: JPEG });
  s.clock.now = ist('2026-10-05', '11:00');
  assert.equal((await staff('POST', '/api/employee/visit', { ...BANK, accuracy: 10, selfie: JPEG, note: '' })).status, 400, 'place is required');
  r = await staff('POST', '/api/employee/visit', { ...BANK, accuracy: 10, selfie: JPEG, note: 'HDFC Bank, Banjara Hills' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const v1 = r.data.id;
  assert.equal((await staff('POST', '/api/employee/visit', { ...BANK, accuracy: 10, selfie: JPEG, note: 'again' })).status, 409, 'not twice in a minute');
  s.clock.now = ist('2026-10-05', '14:00');
  r = await staff('POST', '/api/employee/visit', { lat: 17.39, lng: 78.47, accuracy: 10, selfie: JPEG, note: 'GST office' });
  const v2 = r.data.id;
  // Other branches can't
  await siteStaff('POST', '/api/employee/punch', { note: 'Client office',  kind: 'IN', lat: 16.5, lng: 81.7, accuracy: 10, selfie: JPEG });
  s.clock.now = ist('2026-10-05', '14:05');
  assert.equal((await siteStaff('POST', '/api/employee/visit', { ...BANK, accuracy: 10, selfie: JPEG, note: 'x' })).status, 403);

  // Shows on their day; does not change worked hours
  r = await staff('GET', '/api/employee/today');
  assert.deepEqual(r.data.visits.map((v) => [v.note, v.status]), [['HDFC Bank, Banjara Hills', 'pending'], ['GST office', 'pending']]);
  assert.equal((await staff('GET', `/api/employee/visits/${v1}/selfie`)).headers.get('content-type'), 'image/jpeg');

  // Admin reviews
  assert.equal((await admin('GET', '/api/admin/pending')).data.visits, 2);
  r = await admin('GET', '/api/admin/visits?date=2026-10-05');
  assert.equal(r.data.length, 2);
  assert.equal(r.data[0].branch_name, 'Head Office');
  assert.equal((await admin('GET', `/api/admin/visits/${v2}/selfie`)).headers.get('content-type'), 'image/jpeg');
  await admin('POST', `/api/admin/visits/${v1}/review`, { status: 'approved' });
  await admin('POST', `/api/admin/visits/${v2}/review`, { status: 'rejected' });
  assert.equal((await admin('GET', '/api/admin/pending')).data.visits, 0);
  r = await staff('GET', '/api/employee/today');
  assert.deepEqual(r.data.visits.map((v) => v.status), ['approved', 'rejected']);
  assert.ok(acct);
});

test('staff are reminded until phone, Aadhaar, PAN and UPI/bank are provided', async (t) => {
  const s = await startServer(ist('2026-10-05', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'firefueled', password: 'password123', name: 'Owner' });
  const ho = (await admin('POST', '/api/admin/branches', { name: 'Head Office', ...HQ, radius_m: 150, geofence_mode: 'flag' })).data.id;
  const emp = (await admin('POST', '/api/admin/employees', { code: 'E1', name: 'Ravi', branch_id: ho, salary_type: 'monthly', salary: 30000, weekly_offs: ['0'], joined_on: '', pin: '1234' })).data.id;
  const staff = s.client();
  await staff('POST', '/api/employee/login', { code: 'E1', pin: '1234' });

  assert.deepEqual((await staff('GET', '/api/employee/me')).data.profile_missing, ['phone', 'aadhaar', 'pan', 'payment']);
  assert.equal((await admin('GET', '/api/admin/pending')).data.incomplete_profiles, 1);

  // Validation
  assert.equal((await staff('POST', '/api/employee/profile', { phone: '12345' })).status, 400);
  assert.equal((await staff('POST', '/api/employee/profile', { upi_id: 'not-a-upi' })).status, 400);
  assert.equal((await staff('POST', '/api/employee/profile', { bank_account: '12345678901' })).status, 400, 'IFSC needed too');

  let r = await staff('POST', '/api/employee/profile', { phone: '+91 98765 43210', upi_id: 'ravi@okhdfcbank' });
  assert.deepEqual(r.data.profile_missing, ['aadhaar', 'pan']);
  await staff('POST', '/api/employee/documents', { doc_type: 'aadhaar', doc_number: '1234 5678 9012', file: PDF });
  r = await staff('POST', '/api/employee/documents', { doc_type: 'pan', doc_number: 'ABCDE1234F', file: PDF });
  assert.deepEqual((await staff('GET', '/api/employee/me')).data.profile_missing, []);
  // A rejected document counts as missing again
  await admin('POST', `/api/admin/documents/${r.data.id}/review`, { status: 'rejected', note: 'blurry' });
  assert.deepEqual((await staff('GET', '/api/employee/me')).data.profile_missing, ['pan']);

  // Admin sees it, and an admin edit for something else keeps the staff's details
  let e = (await admin('GET', '/api/admin/employees')).data[0];
  assert.deepEqual([e.phone, e.upi_id, e.profile_missing], ['9876543210', 'ravi@okhdfcbank', ['pan']]);
  await admin('PUT', `/api/admin/employees/${emp}`, { code: 'E1', name: 'Ravi K', branch_id: ho, salary_type: 'monthly', salary: 32000, weekly_offs: ['0'], joined_on: '' });
  e = (await admin('GET', '/api/admin/employees')).data[0];
  assert.deepEqual([e.name, e.phone, e.upi_id], ['Ravi K', '9876543210', 'ravi@okhdfcbank']);

  // Bank details also count as a payment method, and land in the payroll sheet
  await staff('POST', '/api/employee/profile', { upi_id: '', bank_account: '001234567890', bank_ifsc: 'hdfc0001234' });
  assert.deepEqual((await staff('GET', '/api/employee/me')).data.profile_missing, ['pan']);
  const csv = (await admin('GET', '/api/admin/payroll.csv?month=2026-10')).data.toString();
  assert.match(csv, /Phone,UPI ID,Bank account,IFSC/);
  assert.match(csv, /9876543210,,001234567890,HDFC0001234/);
});
