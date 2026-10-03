'use strict';
const express = require('express');
const { getSettings } = require('../db');
const { computeRange, summarize } = require('../attendance');
const {
  bad, HttpError, istDate, haversineMeters, decodeDataUrl, requireDate, requireMonth, daysInMonth, hashSecret,
} = require('../util');
const {
  publicEmployee, validPin, punchState, createDocument, sendStoredFile, notFound, DOC_COLUMNS,
} = require('../common');

const PUNCH_KINDS = ['IN', 'OUT', 'OT_IN', 'OT_OUT'];
const SELFIE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Staff API. With { preview: true } the same handlers are mounted under the admin API so admins can see
 * exactly what an employee sees: the caller sets req.employee, and anything but GET is refused.
 */
module.exports = function employeeRoutes(ctx, { preview = false } = {}) {
  const { db } = ctx;
  const r = express.Router();

  if (preview) {
    r.use((req, res, next) => {
      if (req.method !== 'GET') throw new HttpError(403, 'This is a preview — nothing can be changed here.');
      next();
    });
  } else {
    r.post('/login', (req, res) => {
      const { code, pin } = req.body || {};
      if (typeof code !== 'string' || typeof pin !== 'string') throw bad('Employee ID and PIN are required');
      const emp = db.prepare('SELECT * FROM employees WHERE code = ? AND active = 1').get(code.trim());
      ctx.checkLogin('employees', emp, pin, 'pin_hash');
      ctx.startSession(res, 'employee', emp.id);
      res.json({ ok: true });
    });

    r.post('/logout', (req, res) => {
      ctx.endSession(req, res, 'employee');
      res.json({ ok: true });
    });

    r.use(ctx.requireSession('employee'));
  }

  r.get('/me', (req, res) => {
    const branch = db.prepare('SELECT id, name, address FROM branches WHERE id = ?').get(req.employee.branch_id);
    const settings = getSettings(db);
    res.json({
      employee: publicEmployee(req.employee),
      branch,
      company_name: settings.company_name,
      late_warnings: settings.late_warnings,
      grace_minutes: settings.grace_minutes,
    });
  });

  r.post('/pin', (req, res) => {
    const { current_pin, new_pin } = req.body || {};
    ctx.checkLogin('employees', req.employee, String(current_pin ?? ''), 'pin_hash');
    validPin(new_pin);
    db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(hashSecret(new_pin), req.employee.id);
    ctx.audit(req, 'employee.pin_changed');
    res.json({ ok: true });
  });

  r.get('/today', (req, res) => {
    const now = ctx.now();
    const emp = req.employee;
    const state = punchState(db, emp.id, now);
    const today = istDate(now);
    const workDate = state.openIn?.work_date || state.openOt?.work_date || today;
    const settings = getSettings(db);
    const [day] = computeRange(db, emp, workDate, workDate, settings, now);
    const punches = db
      .prepare(
        `SELECT id, kind, at, status, flag_reason, distance_m, inside_geofence, branch_id FROM punches
         WHERE employee_id = ? AND work_date = ? ORDER BY at`,
      )
      .all(emp.id, workDate);
    const branches = db.prepare('SELECT id, name, lat, lng, radius_m FROM branches WHERE active = 1 AND location_set = 1').all();
    res.json({
      server_time: now,
      work_date: workDate,
      allowed: state.allowed,
      day,
      punches,
      branches,
      home_branch_id: emp.branch_id,
      shift: { start: emp.shift_start, end: emp.shift_end },
    });
  });

  r.post('/punch', (req, res) => {
    const now = ctx.now();
    const emp = req.employee;
    const { kind, lat, lng, accuracy, selfie } = req.body || {};
    if (!PUNCH_KINDS.includes(kind)) throw bad('Unknown punch type');
    if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw bad('Location is required. Allow location access and try again.');
    }
    const acc = typeof accuracy === 'number' && accuracy >= 0 ? accuracy : null;
    const { buf } = decodeDataUrl(selfie, ['image/jpeg'], SELFIE_MAX_BYTES);

    const state = punchState(db, emp.id, now);
    if (!state.allowed.includes(kind)) {
      throw new HttpError(409, `You can't do that right now. Allowed: ${state.allowed.join(', ')}`);
    }
    if (state.last && now - state.last.at < 60000) {
      throw new HttpError(409, 'You just punched. Wait a minute before punching again.');
    }

    const settings = getSettings(db);
    // Branches whose GPS location hasn't been entered yet can't be measured against.
    const branches = db.prepare('SELECT * FROM branches WHERE active = 1 AND location_set = 1').all();
    let nearest = null;
    for (const b of branches) {
      const d = haversineMeters(lat, lng, b.lat, b.lng);
      if (!nearest || d < nearest.distance) nearest = { branch: b, distance: d };
    }
    const inside = !!nearest && nearest.distance <= nearest.branch.radius_m;
    const home = db.prepare('SELECT * FROM branches WHERE id = ?').get(emp.branch_id);
    const homeLocated = !!home?.location_set;
    const mode = homeLocated ? home.geofence_mode : 'flag';

    if (!inside && mode === 'block') {
      const where = nearest ? `${Math.round(nearest.distance)} m from ${nearest.branch.name}` : 'not near any branch';
      throw new HttpError(403, `You are ${where}. Punch from inside the branch. If you are inside, wait for a better GPS signal and retry.`);
    }

    const flags = [];
    if (!homeLocated && !inside) flags.push(`location of ${home?.name || 'home branch'} not set yet`);
    else if (!inside) flags.push(nearest ? `outside geofence (${Math.round(nearest.distance)} m from ${nearest.branch.name})` : 'no branch configured');
    if (acc === null) flags.push('GPS accuracy unknown');
    else if (acc > settings.max_accuracy_m) flags.push(`low GPS accuracy (±${Math.round(acc)} m)`);

    const workDate = kind === 'OUT' ? state.openIn.work_date : kind === 'OT_OUT' ? state.openOt.work_date : istDate(now);
    const file = ctx.saveFile(buf);
    const result = db
      .prepare(
        `INSERT INTO punches (employee_id, kind, at, work_date, lat, lng, accuracy_m, branch_id, distance_m,
           inside_geofence, selfie_file, status, flag_reason, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        emp.id, kind, now, workDate, lat, lng, acc, nearest?.branch.id ?? null,
        nearest ? Math.round(nearest.distance) : null, inside ? 1 : 0, file,
        flags.length ? 'flagged' : 'ok', flags.join('; ') || null, String(req.headers['user-agent'] || '').slice(0, 200),
      );
    let late = null;
    if (kind === 'IN') {
      const [day] = computeRange(db, emp, workDate, workDate, settings, now);
      if (day.late_mark) {
        late = { minutes: day.late_minutes, mark: day.late_mark, warnings: settings.late_warnings, half_day: day.flags.includes('late_penalty') };
      }
    }
    res.json({
      ok: true,
      id: Number(result.lastInsertRowid),
      late,
      at: now,
      status: flags.length ? 'flagged' : 'ok',
      flag_reason: flags.join('; ') || null,
      branch_name: nearest?.branch.name ?? null,
      distance_m: nearest ? Math.round(nearest.distance) : null,
    });
  });

  r.get('/punches/:id/selfie', (req, res) => {
    const p = db.prepare('SELECT selfie_file FROM punches WHERE id = ? AND employee_id = ?').get(Number(req.params.id), req.employee.id);
    if (!p) throw notFound();
    sendStoredFile(ctx, res, p.selfie_file, 'image/jpeg', `selfie-${req.params.id}.jpg`);
  });

  r.get('/attendance', (req, res) => {
    const month = requireMonth(req.query.month);
    const from = `${month}-01`;
    const to = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
    const days = computeRange(db, req.employee, from, to, getSettings(db), ctx.now());
    res.json({ month, days, summary: summarize(days) });
  });

  // ---- leaves ----
  r.get('/leaves', (req, res) => {
    res.json(db.prepare('SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY from_date DESC LIMIT 100').all(req.employee.id));
  });

  r.post('/leaves', (req, res) => {
    const { from_date, to_date, leave_type, reason } = req.body || {};
    requireDate(from_date, 'from_date');
    requireDate(to_date, 'to_date');
    if (to_date < from_date) throw bad('End date is before start date');
    if ((Date.parse(to_date) - Date.parse(from_date)) / 86400000 > 60) throw bad('Leave can be at most 60 days at a time');
    if (!['paid', 'unpaid'].includes(leave_type)) throw bad('Leave type must be paid or unpaid');
    const id = db
      .prepare('INSERT INTO leave_requests (employee_id, from_date, to_date, leave_type, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.employee.id, from_date, to_date, leave_type, String(reason || '').slice(0, 500), ctx.now()).lastInsertRowid;
    res.json({ ok: true, id: Number(id) });
  });

  r.post('/leaves/:id/cancel', (req, res) => {
    const result = db
      .prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id = ? AND employee_id = ? AND status = 'pending'")
      .run(Number(req.params.id), req.employee.id);
    if (!result.changes) throw bad('Only pending requests can be cancelled');
    res.json({ ok: true });
  });

  // ---- documents ----
  r.get('/documents', (req, res) => {
    res.json(db.prepare(`SELECT ${DOC_COLUMNS} FROM documents WHERE employee_id = ? ORDER BY uploaded_at DESC`).all(req.employee.id));
  });

  r.post('/documents', (req, res) => {
    const id = createDocument(ctx, req.employee.id, req.body || {}, 'employee');
    ctx.audit(req, 'document.uploaded', { id, doc_type: req.body.doc_type });
    res.json({ ok: true, id });
  });

  r.get('/documents/:id/file', (req, res) => {
    const d = db.prepare('SELECT * FROM documents WHERE id = ? AND employee_id = ?').get(Number(req.params.id), req.employee.id);
    if (!d) throw notFound();
    sendStoredFile(ctx, res, d.stored_file, d.mime, `${d.doc_type}-${d.id}`);
  });

  // ---- payslips (only finalized months) ----
  r.get('/payslips', (req, res) => {
    const runs = db.prepare('SELECT month, data_json FROM payroll_runs ORDER BY month DESC').all();
    const list = [];
    for (const run of runs) {
      const row = JSON.parse(run.data_json).rows.find((x) => x.employee_id === req.employee.id);
      if (row) list.push({ month: run.month, net_paise: row.net_paise });
    }
    res.json(list);
  });

  r.get('/payslips/:month', (req, res) => {
    const month = requireMonth(req.params.month);
    const run = db.prepare('SELECT data_json FROM payroll_runs WHERE month = ?').get(month);
    const data = run && JSON.parse(run.data_json);
    const row = data?.rows.find((x) => x.employee_id === req.employee.id);
    if (!row) throw notFound('No payslip for this month');
    res.json({ month, company_name: data.company_name, row });
  });

  return r;
};
