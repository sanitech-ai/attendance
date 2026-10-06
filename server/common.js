'use strict';
const { bad, decodeDataUrl, HttpError, haversineMeters, fmtKm } = require('./util');

const PUNCH_WINDOW_MS = 20 * 60 * 60 * 1000;
const DOC_TYPES = ['aadhaar', 'pan', 'bank', 'photo', 'other'];
const DOC_MIME = ['image/jpeg', 'image/png', 'application/pdf'];
const DOC_MAX_BYTES = 8 * 1024 * 1024;

/**
 * What an employee still has to provide: phone, Aadhaar, PAN, and a way to be paid (UPI or bank).
 * A rejected document counts as missing.
 */
function profileMissing(db, emp) {
  const docs = new Set(db.prepare("SELECT doc_type FROM documents WHERE employee_id = ? AND status != 'rejected'").all(emp.id).map((d) => d.doc_type));
  const missing = [];
  if (!/\d{10}$/.test(String(emp.phone || '').replace(/\D/g, ''))) missing.push('phone');
  if (!docs.has('aadhaar')) missing.push('aadhaar');
  if (!docs.has('pan')) missing.push('pan');
  if (!emp.upi_id && !(emp.bank_account && emp.bank_ifsc)) missing.push('payment');
  return missing;
}

const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Validates phone / UPI / bank fields (any subset); returns normalised values. */
function paymentDetails(b) {
  const out = {};
  if (b.phone !== undefined) {
    const digits = String(b.phone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    if (digits && !/^[6-9]\d{9}$/.test(digits)) throw bad('Enter a 10-digit mobile number');
    out.phone = digits;
  }
  if (b.upi_id !== undefined) {
    const upi = String(b.upi_id || '').trim();
    if (upi && !UPI_RE.test(upi)) throw bad('UPI ID looks wrong — it should look like name@okhdfcbank or 98xxxxxx@ybl');
    out.upi_id = upi;
  }
  if (b.bank_account !== undefined || b.bank_ifsc !== undefined) {
    const acct = String(b.bank_account || '').replace(/\s/g, '');
    const ifsc = String(b.bank_ifsc || '').trim().toUpperCase();
    if (acct && !/^\d{9,18}$/.test(acct)) throw bad('Bank account number should be 9 to 18 digits');
    if (ifsc && !IFSC_RE.test(ifsc)) throw bad('IFSC should look like HDFC0001234');
    if (!!acct !== !!ifsc) throw bad('Enter both the bank account number and the IFSC code');
    out.bank_account = acct;
    out.bank_ifsc = ifsc;
  }
  return out;
}

/**
 * Where a punch was taken, relative to the company's sites. Inside any of the employee's own sites
 * counts; otherwise the distance is to the closest company site of any kind (so someone next to the
 * head office isn't shown as "300 km from <another site>"), plus how far they are from their own branch.
 */
function measurePunch(db, emp, lat, lng, acc, settings, note = '') {
  const allowed = allowedBranchIds(db, emp);
  const measured = db.prepare('SELECT * FROM branches WHERE active = 1 AND location_set = 1').all()
    .map((b) => ({ branch: b, distance: haversineMeters(lat, lng, b.lat, b.lng) }))
    .sort((x, y) => x.distance - y.distance);
  const insideAt = measured.find((m) => allowed.has(m.branch.id) && m.distance <= m.branch.radius_m);
  const nearest = insideAt || measured[0] || null;
  const inside = !!insideAt;
  const home = db.prepare('SELECT * FROM branches WHERE id = ?').get(emp.branch_id);
  const homeLocated = !!home?.location_set;
  const homeDist = homeLocated ? measured.find((m) => m.branch.id === home.id)?.distance : null;

  const flags = [];
  // Inside a company site that isn't one of theirs: say so, so the admin sees why it was flagged.
  const otherSite = !inside && measured.find((m) => !allowed.has(m.branch.id) && m.distance <= m.branch.radius_m)?.branch;
  if (!inside && note) flags.push(`off-site: “${note}”`);
  if (otherSite) flags.push(`at ${otherSite.name}, which is not one of their locations`);
  else if (!homeLocated && !inside) flags.push(`location of ${home?.name || 'home branch'} not set yet`);
  else if (!inside) {
    flags.push(nearest
      ? `outside geofence (${fmtKm(nearest.distance)} from ${nearest.branch.name}${allowed.has(nearest.branch.id) ? '' : ', not one of their locations'})`
      : 'no branch configured');
  }
  if (!inside && homeDist != null && nearest && nearest.branch.id !== home.id) flags.push(`${fmtKm(homeDist)} from their branch ${home.name}`);
  if (acc === null || acc === undefined) flags.push('GPS accuracy unknown');
  else if (acc > settings.max_accuracy_m) flags.push(`low GPS accuracy (±${Math.round(acc)} m)`);
  return { nearest, inside, flags, mode: homeLocated ? home.geofence_mode : 'flag' };
}

/** Branches an employee may punch at: their own plus any extra locations an admin allowed. */
function allowedBranchIds(db, emp) {
  const extra = db.prepare('SELECT branch_id FROM employee_locations WHERE employee_id = ?').all(emp.id).map((r) => r.branch_id);
  const linked = db.prepare('SELECT other_id FROM branch_links WHERE branch_id = ?').all(emp.branch_id).map((r) => r.other_id);
  return new Set([emp.branch_id, ...extra, ...linked]);
}

function publicEmployee(e) {
  if (!e) return e;
  const { pin_hash, failed_logins, locked_until, ...rest } = e;
  return rest;
}

function validPin(pin) {
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) throw bad('PIN must be 4 to 6 digits');
  return pin;
}

/** Open regular / OT sessions in the last 20 hours decide which punch is allowed next. */
function punchState(db, employeeId, nowMs) {
  const rows = db
    .prepare(
      `SELECT id, kind, at, work_date FROM punches
       WHERE employee_id = ? AND at > ? AND status != 'rejected' ORDER BY at`,
    )
    .all(employeeId, nowMs - PUNCH_WINDOW_MS);
  let openIn = null;
  let openOt = null;
  for (const p of rows) {
    if (p.kind === 'IN') openIn = p;
    else if (p.kind === 'OUT') openIn = null;
    else if (p.kind === 'OT_IN') openOt = p;
    else if (p.kind === 'OT_OUT') openOt = null;
  }
  const allowed = openOt ? ['OT_OUT'] : openIn ? ['OUT'] : ['IN', 'OT_IN'];
  return { openIn, openOt, allowed, last: rows[rows.length - 1] || null };
}

/** Normalises and validates a document number; Aadhaar is never stored in full. */
function normalizeDocNumber(type, raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (type === 'aadhaar') {
    const digits = value.replace(/\D/g, '');
    if (digits.length !== 12) throw bad('Aadhaar number must have 12 digits');
    return `XXXX XXXX ${digits.slice(-4)}`;
  }
  if (type === 'pan') {
    const pan = value.toUpperCase().replace(/\s/g, '');
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw bad('PAN must look like ABCDE1234F');
    return pan;
  }
  if (type === 'bank') {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 6) throw bad('Account number looks too short');
    return `XXXX${digits.slice(-4)}`;
  }
  return value.slice(0, 60);
}

function createDocument(ctx, employeeId, body, uploadedBy) {
  if (!DOC_TYPES.includes(body.doc_type)) throw bad('Unknown document type');
  const docNumber = normalizeDocNumber(body.doc_type, body.doc_number);
  if (['aadhaar', 'pan'].includes(body.doc_type) && !docNumber) throw bad('Document number is required');
  const { mime, buf } = decodeDataUrl(body.file, DOC_MIME, DOC_MAX_BYTES);
  const stored = ctx.saveFile(buf);
  const r = ctx.db
    .prepare(
      `INSERT INTO documents (employee_id, doc_type, label, doc_number, mime, size_bytes, stored_file, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(employeeId, body.doc_type, String(body.label || '').slice(0, 80), docNumber, mime, buf.length, stored, uploadedBy, ctx.now());
  return Number(r.lastInsertRowid);
}

const DOC_COLUMNS = `id, employee_id, doc_type, label, doc_number, mime, size_bytes, status, review_note,
  uploaded_by, uploaded_at, reviewed_at`;

function sendStoredFile(ctx, res, storedFile, mime, filename) {
  if (!storedFile) throw notFound('This photo was deleted');
  const buf = ctx.readFile(storedFile);
  res.set({
    'Content-Type': mime,
    'Content-Disposition': `inline; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
  });
  // Uploads are content-sniffed to JPEG/PNG/PDF; Chrome's PDF viewer refuses to run under a sandbox CSP.
  if (mime.startsWith('image/')) res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.send(buf);
}

function notFound(what = 'Not found') {
  return new HttpError(404, what);
}

function assertMonthOpen(db, month) {
  if (db.prepare('SELECT 1 FROM payroll_runs WHERE month = ?').get(month)) {
    throw new HttpError(409, `Payroll for ${month} is finalized. Reopen it first to make changes.`);
  }
}

module.exports = {
  allowedBranchIds, measurePunch, profileMissing, paymentDetails, publicEmployee, validPin, punchState, createDocument, normalizeDocNumber, sendStoredFile, notFound,
  assertMonthOpen, DOC_COLUMNS, DOC_TYPES,
};
