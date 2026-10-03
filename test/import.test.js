'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ist, JPEG } = require('./helpers');
const { parseCsv, normDate, normWeeklyOff } = require('../server/importer');
const { parseCoords, resolveMapsLink } = require('../server/maps');

const CSV = [
  'employee_id,name,branch,designation,joined_on,salary,pf,esic,pt,tds,conveyance,room_rent,branch_radius_m',
  'SECPL0008,Mohd. Asif,Head Office - Hyderabad,Sr. Purchase Executive,04-08-2008,43000,3600,860,200,,300,,150',
  'SECPL0437,Koushik Das,Head Office - Hyderabad,Office Boy,23-01-2025,19000,,,,,,,150',
  'SECPL0438,Sudhanshu Barik,HYD-101 ROMP-07,Supervisor,,25000,,,200,,,2000,500',
  '"SECPL0194","Parida, Aditya",Jagyapet GGPL,Store Incharge,,35000,3600,,200,,,,500',
].join('\r\n');

test('CSV parsing and value normalisation', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.equal(normDate('04-08-2008'), '2008-08-04');
  assert.equal(normDate('4/8/26'), '2026-08-04');
  assert.equal(normDate(''), '');
  assert.equal(normDate('31-02-2026'), null);
  assert.equal(normWeeklyOff(''), '0');
  assert.equal(normWeeklyOff('Sat, Sun'), '0,6');
  assert.equal(normWeeklyOff('funday'), null);
});

test('coordinates from a Google Maps page body', () => {
  const { coordsFromPage } = require('../server/maps');
  assert.deepEqual(coordsFromPage('<meta content="https://maps.google.com/maps/api/staticmap?center=17.4126%2C78.4482&amp;zoom=15">'), { lat: 17.4126, lng: 78.4482 });
  assert.deepEqual(coordsFromPage('href="https://www.google.com/maps/place/X/@16.51,81.73,15z"'), { lat: 16.51, lng: 81.73 });
  assert.equal(coordsFromPage('<html>nothing</html>'), null);
});

test('Google Maps links and coordinates', async () => {
  assert.deepEqual(parseCoords('17.4123, 78.4482'), { lat: 17.4123, lng: 78.4482 });
  assert.deepEqual(parseCoords('https://www.google.com/maps/place/Office/@17.40,78.40,17z/data=!3m1!4b1!4m6!3m5!8m2!3d17.4123!4d78.4482'), { lat: 17.4123, lng: 78.4482 }, 'pin beats view centre');
  assert.deepEqual(parseCoords('https://maps.google.com/?q=28.4595,77.0266'), { lat: 28.4595, lng: 77.0266 });
  // Short link: follows redirects, only to Google hosts
  const fakeFetch = async (url) => ({
    headers: new Map([['location', url.includes('goo.gl') ? 'https://www.google.com/maps/place/x/@16.51,81.73,15z' : null]]),
    text: async () => '',
  });
  assert.deepEqual(await resolveMapsLink('https://maps.app.goo.gl/abc123', fakeFetch), { lat: 16.51, lng: 81.73 });
  const evilFetch = async () => ({ headers: new Map([['location', 'https://evil.example.com/']]), text: async () => '' });
  await assert.rejects(resolveMapsLink('https://maps.app.goo.gl/abc', evilFetch), /Only Google Maps links/);
  await assert.rejects(resolveMapsLink('http://169.254.169.254/latest'), /Only Google Maps links/);
});

test('import: preview, create branches + employees + fixed pay items, PINs, payroll', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });

  // Problems are reported and nothing is written
  let r = await admin('POST', '/api/admin/employees/import', { csv: `${CSV}\r\nSECPL0008,Dup,Head Office - Hyderabad,,,abc` });
  assert.equal(r.data.error_count, 1);
  assert.match(r.data.rows[4].errors.join(), /appears twice/);
  assert.match(r.data.rows[4].errors.join(), /Salary/);
  assert.equal((await admin('GET', '/api/admin/employees')).data.length, 0);

  r = await admin('POST', '/api/admin/employees/import', { csv: CSV, dry_run: true });
  assert.equal(r.data.error_count, 0);
  assert.deepEqual(r.data.new_branches.map((b) => b.name), ['Head Office - Hyderabad', 'HYD-101 ROMP-07', 'Jagyapet GGPL']);
  assert.equal((await admin('GET', '/api/admin/branches')).data.length, 0, 'dry run writes nothing');

  r = await admin('POST', '/api/admin/employees/import', { csv: CSV });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created.length, 4);
  for (const c of r.data.created) assert.match(c.pin, /^\d{4}$/);
  const pins = Object.fromEntries(r.data.created.map((c) => [c.code, c.pin]));

  const branches = (await admin('GET', '/api/admin/branches')).data;
  assert.equal(branches.length, 3);
  assert.ok(branches.every((b) => b.location_set === 0));
  assert.equal(branches.find((b) => b.name === 'HYD-101 ROMP-07').radius_m, 500);
  const emps = (await admin('GET', '/api/admin/employees')).data;
  const asif = emps.find((e) => e.code === 'SECPL0008');
  assert.equal(asif.joined_on, '2008-08-04');
  assert.equal(emps.find((e) => e.code === 'SECPL0438').joined_on, '', 'blank joining date stays blank');
  assert.equal(emps.find((e) => e.code === 'SECPL0194').name, 'Parida, Aditya');
  const items = (await admin('GET', `/api/admin/employees/${asif.id}/pay-items`)).data;
  assert.deepEqual(items.map((i) => [i.kind, i.label, i.amount_paise]), [
    ['addition', 'Conveyance', 30000], ['deduction', 'PF', 360000], ['deduction', 'ESIC', 86000], ['deduction', 'Professional Tax', 20000],
  ]);

  // Re-importing the same file is refused (IDs exist)
  r = await admin('POST', '/api/admin/employees/import', { csv: CSV });
  assert.equal(r.data.error_count, 4);

  // Staff can log in with the generated PIN; punches at a branch without location are flagged, not blocked
  const staff = s.client();
  assert.equal((await staff('POST', '/api/employee/login', { code: 'SECPL0008', pin: pins.SECPL0008 })).status, 200);
  s.clock.now = ist('2026-10-01', '09:00');
  r = await staff('POST', '/api/employee/punch', { kind: 'IN', lat: 17.41, lng: 78.44, accuracy: 10, selfie: JPEG });
  assert.equal(r.data.status, 'flagged');
  assert.match(r.data.flag_reason, /location of Head Office - Hyderabad not set/);

  // Setting the location makes geofencing work
  const ho = branches.find((b) => b.name === 'Head Office - Hyderabad');
  r = await admin('PUT', `/api/admin/branches/${ho.id}`, { name: ho.name, lat: 17.41, lng: 78.44, radius_m: 150, geofence_mode: 'block' });
  assert.equal(r.status, 200);
  assert.equal((await admin('GET', '/api/admin/branches')).data.find((b) => b.id === ho.id).location_set, 1);
  s.clock.now = ist('2026-10-01', '18:00');
  r = await staff('POST', '/api/employee/punch', { kind: 'OUT', lat: 17.41, lng: 78.44, accuracy: 10, selfie: JPEG });
  assert.equal(r.data.status, 'ok');

  // Payroll: fixed items apply in full when there are paid days; not for someone with none
  s.clock.now = ist('2026-11-02', '10:00');
  await admin('POST', '/api/admin/login', { username: 'owner', password: 'password123' });
  const pay = (await admin('GET', '/api/admin/payroll?month=2026-10')).data;
  const asifPay = pay.rows.find((x) => x.code === 'SECPL0008');
  assert.ok(asifPay.paid_days > 0);
  assert.deepEqual(asifPay.deductions.map((d) => d.label), ['PF', 'ESIC', 'Professional Tax']);
  assert.equal(asifPay.net_paise, asifPay.base_paise + 30000 - 360000 - 86000 - 20000);
  const sudhanshu = pay.rows.find((x) => x.code === 'SECPL0438');
  // Sundays are paid week-offs for monthly staff, so even with no punches there are paid days.
  assert.ok(sudhanshu.paid_days > 0);
  assert.deepEqual(sudhanshu.additions.map((a) => a.label), ['Room Rent']);

  // Manage pay items
  r = await admin('POST', `/api/admin/employees/${asif.id}/pay-items`, { kind: 'deduction', label: 'TDS', amount: 1500 });
  assert.equal(r.status, 200);
  assert.equal((await admin('DELETE', `/api/admin/pay-items/${r.data.id}`)).status, 200);
});

test('branch location comes from a Google Maps link (form and import)', async (t) => {
  const s = await startServer(ist('2026-10-01', '08:00'));
  t.after(() => s.close());
  const admin = s.client();
  await admin('POST', '/api/admin/setup', { username: 'owner', password: 'password123', name: 'Owner' });

  // Form: link only, no lat/lng typed
  const link = 'https://www.google.com/maps/place/Sanitech/@17.40,78.40,17z/data=!3d17.4126!4d78.4482';
  let r = await admin('POST', '/api/admin/branches', { name: 'HQ', maps_link: link, radius_m: 150, geofence_mode: 'flag' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let b = (await admin('GET', '/api/admin/branches')).data[0];
  assert.deepEqual([b.lat, b.lng, b.location_set, b.maps_link], [17.4126, 78.4482, 1, link]);
  r = await admin('POST', '/api/admin/branches', { name: 'Bad', maps_link: 'https://example.com/x', radius_m: 150, geofence_mode: 'flag' });
  assert.equal(r.status, 400);
  r = await admin('POST', '/api/admin/branches', { name: 'Nothing', radius_m: 150, geofence_mode: 'flag' });
  assert.match(r.data.error, /Google Maps link/);

  // Import: link column locates new branches and an existing unlocated one; a bad link blocks only its rows
  const csv = [
    'employee_id,name,branch,salary,branch_maps_link',
    'E1,A,Site One,10000,"https://maps.google.com/?q=16.5,81.7"',
    'E2,B,Site One,10000,',
    'E3,C,Site Two,10000,',
  ].join('\n');
  r = await admin('POST', '/api/admin/employees/import', { csv, dry_run: true });
  assert.deepEqual(r.data.new_branches.map((x) => [x.name, x.located]), [['Site One', true], ['Site Two', false]]);
  r = await admin('POST', '/api/admin/employees/import', { csv: `${csv}\nE4,D,Site Three,10000,https://evil.example.com/`, dry_run: true });
  assert.equal(r.data.error_count, 0, 'an unreadable link does not block the import');
  assert.match(r.data.link_warnings[0], /^Site Three: Only Google Maps links/);
  r = await admin('POST', '/api/admin/employees/import', { csv });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const branches = (await admin('GET', '/api/admin/branches')).data;
  b = branches.find((x) => x.name === 'Site One');
  assert.deepEqual([b.lat, b.lng, b.location_set], [16.5, 81.7, 1]);
  assert.equal(branches.find((x) => x.name === 'Site Two').location_set, 0);

  r = await admin('POST', '/api/admin/employees/import', { csv: 'employee_id,name,branch,salary,branch_maps_link\nE5,E,Site Two,10000,"28.4595, 77.0266"' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  b = (await admin('GET', '/api/admin/branches')).data.find((x) => x.name === 'Site Two');
  assert.deepEqual([b.lat, b.lng, b.location_set], [28.4595, 77.0266, 1], 'existing unlocated branch gets the location');
});
