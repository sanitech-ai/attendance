'use strict';
const crypto = require('node:crypto');
const { isDate, isTime } = require('./util');

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF, Excel BOM). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

// Header aliases -> canonical column names.
const COLUMNS = {
  employee_id: ['employee_id', 'employee id', 'emp id', 'code', 'id'],
  name: ['name', 'employee name'],
  phone: ['phone', 'mobile'],
  designation: ['designation'],
  branch: ['branch', 'site', 'site / location', 'location'],
  joined_on: ['joined_on', 'joining date', 'doj', 'date of joining'],
  salary_type: ['salary_type', 'salary type'],
  salary: ['salary', 'monthly salary', 'total salary'],
  shift_start: ['shift_start', 'shift start'],
  shift_end: ['shift_end', 'shift end'],
  weekly_off: ['weekly_off', 'weekly off', 'weekly offs'],
  branch_radius_m: ['branch_radius_m', 'branch radius', 'radius'],
  branch_maps_link: ['branch_maps_link', 'maps_link', 'google maps link', 'location link'],
  pin: ['pin'],
};
// Optional fixed monthly pay items: column -> [kind, label].
const PAY_COLUMNS = {
  pf: ['deduction', 'PF'],
  esic: ['deduction', 'ESIC'],
  pt: ['deduction', 'Professional Tax'],
  tds: ['deduction', 'TDS'],
  conveyance: ['addition', 'Conveyance'],
  room_rent: ['addition', 'Room Rent'],
};
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function normDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (isDate(s)) return s;
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/); // Indian DD-MM-YYYY
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  const iso = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isDate(iso) && new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso) ? iso : null;
}

function normWeeklyOff(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return '0';
  if (s === 'none') return '';
  const out = [];
  for (const part of s.split(/[\s,;/]+/).filter(Boolean)) {
    const i = /^[0-6]$/.test(part) ? Number(part) : DAY_NAMES.indexOf(part.slice(0, 3));
    if (i < 0) return null;
    out.push(String(i));
  }
  return [...new Set(out)].sort().join(',');
}

function money(v) {
  const s = String(v ?? '').replace(/[₹,\s]/g, '');
  if (s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/**
 * Validates an employee CSV against the database. Nothing is written.
 * Returns { rows: [{ line, data, items, errors }], newBranches: [name] }.
 */
function planImport(db, csvText) {
  const table = parseCsv(csvText);
  if (table.length < 2) return { error: 'The file needs a header row and at least one employee.' };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const [key, aliases] of Object.entries(COLUMNS)) idx[key] = header.findIndex((h) => aliases.includes(h));
  for (const key of Object.keys(PAY_COLUMNS)) idx[key] = header.indexOf(key);
  const missing = ['name', 'branch', 'salary'].filter((k) => idx[k] < 0);
  if (missing.length) return { error: `Missing column(s): ${missing.join(', ')}` };

  const branches = new Map(db.prepare('SELECT id, name, location_set FROM branches').all().map((b) => [b.name.trim().toLowerCase(), b]));
  const branchLinks = new Map(); // branch key -> Google Maps link (first one given in the file)
  const existingCodes = new Set(db.prepare('SELECT code FROM employees').all().map((e) => e.code.toLowerCase()));
  const seenCodes = new Set();
  const newBranches = new Map();
  const rows = [];

  table.slice(1).forEach((cells, i) => {
    const get = (k) => (idx[k] >= 0 ? String(cells[idx[k]] ?? '').trim() : '');
    const errors = [];
    const code = get('employee_id');
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(code)) errors.push('Employee ID missing or invalid');
    else if (existingCodes.has(code.toLowerCase())) errors.push(`Employee ID ${code} already exists`);
    else if (seenCodes.has(code.toLowerCase())) errors.push(`Employee ID ${code} appears twice in the file`);
    seenCodes.add(code.toLowerCase());
    const name = get('name');
    if (!name) errors.push('Name missing');
    const branch = get('branch');
    if (!branch) errors.push('Branch missing');
    const salaryType = (get('salary_type') || 'monthly').toLowerCase();
    if (salaryType !== 'monthly') errors.push('All staff are paid monthly (salary_type must be monthly or blank)');
    const salary = money(get('salary'));
    if (!salary) errors.push('Salary missing or invalid');
    const joined = normDate(get('joined_on'));
    if (joined === null) errors.push('Joining date must be DD-MM-YYYY');
    const shiftStart = get('shift_start') || '09:00';
    const shiftEnd = get('shift_end') || '18:00';
    if (!isTime(shiftStart) || !isTime(shiftEnd)) errors.push('Shift times must be HH:MM');
    const offs = normWeeklyOff(get('weekly_off'));
    if (offs === null) errors.push('Weekly off must be day names like Sun or Sat,Sun');
    const pin = get('pin');
    if (pin && !/^\d{4,6}$/.test(pin)) errors.push('PIN must be 4-6 digits');
    const radius = get('branch_radius_m') ? Number(get('branch_radius_m')) : 150;
    if (!Number.isInteger(radius) || radius < 20 || radius > 5000) errors.push('Branch radius must be 20-5000 m');

    const items = [];
    for (const [col, [kind, label]] of Object.entries(PAY_COLUMNS)) {
      const amount = money(get(col));
      if (amount === null) errors.push(`${label} amount is invalid`);
      else if (amount > 0) items.push({ kind, label, amount_paise: amount });
    }

    const branchKey = branch.toLowerCase();
    const link = get('branch_maps_link');
    if (link && !branchLinks.has(branchKey)) branchLinks.set(branchKey, link.slice(0, 2000));
    if (branch && !branches.has(branchKey) && !newBranches.has(branchKey)) newBranches.set(branchKey, { name: branch, radius_m: radius });
    rows.push({
      line: i + 2,
      errors,
      items,
      data: {
        code, name, branch, branchKey, phone: get('phone').slice(0, 20), designation: get('designation').slice(0, 60),
        salary_type: salaryType, salary_paise: salary, joined_on: joined || '', shift_start: shiftStart, shift_end: shiftEnd,
        weekly_offs: offs, pin, shift_given: !!(get('shift_start') || get('shift_end')),
      },
    });
  });
  // Links only matter for branches that are new or still have no location.
  for (const key of [...branchLinks.keys()]) {
    if (branches.get(key)?.location_set) branchLinks.delete(key);
  }
  return { rows, branches, newBranches: [...newBranches.values()], branchLinks };
}

function randomPin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

module.exports = { parseCsv, planImport, normDate, normWeeklyOff, randomPin };
