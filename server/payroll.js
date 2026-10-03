'use strict';
const { computeRange, summarize } = require('./attendance');
const { daysInMonth, shiftMinutes } = require('./util');

/**
 * Salary rules
 *  monthly: per-day = salary / calendar days in month.
 *           Paid days = present + ½·half-days + paid leave + weekly offs + holidays.
 *  daily:   per-day = salary. Paid days = present + ½·half-days + paid leave.
 *  hourly:  pay = rate × hours worked (paid leave counts as a full shift).
 * Overtime is paid at the same hourly rate as regular work:
 *  monthly hourly rate = per-day / shift hours, daily = salary / shift hours, hourly = salary.
 * Only approved overtime is paid.
 * Fixed monthly pay items (PF, PT, conveyance...) apply in full whenever there is at least one paid day.
 */
function salaryForEmployee(emp, days, month, extras) {
  const s = summarize(days);
  const shiftMin = shiftMinutes(emp.shift_start, emp.shift_end);
  const dim = daysInMonth(month);

  let perDay = 0;
  let hourlyRate = 0;
  let paidDays = 0;
  let basePaise = 0;

  if (emp.salary_type === 'monthly') {
    perDay = emp.salary_paise / dim;
    hourlyRate = perDay / (shiftMin / 60);
    paidDays = s.present + 0.5 * s.half_day + s.paid_leave + s.week_off + s.holiday;
    basePaise = perDay * paidDays;
  } else if (emp.salary_type === 'daily') {
    perDay = emp.salary_paise;
    hourlyRate = perDay / (shiftMin / 60);
    paidDays = s.present + 0.5 * s.half_day + s.paid_leave;
    basePaise = perDay * paidDays;
  } else {
    hourlyRate = emp.salary_paise;
    let minutes = 0;
    for (const d of days) {
      if (d.status === 'present' || d.status === 'half_day') {
        if (d.worked_minutes > 0) minutes += d.worked_minutes;
        else if (d.override) minutes += d.status === 'present' ? shiftMin : shiftMin / 2;
      } else if (d.status === 'paid_leave') {
        minutes += shiftMin;
      }
    }
    paidDays = s.present + 0.5 * s.half_day + s.paid_leave;
    basePaise = (hourlyRate * minutes) / 60;
  }

  const otPaise = (hourlyRate * s.ot_payable_minutes) / 60;
  const fixed = paidDays > 0 ? extras.payItems || [] : [];
  const items = [...fixed, ...extras.adjustments];
  const additions = items.filter((a) => a.kind === 'addition');
  const deductions = items.filter((a) => a.kind === 'deduction');
  const sum = (xs) => xs.reduce((t, x) => t + x.amount_paise, 0);

  const base = Math.round(basePaise);
  const ot = Math.round(otPaise);
  const addTotal = sum(additions);
  const dedTotal = sum(deductions);
  const advTotal = sum(extras.advances);
  const gross = base + ot + addTotal;

  return {
    employee_id: emp.id,
    code: emp.code,
    name: emp.name,
    designation: emp.designation,
    branch_id: emp.branch_id,
    branch_name: emp.branch_name,
    salary_type: emp.salary_type,
    salary_paise: emp.salary_paise,
    shift: `${emp.shift_start}-${emp.shift_end}`,
    days_in_month: dim,
    attendance: s,
    paid_days: paidDays,
    per_day_paise: Math.round(perDay),
    hourly_rate_paise: Math.round(hourlyRate),
    base_paise: base,
    ot_hours: Math.round((s.ot_payable_minutes / 60) * 100) / 100,
    ot_paise: ot,
    additions: additions.map(({ label, amount_paise }) => ({ label, amount_paise })),
    deductions: deductions.map(({ label, amount_paise }) => ({ label, amount_paise })),
    advances: extras.advances.map(({ given_on, note, amount_paise }) => ({ given_on, note, amount_paise })),
    gross_paise: gross,
    total_deductions_paise: dedTotal + advTotal,
    net_paise: gross - dedTotal - advTotal,
  };
}

function computePayroll(db, month, settings, nowMs = Date.now()) {
  const from = `${month}-01`;
  const to = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const employees = db
    .prepare(
      `SELECT e.*, b.name AS branch_name FROM employees e JOIN branches b ON b.id = e.branch_id
       WHERE e.joined_on <= ? AND (e.active = 1 OR EXISTS (
         SELECT 1 FROM punches p WHERE p.employee_id = e.id AND p.work_date BETWEEN ? AND ?))
       ORDER BY b.name, e.name`,
    )
    .all(to, from, to);
  const adjStmt = db.prepare('SELECT * FROM adjustments WHERE employee_id = ? AND month = ? ORDER BY id');
  const advStmt = db.prepare('SELECT * FROM advances WHERE employee_id = ? AND deduct_month = ? ORDER BY given_on');
  const itemStmt = db.prepare('SELECT * FROM pay_items WHERE employee_id = ? ORDER BY kind, id');

  const rows = employees.map((emp) => {
    const days = computeRange(db, emp, from, to, settings, nowMs);
    return salaryForEmployee(emp, days, month, {
      adjustments: adjStmt.all(emp.id, month),
      payItems: itemStmt.all(emp.id),
      advances: advStmt.all(emp.id, month),
    });
  });
  const totals = rows.reduce(
    (t, r) => ({
      base_paise: t.base_paise + r.base_paise,
      ot_paise: t.ot_paise + r.ot_paise,
      gross_paise: t.gross_paise + r.gross_paise,
      total_deductions_paise: t.total_deductions_paise + r.total_deductions_paise,
      net_paise: t.net_paise + r.net_paise,
    }),
    { base_paise: 0, ot_paise: 0, gross_paise: 0, total_deductions_paise: 0, net_paise: 0 },
  );
  return { month, company_name: settings.company_name, rows, totals };
}

module.exports = { computePayroll, salaryForEmployee };
