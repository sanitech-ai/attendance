'use strict';
const express = require('express');
const { getSettings, tx } = require('../db');
const { computeRange, summarize } = require('../attendance');
const { computePayroll } = require('../payroll');
const { planImport, randomPin } = require('../importer');
const { resolveMapsLink, placeName } = require('../maps');
const {
  bad, HttpError, istDate, requireDate, requireMonth, daysInMonth, hashSecret, toPaise, isTime, isDate, haversineMeters, fmtKm,
} = require('../util');
const {
  profileMissing, paymentDetails, publicEmployee, validPin, createDocument, sendStoredFile, notFound, assertMonthOpen, DOC_COLUMNS,
  measurePunch,
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
        .prepare('INSERT INTO admins (username, name, password_hash, can_edit_attendance, created_at) VALUES (?, ?, ?, 1, ?)')
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
    if (b.late_offsets_ot !== undefined) updates.late_offsets_ot = b.late_offsets_ot ? '1' : '0';
    if (b.salary_visible_from !== undefined) updates.salary_visible_from = requireMonth(String(b.salary_visible_from));
    if (updates.late_warnings !== undefined && !Number.isInteger(Number(updates.late_warnings))) throw bad('late_warnings must be a whole number');
    const st = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const [k, v] of Object.entries(updates)) st.run(v, k);
    ctx.audit(req, 'settings.updated', updates);
    res.json(getSettings(db));
  });

  r.get('/admins', (req, res) => res.json(db.prepare('SELECT id, username, name, can_edit_attendance, created_at FROM admins ORDER BY id').all()));

  /** Changing attendance markings (corrections, bulk marking) is limited to admins with this permission. */
  function requireAttendanceEditor(req) {
    if (!req.admin.can_edit_attendance) {
      throw new HttpError(403, 'Only admins with permission to change the attendance register can do this.');
    }
  }

  r.put('/admins/:id/permissions', (req, res) => {
    requireAttendanceEditor(req);
    const target = db.prepare('SELECT id, username, can_edit_attendance FROM admins WHERE id = ?').get(id(req.params.id));
    if (!target) throw notFound();
    const allow = req.body?.can_edit_attendance ? 1 : 0;
    if (!allow && target.can_edit_attendance
      && db.prepare('SELECT COUNT(*) AS n FROM admins WHERE can_edit_attendance = 1').get().n <= 1) {
      throw bad('At least one admin must be able to change the attendance register');
    }
    db.prepare('UPDATE admins SET can_edit_attendance = ? WHERE id = ?').run(allow, target.id);
    ctx.audit(req, allow ? 'admin.attendance_permission_granted' : 'admin.attendance_permission_removed', { username: target.username });
    res.json({ ok: true });
  });

  r.post('/admins', (req, res) => {
    const { username, password, name } = req.body || {};
    validateAdminInput(username, password, name);
    const newId = db
      .prepare('INSERT INTO admins (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username.trim(), name.trim(), hashSecret(password), ctx.now()).lastInsertRowid;
    ctx.audit(req, 'admin.created', { id: Number(newId), username });
    res.json({ ok: true, id: Number(newId) });
  });

  r.put('/admins/:id', (req, res) => {
    const target = db.prepare('SELECT id, username, name FROM admins WHERE id = ?').get(id(req.params.id));
    if (!target) throw notFound();
    const name = String(req.body?.name ?? '').trim();
    const username = String(req.body?.username ?? '').trim();
    if (!name) throw bad('Name is required');
    if (!/^[A-Za-z0-9_.@-]{3,40}$/.test(username)) throw bad('Username must be 3-40 letters/digits');
    db.prepare('UPDATE admins SET name = ?, username = ? WHERE id = ?').run(name.slice(0, 80), username, target.id);
    ctx.audit(req, 'admin.updated', { id: target.id, from: { name: target.name, username: target.username }, to: { name, username } });
    res.json({ ok: true });
  });

  // Another admin's password: needs the acting admin's own password; that admin is logged out everywhere.
  r.post('/admins/:id/password', (req, res) => {
    const target = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(id(req.params.id));
    if (!target) throw notFound();
    checkPassword(req);
    const pw = req.body?.new_password;
    if (typeof pw !== 'string' || pw.length < 8) throw bad('New password must be at least 8 characters');
    db.prepare('UPDATE admins SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashSecret(pw), target.id);
    if (target.id !== req.admin.id) ctx.endAllSessions('admin', target.id);
    ctx.audit(req, 'admin.password_reset', { id: target.id, username: target.username });
    res.json({ ok: true });
  });

  r.delete('/admins/:id', (req, res) => {
    const target = db.prepare('SELECT id, username, name FROM admins WHERE id = ?').get(id(req.params.id));
    if (!target) throw notFound();
    if (target.id === req.admin.id) throw bad('You cannot remove your own account');
    if (db.prepare('SELECT COUNT(*) AS n FROM admins').get().n <= 1) throw bad('At least one admin must remain');
    checkPassword(req);
    tx(db, () => {
      // Keep the records this admin approved; just drop the link to the deleted account.
      for (const [table, col] of [['punches', 'reviewed_by'], ['ot_decisions', 'decided_by'], ['late_decisions', 'decided_by'], ['visits', 'reviewed_by'], ['day_overrides', 'set_by'],
        ['leave_requests', 'decided_by'], ['documents', 'reviewed_by'], ['payroll_runs', 'finalized_by']]) {
        db.prepare(`UPDATE ${table} SET ${col} = NULL WHERE ${col} = ?`).run(target.id);
      }
      db.prepare("DELETE FROM sessions WHERE kind = 'admin' AND user_id = ?").run(target.id);
      db.prepare('DELETE FROM admins WHERE id = ?').run(target.id);
    });
    ctx.audit(req, 'admin.removed', { username: target.username, name: target.name });
    res.json({ ok: true });
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
      `SELECT b.*, (SELECT COUNT(*) FROM employees e WHERE e.branch_id = b.id AND e.active = 1) AS employee_count,
         (SELECT COUNT(*) FROM employees e WHERE e.branch_id = b.id) AS all_employee_count,
         (SELECT group_concat(l.other_id) FROM branch_links l WHERE l.branch_id = b.id) AS linked_ids
       FROM branches b ORDER BY b.active DESC, b.name`,
    ).all());
  });

  // Sanity check of every branch pin: does it match its Google Maps link, where is it, and where do its
  // staff actually punch from?
  r.get('/branches/check', async (req, res) => {
    const branches = db.prepare('SELECT * FROM branches WHERE active = 1 ORDER BY name').all();
    const since = ctx.now() - 60 * 24 * 3600 * 1000;
    const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const out = [];
    for (const [i, b] of branches.entries()) {
      const row = { id: b.id, name: b.name, address: b.address, maps_link: b.maps_link, radius_m: b.radius_m, location_set: !!b.location_set, lat: b.lat, lng: b.lng, issues: [], notes: [] };
      if (!b.location_set) {
        row.issues.push('No location saved yet');
        row.verdict = 'bad';
        out.push(row);
        continue;
      }
      if (b.maps_link) {
        try {
          const l = await resolveMapsLink(b.maps_link, ctx.fetch);
          row.link_lat = l.lat; row.link_lng = l.lng;
          row.link_distance_m = Math.round(haversineMeters(b.lat, b.lng, l.lat, l.lng));
          if (row.link_distance_m > Math.max(b.radius_m, 200)) row.issues.push(`Saved pin is ${fmtKm(row.link_distance_m)} away from where the Google Maps link points`);
        } catch (err) {
          row.notes.push(`Could not read the Google Maps link (${err.message})`);
        }
      } else {
        row.notes.push('No Google Maps link saved — the pin was set by hand or from a phone');
      }
      try {
        if (i) await new Promise((r2) => setTimeout(r2, 1100));
        row.place = await placeName(b.lat, b.lng, ctx.fetch);
      } catch (err) {
        row.notes.push(`Could not look up the place name (${err.message})`);
      }
      const pts = db.prepare(
        `SELECT p.lat, p.lng FROM punches p JOIN employees e ON e.id = p.employee_id
         WHERE e.branch_id = ? AND p.at > ? AND p.status != 'rejected' AND (p.accuracy_m IS NULL OR p.accuracy_m <= 100)`,
      ).all(b.id, since);
      row.punches = pts.length;
      if (pts.length) {
        const mid = { lat: median(pts.map((p) => p.lat)), lng: median(pts.map((p) => p.lng)) };
        row.staff_lat = mid.lat; row.staff_lng = mid.lng;
        row.staff_distance_m = Math.round(haversineMeters(b.lat, b.lng, mid.lat, mid.lng));
        row.inside_share = Math.round(100 * pts.filter((p) => haversineMeters(b.lat, b.lng, p.lat, p.lng) <= b.radius_m).length / pts.length);
        if (pts.length >= 3 && row.staff_distance_m > Math.max(2 * b.radius_m, 500)) {
          row.issues.push(`Staff of this branch usually punch ${fmtKm(row.staff_distance_m)} from the pin (${100 - row.inside_share}% of their punches are outside the radius)`);
        } else if (pts.length >= 3 && row.inside_share < 50) {
          row.notes.push(`${100 - row.inside_share}% of staff punches are outside the ${b.radius_m} m radius — the radius may be too small`);
        }
      }
      row.verdict = row.issues.length ? 'bad' : row.notes.length ? 'check' : 'ok';
      out.push(row);
    }
    res.json(out);
  });

  /** Validates a branch; a Google Maps link, when given, is the source of the coordinates. */
  async function branchInput(b, before) {
    const name = String(b.name || '').trim();
    if (!name) throw bad('Branch name is required');
    const link = String(b.maps_link || '').trim().slice(0, 2000);
    // Only read the link when it is new or changed. Re-reading it on every edit used to move a pin
    // silently whenever Google answered the server with a different spot.
    if (link && !(before && before.location_set && link === before.maps_link)) {
      try {
        Object.assign(b, await resolveMapsLink(link, ctx.fetch));
      } catch (err) {
        // Keep coordinates entered by hand / from the phone if the link can't be read.
        if (b.lat === '' || b.lat == null || b.lng === '' || b.lng == null) throw err;
      }
    }
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    if (b.lat === '' || b.lng === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw bad('Paste a Google Maps link (or enter latitude and longitude)');
    }
    const radius = Number(b.radius_m ?? 150);
    if (!Number.isInteger(radius) || radius < 20 || radius > 5000) throw bad('Radius must be 20 to 5000 metres');
    if (!['block', 'flag'].includes(b.geofence_mode)) throw bad('Geofence mode must be block or flag');
    const shiftStart = b.shift_start || '09:00';
    const shiftEnd = b.shift_end || '18:00';
    if (!isTime(shiftStart) || !isTime(shiftEnd)) throw bad('Office timings must be HH:MM');
    return [name, String(b.address || '').slice(0, 300), lat, lng, radius, b.geofence_mode, b.active === false ? 0 : 1, link, shiftStart, shiftEnd,
      b.field_visits ? 1 : 0];
  }

  r.post('/branches', async (req, res) => {
    const v = await branchInput(req.body || {});
    const newId = db
      .prepare('INSERT INTO branches (name, address, lat, lng, radius_m, geofence_mode, active, maps_link, shift_start, shift_end, field_visits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(...v, ctx.now()).lastInsertRowid;
    setBranchLinks(Number(newId), req.body?.linked_branches);
    ctx.audit(req, 'branch.created', { id: Number(newId), name: v[0] });
    // A new site can be the closest one for recent punches.
    res.json({ ok: true, id: Number(newId), remeasured: remeasurePunches() });
  });

  r.put('/branches/:id', async (req, res) => {
    const before = db.prepare('SELECT * FROM branches WHERE id = ?').get(id(req.params.id));
    if (!before) throw notFound();
    const v = await branchInput(req.body || {}, before);
    db.prepare('UPDATE branches SET name = ?, address = ?, lat = ?, lng = ?, radius_m = ?, geofence_mode = ?, active = ?, maps_link = ?, shift_start = ?, shift_end = ?, field_visits = ?, location_set = 1 WHERE id = ?')
      .run(...v, before.id);
    const linksChanged = setBranchLinks(before.id, req.body?.linked_branches);
    const moved = linksChanged || !before.location_set || before.lat !== v[2] || before.lng !== v[3] || before.radius_m !== v[4] || before.active !== v[6];
    const remeasured = moved ? remeasurePunches() : 0;
    // Staff who follow their branch's timing get the new office hours.
    db.prepare('UPDATE employees SET shift_start = ?, shift_end = ? WHERE branch_id = ? AND follow_branch_shift = 1').run(v[8], v[9], id(req.params.id));
    ctx.audit(req, 'branch.updated', { id: Number(req.params.id), moved, from: moved ? [before.lat, before.lng] : undefined });
    res.json({ ok: true, remeasured });
  });

  // Move a pin to an exact spot (e.g. where the branch's staff actually punch).
  /** Branches whose staff may punch at this branch's linked branches too. Returns whether anything changed. */
  function setBranchLinks(branchId, list) {
    if (!Array.isArray(list)) return false;
    const want = [...new Set(list.map(Number))].filter((o) => o !== branchId && db.prepare('SELECT 1 FROM branches WHERE id = ?').get(o)).sort();
    const have = db.prepare('SELECT other_id FROM branch_links WHERE branch_id = ? ORDER BY other_id').all(branchId).map((r2) => r2.other_id);
    if (String(want) === String(have)) return false;
    tx(db, () => {
      db.prepare('DELETE FROM branch_links WHERE branch_id = ?').run(branchId);
      const ins = db.prepare('INSERT INTO branch_links (branch_id, other_id) VALUES (?, ?)');
      for (const o of want) ins.run(branchId, o);
    });
    return true;
  }

  r.post('/branches/:id/pin', (req, res) => {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw bad('Invalid location');
    const before = db.prepare('SELECT * FROM branches WHERE id = ?').get(id(req.params.id));
    if (!before) throw notFound();
    db.prepare('UPDATE branches SET lat = ?, lng = ?, location_set = 1 WHERE id = ?').run(lat, lng, before.id);
    const remeasured = remeasurePunches();
    ctx.audit(req, 'branch.pin_moved', { id: before.id, from: [before.lat, before.lng], to: [lat, lng] });
    res.json({ ok: true, remeasured });
  });

  /**
   * After a pin moves, measure the last 45 days of punches again so their distances and flags are right.
   * Punches an admin already approved/rejected, and finalized months, are left alone. A punch that was
   * only flagged for its location and is now inside its site becomes OK.
   */
  function remeasurePunches() {
    const settings = getSettings(db);
    const closed = new Set(db.prepare('SELECT month FROM payroll_runs').all().map((r2) => r2.month));
    const rows = db.prepare("SELECT * FROM punches WHERE at > ? AND status IN ('ok', 'flagged')").all(ctx.now() - 45 * 86400000);
    const emps = new Map();
    const upd = db.prepare('UPDATE punches SET branch_id = ?, distance_m = ?, inside_geofence = ?, status = ?, flag_reason = ? WHERE id = ?');
    let n = 0;
    tx(db, () => {
      for (const p of rows) {
        if (closed.has(p.work_date.slice(0, 7))) continue;
        if (!emps.has(p.employee_id)) emps.set(p.employee_id, db.prepare('SELECT * FROM employees WHERE id = ?').get(p.employee_id));
        const m = measurePunch(db, emps.get(p.employee_id), p.lat, p.lng, p.accuracy_m, settings, p.note || '');
        const status = p.status === 'flagged' && !m.flags.length ? 'ok' : p.status;
        const reason = status === 'ok' && p.status === 'ok' ? p.flag_reason : m.flags.join('; ') || null;
        upd.run(m.nearest?.branch.id ?? null, m.nearest ? Math.round(m.nearest.distance) : null, m.inside ? 1 : 0, status, reason, p.id);
        n++;
      }
    });
    return n;
  }

  r.delete('/branches/:id', (req, res) => {
    const b = db.prepare('SELECT * FROM branches WHERE id = ?').get(id(req.params.id));
    if (!b) throw notFound();
    const n = db.prepare('SELECT COUNT(*) AS n FROM employees WHERE branch_id = ?').get(b.id).n;
    if (n) throw new HttpError(409, `${n} employee(s) still belong to ${b.name}. Move or delete them first.`);
    tx(db, () => {
      db.prepare('UPDATE punches SET branch_id = NULL WHERE branch_id = ?').run(b.id);
      db.prepare('DELETE FROM holidays WHERE branch_id = ?').run(b.id);
      db.prepare('DELETE FROM employee_locations WHERE branch_id = ?').run(b.id);
      db.prepare('DELETE FROM branch_links WHERE branch_id = ? OR other_id = ?').run(b.id, b.id);
      db.prepare('DELETE FROM branches WHERE id = ?').run(b.id);
    });
    ctx.audit(req, 'branch.deleted', { name: b.name });
    res.json({ ok: true });
  });

  r.post('/maps/resolve', async (req, res) => {
    const c = await resolveMapsLink(String(req.body?.link || ''), ctx.fetch);
    // Name the place so a wrong spot is obvious straight away (best effort).
    const place = await placeName(c.lat, c.lng, ctx.fetch).catch(() => '');
    res.json({ ...c, place });
  });

  // ---- employees ----
  r.get('/employees', (req, res) => {
    const rows = db.prepare(
      `SELECT e.*, b.name AS branch_name,
         (SELECT COUNT(*) FROM documents d WHERE d.employee_id = e.id) AS document_count,
         (SELECT group_concat(l.branch_id) FROM employee_locations l WHERE l.employee_id = e.id) AS extra_location_ids
       FROM employees e JOIN branches b ON b.id = e.branch_id ORDER BY e.active DESC, e.name`,
    ).all();
    res.json(rows.map((e) => ({ ...publicEmployee(e), profile_missing: profileMissing(db, e) })));
  });

  r.get('/employees/:id', (req, res) => {
    const e = db.prepare('SELECT e.*, b.name AS branch_name FROM employees e JOIN branches b ON b.id = e.branch_id WHERE e.id = ?').get(id(req.params.id));
    if (!e) throw notFound();
    res.json(publicEmployee(e));
  });

  function employeeInput(b, before = null) {
    const code = String(b.code || '').trim();
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(code)) throw bad('Employee ID must be 1-20 letters, digits, - or _');
    if (!name) throw bad('Name is required');
    const branchId = id(b.branch_id);
    const branch = db.prepare('SELECT shift_start, shift_end FROM branches WHERE id = ?').get(branchId);
    if (!branch) throw bad('Branch not found');
    // Not stated: follow the branch unless a different shift was given.
    const follow = b.follow_branch_shift === undefined
      ? (!b.shift_start && !b.shift_end) || (b.shift_start === branch.shift_start && b.shift_end === branch.shift_end)
      : !!b.follow_branch_shift;
    if (follow) {
      b.shift_start = branch.shift_start;
      b.shift_end = branch.shift_end;
    }
    const extra = [...new Set((Array.isArray(b.extra_locations) ? b.extra_locations : []).map(Number))].filter((x) => x !== branchId);
    for (const x of extra) {
      if (!Number.isInteger(x) || !db.prepare('SELECT 1 FROM branches WHERE id = ?').get(x)) throw bad('Unknown extra location');
    }
    if (!['monthly', 'daily', 'hourly'].includes(b.salary_type)) throw bad('Salary type must be monthly, daily or hourly');
    const salary = toPaise(b.salary, 'Salary');
    if (!isTime(b.shift_start) || !isTime(b.shift_end)) throw bad('Shift times must be HH:MM');
    const offs = Array.isArray(b.weekly_offs) ? b.weekly_offs : String(b.weekly_offs ?? '').split(',').filter((x) => x !== '');
    if (offs.some((d) => !/^[0-6]$/.test(String(d)))) throw bad('Weekly offs must be days 0 (Sun) to 6 (Sat)');
    const joinedOn = String(b.joined_on ?? '').trim();
    if (joinedOn && !isDate(joinedOn)) throw bad('Joining date must be a valid date');
    return {
      code, name, branch_id: branchId, salary_type: b.salary_type, salary_paise: salary,
      designation: String(b.designation || '').slice(0, 60),
      shift_start: b.shift_start, shift_end: b.shift_end, weekly_offs: [...new Set(offs.map(String))].sort().join(','),
      joined_on: joinedOn, active: b.active === false ? 0 : 1,
      is_manager: b.is_manager ? 1 : 0, manager_scope: b.manager_scope === 'all' ? 'all' : 'branch',
      follow_branch_shift: follow ? 1 : 0, extra_locations: extra,
      allow_offsite: (b.allow_offsite ?? before?.allow_offsite) ? 1 : 0,
      // Fields not sent keep their current value (staff may have filled them in themselves).
      ...paymentDetails({
        phone: b.phone ?? before?.phone ?? '',
        upi_id: b.upi_id ?? before?.upi_id ?? '',
        bank_account: b.bank_account ?? before?.bank_account ?? '',
        bank_ifsc: b.bank_ifsc ?? before?.bank_ifsc ?? '',
      }),
    };
  }

  r.post('/employees', (req, res) => {
    const v = employeeInput(req.body || {});
    const pin = validPin(String(req.body.pin ?? ''));
    const newId = db
      .prepare(
        `INSERT INTO employees (code, name, phone, designation, branch_id, salary_type, salary_paise, shift_start, shift_end,
           weekly_offs, joined_on, active, is_manager, manager_scope, follow_branch_shift, upi_id, bank_account, bank_ifsc, allow_offsite, pin_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.code, v.name, v.phone, v.designation, v.branch_id, v.salary_type, v.salary_paise, v.shift_start, v.shift_end,
        v.weekly_offs, v.joined_on, v.active, v.is_manager, v.manager_scope, v.follow_branch_shift, v.upi_id, v.bank_account, v.bank_ifsc,
        v.allow_offsite, hashSecret(pin), ctx.now()).lastInsertRowid;
    setExtraLocations(Number(newId), v.extra_locations);
    ctx.audit(req, 'employee.created', { id: Number(newId), code: v.code });
    res.json({ ok: true, id: Number(newId) });
  });

  r.put('/employees/:id', (req, res) => {
    const empId = id(req.params.id);
    const before = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
    if (!before) throw notFound();
    const v = employeeInput(req.body || {}, before);
    db.prepare(
      `UPDATE employees SET code = ?, name = ?, phone = ?, designation = ?, branch_id = ?, salary_type = ?, salary_paise = ?,
         shift_start = ?, shift_end = ?, weekly_offs = ?, joined_on = ?, active = ?, is_manager = ?, manager_scope = ?, follow_branch_shift = ?,
         upi_id = ?, bank_account = ?, bank_ifsc = ?, allow_offsite = ? WHERE id = ?`,
    ).run(v.code, v.name, v.phone, v.designation, v.branch_id, v.salary_type, v.salary_paise, v.shift_start, v.shift_end,
      v.weekly_offs, v.joined_on, v.active, v.is_manager, v.manager_scope, v.follow_branch_shift, v.upi_id, v.bank_account, v.bank_ifsc,
      v.allow_offsite, empId);
    setExtraLocations(empId, v.extra_locations);
    if (!v.active) ctx.endAllSessions('employee', empId);
    const changed = Object.keys(v).filter((k) => k !== 'extra_locations' && String(before[k]) !== String(v[k]));
    ctx.audit(req, 'employee.updated', { id: empId, changed });
    res.json({ ok: true });
  });

  function setExtraLocations(empId, branchIds) {
    db.prepare('DELETE FROM employee_locations WHERE employee_id = ?').run(empId);
    const ins = db.prepare('INSERT INTO employee_locations (employee_id, branch_id) VALUES (?, ?)');
    for (const b of branchIds) ins.run(empId, b);
  }

  r.post('/employees/:id/reset-pin', (req, res) => {
    const empId = id(req.params.id);
    const pin = validPin(String(req.body?.pin ?? ''));
    const result = db.prepare('UPDATE employees SET pin_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashSecret(pin), empId);
    if (!result.changes) throw notFound();
    ctx.endAllSessions('employee', empId);
    ctx.audit(req, 'employee.pin_reset', { id: empId });
    res.json({ ok: true });
  });

  // New random PINs for many staff at once, returned once so the admin can send them out.
  r.post('/employees/reset-pins', (req, res) => {
    const ids = [...new Set((req.body?.ids || []).map(id))];
    if (!ids.length) throw bad('Select at least one employee');
    const out = tx(db, () => ids.map((empId) => {
      const e = db.prepare('SELECT id, code, name, phone FROM employees WHERE id = ? AND active = 1').get(empId);
      if (!e) throw notFound('Employee not found or inactive');
      const pin = randomPin();
      db.prepare('UPDATE employees SET pin_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashSecret(pin), empId);
      ctx.endAllSessions('employee', empId);
      return { ...e, pin };
    }));
    ctx.audit(req, 'employee.pins_reset', { ids });
    res.json(out);
  });

  /** Permanently removes employees and everything recorded for them, including stored selfies/documents. */
  function deleteEmployees(ids) {
    if (!ids.length) return 0;
    const marks = ids.map(() => '?').join(',');
    const files = [
      ...db.prepare(`SELECT selfie_file AS f FROM punches WHERE employee_id IN (${marks})`).all(...ids),
      ...db.prepare(`SELECT stored_file AS f FROM documents WHERE employee_id IN (${marks})`).all(...ids),
      ...db.prepare(`SELECT selfie_file AS f FROM visits WHERE employee_id IN (${marks})`).all(...ids),
    ].map((r) => r.f);
    tx(db, () => {
      for (const table of ['punches', 'documents', 'leave_requests', 'day_overrides', 'ot_decisions', 'late_decisions', 'advances', 'adjustments', 'pay_items', 'employee_locations', 'visits']) {
        db.prepare(`DELETE FROM ${table} WHERE employee_id IN (${marks})`).run(...ids);
      }
      db.prepare(`DELETE FROM verifications WHERE manager_id IN (${marks})`).run(...ids);
      db.prepare(`DELETE FROM sessions WHERE kind = 'employee' AND user_id IN (${marks})`).run(...ids);
      db.prepare(`DELETE FROM employees WHERE id IN (${marks})`).run(...ids);
    });
    for (const f of files) ctx.deleteFile(f);
    return ids.length;
  }

  function checkPassword(req) {
    const me = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
    try {
      ctx.checkLogin('admins', me, String(req.body?.password ?? ''), 'password_hash');
    } catch (err) {
      // A wrong password here must not look like an expired session to the dashboard.
      if (err.status === 401) throw new HttpError(403, 'Wrong password');
      throw err;
    }
  }

  r.delete('/employees/:id', (req, res) => {
    const emp = db.prepare('SELECT id, code, name FROM employees WHERE id = ?').get(id(req.params.id));
    if (!emp) throw notFound();
    deleteEmployees([emp.id]);
    ctx.audit(req, 'employee.deleted', { code: emp.code, name: emp.name });
    res.json({ ok: true });
  });

  // Fresh start: removes every employee (with all their records) and every branch. Admins, settings,
  // company-wide holidays and finalized payroll snapshots are kept.
  r.post('/reset-staff', (req, res) => {
    if (req.body?.confirm !== 'DELETE') throw bad('Type DELETE to confirm');
    checkPassword(req);
    const ids = db.prepare('SELECT id FROM employees').all().map((e) => e.id);
    deleteEmployees(ids);
    const branches = tx(db, () => {
      db.prepare('DELETE FROM holidays WHERE branch_id IS NOT NULL').run();
      db.prepare('DELETE FROM employee_locations').run();
      db.prepare('DELETE FROM branch_links').run();
      return db.prepare('DELETE FROM branches').run().changes;
    });
    ctx.audit(req, 'staff.reset', { employees: ids.length, branches });
    res.json({ ok: true, employees: ids.length, branches });
  });

  // Delete a single punch or field visit with its selfie (e.g. a test or duplicate entry).
  r.delete('/punches/:id', (req, res) => {
    requireAttendanceEditor(req);
    const p = db.prepare('SELECT * FROM punches WHERE id = ?').get(id(req.params.id));
    if (!p) throw notFound();
    assertMonthOpen(db, p.work_date.slice(0, 7));
    tx(db, () => {
      db.prepare("DELETE FROM verifications WHERE kind = 'punch' AND ref = ?").run(String(p.id));
      db.prepare('DELETE FROM punches WHERE id = ?').run(p.id);
    });
    if (p.selfie_file) ctx.deleteFile(p.selfie_file);
    ctx.audit(req, 'punch.deleted', { id: p.id, employee_id: p.employee_id, kind: p.kind, at: p.at, work_date: p.work_date });
    res.json({ ok: true });
  });

  r.delete('/visits/:id', (req, res) => {
    requireAttendanceEditor(req);
    const v = db.prepare('SELECT * FROM visits WHERE id = ?').get(id(req.params.id));
    if (!v) throw notFound();
    db.prepare('DELETE FROM visits WHERE id = ?').run(v.id);
    if (v.selfie_file) ctx.deleteFile(v.selfie_file);
    ctx.audit(req, 'visit.deleted', { id: v.id, employee_id: v.employee_id, at: v.at, note: v.note });
    res.json({ ok: true });
  });

  /** Manager checks keyed by ref, with the manager's name, for showing next to flagged items. */
  function verificationsFor(kind) {
    return new Map(db.prepare(
      `SELECT v.ref, v.verdict, v.note, v.at, e.name AS manager_name FROM verifications v
       JOIN employees e ON e.id = v.manager_id WHERE v.kind = ?`,
    ).all(kind).map((v) => [v.ref, v]));
  }

  /** Days with an arrival later than late_max_minutes that nobody has decided yet (active staff). */
  function pendingLateCount() {
    const s = getSettings(db);
    return db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT p.employee_id, p.work_date, MIN(p.at) AS first_in, e.shift_start, e.joined_on
         FROM punches p JOIN employees e ON e.id = p.employee_id
         WHERE p.kind = 'IN' AND p.status != 'rejected' AND e.active = 1
         GROUP BY p.employee_id, p.work_date) f
       WHERE f.first_in - (CAST(strftime('%s', f.work_date || ' ' || f.shift_start) AS INTEGER) * 1000 - 19800000) >= ?
         AND (f.joined_on = '' OR f.work_date >= f.joined_on)
         AND NOT EXISTS (SELECT 1 FROM late_decisions d WHERE d.employee_id = f.employee_id AND d.work_date = f.work_date)
         AND NOT EXISTS (SELECT 1 FROM day_overrides o WHERE o.employee_id = f.employee_id AND o.work_date = f.work_date)`,
    ).get((s.late_max_minutes + 1) * 60000).n;
  }

  function pendingCounts() {
    return {
      late_approvals: pendingLateCount(),
      visits: db.prepare("SELECT COUNT(*) AS n FROM visits WHERE status = 'pending'").get().n,
      incomplete_profiles: db.prepare('SELECT * FROM employees WHERE active = 1').all().filter((e) => profileMissing(db, e).length).length,
      flagged_punches: db.prepare("SELECT COUNT(*) AS n FROM punches WHERE status = 'flagged'").get().n,
      leaves: db.prepare("SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending'").get().n,
      documents: db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'pending'").get().n,
    };
  }

  r.get('/pending', (req, res) => res.json(pendingCounts()));

  // ---- staff app preview (read-only, as the employee sees it) ----
  r.use('/preview/:empId', (req, res, next) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id(req.params.empId));
    if (!emp) throw notFound();
    req.employee = emp;
    if (req.path === '/me') ctx.audit(req, 'employee.previewed', { code: emp.code, name: emp.name });
    next();
  }, require('./employee')(ctx, { preview: true }));

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
  r.post('/employees/import', async (req, res) => {
    const { csv, dry_run: dryRun } = req.body || {};
    if (typeof csv !== 'string' || !csv.trim()) throw bad('Choose a CSV file');
    if (csv.length > 2_000_000) throw bad('File is too large');
    const plan = planImport(db, csv);
    if (plan.error) throw bad(plan.error);
    // Turn each branch's Google Maps link into coordinates. A link that can't be read doesn't block the
    // import: the branch is created without a location and the admin sets it afterwards.
    const branchCoords = new Map();
    const linkWarnings = [];
    await Promise.all([...plan.branchLinks].map(async ([key, link]) => {
      try {
        branchCoords.set(key, await resolveMapsLink(link, ctx.fetch));
      } catch (err) {
        const name = plan.rows.find((row) => row.data.branchKey === key)?.data.branch || key;
        linkWarnings.push(`${name}: ${err.message}`);
      }
    }));
    for (const nb of plan.newBranches) nb.located = branchCoords.has(nb.name.toLowerCase());
    const summary = plan.rows.map((r) => ({
      line: r.line, code: r.data.code, name: r.data.name, branch: r.data.branch, designation: r.data.designation,
      salary_paise: r.data.salary_paise, joined_on: r.data.joined_on, items: r.items, errors: r.errors,
    }));
    const errorCount = plan.rows.filter((r) => r.errors.length).length;
    if (dryRun || errorCount) {
      return res.json({ dry_run: true, rows: summary, new_branches: plan.newBranches, error_count: errorCount, link_warnings: linkWarnings });
    }
    const created = tx(db, () => {
      const branchIds = new Map([...plan.branches].map(([k, b]) => [k, b.id]));
      for (const nb of plan.newBranches) {
        // Location comes later (admin pastes a Google Maps link); until then punches here are flagged.
        const c = branchCoords.get(nb.name.toLowerCase());
        const bid = db.prepare(
          `INSERT INTO branches (name, address, lat, lng, radius_m, geofence_mode, active, location_set, maps_link, created_at)
           VALUES (?, '', ?, ?, ?, 'flag', 1, ?, ?, ?)`,
        ).run(nb.name, c?.lat ?? 0, c?.lng ?? 0, nb.radius_m, c ? 1 : 0, c ? plan.branchLinks.get(nb.name.toLowerCase()) : '', ctx.now()).lastInsertRowid;
        branchIds.set(nb.name.toLowerCase(), Number(bid));
      }
      // Existing branches that had no location yet get it from the file.
      for (const [key, c] of branchCoords) {
        const existing = plan.branches.get(key);
        if (existing) {
          db.prepare('UPDATE branches SET lat = ?, lng = ?, maps_link = ?, location_set = 1 WHERE id = ?').run(c.lat, c.lng, plan.branchLinks.get(key), existing.id);
        }
      }
      const insEmp = db.prepare(
        `INSERT INTO employees (code, name, phone, designation, branch_id, salary_type, salary_paise, shift_start, shift_end,
           weekly_offs, joined_on, active, follow_branch_shift, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      );
      const branchShift = db.prepare('SELECT shift_start, shift_end FROM branches WHERE id = ?');
      const insItem = db.prepare('INSERT INTO pay_items (employee_id, kind, label, amount_paise, created_at) VALUES (?, ?, ?, ?, ?)');
      return plan.rows.map(({ data: d, items }) => {
        const pin = d.pin || randomPin();
        // No shift in the file: follow the branch's office timings.
        const bid = branchIds.get(d.branchKey);
        const shift = d.shift_given ? d : branchShift.get(bid);
        const empId = insEmp.run(d.code, d.name, d.phone, d.designation, bid, d.salary_type, d.salary_paise,
          shift.shift_start, shift.shift_end, d.weekly_offs, d.joined_on, d.shift_given ? 0 : 1, hashSecret(pin), ctx.now()).lastInsertRowid;
        for (const it of items) insItem.run(empId, it.kind, it.label, it.amount_paise, ctx.now());
        return { code: d.code, name: d.name, branch: d.branch, pin };
      });
    });
    ctx.audit(req, 'employees.imported', { count: created.length, new_branches: plan.newBranches.map((b) => b.name) });
    res.json({ ok: true, created, new_branches: plan.newBranches, link_warnings: linkWarnings });
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
         p.status, p.flag_reason, p.reviewed_at, p.note, p.place, e.code, e.name, b.name AS branch_name, hb.name AS home_branch_name
       FROM punches p JOIN employees e ON e.id = p.employee_id
       LEFT JOIN branches b ON b.id = p.branch_id JOIN branches hb ON hb.id = e.branch_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.at DESC LIMIT 500`,
    ).all(...params);
    const checks = verificationsFor('punch');
    res.json(rows.map((p) => ({ ...p, verification: checks.get(String(p.id)) || null })));
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
    requireAttendanceEditor(req);
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

  // ---- monthly late & overtime tracker ----
  function lateOtRows(month, branchId) {
    const [from, to] = monthRange(month);
    const settings = getSettings(db);
    return registerEmployees(branchId).map((e) => {
      const days = computeRange(db, e, from, to, settings, ctx.now()).filter((d) => !d.future);
      const s = summarize(days);
      return {
        employee_id: e.id, code: e.code, name: e.name, branch_name: e.branch_name, shift_start: e.shift_start,
        late_days: s.late_days, late_hour_days: s.late_hour_days, late_minutes: s.late_minutes,
        late_penalties: s.late_penalties, late_pending: s.late_pending,
        ot_days: s.ot_days, ot_minutes: s.ot_minutes, ot_payable_minutes: s.ot_payable_minutes, ot_pending_minutes: s.ot_pending_minutes,
        ot_after_late_minutes: settings.late_offsets_ot && e.salary_type !== 'hourly' ? Math.max(0, s.ot_payable_minutes - s.late_minutes) : s.ot_payable_minutes,
        first_day: days.find((d) => d.flags.includes('first_day'))?.date || null,
        late: days.filter((d) => d.late_minutes > 0).map((d) => ({
          date: d.date, first_in: d.first_in, minutes: d.late_minutes,
          outcome: d.late_review ? (d.late_review === 'pending' ? 'over 1 hour — to review' : `over 1 hour — ${d.late_review === 'present' ? 'full day given' : 'half day'}`)
            : d.flags.includes('late_penalty') ? `late #${d.late_mark} — half day` : `late #${d.late_mark} — warning`,
        })),
        ot: days.filter((d) => d.ot_minutes > 0).map((d) => ({ date: d.date, start: d.ot_start, end: d.ot_end, minutes: d.ot_minutes, status: d.ot_status, payable_minutes: d.ot_payable_minutes })),
      };
    });
  }

  r.get('/late-ot', (req, res) => {
    const month = requireMonth(req.query.month);
    res.json({ month, grace_minutes: getSettings(db).grace_minutes, late_max_minutes: getSettings(db).late_max_minutes, late_offsets_ot: getSettings(db).late_offsets_ot, rows: lateOtRows(month, req.query.branch_id ? id(req.query.branch_id) : null) });
  });

  r.get('/late-ot.csv', (req, res) => {
    const month = requireMonth(req.query.month);
    const st = getSettings(db);
    const hrs = (m) => (m / 60).toFixed(2);
    const rows = [['Employee ID', 'Name', 'Branch', `Late (over ${st.grace_minutes} min) — days`, `Late over ${st.late_max_minutes / 60} hour — days`, 'Total late (minutes)',
      'Late days counted as half day', 'Overtime days', 'Overtime hours (recorded)', 'Overtime hours (approved)', 'Overtime hours (pending)',
      st.late_offsets_ot ? 'Overtime hours paid (approved minus late time)' : 'Overtime hours paid', 'Late dates', 'Overtime dates']];
    for (const r2 of lateOtRows(month, req.query.branch_id ? id(req.query.branch_id) : null)) {
      rows.push([r2.code, r2.name, r2.branch_name, r2.late_days, r2.late_hour_days, r2.late_minutes, r2.late_penalties, r2.ot_days,
        hrs(r2.ot_minutes), hrs(r2.ot_payable_minutes), hrs(r2.ot_pending_minutes), hrs(r2.ot_after_late_minutes),
        r2.late.map((l) => `${l.date.slice(8)} (${l.minutes}m)`).join(' '), r2.ot.map((o) => `${o.date.slice(8)} (${hrs(o.minutes)}h)`).join(' ')]);
    }
    sendCsv(res, `late-and-overtime-${month}.csv`, rows);
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
    const checks = verificationsFor('overtime');
    for (const row of out) row.verification = checks.get(`${row.employee_id}:${row.date}`) || null;
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

  // ---- visit selfies (field staff) ----
  r.get('/visits', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.date) { where.push('v.work_date = ?'); params.push(requireDate(req.query.date)); }
    if (req.query.status) { where.push('v.status = ?'); params.push(String(req.query.status)); }
    if (req.query.employee_id) { where.push('v.employee_id = ?'); params.push(id(req.query.employee_id)); }
    res.json(db.prepare(
      `SELECT v.id, v.employee_id, v.at, v.work_date, v.lat, v.lng, v.accuracy_m, v.note, v.place, v.status, v.reviewed_at,
         e.code, e.name, b.name AS branch_name, b.lat AS branch_lat, b.lng AS branch_lng
       FROM visits v JOIN employees e ON e.id = v.employee_id JOIN branches b ON b.id = e.branch_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY v.status = 'pending' DESC, v.at DESC LIMIT 500`,
    ).all(...params));
  });

  r.get('/visits/:id/selfie', (req, res) => {
    const v = db.prepare('SELECT selfie_file FROM visits WHERE id = ?').get(id(req.params.id));
    if (!v) throw notFound();
    sendStoredFile(ctx, res, v.selfie_file, 'image/jpeg', `visit-${req.params.id}.jpg`);
  });

  r.post('/visits/:id/review', (req, res) => {
    const { status } = req.body || {};
    if (!['approved', 'rejected', 'pending'].includes(status)) throw bad('Status must be approved or rejected');
    const result = db.prepare('UPDATE visits SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
      .run(status, status === 'pending' ? null : req.admin.id, status === 'pending' ? null : ctx.now(), id(req.params.id));
    if (!result.changes) throw notFound();
    ctx.audit(req, `visit.${status}`, { id: Number(req.params.id) });
    res.json({ ok: true });
  });

  // ---- very late arrivals: admin decides full or half day ----
  r.get('/late-approvals', (req, res) => {
    const month = requireMonth(req.query.month);
    const [from, to] = monthRange(month);
    const settings = getSettings(db);
    const emps = db.prepare(
      `SELECT DISTINCT e.*, b.name AS branch_name FROM employees e JOIN branches b ON b.id = e.branch_id
       JOIN punches p ON p.employee_id = e.id AND p.kind = 'IN' AND p.work_date BETWEEN ? AND ?
       ORDER BY e.name`,
    ).all(from, to);
    const out = [];
    for (const e of emps) {
      for (const d of computeRange(db, e, from, to, settings, ctx.now())) {
        if (d.late_review) out.push({ employee_id: e.id, code: e.code, name: e.name, branch_name: e.branch_name, shift_start: e.shift_start, shift_end: e.shift_end, ...d });
      }
    }
    // Undecided first, then newest first.
    out.sort((a, b) => (b.late_review === 'pending') - (a.late_review === 'pending') || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const checks = verificationsFor('late');
    for (const row of out) row.verification = checks.get(`${row.employee_id}:${row.date}`) || null;
    res.json({ month, late_max_minutes: settings.late_max_minutes, rows: out });
  });

  r.post('/late-approvals/decision', (req, res) => {
    const { employee_id, date, status } = req.body || {};
    requireDate(date);
    const empId = id(employee_id);
    assertMonthOpen(db, date.slice(0, 7));
    if (status === null) {
      db.prepare('DELETE FROM late_decisions WHERE employee_id = ? AND work_date = ?').run(empId, date);
      ctx.audit(req, 'late.decision_cleared', { employee_id: empId, date });
      return res.json({ ok: true });
    }
    if (!['present', 'half_day'].includes(status)) throw bad('Choose full day or half day');
    db.prepare(
      `INSERT INTO late_decisions (employee_id, work_date, status, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (employee_id, work_date) DO UPDATE SET status = excluded.status, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
    ).run(empId, date, status, req.admin.id, ctx.now());
    ctx.audit(req, 'late.decided', { employee_id: empId, date, status });
    res.json({ ok: true });
  });

  // Mark a range of days for all (or one branch's) active staff, e.g. before the app went live.
  r.post('/attendance/bulk-override', (req, res) => {
    requireAttendanceEditor(req);
    const { from, to, status, note, branch_id: branchId, include_week_offs: includeOffs } = req.body || {};
    requireDate(from, 'from');
    requireDate(to, 'to');
    if (to < from) throw bad('End date is before start date');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 31) throw bad('At most 31 days at a time');
    if (!OVERRIDE_STATUSES.includes(status)) throw bad('Unknown status');
    for (const m of new Set([from.slice(0, 7), to.slice(0, 7)])) assertMonthOpen(db, m);
    const emps = db.prepare(`SELECT * FROM employees WHERE active = 1 ${branchId ? 'AND branch_id = ?' : ''}`).all(...(branchId ? [id(branchId)] : []));
    const upsert = db.prepare(
      `INSERT INTO day_overrides (employee_id, work_date, status, worked_minutes, note, set_by, set_at) VALUES (?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT (employee_id, work_date) DO UPDATE SET status = excluded.status, worked_minutes = NULL,
         note = excluded.note, set_by = excluded.set_by, set_at = excluded.set_at`,
    );
    let count = 0;
    tx(db, () => {
      for (const e of emps) {
        const offs = e.weekly_offs.split(',').filter(Boolean).map(Number);
        for (let d = from; d <= to; d = new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)) {
          if (e.joined_on && d < e.joined_on) continue;
          if (!includeOffs && offs.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) continue;
          upsert.run(e.id, d, status, String(note || '').slice(0, 300), req.admin.id, ctx.now());
          count++;
        }
      }
    });
    ctx.audit(req, 'attendance.bulk_override', { from, to, status, note, branch_id: branchId || null, days: count, employees: emps.length });
    res.json({ ok: true, employees: emps.length, days: count });
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
      'Paid leave', 'Week off', 'Holiday', 'OT approved (h)', 'Late time (h)', 'OT paid after late (h)', 'Base pay', 'OT pay', 'Additions', 'Deductions', 'Advances', 'Net pay',
      'Phone', 'UPI ID', 'Bank account', 'IFSC',
    ]];
    // Current payment details, so the sheet can be used to pay salaries.
    const pay = new Map(db.prepare('SELECT id, phone, upi_id, bank_account, bank_ifsc FROM employees').all().map((e) => [e.id, e]));
    for (const x of p.rows) {
      const e = pay.get(x.employee_id) || {};
      const a = x.attendance;
      const sum = (xs) => xs.reduce((t, y) => t + y.amount_paise, 0);
      rows.push([
        x.code, x.name, x.branch_name, x.salary_type, rupees(x.salary_paise), x.paid_days, a.present, a.half_day,
        a.absent + a.not_marked, a.paid_leave, a.week_off, a.holiday, (x.ot_approved_minutes / 60).toFixed(2), (x.late_minutes / 60).toFixed(2), x.ot_hours, rupees(x.base_paise), rupees(x.ot_paise),
        rupees(sum(x.additions)), rupees(sum(x.deductions)), rupees(sum(x.advances)), rupees(x.net_paise),
        e.phone || '', e.upi_id || '', e.bank_account || '', e.bank_ifsc || '',
      ]);
    }
    rows.push(['TOTAL', '', '', '', '', '', '', '', '', '', '', '', '', '', '', rupees(p.totals.base_paise), rupees(p.totals.ot_paise), '', '', '', rupees(p.totals.net_paise)]);
    sendCsv(res, `payroll-${month}.csv`, rows);
  });

  return r;
};

function validateAdminInput(username, password, name) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{3,40}$/.test(username.trim())) throw bad('Username must be 3-40 letters/digits');
  if (typeof password !== 'string' || password.length < 8) throw bad('Password must be at least 8 characters');
  if (typeof name !== 'string' || !name.trim()) throw bad('Name is required');
}
