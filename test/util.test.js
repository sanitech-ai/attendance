'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../server/util');
const { normalizeDocNumber } = require('../server/common');

test('IST date/time helpers', () => {
  const ms = Date.parse('2026-09-30T20:00:00Z'); // 01:30 IST next day
  assert.equal(u.istDate(ms), '2026-10-01');
  assert.equal(u.istTime(ms), '01:30');
  assert.equal(u.istMs('2026-10-01', '01:30'), ms);
  assert.equal(u.daysInMonth('2026-02'), 28);
  assert.equal(u.daysInMonth('2028-02'), 29);
  assert.equal(u.monthDates('2026-09').length, 30);
});

test('shift length handles overnight shifts', () => {
  assert.equal(u.shiftMinutes('09:30', '18:30'), 540);
  assert.equal(u.shiftMinutes('22:00', '06:00'), 480);
});

test('haversine distance is roughly right', () => {
  // ~111 m per 0.001 degree latitude
  const d = u.haversineMeters(19.0, 72.8, 19.001, 72.8);
  assert.ok(d > 105 && d < 117, String(d));
});

test('secrets hash and verify', () => {
  const h = u.hashSecret('1234');
  assert.ok(u.verifySecret('1234', h));
  assert.ok(!u.verifySecret('1235', h));
});

test('file encryption round-trips and detects tampering', () => {
  const key = Buffer.alloc(32, 7);
  const enc = u.encrypt(Buffer.from('hello'), key);
  assert.equal(u.decrypt(enc, key).toString(), 'hello');
  enc[enc.length - 1] ^= 1;
  assert.throws(() => u.decrypt(enc, key));
});

test('document numbers are validated and Aadhaar is masked', () => {
  assert.equal(normalizeDocNumber('aadhaar', '1234 5678 9012'), 'XXXX XXXX 9012');
  assert.throws(() => normalizeDocNumber('aadhaar', '1234'));
  assert.equal(normalizeDocNumber('pan', 'abcde1234f'), 'ABCDE1234F');
  assert.throws(() => normalizeDocNumber('pan', 'ABC123'));
  assert.equal(normalizeDocNumber('bank', '001234567890'), 'XXXX7890');
});
