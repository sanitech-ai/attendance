'use strict';
const crypto = require('node:crypto');

// India Standard Time has no daylight saving, so a fixed offset is exact.
const TZ_OFFSET_MS = 330 * 60 * 1000;

function istDate(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function istTime(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(11, 16);
}

/** Epoch ms for a wall-clock IST date + "HH:MM". */
function istMs(date, hhmm) {
  return Date.parse(`${date}T${hhmm}:00Z`) - TZ_OFFSET_MS;
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthDates(month) {
  const n = daysInMonth(month);
  const out = [];
  for (let d = 1; d <= n; d++) out.push(`${month}-${String(d).padStart(2, '0')}`);
  return out;
}

/** Shift length in minutes; handles overnight shifts such as 22:00-06:00. */
function shiftMinutes(start, end) {
  if (!start || !end) return 9 * 60;
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  let diff = toMin(end) - toMin(start);
  if (diff <= 0) diff += 24 * 60;
  return diff;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- secrets -------------------------------------------------------------

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifySecret(secret, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---- file encryption (AES-256-GCM) ----------------------------------------

function encrypt(buf, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function decrypt(buf, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

// ---- validation ------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bad(message) {
  return new HttpError(400, message);
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function requireDate(s, name = 'date') {
  if (!isDate(s)) throw bad(`${name} must be YYYY-MM-DD`);
  return s;
}

function requireMonth(s) {
  if (!isMonth(s)) throw bad('month must be YYYY-MM');
  return s;
}

/** Rupees (number or string) -> integer paise. */
function toPaise(v, name = 'amount') {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${name} must be a non-negative number`);
  return Math.round(n * 100);
}

function sniffMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** Decode a data: URL, returning {mime, buf}; verifies the content really is the claimed type. */
function decodeDataUrl(dataUrl, allowed, maxBytes) {
  const m = typeof dataUrl === 'string' && dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/s);
  if (!m) throw bad('file must be a base64 data URL');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) throw bad(`file is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
  const mime = sniffMime(buf);
  if (!mime || !allowed.includes(mime)) throw bad(`file type not allowed (allowed: ${allowed.join(', ')})`);
  return { mime, buf };
}

module.exports = {
  istDate, istTime, istMs, addDays, weekday, daysInMonth, monthDates, shiftMinutes, haversineMeters,
  hashSecret, verifySecret, randomToken, sha256, encrypt, decrypt,
  HttpError, bad, isDate, isMonth, isTime, requireDate, requireMonth, toPaise, decodeDataUrl,
};
