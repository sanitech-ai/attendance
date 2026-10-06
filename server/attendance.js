'use strict';
const { istDate, istTime, istMs, weekday, shiftMinutes } = require('./util');

/**
 * Loads everything needed to compute day-by-day attendance for one employee
 * over [from, to] (inclusive IST dates).
 */
function loadContext(db, emp, from, to) {
  const punches = new Map();
  const rows = db
    .prepare(
      `SELECT id, kind, at, work_date, status, flag_reason FROM punches
       WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND status != 'rejected'
       ORDER BY at`,
    )
    .all(emp.id, from, to);
  for (const p of rows) {
    if (!punches.has(p.work_date)) punches.set(p.work_date, []);
    punches.get(p.work_date).push(p);
  }

  const overrides = new Map(
    db
      .prepare('SELECT * FROM day_overrides WHERE employee_id = ? AND work_date BETWEEN ? AND ?')
      .all(emp.id, from, to)
      .map((o) => [o.work_date, o]),
  );

  const leaves = db
    .prepare(
      `SELECT from_date, to_date, leave_type FROM leave_requests
       WHERE employee_id = ? AND status = 'approved' AND to_date >= ? AND from_date <= ?`,
    )
    .all(emp.id, from, to);

  const holidays = new Map(
    db
      .prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ? AND (branch_id IS NULL OR branch_id = ?)')
      .all(from, to, emp.branch_id)
      .map((h) => [h.date, h.name]),
  );

  const ot = new Map(
    db
      .prepare('SELECT * FROM ot_decisions WHERE employee_id = ? AND work_date BETWEEN ? AND ?')
      .all(emp.id, from, to)
      .map((d) => [d.work_date, d]),
  );

  const late = new Map(
    db
      .prepare('SELECT * FROM late_decisions WHERE employee_id = ? AND work_date BETWEEN ? AND ?')
      .all(emp.id, from, to)
      .map((d) => [d.work_date, d]),
  );

  // The first day someone used the app: they often installed it partway through the day.
  const firstAppDay = db.prepare("SELECT MIN(work_date) AS d FROM punches WHERE employee_id = ? AND status != 'rejected'").get(emp.id)?.d || null;

  return { punches, overrides, leaves, holidays, ot, late, firstAppDay };
}

/** Pairs IN->OUT and OT_IN->OT_OUT punches; open sessions are reported, not counted. */
function pairPunches(list) {
  let regularMs = 0;
  let otMs = 0;
  let openIn = null;
  let openOt = null;
  let firstIn = null;
  let lastOut = null;
  let otStart = null;
  let otEnd = null;
  for (const p of list) {
    if (p.kind === 'IN' && openIn === null) {
      openIn = p.at;
      if (firstIn === null) firstIn = p.at;
    } else if (p.kind === 'OUT' && openIn !== null) {
      regularMs += p.at - openIn;
      lastOut = p.at;
      openIn = null;
    } else if (p.kind === 'OT_IN' && openOt === null) {
      openOt = p.at;
      if (otStart === null) otStart = p.at;
    } else if (p.kind === 'OT_OUT' && openOt !== null) {
      otMs += p.at - openOt;
      otEnd = p.at;
      openOt = null;
    }
  }
  return {
    regularMinutes: Math.floor(regularMs / 60000),
    otMinutes: Math.floor(otMs / 60000),
    openIn,
    openOt,
    firstIn,
    lastOut,
    otStart,
    otEnd,
  };
}

/** Full day = the employee's shift length minus the late grace (9:00-18:00 with 15 min grace -> 8h45m). */
function fullDayMinutes(emp, settings) {
  return Math.max(settings.half_day_hours * 60, shiftMinutes(emp.shift_start, emp.shift_end) - settings.grace_minutes);
}

/** Shift end as epoch ms; an overnight shift ends on the next calendar day. */
function shiftEndMs(emp, date) {
  const end = istMs(date, emp.shift_end);
  return emp.shift_end <= emp.shift_start ? end + 86400000 : end;
}

function statusFromMinutes(minutes, settings, emp) {
  if (minutes >= fullDayMinutes(emp, settings)) return 'present';
  if (minutes >= settings.half_day_hours * 60) return 'half_day';
  return 'absent';
}

function computeDay(emp, date, ctx, settings, today) {
  const list = ctx.punches.get(date) || [];
  const p = pairPunches(list);
  const flags = [];
  if (list.some((x) => x.status === 'flagged')) flags.push('flagged_punch');

  const day = {
    date,
    status: null,
    worked_minutes: p.regularMinutes,
    first_in: p.firstIn ? istTime(p.firstIn) : null,
    last_out: p.lastOut ? istTime(p.lastOut) : null,
    late_minutes: 0,
    late_mark: null,
    late_review: null, // very late arrivals: 'pending' until an admin decides 'present' or 'half_day'
    future: date > today, // shown on the calendar, but not counted until the day has passed
    ot_minutes: p.otMinutes,
    ot_start: p.otStart ? istTime(p.otStart) : null,
    ot_end: p.otEnd ? istTime(p.otEnd) : null,
    ot_status: null,
    ot_payable_minutes: 0,
    holiday: ctx.holidays.get(date) || null,
    override: null,
    flags,
  };

  const leave = ctx.leaves.find((l) => l.from_date <= date && l.to_date >= date);
  const isWeekOff = emp.weekly_offs
    .split(',')
    .filter(Boolean)
    .map(Number)
    .includes(weekday(date));
  const override = ctx.overrides.get(date);

  // No late marks on the joining day or the first day on the app (they may have joined or installed
  // the app after arriving); that day counts as a full day if they punched in.
  const firstDay = date === emp.joined_on || date === ctx.firstAppDay;
  if (firstDay && p.firstIn !== null) flags.push('first_day');
  if (p.firstIn !== null && emp.shift_start && !firstDay) {
    const lateBy = Math.floor((p.firstIn - istMs(date, emp.shift_start)) / 60000);
    if (lateBy > settings.grace_minutes) day.late_minutes = lateBy;
  }

  if (emp.joined_on && date < emp.joined_on) {
    day.status = 'not_joined';
  } else if (override) {
    day.status = override.status;
    day.override = { note: override.note, worked_minutes: override.worked_minutes };
    if (override.worked_minutes !== null) day.worked_minutes = override.worked_minutes;
  } else if (p.firstIn !== null) {
    const veryLate = day.late_minutes > settings.late_max_minutes;
    const decision = veryLate ? ctx.late.get(date) : null;
    if (veryLate) day.late_review = decision ? decision.status : 'pending';
    if (p.openIn !== null && date >= today) {
      day.status = 'working';
      if (veryLate && !decision) flags.push('late_approval');
    } else if (decision) {
      // More than the allowed lateness: the admin decided full or half day.
      day.status = decision.status;
    } else if (firstDay) {
      day.status = 'present';
    } else {
      day.status = statusFromMinutes(p.regularMinutes, settings, emp);
      // A slightly late arrival who stays until shift end is handled by the late-mark rule
      // (warnings, then half day) rather than being cut for short hours.
      if (day.status !== 'present' && day.late_minutes > 0 && day.late_minutes <= settings.late_max_minutes
        && p.openIn === null && p.lastOut >= shiftEndMs(emp, date)) {
        day.status = 'present';
      }
      if (p.openIn !== null) {
        flags.push('missing_out');
        // Came in but never punched out: give half a day until an admin corrects it.
        if (day.status === 'absent') day.status = 'half_day';
      } else if (day.status === 'absent') {
        flags.push('short_hours');
      }
      if (veryLate) {
        // More than late_max_minutes late: at most a half day, flagged so an admin can review it
        // later (and grant a full day if justified).
        if (day.status === 'present') day.status = 'half_day';
        flags.push('late_approval');
      }
    }
  } else if (leave) {
    day.status = leave.leave_type === 'paid' ? 'paid_leave' : 'unpaid_leave';
  } else if (day.holiday) {
    day.status = 'holiday';
  } else if (isWeekOff) {
    day.status = 'week_off';
  } else if (date > today) {
    day.status = 'upcoming';
  } else if (date === today) {
    day.status = 'not_marked';
  } else {
    day.status = 'absent';
  }

  if (p.openOt !== null && date < today) flags.push('missing_ot_out');
  if (p.otMinutes > 0) {
    const decision = ctx.ot.get(date);
    if (!settings.ot_requires_approval) {
      day.ot_status = 'approved';
      day.ot_payable_minutes = p.otMinutes;
    } else if (decision) {
      day.ot_status = decision.status;
      day.ot_payable_minutes =
        decision.status === 'approved' ? (decision.approved_minutes ?? p.otMinutes) : 0;
    } else {
      day.ot_status = 'pending';
    }
  }
  return day;
}

/**
 * Late marks are counted per calendar month. With late_warnings = 2, every 3rd late (3rd, 6th, 9th...)
 * counts as a half day and the others are warnings. Not counted: days an admin corrected, and arrivals
 * later than late_max_minutes, which go to an admin to decide full or half day instead.
 */
function applyLateMarks(day, state, settings) {
  const month = day.date.slice(0, 7);
  if (state.month !== month) {
    state.month = month;
    state.count = 0;
  }
  if (day.override || day.late_review || day.late_minutes <= 0 || !['present', 'half_day', 'working'].includes(day.status)) return;
  state.count++;
  day.late_mark = state.count;
  if (state.count % (settings.late_warnings + 1) === 0) {
    if (day.status === 'present') day.status = 'half_day';
    day.flags.push('late_penalty');
  } else {
    day.flags.push('late_warning');
  }
}

function computeRange(db, emp, from, to, settings, nowMs = Date.now()) {
  // Start at the 1st of the month so late marks earlier in the month are counted.
  const start = `${from.slice(0, 7)}-01`;
  const ctx = loadContext(db, emp, start, to);
  const today = istDate(nowMs);
  const days = [];
  const late = { month: null, count: 0 };
  for (let d = start; d <= to; ) {
    const day = computeDay(emp, d, ctx, settings, today);
    applyLateMarks(day, late, settings);
    if (d >= from) days.push(day);
    const next = new Date(`${d}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    d = next.toISOString().slice(0, 10);
  }
  return days;
}

const COUNTED = ['present', 'half_day', 'absent', 'paid_leave', 'unpaid_leave', 'week_off', 'holiday', 'not_marked', 'working'];

function summarize(days) {
  const s = Object.fromEntries(COUNTED.map((k) => [k, 0]));
  s.worked_minutes = 0;
  s.ot_minutes = 0;
  s.ot_payable_minutes = 0;
  s.ot_pending_minutes = 0;
  s.late_days = 0; // later than the grace period (15 min)
  s.late_hour_days = 0; // later than late_max_minutes (1 hour)
  s.late_minutes = 0;
  s.late_penalties = 0;
  s.late_pending = 0;
  s.ot_days = 0;
  for (const d of days) {
    if (d.future) continue;
    if (d.status in s) s[d.status]++;
    s.worked_minutes += d.worked_minutes;
    s.ot_minutes += d.ot_minutes;
    s.ot_payable_minutes += d.ot_payable_minutes;
    if (d.ot_status === 'pending') s.ot_pending_minutes += d.ot_minutes;
    if (d.late_minutes > 0) { s.late_days++; s.late_minutes += d.late_minutes; }
    if (d.late_review) s.late_hour_days++;
    if (d.ot_minutes > 0) s.ot_days++;
    if (d.flags.includes('late_penalty')) s.late_penalties++;
    if (d.flags.includes('late_approval')) s.late_pending++;
  }
  return s;
}

module.exports = { computeRange, computeDay, pairPunches, summarize, shiftMinutes };
