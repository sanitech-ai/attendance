'use strict';
const { bad, decodeDataUrl, HttpError } = require('./util');

const PUNCH_WINDOW_MS = 20 * 60 * 60 * 1000;
const DOC_TYPES = ['aadhaar', 'pan', 'bank', 'photo', 'other'];
const DOC_MIME = ['image/jpeg', 'image/png', 'application/pdf'];
const DOC_MAX_BYTES = 8 * 1024 * 1024;

/** Branches an employee may punch at: their own plus any extra locations an admin allowed. */
function allowedBranchIds(db, emp) {
  const extra = db.prepare('SELECT branch_id FROM employee_locations WHERE employee_id = ?').all(emp.id).map((r) => r.branch_id);
  return new Set([emp.branch_id, ...extra]);
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
  allowedBranchIds, publicEmployee, validPin, punchState, createDocument, normalizeDocNumber, sendStoredFile, notFound,
  assertMonthOpen, DOC_COLUMNS, DOC_TYPES,
};
