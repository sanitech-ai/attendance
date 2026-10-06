'use strict';
const express = require('express');
const { getSettings } = require('../db');
const { computeRange, summarize } = require('../attendance');
const { employeeSalary } = require('../payroll');
const {
  bad, HttpError, istDate, haversineMeters, fmtKm, decodeDataUrl, requireDate, requireMonth, daysInMonth, hashSecret,
} = require('../util');
const {
  allowedBranchIds, measurePunch, profileMissing, paymentDetails, publicEmployee, validPin, punchState, createDocument, sendStoredFile, notFound, DOC_COLUMNS,
} = require('../common');

const { addressAt } = require('../maps');

const PUNCH_KINDS = ['IN', 'OUT', 'OT_IN', 'OT_OUT'];
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
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
      db.prepare('UPDATE employees SET last_login_at = ? WHERE id = ?').run(ctx.now(), emp.id);
      res.json({ ok: true });
    });

    r.post('/logout', (req, res) => {
      ctx.endSession(req, res, 'employee');
      res.json({ ok: true });
    });

    r.use(ctx.requireSession('employee'));
  }

  r.get('/me', (req, res) => {
    const branch = db.prepare('SELECT id, name, address, field_visits FROM branches WHERE id = ?').get(req.employee.branch_id);
    const settings = getSettings(db);
    res.json({
      employee: publicEmployee(req.employee),
      branch,
      can_visit: !!branch?.field_visits,
      profile_missing: profileMissing(db, req.employee),
      company_name: settings.company_name,
      late_warnings: settings.late_warnings,
      late_max_minutes: settings.late_max_minutes,
      salary_visible_from: settings.salary_visible_from,
      grace_minutes: settings.grace_minutes,
      late_offsets_ot: settings.late_offsets_ot,
    });
  });

  // Staff fill in their own phone number and where they want to be paid.
  r.post('/profile', (req, res) => {
    const v = paymentDetails(req.body || {});
    const cols = Object.keys(v);
    if (!cols.length) throw bad('Nothing to save');
    db.prepare(`UPDATE employees SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => v[c]), req.employee.id);
    ctx.audit(req, 'employee.profile_updated', { fields: cols });
    const fresh = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.employee.id);
    res.json({ ok: true, profile_missing: profileMissing(db, fresh) });
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
        `SELECT p.id, p.kind, p.at, p.status, p.flag_reason, p.distance_m, p.inside_geofence, p.branch_id, p.note, p.place, b.name AS branch_name
         FROM punches p LEFT JOIN branches b ON b.id = p.branch_id
         WHERE p.employee_id = ? AND p.work_date = ? ORDER BY p.at`,
      )
      .all(emp.id, workDate);
    const allowed = allowedBranchIds(db, emp);
    const branches = db.prepare('SELECT id, name, lat, lng, radius_m FROM branches WHERE active = 1 AND location_set = 1').all()
      .map((b) => ({ ...b, mine: allowed.has(b.id) }));
    res.json({
      server_time: now,
      work_date: workDate,
      allowed: state.allowed,
      day,
      punches,
      branches,
      home_branch_id: emp.branch_id,
      offsite_allowed: !!emp.allow_offsite || db.prepare('SELECT geofence_mode, location_set FROM branches WHERE id = ?').get(emp.branch_id)?.geofence_mode !== 'block',
      max_accuracy_m: settings.max_accuracy_m,
      shift: { start: emp.shift_start, end: emp.shift_end },
      can_visit: !!db.prepare('SELECT field_visits FROM branches WHERE id = ?').get(emp.branch_id)?.field_visits,
      on_duty: !!state.openIn,
      visits: db.prepare('SELECT id, at, note, place, status, lat, lng FROM visits WHERE employee_id = ? AND work_date = ? ORDER BY at').all(emp.id, workDate),
    });
  });

  // ---- visit selfies: staff who go out during the day (banks, GST office, clients) ----
  r.post('/visit', (req, res) => {
    const now = ctx.now();
    const emp = req.employee;
    const branch = db.prepare('SELECT field_visits FROM branches WHERE id = ?').get(emp.branch_id);
    if (!branch?.field_visits) throw new HttpError(403, 'Field visit selfies are not turned on for your branch');
    const { lat, lng, accuracy, selfie, note } = req.body || {};
    const place = String(note || '').trim();
    if (!place) throw bad('Write where you are (e.g. HDFC Bank, Banjara Hills)');
    if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw bad('Location is required. Allow location access and try again.');
    }
    const { buf } = decodeDataUrl(selfie, ['image/jpeg'], SELFIE_MAX_BYTES);
    const state = punchState(db, emp.id, now);
    if (!state.openIn) throw new HttpError(409, 'Punch in first — field visit selfies are for while you are on duty.');
    const last = db.prepare('SELECT at FROM visits WHERE employee_id = ? ORDER BY at DESC LIMIT 1').get(emp.id);
    if (last && now - last.at < 60000) throw new HttpError(409, 'You just added a visit. Wait a minute before adding another.');
    const file = ctx.saveFile(buf);
    const id = db.prepare(
      'INSERT INTO visits (employee_id, at, work_date, lat, lng, accuracy_m, note, selfie_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(emp.id, now, state.openIn.work_date, lat, lng, typeof accuracy === 'number' ? accuracy : null, place.slice(0, 200), file).lastInsertRowid;
    fillPlace('visits', id, lat, lng);
    res.json({ ok: true, id: Number(id), at: now });
  });

  r.get('/visits/:id/selfie', (req, res) => {
    const v = db.prepare('SELECT selfie_file FROM visits WHERE id = ? AND employee_id = ?').get(Number(req.params.id), req.employee.id);
    if (!v) throw notFound();
    sendStoredFile(ctx, res, v.selfie_file, 'image/jpeg', `visit-${req.params.id}.jpg`);
  });

  /** Looks up the street address in the background so the punch itself is never slowed down. */
  function fillPlace(table, rowId, lat, lng) {
    addressAt(lat, lng, ctx.fetch)
      .then((place) => { if (place) db.prepare(`UPDATE ${table} SET place = ? WHERE id = ?`).run(place, Number(rowId)); })
      .catch(() => {});
  }

  // Address preview for the camera screen (at most one lookup every 3 seconds per person).
  const lastLookup = new Map();
  r.get('/place', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw bad('lat and lng are required');
    const t = Date.now();
    if (t - (lastLookup.get(req.employee.id) || 0) < 3000) throw new HttpError(429, 'Too many lookups');
    lastLookup.set(req.employee.id, t);
    res.json({ place: await addressAt(lat, lng, ctx.fetch).catch(() => '') });
  });

  r.post('/punch', (req, res) => {
    const now = ctx.now();
    const emp = req.employee;
    const { kind, lat, lng, accuracy, selfie } = req.body || {};
    const note = String(req.body?.note || '').trim().slice(0, 200);
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
    const { nearest, inside, mode, flags } = measurePunch(db, emp, lat, lng, acc, settings, note);
    if (!inside && mode === 'block' && !emp.allow_offsite) {
      const where = nearest ? `${fmtKm(nearest.distance)} from ${nearest.branch.name}` : 'not near any branch';
      throw new HttpError(403, `You are ${where}. Punch from inside one of your sites. If you are inside, wait for a better GPS signal and retry.`);
    }
    // Punching from a bank, GST office, client office…: they must say where; an admin approves it.
    if (!inside && note.length < 3) throw bad('You are not at one of your sites. Write where you are punching from (e.g. HDFC Bank Ameerpet, client office).');

    const workDate = kind === 'OUT' ? state.openIn.work_date : kind === 'OT_OUT' ? state.openOt.work_date : istDate(now);
    const file = ctx.saveFile(buf);
    const result = db
      .prepare(
        `INSERT INTO punches (employee_id, kind, at, work_date, lat, lng, accuracy_m, branch_id, distance_m,
           inside_geofence, selfie_file, status, flag_reason, user_agent, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        emp.id, kind, now, workDate, lat, lng, acc, nearest?.branch.id ?? null,
        nearest ? Math.round(nearest.distance) : null, inside ? 1 : 0, file,
        flags.length ? 'flagged' : 'ok', flags.join('; ') || null, String(req.headers['user-agent'] || '').slice(0, 200),
        inside ? null : note,
      );
    if (!inside) fillPlace('punches', result.lastInsertRowid, lat, lng);
    let late = null;
    if (kind === 'IN') {
      const monthDays = computeRange(db, emp, `${workDate.slice(0, 7)}-01`, workDate, settings, now);
      const day = monthDays[monthDays.length - 1];
      const monthLate = monthDays.filter((d) => d.late_minutes > 0);
      const totals = { month_days: monthLate.length, month_minutes: monthLate.reduce((t, d) => t + d.late_minutes, 0) };
      if (day.late_review) {
        late = { minutes: day.late_minutes, review: true, ...totals };
      } else if (day.late_mark) {
        late = { minutes: day.late_minutes, mark: day.late_mark, every: settings.late_warnings + 1, half_day: day.flags.includes('late_penalty'), ...totals };
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
  // ---- managers: check what the app flagged for their team (read + verify only, no changes) ----
  function teamOf(manager) {
    if (!manager.is_manager) throw new HttpError(403, 'Only managers can see this');
    const rows = manager.manager_scope === 'all'
      ? db.prepare('SELECT e.*, b.name AS branch_name FROM employees e JOIN branches b ON b.id = e.branch_id WHERE e.active = 1 AND e.id != ?').all(manager.id)
      : db.prepare('SELECT e.*, b.name AS branch_name FROM employees e JOIN branches b ON b.id = e.branch_id WHERE e.active = 1 AND e.id != ? AND e.branch_id = ?').all(manager.id, manager.branch_id);
    return new Map(rows.map((e) => [e.id, e]));
  }

  function verificationMap(kind) {
    return new Map(db.prepare('SELECT ref, verdict, note, at FROM verifications WHERE kind = ?').all(kind).map((v) => [v.ref, v]));
  }

  /** Pending very-late days and pending overtime for the team, current and previous month. */
  function teamDayFlags(team) {
    const now = ctx.now();
    const today = istDate(now);
    const settings = getSettings(db);
    const prev = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    prev.setUTCMonth(prev.getUTCMonth() - 1);
    const from = prev.toISOString().slice(0, 10);
    const late = [];
    const overtime = [];
    for (const e of team.values()) {
      for (const d of computeRange(db, e, from, today, settings, now)) {
        const who = { employee_id: e.id, code: e.code, name: e.name, branch_name: e.branch_name, date: d.date };
        if (d.late_review === 'pending') late.push({ ...who, first_in: d.first_in, last_out: d.last_out, late_minutes: d.late_minutes, worked_minutes: d.worked_minutes, shift_start: e.shift_start });
        if (d.ot_status === 'pending') overtime.push({ ...who, ot_start: d.ot_start, ot_end: d.ot_end, ot_minutes: d.ot_minutes });
      }
    }
    return { late, overtime };
  }

  r.get('/team', (req, res) => {
    const team = teamOf(req.employee);
    const ids = [...team.keys()];
    const punches = ids.length
      ? db.prepare(
        `SELECT p.id, p.employee_id, p.kind, p.at, p.work_date, p.lat, p.lng, p.accuracy_m, p.distance_m, p.flag_reason, p.note, p.place, b.name AS near_branch
         FROM punches p LEFT JOIN branches b ON b.id = p.branch_id
         WHERE p.status = 'flagged' AND p.employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY p.at DESC LIMIT 200`,
      ).all(...ids)
      : [];
    const pv = verificationMap('punch');
    const lv = verificationMap('late');
    const ov = verificationMap('overtime');
    const { late, overtime } = teamDayFlags(team);
    res.json({
      scope: req.employee.manager_scope,
      team_size: team.size,
      punches: punches.map((p) => ({ ...p, name: team.get(p.employee_id).name, code: team.get(p.employee_id).code, verification: pv.get(String(p.id)) || null })),
      late: late.map((x) => ({ ...x, verification: lv.get(`${x.employee_id}:${x.date}`) || null })).reverse(),
      overtime: overtime.map((x) => ({ ...x, verification: ov.get(`${x.employee_id}:${x.date}`) || null })).reverse(),
    });
  });

  r.get('/team/punches/:id/selfie', (req, res) => {
    const team = teamOf(req.employee);
    const p = db.prepare('SELECT employee_id, selfie_file FROM punches WHERE id = ?').get(Number(req.params.id));
    if (!p || !team.has(p.employee_id)) throw notFound();
    sendStoredFile(ctx, res, p.selfie_file, 'image/jpeg', `selfie-${req.params.id}.jpg`);
  });

  r.post('/team/verify', (req, res) => {
    const team = teamOf(req.employee);
    const { kind, punch_id: punchId, employee_id: empId, date, verdict, note } = req.body || {};
    if (!['ok', 'doubt'].includes(verdict)) throw bad('Choose "Looks fine" or "Doubtful"');
    let ref;
    if (kind === 'punch') {
      const p = db.prepare("SELECT id, employee_id FROM punches WHERE id = ? AND status = 'flagged'").get(Number(punchId));
      if (!p || !team.has(p.employee_id)) throw notFound('This punch is not waiting for a check');
      ref = String(p.id);
    } else if (kind === 'late' || kind === 'overtime') {
      requireDate(date);
      if (!team.has(Number(empId))) throw notFound('Not in your team');
      const flags = teamDayFlags(new Map([[Number(empId), team.get(Number(empId))]]));
      if (!flags[kind].some((x) => x.date === date)) throw notFound('This day is not waiting for a check');
      ref = `${Number(empId)}:${date}`;
    } else {
      throw bad('Unknown item');
    }
    db.prepare(
      `INSERT INTO verifications (kind, ref, verdict, note, manager_id, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, ref) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, manager_id = excluded.manager_id, at = excluded.at`,
    ).run(kind, ref, verdict, String(note || '').slice(0, 300), req.employee.id, ctx.now());
    ctx.audit(req, 'manager.verified', { kind, ref, verdict });
    res.json({ ok: true });
  });

  // Salary for any month up to now: the final payslip once payroll is finalized, otherwise a live
  // statement calculated from attendance so far (it changes as days are punched and approved).
  r.get('/salary', (req, res) => {
    const now = ctx.now();
    const current = istDate(now).slice(0, 7);
    const month = req.query.month ? requireMonth(req.query.month) : current;
    if (month > current) throw bad('That month has not started yet');
    const settings = getSettings(db);
    if (month < settings.salary_visible_from) throw bad(`Salary details are available from ${monthName(settings.salary_visible_from)} onwards.`);
    const emp = req.employee;
    if (emp.joined_on && month < emp.joined_on.slice(0, 7)) throw bad('You had not joined yet in that month');
    const run = db.prepare('SELECT data_json, finalized_at FROM payroll_runs WHERE month = ?').get(month);
    if (run) {
      const data = JSON.parse(run.data_json);
      const row = data.rows.find((x) => x.employee_id === emp.id);
      if (row) return res.json({ month, status: 'final', finalized_at: run.finalized_at, company_name: data.company_name, row });
    }
    const branch = db.prepare('SELECT name FROM branches WHERE id = ?').get(emp.branch_id);
    const row = employeeSalary(db, { ...emp, branch_name: branch?.name || '' }, month, settings, now);
    res.json({
      month,
      status: month === current ? 'live' : 'pending',
      as_of: now,
      counted_until: month === current ? istDate(now) : null,
      company_name: settings.company_name,
      row,
    });
  });

  r.get('/payslips', (req, res) => {
    const runs = db.prepare('SELECT month, data_json FROM payroll_runs WHERE month >= ? ORDER BY month DESC').all(getSettings(db).salary_visible_from);
    const list = [];
    for (const run of runs) {
      const row = JSON.parse(run.data_json).rows.find((x) => x.employee_id === req.employee.id);
      if (row) list.push({ month: run.month, net_paise: row.net_paise });
    }
    res.json(list);
  });

  r.get('/payslips/:month', (req, res) => {
    const month = requireMonth(req.params.month);
    if (month < getSettings(db).salary_visible_from) throw notFound('No payslip for this month');
    const run = db.prepare('SELECT data_json FROM payroll_runs WHERE month = ?').get(month);
    const data = run && JSON.parse(run.data_json);
    const row = data?.rows.find((x) => x.employee_id === req.employee.id);
    if (!row) throw notFound('No payslip for this month');
    res.json({ month, company_name: data.company_name, row });
  });

  return r;
};
