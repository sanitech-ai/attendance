'use strict';
/* Shared helpers for the staff app and admin dashboard (no build step, no framework). */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.endsWith('/login') && !url.endsWith('/pin') && !url.endsWith('/password')) onUnauthorized();
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

function toast(message, kind = 'ok') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
}

/** Runs an async action, showing errors as toasts. Disables the button while running. */
async function run(fn, button) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message || String(err), 'error');
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const money = (paise) => inr.format((paise || 0) / 100);

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
function fmtDateTime(ms) {
  return new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
function fmtDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function fmtMonth(month) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function fmtMinutes(m) {
  if (!m) return '0h';
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
}
function todayIST() {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}
function thisMonth() {
  return todayIST().slice(0, 7);
}
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

const STATUS_LABEL = {
  present: 'Present', half_day: 'Half day', absent: 'Absent', paid_leave: 'Paid leave', unpaid_leave: 'Unpaid leave',
  week_off: 'Week off', holiday: 'Holiday', not_marked: 'Not marked', upcoming: '', not_joined: '', working: 'Working',
};
const STATUS_SHORT = {
  present: 'P', half_day: 'HD', absent: 'A', paid_leave: 'PL', unpaid_leave: 'UL', week_off: 'WO', holiday: 'H',
  not_marked: '–', upcoming: '', not_joined: '', working: 'W',
};
const PUNCH_LABEL = { IN: 'Punch In', OUT: 'Punch Out', OT_IN: 'Start Overtime', OT_OUT: 'End Overtime' };
const DOC_LABEL = { aadhaar: 'Aadhaar', pan: 'PAN', bank: 'Bank passbook / cheque', photo: 'Photo', other: 'Other' };
const FLAG_LABEL = {
  flagged_punch: 'Location flagged', missing_out: 'No punch out', short_hours: 'Short hours', missing_ot_out: 'OT not ended',
  late_warning: 'Late (warning)', late_penalty: 'Late → half day', late_approval: 'Very late — half day, to review',
};

/** "Late 20m · warning 1 of 2" / "Late 20m · 3rd late → half day" */
/** "Late 20m · late #1 this month (every 3rd is a half day)" / "Late 1h 30m · waiting for approval" */
function lateText(day, warnings) {
  if (!day.late_minutes) return '';
  const ord = (n) => `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10] || 'th'}`;
  const late = `Late ${fmtMinutes(day.late_minutes)}`;
  if (day.late_review === 'pending') return `${late} · counted as half day (to be reviewed)`;
  if (day.late_review === 'present') return `${late} · approved as full day`;
  if (day.late_review === 'half_day') return `${late} · marked half day`;
  if (!day.late_mark) return late;
  return day.flags.includes('late_penalty')
    ? `${late} · ${ord(day.late_mark)} late this month → half day`
    : `${late} · ${ord(day.late_mark)} late this month (every ${ord(warnings + 1)} is a half day)`;
}

/** "✓ Naresh (manager): looks fine — note" shown next to items a manager has checked. */
function verifBadge(v) {
  if (!v) return '';
  return h('div', { class: 'small', style: { marginTop: '4px' } },
    badge(`${v.verdict === 'ok' ? '✓' : '⚠'} ${v.manager_name || 'Manager'}: ${v.verdict === 'ok' ? 'looks fine' : 'doubtful'}`, v.verdict === 'ok' ? 'ok' : 'bad'),
    v.note ? h('span', { class: 'muted' }, ` “${v.note}”`) : '');
}

function lateKind(day) {
  return day.flags.includes('late_penalty') || day.late_review === 'half_day' ? 'bad' : day.late_review === 'present' ? 'ok' : 'warn';
}

function badge(text, kind) {
  return h('span', { class: `badge badge-${kind || 'neutral'}` }, text);
}

function statusBadge(status) {
  const kind = { present: 'ok', working: 'ok', half_day: 'warn', absent: 'bad', not_marked: 'bad', paid_leave: 'info', unpaid_leave: 'info', week_off: 'neutral', holiday: 'neutral' }[status];
  return STATUS_LABEL[status] ? badge(STATUS_LABEL[status], kind) : '';
}

/** Modal dialog. content: Node. Returns {close}. */
function modal(title, content, { wide = false, onClose } = {}) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const overlay = h('div', { class: 'modal-overlay', onclick: (e) => e.target === overlay && close() },
    h('div', { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, content)));
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return { close };
}

/**
 * Generic form in a modal.
 * fields: [{name, label, type: text|number|date|time|select|textarea|checkbox|checks|file|password, options, value, required, hint, step}]
 */
function formDialog({ title, fields, submitLabel = 'Save', onSubmit, wide }) {
  const inputs = {};
  const body = h('form', { class: 'form', novalidate: true });
  for (const f of fields) {
    if (f.type === 'heading') {
      body.append(h('h3', { class: 'form-heading' }, f.label));
      continue;
    }
    if (f.type === 'button') {
      body.append(h('div', { class: 'field' }, h('button', { type: 'button', class: 'btn btn-sm', onclick: (e) => f.onclick(body, e.currentTarget) }, f.label),
        f.hint ? h('div', { class: 'hint' }, f.hint) : ''));
      continue;
    }
    let input;
    const id = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
    if (f.type === 'select') {
      input = h('select', { id, name: f.name, required: f.required },
        f.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value ?? '') }, o.label)));
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, name: f.name, rows: 3, required: f.required }, f.value ?? '');
    } else if (f.type === 'checkbox') {
      input = h('input', { id, name: f.name, type: 'checkbox', checked: !!f.value });
    } else if (f.type === 'checks') {
      const vals = new Set((f.value || []).map(String));
      input = h('div', { class: 'checks', id },
        f.options.map((o) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: o.value, checked: vals.has(String(o.value)) }), o.label)));
    } else {
      input = h('input', {
        id, name: f.name, type: f.type || 'text', value: f.type === 'file' ? null : f.value ?? '', required: f.required,
        step: f.step, min: f.min, max: f.max, accept: f.accept, placeholder: f.placeholder, inputmode: f.inputmode,
        autocomplete: f.autocomplete || 'off', maxlength: f.maxlength, pattern: f.pattern,
      });
    }
    inputs[f.name] = { f, input };
    const label = f.type === 'checkbox'
      ? h('label', { class: 'check', for: id }, input, f.label)
      : [h('label', { for: id }, f.label, f.required ? h('span', { class: 'req' }, ' *') : ''), input];
    body.append(h('div', { class: 'field' }, label, f.hint ? h('div', { class: 'hint' }, f.hint) : ''));
  }
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel);
  body.append(h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), submit));
  const dlg = modal(title, body, { wide });
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const [name, { f, input }] of Object.entries(inputs)) {
      if (f.type === 'checkbox') values[name] = input.checked;
      else if (f.type === 'checks') values[name] = [...input.querySelectorAll('input:checked')].map((x) => x.value);
      else if (f.type === 'file') values[name] = input.files[0] || null;
      else values[name] = input.value.trim();
      if (f.required && (values[name] === '' || values[name] === null)) {
        toast(`${f.label} is required`, 'error');
        input.focus();
        return;
      }
    }
    const ok = await run(() => onSubmit(values), submit);
    if (ok !== undefined && ok !== false) dlg.close();
  });
  setTimeout(() => body.querySelector('input:not([type=checkbox]),select,textarea')?.focus(), 50);
  return { ...dlg, form: body };
}

function confirmDialog(title, message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.close();
      resolve(v);
    };
    const dlg = modal(title, h('div', {},
      h('p', {}, message),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => finish(true) }, confirmLabel))),
    { onClose: () => finish(false) });
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}

/** Shrinks large photos before upload so phone pictures don't hit the size limit. */
async function prepareUpload(file, maxBytes = 8 * 1024 * 1024) {
  if (file.type === 'application/pdf') {
    if (file.size > maxBytes) throw new Error('PDF is larger than 8 MB');
    return readFileAsDataUrl(file);
  }
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('Only JPG, PNG or PDF files are allowed');
  if (file.size < 1.5 * 1024 * 1024) return readFileAsDataUrl(file);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = h('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function table(columns, rows, { empty = 'Nothing here yet.', rowClass } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.class }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', { class: rowClass ? rowClass(r) : null }, columns.map((c) => h('td', { class: c.class, 'data-label': c.label }, c.render(r))))))));
}

function monthPicker(month, onChange) {
  return h('div', { class: 'month-picker' },
    h('button', { class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => onChange(shiftMonth(month, -1)) }, '‹'),
    h('span', {}, fmtMonth(month)),
    h('button', { class: 'icon-btn', 'aria-label': 'Next month', onclick: () => onChange(shiftMonth(month, 1)) }, '›'));
}

function mapLink(lat, lng, text = 'Map') {
  return h('a', { href: `https://www.google.com/maps?q=${lat},${lng}`, target: '_blank', rel: 'noopener' }, text);
}

/** Opens a printable payslip in a new window. */
/** Opens a printable payslip. opts.provisional marks a not-yet-final, live statement. */
function openPayslip(company, month, row, opts = {}) {
  const w = window.open('', '_blank');
  if (!w) {
    toast('Allow pop-ups to view the payslip', 'error');
    return;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const a = row.attendance;
  const line = (label, value) => `<tr><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`;
  const earnings = [
    line(`Base pay (${row.paid_days} paid days)`, money(row.base_paise)),
    line(`Overtime (${row.ot_hours} h)`, money(row.ot_paise)),
    ...row.additions.map((x) => line(x.label, money(x.amount_paise))),
  ].join('');
  const deductions = [
    ...row.deductions.map((x) => line(x.label, money(x.amount_paise))),
    ...row.advances.map((x) => line(`Advance (${x.given_on}${x.note ? `, ${x.note}` : ''})`, money(x.amount_paise))),
  ].join('') || line('None', money(0));
  const rate = row.salary_type === 'monthly' ? `${money(row.salary_paise)} / month`
    : row.salary_type === 'daily' ? `${money(row.salary_paise)} / day` : `${money(row.salary_paise)} / hour`;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${esc(row.code)} ${esc(month)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:24px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:#555}
.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #111;padding-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 4px;border-bottom:1px solid #e5e5e5}.r{text-align:right}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:14px}.net{font-size:20px;font-weight:700;margin-top:20px;display:flex;justify-content:space-between;border-top:2px solid #111;padding-top:12px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media(max-width:600px){.cols,.grid{grid-template-columns:1fr}}
button{margin-top:24px;padding:8px 16px;font-size:14px}.prov{margin-top:6px;color:#9a5b00;font-size:13px;font-weight:600}@media print{button{display:none}}
</style></head><body>
<div class="head"><div style="display:flex;gap:14px;align-items:center"><img src="${location.origin}/logo.svg" alt="" style="width:86px"><div><h1>${esc(company)}</h1><div>${opts.provisional ? 'Salary statement (provisional)' : 'Payslip'} for ${esc(fmtMonth(month))}</div>${opts.provisional ? `<div class="prov">Not final — calculated from attendance up to ${esc(fmtDateTime(opts.asOf))}. It can change until salary is finalized.</div>` : ''}</div></div><div>${esc(row.branch_name)}</div></div>
<h2>Employee</h2>
<div class="grid"><div>Name: <b>${esc(row.name)}</b></div><div>Employee ID: <b>${esc(row.code)}</b></div>
<div>Designation: ${esc(row.designation || '-')}</div><div>Salary: ${esc(rate)}</div><div>Shift: ${esc(row.shift)}</div></div>
<h2>Attendance</h2>
<div class="grid"><div>Days in month: ${row.days_in_month}</div><div>Paid days: <b>${row.paid_days}</b></div>
<div>Present: ${a.present}</div><div>Half days: ${a.half_day}</div><div>Absent: ${a.absent + a.not_marked}</div><div>Paid leave: ${a.paid_leave}</div>
<div>Unpaid leave: ${a.unpaid_leave}</div><div>Week offs: ${a.week_off}</div><div>Holidays: ${a.holiday}</div><div>Late days: ${a.late_days}${a.late_penalties ? ` (${a.late_penalties} counted as half day)` : ''}</div>
<div>Overtime (approved): ${row.ot_hours} h</div></div>
<div class="cols"><div><h2>Earnings</h2><table>${earnings}${line('Gross', money(row.gross_paise))}</table></div>
<div><h2>Deductions</h2><table>${deductions}${line('Total', money(row.total_deductions_paise))}</table></div></div>
<div class="net"><span>Net pay</span><span>${money(row.net_paise)}</span></div>
<button id="print">Print / Save as PDF</button>
</body></html>`);
  w.document.close();
  w.document.getElementById('print').addEventListener('click', () => w.print());
}
