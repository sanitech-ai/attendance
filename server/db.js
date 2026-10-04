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
  joined_on     TEXT NOT NULL DEFAULT '', -- '' when unknown
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

-- Admin's call on arrivals later than late_max_minutes: count the day as full or half.
CREATE TABLE IF NOT EXISTS late_decisions (
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('present', 'half_day')),
  decided_by  INTEGER REFERENCES admins(id),
  decided_at  INTEGER NOT NULL,
  PRIMARY KEY (employee_id, work_date)
);

-- Selfies taken during the day at outside places (banks, GST office, clients); reviewed by an admin.
CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  at          INTEGER NOT NULL,
  work_date   TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy_m  REAL,
  note        TEXT NOT NULL,
  selfie_file TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by INTEGER REFERENCES admins(id),
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS visits_date ON visits(work_date);

-- Extra branches (besides their own) where an employee may punch in/out.
CREATE TABLE IF NOT EXISTS employee_locations (
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  branch_id   INTEGER NOT NULL REFERENCES branches(id),
  PRIMARY KEY (employee_id, branch_id)
);

-- A manager's check of something the app flagged. ref is the punch id, or "employee_id:date".
CREATE TABLE IF NOT EXISTS verifications (
  kind        TEXT NOT NULL CHECK (kind IN ('punch', 'late', 'overtime')),
  ref         TEXT NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('ok', 'doubt')),
  note        TEXT NOT NULL DEFAULT '',
  manager_id  INTEGER NOT NULL REFERENCES employees(id),
  at          INTEGER NOT NULL,
  PRIMARY KEY (kind, ref)
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

-- Recurring monthly earnings/deductions (PF, ESIC, PT, TDS, conveyance, room rent...).
CREATE TABLE IF NOT EXISTS pay_items (
  id           INTEGER PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  kind         TEXT NOT NULL CHECK (kind IN ('addition', 'deduction')),
  label        TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pay_items_emp ON pay_items(employee_id);

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
  // Warnings between half days: 2 means every 3rd late in a month (3rd, 6th, 9th...) is a half day.
  late_warnings: '2',
  // Arriving later than this needs an admin to decide full or half day.
  late_max_minutes: '60',
  // Staff can see salary statements from this month onwards.
  salary_visible_from: '2026-10',
  max_accuracy_m: '100',
  ot_requires_approval: '1',
};

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

/** Additive migrations for databases created by earlier versions. */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(branches)').all().map((c) => c.name);
  if (!cols.includes('location_set')) {
    // 0 = branch created (e.g. by import) before its GPS location was entered.
    db.exec('ALTER TABLE branches ADD COLUMN location_set INTEGER NOT NULL DEFAULT 1');
  }
  if (!cols.includes('maps_link')) db.exec("ALTER TABLE branches ADD COLUMN maps_link TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('field_visits')) db.exec('ALTER TABLE branches ADD COLUMN field_visits INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('shift_start')) {
    // Office timings per branch; staff who follow their branch get these copied into their shift.
    db.exec("ALTER TABLE branches ADD COLUMN shift_start TEXT NOT NULL DEFAULT '09:00'");
    db.exec("ALTER TABLE branches ADD COLUMN shift_end TEXT NOT NULL DEFAULT '18:00'");
  }

  const adminCols = db.prepare('PRAGMA table_info(admins)').all().map((c) => c.name);
  if (!adminCols.includes('can_edit_attendance')) {
    // Only some admins may change attendance markings. On upgrade, give it to firefueled and
    // amitsharma (amit.sharma etc.); if neither exists, to the first admin so someone has it.
    db.exec('ALTER TABLE admins ADD COLUMN can_edit_attendance INTEGER NOT NULL DEFAULT 0');
    const granted = db.prepare(
      `UPDATE admins SET can_edit_attendance = 1
       WHERE lower(replace(replace(replace(username, '.', ''), '_', ''), '-', '')) IN ('firefueled', 'amitsharma')`,
    ).run().changes;
    if (!granted) db.exec('UPDATE admins SET can_edit_attendance = 1 WHERE id = (SELECT MIN(id) FROM admins)');
  }

  const empCols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
  if (!empCols.includes('upi_id')) {
    // Where staff want their salary paid (they can fill these in themselves).
    db.exec("ALTER TABLE employees ADD COLUMN upi_id TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE employees ADD COLUMN bank_account TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE employees ADD COLUMN bank_ifsc TEXT NOT NULL DEFAULT ''");
  }
  if (!empCols.includes('follow_branch_shift')) {
    db.exec('ALTER TABLE employees ADD COLUMN follow_branch_shift INTEGER NOT NULL DEFAULT 1');
    // Anyone already on a personal shift keeps it.
    db.exec(`UPDATE employees SET follow_branch_shift = 0 WHERE shift_start != '09:00' OR shift_end != '18:00'`);
  }
  if (!empCols.includes('allow_offsite')) {
    // Staff of "block" branches who may still punch from a bank, client office etc. (with a note).
    db.exec('ALTER TABLE employees ADD COLUMN allow_offsite INTEGER NOT NULL DEFAULT 0');
  }
  const punchCols = db.prepare('PRAGMA table_info(punches)').all().map((c) => c.name);
  if (!punchCols.includes('note')) {
    // Off-site punches: where the employee says they are, and the address the GPS points to.
    db.exec('ALTER TABLE punches ADD COLUMN note TEXT');
    db.exec('ALTER TABLE punches ADD COLUMN place TEXT');
  }
  const visitCols = db.prepare('PRAGMA table_info(visits)').all().map((c) => c.name);
  if (!visitCols.includes('place')) db.exec('ALTER TABLE visits ADD COLUMN place TEXT');
  if (!empCols.includes('last_login_at')) {
    // Tells the admin who has started using the app (and so already knows their PIN).
    db.exec('ALTER TABLE employees ADD COLUMN last_login_at INTEGER');
    db.exec(`UPDATE employees SET last_login_at = (SELECT MAX(at) FROM punches p WHERE p.employee_id = employees.id)`);
  }
  if (!empCols.includes('is_manager')) {
    // Managers can mark app-flagged items as verified/doubtful; they cannot change anything.
    db.exec('ALTER TABLE employees ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0');
    db.exec("ALTER TABLE employees ADD COLUMN manager_scope TEXT NOT NULL DEFAULT 'branch'");
  }
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
    late_warnings: Number(s.late_warnings),
    late_max_minutes: Number(s.late_max_minutes),
    salary_visible_from: s.salary_visible_from,
    max_accuracy_m: Number(s.max_accuracy_m),
    ot_requires_approval: s.ot_requires_approval === '1',
  };
}

module.exports = { openDb, tx, getSettings, DEFAULT_SETTINGS };
