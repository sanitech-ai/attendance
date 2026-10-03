'use strict';
const express = require('express');
const { getSettings, tx } = require('../db');
const { computeRange, summarize } = require('../attendance');
const { computePayroll } = require('../payroll');
const { planImport, randomPin } = require('../importer');
const { resolveMapsLink } = require('../maps');
const {
  bad, HttpError, istDate, requireDate, requireMonth, daysInMonth, hashSecret, toPaise, isTime, isDate,
} = require('../util');
const {
  publicEmployee, validPin, createDocument, sendStoredFile, notFound, assertMonthOpen, DOC_COLUMNS,
} = require('../common');

const OVERRIDE_STATUSES = ['present', 'half_day', 'absent', 'paid_leave', 'unpaid_leave', 'week_off', 'holiday'];

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function sendCsv(res, filename, rows) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.send(`﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`);
}

const rupees = (p) => (p / 100).toFixed(2);
const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('Invalid id');
  return n;
};

module.exports = function adminRoutes(ctx) {
  const { db } = ctx;
  const r = express.Router();

  // ---- auth & first-run setup ----
  r.get('/setup-status', (req, res) => {
    res.json({ needs_setup: !db.prepare('SELECT 1 FROM admins LIMIT 1').get() });
  });

  r.post('/setup', (req, res) => {
    const { username, password, name, company_name } = req.body || {};
    if (db.prepare('SELECT 1 FROM admins LIMIT 1').get()) throw new HttpError(409, 'Setup is already complete');
    validateAdminInput(username, password, name);
    tx(db, () => {
      if (db.prepare('SELECT 1 FROM admins LIMIT 1').get()) throw new HttpError(409, 'Setup is already complete');
      const adminId = db
        .prepare('INSERT INTO admins (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(username.trim(), name.trim(), hashSecret(password), ctx.now()).lastInsertRowid;
      if (company_name) db.prepare("UPDATE settings SET value = ? WHERE key = 'company_name'").run(String(company_name).slice(0, 100));
      ctx.startSession(res, 'admin', Number(adminId));
    });
    res.json({ ok: true });
  });

  r.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') throw bad('Username and password are required');
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username.trim());
    ctx.checkLogin('admins', admin, password, 'password_hash');
    ctx.startSession(res, 'admin', admin.id);
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    ctx.endSession(req, res, 'admin');
    res.json({ ok: true });
  });

  r.use(ctx.requireSession('admin'));

  r.get('/me', (req, res) => res.json({ admin: req.admin, settings: getSettings(db) }));

  // ---- settings & admins ----
  r.get('/settings', (req, res) => res.json(getSettings(db)));

  r.put('/settings', (req, res) => {
    const b = req.body || {};
    const updates = {};
    if (b.company_name !== undefined) {
      if (!String(b.company_name).trim()) throw bad('Company name is required');
      updates.company_name = String(b.company_name).trim().slice(0, 100);
    }
    for (const [k, min, max] of [['half_day_hours', 0.5, 24], ['grace_minutes', 0, 240], ['late_warnings', 0, 31], ['late_max_minutes', 0, 480], ['max_accuracy_m', 10, 5000]]) {
      if (b[k] !== undefined) {
        const n = Number(b[k]);
        if (!Number.isFinite(n) || n < min || n > max) throw bad(`${k} must be between ${min} and ${max}`);
        updates[k] = String(n);
      }
    }
    if (b.ot_requires_approval !== undefined) updates.ot_requires_approval = b.ot_requires_approval ? '1' : '0';
    const st = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const [k, v] of Object.entries(updates)) st.run(v, k);
    ctx.audit(req, 'settings.updated', updates);
    res.json(getSettings(db));
  });

  r.get('/admins', (req, res) => res.json(db.prepare('SELECT id, username, name, created_at FROM admins ORDER BY id').all()));

  r.post('/admins', (req, res) => {
    const { username, password, name } = req.body || {};
    validateAdminInput(username, password, name);
    const newId = db
      .prepare('INSERT INTO admins (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username.trim(), name.trim(), hashSecret(password), ctx.now()).lastInsertRowid;
    ctx.audit(req, 'admin.created', { id: Number(newId), username });
    res.json({ ok: true, id: Number(newId) });
  });

  r.post('/password', (req, res) => {
    const { current_password, new_password } = req.body || {};
    const me = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
    ctx.checkLogin('admins', me, String(current_password ?? ''), 'password_hash');
    if (typeof new_password !== 'string' || new_password.length < 8) throw bad('New password must be at least 8 characters');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashSecret(new_password), me.id);
    ctx.audit(req, 'admin.password_changed');
    res.json({ ok: true });
  });

  r.get('/audit', (req, res) => {
    res.json(db.prepare(
      `SELECT l.*, COALESCE(a.name, e.name) AS actor_name FROM audit_log l
       LEFT JOIN admins a ON l.actor_kind = 'admin' AND a.id = l.actor_id
       LEFT JOIN employees e ON l.actor_kind = 'employee' AND e.id = l.actor_id
       ORDER BY l.id DESC LIMIT 300`,
    ).all());
  });

  // ---- branches ----
  r.get('/branches', (req, res) => {
    res.json(db.prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM employees e WHERE e.branch_id = b.id AND e.active = 1) AS employee_count
       FROM branches b ORDER BY b.active DESC, b.name`,
    ).all());
  });

  function branchInput(b) {
    const name = String(b.name || '').trim();
    if (!name) throw bad('Branch name is required');
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    if (b.lat === '' || b.lng === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw bad('Valid latitude and longitude are required');
    }
    const radius = Number(b.radius_m ?? 150);
    if (!Number.isInteger(radius) || radius < 20 || radius > 5000) throw bad('Radius must be 20 to 5000 metres');
    if (!['block', 'flag'].includes(b.geofence_mode)) throw bad('Geofence mode must be block or flag');
    return [name, String(b.address || '').slice(0, 300), lat, lng, radius, b.geofence_mode, b.active === false ? 0 : 1];
  }

  r.post('/branches', (req, res) => {
    const v = branchInput(req.body || {});
    const newId = db
      .prepare('INSERT INTO branches (name, address, lat, lng, radius_m, geofence_mode, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(...v, ctx.now()).lastInsertRowid;
    ctx.audit(req, 'branch.created', { id: Number(newId), name: v[0] });
    res.json({ ok: true, id: Number(newId) });
  });

  r.put('/branches/:id', (req, res) => {
    const v = branchInput(req.body || {});
    const result = db
      .prepare('UPDATE branches SET name = ?, address = ?, lat = ?, lng = ?, radius_m = ?, geofence_mode = ?, active = ?, location_set = 1 WHERE id = ?')
      .run(...v, id(req.params.id));
    if (!result.changes) throw notFound();
    ctx.audit(req, 'branch.updated', { id: Number(req.params.id) });
    res.json({ ok: true });
  });

  r.post('/maps/resolve', async (req, res) => {
    res.json(await resolveMapsLink(String(req.body?.link || '')));
  });

  // ---- employees ----
  r.get('/employees', (req, res) => {
    const rows = db.prepare(
      `SELECT e.*, b.name AS branch_name,
         (SELECT COUNT(*) FROM documents d WHERE d.employee_id = e.id) AS document_count
       FROM employees e JOIN branches b ON b.id = e.branch_id ORDER BY e.active DESC, e.name`,
    ).all();
    res.json(rows.map(publicEmployee));
  });

  r.get('/employees/:id', (req, res) => {
    const e = db.prepare('SELECT e.*, b.name AS branch_name FROM employees e JOIN branches b ON b.id = e.branch_id WHERE e.id = ?').get(id(req.params.id));
    if (!e) throw notFound();
    res.json(publicEmployee(e));
  });

  function employeeInput(b) {
    const code = String(b.code || '').trim();
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(code)) throw bad('Employee ID must be 1-20 letters, digits, - or _');
    if (!name) throw bad('Name is required');
    const branchId = id(b.branch_id);
    if (!db.prepare('SELECT 1 FROM branches WHERE id = ?').get(branchId)) throw bad('Branch not found');
    if (!['monthly', 'daily', 'hourly'].includes(b.salary_type)) throw bad('Salary type must be monthly, daily or hourly');
    const salary = toPaise(b.salary, 'Salary');
    if (!isTime(b.shift_start) || !isTime(b.shift_end)) throw bad('Shift times must be HH:MM');
    const offs = Array.isArray(b.weekly_offs) ? b.weekly_offs : String(b.weekly_offs ?? '').split(',').filter((x) => x !== '');
    if (offs.some((d) => !/^[0-6]$/.test(String(d)))) throw bad('Weekly offs must be days 0 (Sun) to 6 (Sat)');
    const joinedOn = String(b.joined_on ?? '').trim();
    if (joinedOn && !isDate(joinedOn)) throw bad('Joining date must be a valid date');
    return {
      code, name, branch_id: branchId, salary_type: b.salary_type, salary_paise: salary,
      phone: String(b.phone || '').slice(0, 20), designation: String(b.designation || '').slice(0, 60),
      shift_start: b.shift_start, shift_end: b.shift_end, weekly_offs: [...new Set(offs.map(String))].sort().join(','),
      joined_on: joinedOn, active: b.active === false ? 0 : 1,
    };
  }

  r.post('/employees', (req, res) => {
    const v = employeeInput(req.body || {});
    const pin = validPin(String(req.body.pin ?? ''));
    const newId = db
      .prepare(
        `INSERT INTO employees (code, name, phone, designation, branch_id, salary_type, salary_paise, shift_start, shift_end,
           weekly_offs, joined_on, active, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.code, v.name, v.phone, v.designation, v.branch_id, v.salary_type, v.salary_paise, v.shift_start, v.shift_end,
        v.weekly_offs, v.joined_on, v.active, hashSecret(pin), ctx.now()).lastInsertRowid;
    ctx.audit(req, 'employee.created', { id: Number(newId), code: v.code });
    res.json({ ok: true, id: Number(newId) });
  });

  r.put('/employees/:id', (req, res) => {
    const empId = id(req.params.id);
    const before = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
    if (!before) throw notFound();
    const v = employeeInput(req.body || {});
    db.prepare(
      `UPDATE employees SET code = ?, name = ?, phone = ?, designation = ?, branch_id = ?, salary_type = ?, salary_paise = ?,
         shift_start = ?, shift_end = ?, weekly_offs = ?, joined_on = ?, active = ? WHERE id = ?`,
    ).run(v.code, v.name, v.phone, v.designation, v.branch_id, v.salary_type, v.salary_paise, v.shift_start, v.shift_end,
      v.weekly_offs, v.joined_on, v.active, empId);
    if (!v.active) ctx.endAllSessions('employee', empId);
    const changed = Object.keys(v).filter((k) => String(before[k]) !== String(v[k]));
    ctx.audit(req, 'employee.updated', { id: empId, changed });
    res.json({ ok: true });
  });

  r.post('/employees/:id/reset-pin', (req, res) => {
    const empId = id(req.params.id);
    const pin = validPin(String(req.body?.pin ?? ''));
    const result = db.prepare('UPDATE employees SET pin_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashSecret(pin), empId);
    if (!result.changes) throw notFound();
    ctx.endAllSessions('employee', empId);
    ctx.audit(req, 'employee.pin_reset', { id: empId });
    res.json({ ok: true });
  });

  function pendingCounts() {
    return {
      flagged_punches: db.prepare("SELECT COUNT(*) AS n FROM punches WHERE status = 'flagged'").get().n,
      leaves: db.prepare("SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending'").get().n,
      documents: db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'pending'").get().n,
    };
  }

  r.get('/pending', (req, res) => res.json(pendingCounts()));

  // ---- fixed monthly pay items (PF, PT, allowances...) ----
  r.get('/employees/:id/pay-items', (req, res) => {
    res.json(db.prepare('SELECT * FROM pay_items WHERE employee_id = ? ORDER BY kind, id').all(id(req.params.id)));
  });

  r.post('/employees/:id/pay-items', (req, res) => {
    const empId = id(req.params.id);
    if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(empId)) throw notFound();
    const { kind, label } = req.body || {};
    if (!['addition', 'deduction'].includes(kind)) throw bad('Kind must be addition or deduction');
    if (!String(label || '').trim()) throw bad('Label is required (e.g. PF)');
    const amount = toPaise(req.body.amount);
    if (!amount) throw bad('Amount must be more than zero');
    const newId = db.prepare('INSERT INTO pay_items (employee_id, kind, label, amount_paise, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(empId, kind, String(label).trim().slice(0, 60), amount, ctx.now()).lastInsertRowid;
    ctx.audit(req, 'pay_item.created', { employee_id: empId, kind, label, amount: rupees(amount) });
    res.json({ ok: true, id: Number(newId) });
  });

  r.delete('/pay-items/:id', (req, res) => {
    const item = db.prepare('SELECT * FROM pay_items WHERE id = ?').get(id(req.params.id));
    if (!item) throw notFound();
    db.prepare('DELETE FROM pay_items WHERE id = ?').run(item.id);
    ctx.audit(req, 'pay_item.deleted', { employee_id: item.employee_id, label: item.label, amount: rupees(item.amount_paise) });
    res.json({ ok: true });
  });

  // ---- bulk import from CSV ----
  r.post('/employees/import', (req, res) => {
    const { csv, dry_run: dryRun } = req.body || {};
    if (typeof csv !== 'string' || !csv.trim()) throw bad('Choose a CSV file');
    if (csv.length > 2_000_000) throw bad('File is too large');
    const plan = planImport(db, csv);
    if (plan.error) throw bad(plan.error);
    const summary = plan.rows.map((r) => ({
      line: r.line, code: r.data.code, name: r.data.name, branch: r.data.branch, designation: r.data.designation,
      salary_paise: r.data.salary_paise, joined_on: r.data.joined_on, items: r.items, errors: r.errors,
    }));
    const errorCount = plan.rows.filter((r) => r.errors.length).length;
    if (dryRun || errorCount) {
      return res.json({ dry_run: true, rows: summary, new_branches: plan.newBranches, error_count: errorCount });
    }
    const created = tx(db, () => {
      const branchIds = new Map([...plan.branches].map(([k, b]) => [k, b.id]));
      for (const nb of plan.newBranches) {
        // Location comes later (admin pastes a Google Maps link); until then punches here are flagged.
        const bid = db.prepare(
          `INSERT INTO branches (name, address, lat, lng, radius_m, geofence_mode, active, location_set, created_at)
           VALUES (?, '', 0, 0, ?, 'flag', 1, 0, ?)`,
        ).run(nb.name, nb.radius_m, ctx.now()).lastInsertRowid;
        branchIds.set(nb.name.toLowerCase(), Number(bid));
      }
      const insEmp = db.prepare(
        `INSERT INTO employees (code, name, phone, designation, branch_id, salary_type, salary_paise, shift_start, shift_end,
           weekly_offs, joined_on, active, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      );
      const insItem = db.prepare('INSERT INTO pay_items (employee_id, kind, label, amount_paise, created_at) VALUES (?, ?, ?, ?, ?)');
      return plan.rows.map(({ data: d, items }) => {
        const pin = d.pin || randomPin();
        const empId = insEmp.run(d.code, d.name, d.phone, d.designation, branchIds.get(d.branchKey), d.salary_type, d.salary_paise,
          d.shift_start, d.shift_end, d.weekly_offs, d.joined_on, hashSecret(pin), ctx.now()).lastInsertRowid;
        for (const it of items) insItem.run(empId, it.kind, it.label, it.amount_paise, ctx.now());
        return { code: d.code, name: d.name, branch: d.branch, pin };
      });
    });
    ctx.audit(req, 'employees.imported', { count: created.length, new_branches: plan.newBranches.map((b) => b.name) });
    res.json({ ok: true, created, new_branches: plan.newBranches });
  });

  // ---- dashboard ----
  r.get('/dashboard', (req, res) => {
    const date = req.query.date ? requireDate(req.query.date) : istDate(ctx.now());
    const settings = getSettings(db);
    const emps = db.prepare(
      `SELECT e.*, b.name AS branch_name FROM employees e JOIN branches b ON b.id = e.branch_id
       WHERE e.active = 1 ORDER BY b.name, e.name`,
    ).all();
    const lastPunch = db.prepare(
      `SELECT p.id, p.kind, p.at, p.status, p.flag_reason, p.distance_m, b.name AS branch_name FROM punches p
       LEFT JOIN branches b ON b.id = p.branch_id WHERE p.employee_id = ? AND p.work_date = ? ORDER BY p.at DESC LIMIT 1`,
    );
    const rows = emps.map((e) => {
      const [day] = computeRange(db, e, date, date, settings, ctx.now());
      return { employee_id: e.id, code: e.code, name: e.name, branch_id: e.branch_id, branch_name: e.branch_name, day, last_punch: lastPunch.get(e.id, date) || null };
    });
    const count = (s) => rows.filter((x) => s.includes(x.day.status)).length;
    res.json({
      date,
      totals: {
        employees: rows.length,
        in: count(['present', 'half_day', 'working']),
        absent: count(['absent', 'not_marked']),
        on_leave: count(['paid_leave', 'unpaid_leave']),
        off: count(['week_off', 'holiday']),
        late: rows.filter((x) => x.day.late_minutes > 0).length,
        on_ot: rows.filter((x) => x.last_punch?.kind === 'OT_IN').length,
      },
      pending: pendingCounts(),
      rows,
    });
  });

  // ---- punches ----
  r.get('/punches', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.date) { where.push('p.work_date = ?'); params.push(requireDate(req.query.date)); }
    if (req.query.status) { where.push('p.status = ?'); params.push(String(req.query.status)); }
    if (req.query.employee_id) { where.push('p.employee_id = ?'); params.push(id(req.query.employee_id)); }
    if (req.query.branch_id) { where.push('e.branch_id = ?'); params.push(id(req.query.branch_id)); }
    const rows = db.prepare(
      `SELECT p.id, p.employee_id, p.kind, p.at, p.work_date, p.lat, p.lng, p.accuracy_m, p.distance_m, p.inside_geofence,
         p.status, p.flag_reason, p.reviewed_at, e.code, e.name, b.name AS branch_name, hb.name AS home_branch_name
       FROM punches p JOIN employees e ON e.id = p.employee_id
       LEFT JOIN branches b ON b.id = p.branch_id JOIN branches hb ON hb.id = e.branch_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.at DESC LIMIT 500`,
    ).all(...params);
    res.json(rows);
  });

  r.get('/punches/:id/selfie', (req, res) => {
    const p = db.prepare('SELECT selfie_file FROM punches WHERE id = ?').get(id(req.params.id));
    if (!p) throw notFound();
    sendStoredFile(ctx, res, p.selfie_file, 'image/jpeg', `selfie-${req.params.id}.jpg`);
  });

  r.post('/punches/:id/review', (req, res) => {
    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) throw bad('Status must be approved or rejected');
    const p = db.prepare('SELECT * FROM punches WHERE id = ?').get(id(req.params.id));
    if (!p) throw notFound();
    assertMonthOpen(db, p.work_date.slice(0, 7));
    db.prepare('UPDATE punches SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(status, req.admin.id, ctx.now(), p.id);
    ctx.audit(req, `punch.${status}`, { id: p.id, employee_id: p.employee_id, work_date: p.work_date, kind: p.kind });
    res.json({ ok: true });
  });

  // ---- attendance register & overrides ----
  function monthRange(month) {
    return [`${month}-01`, `${month}-${String(daysInMonth(month)).padStart(2, '0')}`];
  }

  function registerEmployees(branchId) {
    return db.prepare(
      `SELECT e.*, b.name AS branch_name FROM employees e JOIN branches b ON b.id = e.branch_id
       WHERE e.active = 1 ${branchId ? 'AND e.branch_id = ?' : ''} ORDER BY b.name, e.name`,
    ).all(...(branchId ? [branchId] : []));
  }

  r.get('/attendance', (req, res) => {
    const month = requireMonth(req.query.month);
    const [from, to] = monthRange(month);
    const settings = getSettings(db);
    const emps = registerEmployees(req.query.branch_id ? id(req.query.branch_id) : null);
    const rows = emps.map((e) => {
      const days = computeRange(db, e, from, to, settings, ctx.now());
      return { employee_id: e.id, code: e.code, name: e.name, branch_name: e.branch_name, days, summary: summarize(days) };
    });
    const finalized = !!db.prepare('SELECT 1 FROM payroll_runs WHERE month = ?').get(month);
    res.json({ month, finalized, rows });
  });

  r.get('/attendance/:employeeId', (req, res) => {
    const month = requireMonth(req.query.month);
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id(req.params.employeeId));
    if (!emp) throw notFound();
    const [from, to] = monthRange(month);
    const days = computeRange(db, emp, from, to, getSettings(db), ctx.now());
    res.json({ month, employee: publicEmployee(emp), days, summary: summarize(days) });
  });

  r.put('/attendance/override', (req, res) => {
    const { employee_id, date, status, worked_minutes, note } = req.body || {};
    requireDate(date);
    const empId = id(employee_id);
    assertMonthOpen(db, date.slice(0, 7));
    if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(empId)) throw notFound();
    if (status === null || status === '') {
      db.prepare('DELETE FROM day_overrides WHERE employee_id = ? AND work_date = ?').run(empId, date);
      ctx.audit(req, 'attendance.override_cleared', { employee_id: empId, date });
      return res.json({ ok: true });
    }
    if (!OVERRIDE_STATUSES.includes(status)) throw bad('Unknown status');
    let minutes = null;
    if (worked_minutes !== undefined && worked_minutes !== null && worked_minutes !== '') {
      minutes = Number(worked_minutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw bad('Worked minutes must be 0-1440');
    }
    db.prepare(
      `INSERT INTO day_overrides (employee_id, work_date, status, worked_minutes, note, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (employee_id, work_date) DO UPDATE SET status = excluded.status, worked_minutes = excluded.worked_minutes,
         note = excluded.note, set_by = excluded.set_by, set_at = excluded.set_at`,
    ).run(empId, date, status, minutes, String(note || '').slice(0, 300), req.admin.id, ctx.now());
    ctx.audit(req, 'attendance.override_set', { employee_id: empId, date, status, worked_minutes: minutes, note });
    res.json({ ok: true });
  });

  r.get('/attendance.csv', (req, res) => {
    const month = requireMonth(req.query.month);
    const [from, to] = monthRange(month);
    const settings = getSettings(db);
    const codes = { present: 'P', half_day: 'HD', absent: 'A', paid_leave: 'PL', unpaid_leave: 'UL', week_off: 'WO', holiday: 'H', not_marked: '-', upcoming: '', not_joined: '', working: 'W' };
    const emps = registerEmployees(req.query.branch_id ? id(req.query.branch_id) : null);
    const header = ['Employee ID', 'Name', 'Branch'];
    const dates = [];
    for (let d = from; d <= to; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) dates.push(d);
    header.push(...dates.map((d) => d.slice(8)), 'Present', 'Half days', 'Absent', 'Paid leave', 'Unpaid leave', 'Week off', 'Holiday', 'Late days', 'Hours worked', 'OT hours (approved)');
    const rows = [header];
    for (const e of emps) {
      const days = computeRange(db, e, from, to, settings, ctx.now());
      const s = summarize(days);
      rows.push([
        e.code, e.name, e.branch_name, ...days.map((d) => codes[d.status] ?? d.status),
        s.present, s.half_day, s.absent + s.not_marked, s.paid_leave, s.unpaid_leave, s.week_off, s.holiday, s.late_days,
        (s.worked_minutes / 60).toFixed(2), (s.ot_payable_minutes / 60).toFixed(2),
      ]);
    }
    sendCsv(res, `attendance-${month}.csv`, rows);
  });

  // ---- overtime ----
  r.get('/overtime', (req, res) => {
    const month = requireMonth(req.query.month);
    const [from, to] = monthRange(month);
    const settings = getSettings(db);
    const emps = db.prepare(
      `SELECT DISTINCT e.*, b.name AS branch_name FROM employees e JOIN branches b ON b.id = e.branch_id
       JOIN punches p ON p.employee_id = e.id AND p.kind IN ('OT_IN', 'OT_OUT') AND p.work_date BETWEEN ? AND ?
       ORDER BY e.name`,
    ).all(from, to);
    const out = [];
    for (const e of emps) {
      for (const d of computeRange(db, e, from, to, settings, ctx.now())) {
        if (d.ot_minutes > 0 || d.flags.includes('missing_ot_out')) {
          out.push({ employee_id: e.id, code: e.code, name: e.name, branch_name: e.branch_name, ...d });
        }
      }
    }
    out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name)));
    res.json({ month, requires_approval: settings.ot_requires_approval, rows: out });
  });

  r.post('/overtime/decision', (req, res) => {
    const { employee_id, date, status, approved_minutes } = req.body || {};
    requireDate(date);
    const empId = id(employee_id);
    assertMonthOpen(db, date.slice(0, 7));
    if (status === null) {
      db.prepare('DELETE FROM ot_decisions WHERE employee_id = ? AND work_date = ?').run(empId, date);
      return res.json({ ok: true });
    }
    if (!['approved', 'rejected'].includes(status)) throw bad('Status must be approved or rejected');
    let minutes = null;
    if (status === 'approved' && approved_minutes !== undefined && approved_minutes !== null && approved_minutes !== '') {
      minutes = Number(approved_minutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw bad('Approved minutes must be 0-1440');
    }
    db.prepare(
      `INSERT INTO ot_decisions (employee_id, work_date, status, approved_minutes, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (employee_id, work_date) DO UPDATE SET status = excluded.status, approved_minutes = excluded.approved_minutes,
         decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
    ).run(empId, date, status, minutes, req.admin.id, ctx.now());
    ctx.audit(req, `overtime.${status}`, { employee_id: empId, date, approved_minutes: minutes });
    res.json({ ok: true });
  });

  // ---- leaves ----
  r.get('/leaves', (req, res) => {
    const status = req.query.status;
    res.json(db.prepare(
      `SELECT l.*, e.code, e.name FROM leave_requests l JOIN employees e ON e.id = l.employee_id
       ${status ? 'WHERE l.status = ?' : ''} ORDER BY l.status = 'pending' DESC, l.from_date DESC LIMIT 300`,
    ).all(...(status ? [String(status)] : [])));
  });

  r.post('/leaves/:id/decision', (req, res) => {
    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) throw bad('Status must be approved or rejected');
    const l = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id(req.params.id));
    if (!l) throw notFound();
    if (!['pending', 'approved', 'rejected'].includes(l.status)) throw bad('This request was cancelled');
    for (const m of new Set([l.from_date.slice(0, 7), l.to_date.slice(0, 7)])) assertMonthOpen(db, m);
    db.prepare('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, req.admin.id, ctx.now(), l.id);
    ctx.audit(req, `leave.${status}`, { id: l.id, employee_id: l.employee_id });
    res.json({ ok: true });
  });

  // ---- holidays ----
  r.get('/holidays', (req, res) => {
    const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : istDate(ctx.now()).slice(0, 4);
    res.json(db.prepare(
      `SELECT h.*, b.name AS branch_name FROM holidays h LEFT JOIN branches b ON b.id = h.branch_id
       WHERE h.date LIKE ? ORDER BY h.date`,
    ).all(`${year}-%`));
  });

  r.post('/holidays', (req, res) => {
    const { date, name, branch_id } = req.body || {};
    requireDate(date);
    if (!String(name || '').trim()) throw bad('Holiday name is required');
    assertMonthOpen(db, date.slice(0, 7));
    const newId = db.prepare('INSERT INTO holidays (date, name, branch_id) VALUES (?, ?, ?)')
      .run(date, String(name).trim().slice(0, 80), branch_id ? id(branch_id) : null).lastInsertRowid;
    ctx.audit(req, 'holiday.created', { date, name });
    res.json({ ok: true, id: Number(newId) });
  });

  r.delete('/holidays/:id', (req, res) => {
    const h = db.prepare('SELECT * FROM holidays WHERE id = ?').get(id(req.params.id));
    if (!h) throw notFound();
    assertMonthOpen(db, h.date.slice(0, 7));
    db.prepare('DELETE FROM holidays WHERE id = ?').run(h.id);
    ctx.audit(req, 'holiday.deleted', { date: h.date, name: h.name });
    res.json({ ok: true });
  });

  // ---- advances & adjustments ----
  r.get('/advances', (req, res) => {
    const month = requireMonth(req.query.month);
    res.json(db.prepare(
      `SELECT a.*, e.code, e.name FROM advances a JOIN employees e ON e.id = a.employee_id
       WHERE a.deduct_month = ? ORDER BY a.given_on DESC`,
    ).all(month));
  });

  r.post('/advances', (req, res) => {
    const b = req.body || {};
    const empId = id(b.employee_id);
    requireDate(b.given_on, 'given_on');
    requireMonth(b.deduct_month);
    assertMonthOpen(db, b.deduct_month);
    const amount = toPaise(b.amount);
    if (!amount) throw bad('Amount must be more than zero');
    const newId = db.prepare('INSERT INTO advances (employee_id, amount_paise, given_on, deduct_month, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(empId, amount, b.given_on, b.deduct_month, String(b.note || '').slice(0, 200), ctx.now()).lastInsertRowid;
    ctx.audit(req, 'advance.created', { employee_id: empId, amount: rupees(amount), deduct_month: b.deduct_month });
    res.json({ ok: true, id: Number(newId) });
  });

  r.delete('/advances/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM advances WHERE id = ?').get(id(req.params.id));
    if (!a) throw notFound();
    assertMonthOpen(db, a.deduct_month);
    db.prepare('DELETE FROM advances WHERE id = ?').run(a.id);
    ctx.audit(req, 'advance.deleted', { employee_id: a.employee_id, amount: rupees(a.amount_paise) });
    res.json({ ok: true });
  });

  r.get('/adjustments', (req, res) => {
    const month = requireMonth(req.query.month);
    res.json(db.prepare(
      `SELECT a.*, e.code, e.name FROM adjustments a JOIN employees e ON e.id = a.employee_id
       WHERE a.month = ? ORDER BY e.name, a.id`,
    ).all(month));
  });

  r.post('/adjustments', (req, res) => {
    const b = req.body || {};
    const empId = id(b.employee_id);
    requireMonth(b.month);
    assertMonthOpen(db, b.month);
    if (!['addition', 'deduction'].includes(b.kind)) throw bad('Kind must be addition or deduction');
    const label = String(b.label || '').trim();
    if (!label) throw bad('Label is required (e.g. Bonus, Fine)');
    const amount = toPaise(b.amount);
    if (!amount) throw bad('Amount must be more than zero');
    const newId = db.prepare('INSERT INTO adjustments (employee_id, month, kind, amount_paise, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(empId, b.month, b.kind, amount, label.slice(0, 80), ctx.now()).lastInsertRowid;
    ctx.audit(req, 'adjustment.created', { employee_id: empId, month: b.month, kind: b.kind, amount: rupees(amount), label });
    res.json({ ok: true, id: Number(newId) });
  });

  r.delete('/adjustments/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM adjustments WHERE id = ?').get(id(req.params.id));
    if (!a) throw notFound();
    assertMonthOpen(db, a.month);
    db.prepare('DELETE FROM adjustments WHERE id = ?').run(a.id);
    ctx.audit(req, 'adjustment.deleted', { employee_id: a.employee_id, label: a.label });
    res.json({ ok: true });
  });

  // ---- documents ----
  r.get('/documents', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.employee_id) { where.push('d.employee_id = ?'); params.push(id(req.query.employee_id)); }
    if (req.query.status) { where.push('d.status = ?'); params.push(String(req.query.status)); }
    res.json(db.prepare(
      `SELECT ${DOC_COLUMNS.split(',').map((c) => `d.${c.trim()}`).join(', ')}, e.code, e.name FROM documents d
       JOIN employees e ON e.id = d.employee_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY d.status = 'pending' DESC, d.uploaded_at DESC LIMIT 500`,
    ).all(...params));
  });

  r.post('/documents', (req, res) => {
    const empId = id(req.body?.employee_id);
    if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(empId)) throw notFound();
    const newId = createDocument(ctx, empId, req.body, 'admin');
    db.prepare("UPDATE documents SET status = 'verified', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(req.admin.id, ctx.now(), newId);
    ctx.audit(req, 'document.uploaded', { id: newId, employee_id: empId, doc_type: req.body.doc_type });
    res.json({ ok: true, id: newId });
  });

  r.get('/documents/:id/file', (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(id(req.params.id));
    if (!d) throw notFound();
    ctx.audit(req, 'document.viewed', { id: d.id, employee_id: d.employee_id, doc_type: d.doc_type });
    sendStoredFile(ctx, res, d.stored_file, d.mime, `${d.doc_type}-${d.id}`);
  });

  r.post('/documents/:id/review', (req, res) => {
    const { status, note } = req.body || {};
    if (!['verified', 'rejected'].includes(status)) throw bad('Status must be verified or rejected');
    const result = db.prepare('UPDATE documents SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
      .run(status, String(note || '').slice(0, 200), req.admin.id, ctx.now(), id(req.params.id));
    if (!result.changes) throw notFound();
    ctx.audit(req, `document.${status}`, { id: Number(req.params.id) });
    res.json({ ok: true });
  });

  r.delete('/documents/:id', (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(id(req.params.id));
    if (!d) throw notFound();
    db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
    ctx.deleteFile(d.stored_file);
    ctx.audit(req, 'document.deleted', { id: d.id, employee_id: d.employee_id, doc_type: d.doc_type });
    res.json({ ok: true });
  });

  // ---- payroll ----
  function payrollFor(month) {
    const run = db.prepare('SELECT * FROM payroll_runs WHERE month = ?').get(month);
    if (run) {
      const admin = db.prepare('SELECT name FROM admins WHERE id = ?').get(run.finalized_by);
      return { ...JSON.parse(run.data_json), finalized: true, finalized_at: run.finalized_at, finalized_by: admin?.name ?? null };
    }
    return { ...computePayroll(db, month, getSettings(db), ctx.now()), finalized: false };
  }

  r.get('/payroll', (req, res) => res.json(payrollFor(requireMonth(req.query.month))));

  r.post('/payroll/:month/finalize', (req, res) => {
    const month = requireMonth(req.params.month);
    if (month >= istDate(ctx.now()).slice(0, 7)) throw bad('Only past months can be finalized');
    tx(db, () => {
      assertMonthOpen(db, month);
      const data = computePayroll(db, month, getSettings(db), ctx.now());
      const pendingOt = data.rows.filter((x) => x.attendance.ot_pending_minutes > 0);
      if (pendingOt.length && !req.body?.ignore_pending_ot) {
        throw new HttpError(409, `${pendingOt.length} employee(s) have overtime waiting for approval. Approve or reject it first.`);
      }
      db.prepare('INSERT INTO payroll_runs (month, finalized_at, finalized_by, data_json) VALUES (?, ?, ?, ?)')
        .run(month, ctx.now(), req.admin.id, JSON.stringify(data));
    });
    ctx.audit(req, 'payroll.finalized', { month });
    res.json({ ok: true });
  });

  r.delete('/payroll/:month/finalize', (req, res) => {
    const month = requireMonth(req.params.month);
    const result = db.prepare('DELETE FROM payroll_runs WHERE month = ?').run(month);
    if (!result.changes) throw notFound('This month is not finalized');
    ctx.audit(req, 'payroll.reopened', { month });
    res.json({ ok: true });
  });

  r.get('/payroll.csv', (req, res) => {
    const month = requireMonth(req.query.month);
    const p = payrollFor(month);
    const rows = [[
      'Employee ID', 'Name', 'Branch', 'Salary type', 'Salary (Rs)', 'Paid days', 'Present', 'Half days', 'Absent',
      'Paid leave', 'Week off', 'Holiday', 'OT hours', 'Base pay', 'OT pay', 'Additions', 'Deductions', 'Advances', 'Net pay',
    ]];
    for (const x of p.rows) {
      const a = x.attendance;
      const sum = (xs) => xs.reduce((t, y) => t + y.amount_paise, 0);
      rows.push([
        x.code, x.name, x.branch_name, x.salary_type, rupees(x.salary_paise), x.paid_days, a.present, a.half_day,
        a.absent + a.not_marked, a.paid_leave, a.week_off, a.holiday, x.ot_hours, rupees(x.base_paise), rupees(x.ot_paise),
        rupees(sum(x.additions)), rupees(sum(x.deductions)), rupees(sum(x.advances)), rupees(x.net_paise),
      ]);
    }
    rows.push(['TOTAL', '', '', '', '', '', '', '', '', '', '', '', '', rupees(p.totals.base_paise), rupees(p.totals.ot_paise), '', '', '', rupees(p.totals.net_paise)]);
    sendCsv(res, `payroll-${month}.csv`, rows);
  });

  return r;
};

function validateAdminInput(username, password, name) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{3,40}$/.test(username.trim())) throw bad('Username must be 3-40 letters/digits');
  if (typeof password !== 'string' || password.length < 8) throw bad('Password must be at least 8 characters');
  if (typeof name !== 'string' || !name.trim()) throw bad('Name is required');
}
