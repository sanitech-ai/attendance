'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  address       TEXT NOT NULL DEFAULT '',
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  radius_m      INTEGER NOT NULL DEFAULT 150,
  geofence_mode TEXT NOT NULL DEFAULT 'flag' CHECK (geofence_mode IN ('block', 'flag')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  designation   TEXT NOT NULL DEFAULT '',
  branch_id     INTEGER NOT NULL REFERENCES branches(id),
  salary_type   TEXT NOT NULL CHECK (salary_type IN ('monthly', 'daily', 'hourly')),
  salary_paise  INTEGER NOT NULL,
  shift_start   TEXT NOT NULL DEFAULT '09:00',
  shift_end     TEXT NOT NULL DEFAULT '18:00',
  weekly_offs   TEXT NOT NULL DEFAULT '0',
  joined_on     TEXT NOT NULL,
  pin_hash      TEXT NOT NULL,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('admin', 'employee')),
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS punches (
  id              INTEGER PRIMARY KEY,
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  kind            TEXT NOT NULL CHECK (kind IN ('IN', 'OUT', 'OT_IN', 'OT_OUT')),
  at              INTEGER NOT NULL,
  work_date       TEXT NOT NULL,
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  accuracy_m      REAL,
  branch_id       INTEGER REFERENCES branches(id),
  distance_m      REAL,
  inside_geofence INTEGER NOT NULL,
  selfie_file     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ok', 'flagged', 'approved', 'rejected')),
  flag_reason     TEXT,
  user_agent      TEXT,
  reviewed_by     INTEGER REFERENCES admins(id),
  reviewed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS punches_emp_date ON punches(employee_id, work_date);
CREATE INDEX IF NOT EXISTS punches_date ON punches(work_date);

CREATE TABLE IF NOT EXISTS ot_decisions (
  employee_id      INTEGER NOT NULL REFERENCES employees(id),
  work_date        TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  approved_minutes INTEGER,
  decided_by       INTEGER REFERENCES admins(id),
  decided_at       INTEGER NOT NULL,
  PRIMARY KEY (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS day_overrides (
  employee_id    INTEGER NOT NULL REFERENCES employees(id),
  work_date      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('present', 'half_day', 'absent', 'paid_leave', 'unpaid_leave', 'week_off', 'holiday')),
  worked_minutes INTEGER,
  note           TEXT NOT NULL DEFAULT '',
  set_by         INTEGER REFERENCES admins(id),
  set_at         INTEGER NOT NULL,
  PRIMARY KEY (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  from_date   TEXT NOT NULL,
  to_date     TEXT NOT NULL,
  leave_type  TEXT NOT NULL CHECK (leave_type IN ('paid', 'unpaid')),
  reason      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by  INTEGER REFERENCES admins(id),
  decided_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS holidays (
  id        INTEGER PRIMARY KEY,
  date      TEXT NOT NULL,
  name      TEXT NOT NULL,
  branch_id INTEGER REFERENCES branches(id)
);

CREATE TABLE IF NOT EXISTS advances (
  id           INTEGER PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  amount_paise INTEGER NOT NULL,
  given_on     TEXT NOT NULL,
  deduct_month TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adjustments (
  id           INTEGER PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  month        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('addition', 'deduction')),
  amount_paise INTEGER NOT NULL,
  label        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id                INTEGER PRIMARY KEY,
  employee_id       INTEGER NOT NULL REFERENCES employees(id),
  doc_type          TEXT NOT NULL CHECK (doc_type IN ('aadhaar', 'pan', 'bank', 'photo', 'other')),
  label             TEXT NOT NULL DEFAULT '',
  doc_number        TEXT NOT NULL DEFAULT '',
  mime              TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  stored_file       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  review_note       TEXT NOT NULL DEFAULT '',
  uploaded_by       TEXT NOT NULL CHECK (uploaded_by IN ('admin', 'employee')),
  uploaded_at       INTEGER NOT NULL,
  reviewed_by       INTEGER REFERENCES admins(id),
  reviewed_at       INTEGER
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  month        TEXT PRIMARY KEY,
  finalized_at INTEGER NOT NULL,
  finalized_by INTEGER REFERENCES admins(id),
  data_json    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id   INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT ''
);
`;

const DEFAULT_SETTINGS = {
  company_name: 'Sanitech',
  half_day_hours: '4',
  grace_minutes: '15',
  max_accuracy_m: '100',
  ot_requires_approval: '1',
};

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    company_name: s.company_name,
    half_day_hours: Number(s.half_day_hours),
    grace_minutes: Number(s.grace_minutes),
    max_accuracy_m: Number(s.max_accuracy_m),
    ot_requires_approval: s.ot_requires_approval === '1',
  };
}

module.exports = { openDb, tx, getSettings, DEFAULT_SETTINGS };
