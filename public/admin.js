'use strict';
/* Admin dashboard: attendance review, staff, branches, documents, overtime, leaves and payroll. */

const A = { me: null, branches: [], employees: [] };
const root = document.getElementById('root');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

setUnauthorizedHandler(() => showLogin());

// ---------------------------------------------------------------- auth

async function boot() {
  try {
    A.me = await api('GET', '/api/admin/me');
  } catch (err) {
    if (err.status !== 401) {
      root.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'card' }, `Could not connect: ${err.message}`)));
      return;
    }
    const { needs_setup: needsSetup } = await api('GET', '/api/admin/setup-status');
    return needsSetup ? showSetup() : showLogin();
  }
  window.addEventListener('hashchange', route);
  route();
}

function loginShell(title, subtitle, fields, submitLabel, onSubmit) {
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, submitLabel);
  const inputs = fields.map((f) => h('input', { id: f.name, name: f.name, type: f.type || 'text', autocomplete: f.autocomplete || 'off', required: true, placeholder: f.placeholder }));
  const form = h('form', { class: 'form card login-card' },
    h('img', { src: '/icon.svg', alt: '', class: 'logo' }), h('h1', {}, title), h('p', { class: 'muted' }, subtitle),
    fields.map((f, i) => h('div', { class: 'field' }, h('label', { for: f.name }, f.label), inputs[i], f.hint ? h('div', { class: 'hint' }, f.hint) : '')),
    btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
    await run(() => onSubmit(values), btn);
  });
  root.replaceChildren(h('div', { class: 'login-wrap' }, form));
  inputs[0].focus();
}

function showLogin() {
  loginShell('Admin login', 'Attendance & payroll dashboard', [
    { name: 'username', label: 'Username', autocomplete: 'username' },
    { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' },
  ], 'Log in', async (v) => {
    await api('POST', '/api/admin/login', v);
    location.reload();
  });
}

function showSetup() {
  loginShell('Welcome! Set up your account', 'Create the first admin account. You can add more admins later in Settings.', [
    { name: 'company_name', label: 'Company name' },
    { name: 'name', label: 'Your name' },
    { name: 'username', label: 'Username', autocomplete: 'username' },
    { name: 'password', label: 'Password', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters.' },
  ], 'Create account', async (v) => {
    await api('POST', '/api/admin/setup', v);
    location.hash = '#/branches';
    location.reload();
  });
}

// ---------------------------------------------------------------- layout & routing

const PAGES = [
  ['dashboard', 'Dashboard'],
  ['punches', 'Punches & selfies', 'flagged_punches'],
  ['attendance', 'Attendance register'],
  ['overtime', 'Overtime'],
  ['leaves', 'Leave requests', 'leaves'],
  ['payroll', 'Payroll'],
  ['employees', 'Employees'],
  ['documents', 'Documents', 'documents'],
  ['branches', 'Branches'],
  ['holidays', 'Holidays'],
  ['settings', 'Settings'],
];

function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  return { page: path || 'dashboard', params: new URLSearchParams(qs || '') };
}

function go(page, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  const target = `#/${page}${qs ? `?${qs}` : ''}`;
  if (location.hash === target) route();
  else location.hash = target;
}

async function route() {
  const { page, params } = parseHash();
  const content = h('main', { class: 'content' });
  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, A.me.settings.company_name),
    h('nav', {}, PAGES.map(([key, label, countKey]) =>
      h('a', { href: `#/${key}`, class: key === page ? 'active' : '', onclick: () => sidebar.classList.remove('open') },
        label, countKey ? h('span', { class: 'count hidden', 'data-count': countKey }) : ''))),
    h('div', { class: 'foot' },
      h('div', {}, A.me.admin.name),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('a', { href: '/', target: '_blank', class: 'small' }, 'Staff app ↗'),
        h('button', { class: 'btn btn-sm', onclick: async () => { await run(() => api('POST', '/api/admin/logout')); location.reload(); } }, 'Log out'))));
  root.replaceChildren(h('div', { class: 'admin' },
    sidebar,
    h('div', {},
      h('div', { class: 'mobile-bar' }, h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: () => sidebar.classList.toggle('open') }, '☰'), A.me.settings.company_name),
      content)));
  refreshCounts();
  const fn = PAGE_FNS[page] || PAGE_FNS.dashboard;
  content.append(h('div', { class: 'empty' }, 'Loading…'));
  try {
    await fn(content, params);
  } catch (err) {
    content.replaceChildren(h('div', { class: 'card' }, `Error: ${err.message}`));
  }
}

async function refreshCounts() {
  const c = await api('GET', '/api/admin/pending').catch(() => null);
  if (!c) return;
  for (const el of document.querySelectorAll('[data-count]')) {
    const n = c[el.dataset.count];
    el.textContent = n;
    el.classList.toggle('hidden', !n);
  }
}

async function loadBranches() {
  A.branches = await api('GET', '/api/admin/branches');
  return A.branches;
}
async function loadEmployees() {
  A.employees = await api('GET', '/api/admin/employees');
  return A.employees;
}

function pageHead(title, ...right) {
  return h('div', { class: 'page-head' }, h('h1', {}, title), h('div', { class: 'row' }, right));
}

function branchSelect(value, onChange, allLabel = 'All branches') {
  return h('select', { onchange: (e) => onChange(e.target.value), 'aria-label': 'Branch' },
    h('option', { value: '' }, allLabel),
    A.branches.filter((b) => b.active).map((b) => h('option', { value: b.id, selected: String(b.id) === String(value) }, b.name)));
}

function employeeSelect(value, onChange, allLabel = 'All employees') {
  return h('select', { onchange: (e) => onChange(e.target.value), 'aria-label': 'Employee' },
    h('option', { value: '' }, allLabel),
    A.employees.map((e) => h('option', { value: e.id, selected: String(e.id) === String(value) }, `${e.name} (${e.code})`)));
}

function employeeOptions() {
  return A.employees.filter((e) => e.active).map((e) => ({ value: e.id, label: `${e.name} (${e.code})` }));
}

// ---------------------------------------------------------------- dashboard

async function pageDashboard(el, params) {
  const date = params.get('date') || todayIST();
  const d = await api('GET', `/api/admin/dashboard?date=${date}`);
  const t = d.totals;
  if (!A.branches.length) await loadBranches();
  const tile = (v, l, href) => h(href ? 'a' : 'div', { class: 'stat', href }, h('div', { class: 'v' }, String(v)), h('div', { class: 'l' }, l));
  const gettingStarted = !A.branches.length || !t.employees
    ? h('div', { class: 'card', style: { marginBottom: '16px' } }, h('h2', {}, 'Getting started'),
      h('ol', {},
        h('li', {}, h('a', { href: '#/branches' }, 'Add your branches'), ' with their GPS location and allowed radius.'),
        h('li', {}, h('a', { href: '#/employees' }, 'Add employees'), ' with salary, shift and a PIN.'),
        h('li', {}, 'Share the staff app link with employees: ', h('code', {}, location.origin + '/'), '. They log in with Employee ID + PIN and add it to their home screen.')))
    : '';
  el.replaceChildren(
    pageHead('Dashboard', h('input', { type: 'date', value: date, onchange: (e) => go('dashboard', { date: e.target.value }) })),
    gettingStarted,
    h('div', { class: 'stats' },
      tile(t.employees, 'Active staff'), tile(t.in, 'Present / working'), tile(t.absent, 'Absent / not marked'),
      tile(t.late, 'Late'), tile(t.on_leave, 'On leave'), tile(t.off, 'Week off / holiday'), tile(t.on_ot, 'On overtime now')),
    h('div', { class: 'stats', style: { marginTop: '10px' } },
      tile(d.pending.flagged_punches, 'Flagged punches to review', '#/punches?status=flagged'),
      tile(d.pending.leaves, 'Leave requests pending', '#/leaves?status=pending'),
      tile(d.pending.documents, 'Documents to verify', '#/documents?status=pending')),
    h('h2', { style: { margin: '20px 0 10px' } }, `Staff on ${fmtDate(date)}`),
    table([
      { label: 'Employee', render: (r) => h('div', {}, h('strong', {}, r.name), h('div', { class: 'small muted' }, `${r.code} · ${r.branch_name}`)) },
      { label: 'Status', render: (r) => [statusBadge(r.day.status), r.day.late_minutes ? [' ', badge(`Late ${fmtMinutes(r.day.late_minutes)}`, 'warn')] : ''] },
      { label: 'In', render: (r) => r.day.first_in || '—' },
      { label: 'Out', render: (r) => r.day.last_out || '—' },
      { label: 'Worked', class: 'num', render: (r) => fmtMinutes(r.day.worked_minutes) },
      { label: 'OT', class: 'num', render: (r) => (r.day.ot_minutes ? fmtMinutes(r.day.ot_minutes) : r.last_punch?.kind === 'OT_IN' ? badge('on OT', 'ot') : '—') },
      { label: 'Last punch', render: (r) => (r.last_punch ? h('span', {}, `${PUNCH_LABEL[r.last_punch.kind]} ${fmtTime(r.last_punch.at)}`,
        r.last_punch.status === 'flagged' ? [' ', badge('flagged', 'warn')] : '') : '—') },
      { label: '', render: (r) => h('a', { href: `#/punches?date=${date}&employee_id=${r.employee_id}` }, 'Selfies') },
    ], d.rows, { empty: 'No active employees yet.', rowClass: (r) => (r.day.flags.includes('flagged_punch') ? 'row-flag' : null) }));
}

// ---------------------------------------------------------------- punches

async function pagePunches(el, params) {
  await Promise.all([loadBranches(), loadEmployees()]);
  const f = {
    date: params.has('date') ? params.get('date') : (params.get('status') === 'flagged' ? '' : todayIST()),
    branch_id: params.get('branch_id') || '',
    employee_id: params.get('employee_id') || '',
    status: params.get('status') || '',
  };
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const rows = await api('GET', `/api/admin/punches?${qs}`);
  const set = (k) => (v) => go('punches', { ...f, [k]: v });
  const statusKind = { ok: 'ok', flagged: 'warn', approved: 'info', rejected: 'bad' };

  el.replaceChildren(
    pageHead('Punches & selfies'),
    h('div', { class: 'toolbar' },
      h('input', { type: 'date', value: f.date, onchange: (e) => set('date')(e.target.value), 'aria-label': 'Date' }),
      f.date ? h('button', { class: 'btn btn-sm', onclick: () => set('date')('') }, 'All dates') : '',
      branchSelect(f.branch_id, set('branch_id')),
      employeeSelect(f.employee_id, set('employee_id')),
      h('select', { onchange: (e) => set('status')(e.target.value), 'aria-label': 'Status' },
        [['', 'All statuses'], ['flagged', 'Flagged (needs review)'], ['ok', 'OK'], ['approved', 'Approved'], ['rejected', 'Rejected']]
          .map(([v, l]) => h('option', { value: v, selected: v === f.status }, l)))),
    table([
      { label: 'Selfie', render: (p) => h('img', { class: 'thumb', src: `/api/admin/punches/${p.id}/selfie`, alt: 'Selfie', loading: 'lazy', onclick: () => punchDetail(p) }) },
      { label: 'Employee', render: (p) => h('div', {}, h('strong', {}, p.name), h('div', { class: 'small muted' }, p.code)) },
      { label: 'Punch', render: (p) => h('div', {}, PUNCH_LABEL[p.kind], h('div', { class: 'small muted' }, `${fmtDateTime(p.at)}`)) },
      { label: 'Location', render: (p) => h('div', {}, p.inside_geofence ? `At ${p.branch_name}` : p.branch_name ? `${p.distance_m} m from ${p.branch_name}` : 'Unknown',
        h('div', { class: 'small muted' }, p.accuracy_m !== null ? `±${Math.round(p.accuracy_m)} m · ` : '', mapLink(p.lat, p.lng))) },
      { label: 'Status', render: (p) => h('div', {}, badge(p.status, statusKind[p.status]), p.flag_reason ? h('div', { class: 'small muted' }, p.flag_reason) : '') },
      { label: '', render: (p) => reviewButtons(p) },
    ], rows, { empty: 'No punches match these filters.', rowClass: (p) => (p.status === 'flagged' ? 'row-flag' : null) }),
    rows.length === 500 ? h('p', { class: 'small muted' }, 'Showing the latest 500 punches. Use filters to narrow down.') : '');
}

function reviewButtons(p, after) {
  const act = (status) => async (e) => {
    if (await run(() => api('POST', `/api/admin/punches/${p.id}/review`, { status }), e.currentTarget)) {
      toast(status === 'approved' ? 'Punch approved' : 'Punch rejected — it no longer counts for attendance');
      if (after) after();
      route();
    }
  };
  return h('div', { class: 'row' },
    p.status !== 'approved' && p.status !== 'ok' ? h('button', { class: 'btn btn-sm btn-ok', onclick: act('approved') }, 'Approve') : '',
    p.status !== 'rejected' ? h('button', { class: 'btn btn-sm', onclick: act('rejected') }, 'Reject') : '');
}

function punchDetail(p) {
  const dlg = modal(`${p.name} · ${PUNCH_LABEL[p.kind]}`, h('div', { class: 'stack' },
    h('img', { class: 'selfie-big', src: `/api/admin/punches/${p.id}/selfie`, alt: 'Selfie' }),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Time'), h('dd', {}, fmtDateTime(p.at)),
      h('dt', {}, 'Work date'), h('dd', {}, fmtDate(p.work_date)),
      h('dt', {}, 'Home branch'), h('dd', {}, p.home_branch_name),
      h('dt', {}, 'Nearest branch'), h('dd', {}, p.branch_name ? `${p.branch_name} (${p.distance_m} m, ${p.inside_geofence ? 'inside' : 'outside'} geofence)` : '—'),
      h('dt', {}, 'GPS'), h('dd', {}, `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)} `, p.accuracy_m !== null ? `±${Math.round(p.accuracy_m)} m ` : '', mapLink(p.lat, p.lng, 'Open map')),
      h('dt', {}, 'Status'), h('dd', {}, p.status, p.flag_reason ? ` — ${p.flag_reason}` : '')),
    reviewButtons(p, () => dlg.close())), { wide: true });
}

// ---------------------------------------------------------------- attendance register

async function pageAttendance(el, params) {
  await loadBranches();
  const month = params.get('month') || thisMonth();
  const branchId = params.get('branch_id') || '';
  const data = await api('GET', `/api/admin/attendance?month=${month}${branchId ? `&branch_id=${branchId}` : ''}`);
  const dates = data.rows[0]?.days.map((d) => d.date) || [];
  const today = todayIST();

  const grid = data.rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'register' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Employee'),
      dates.map((d) => h('th', { title: fmtDate(d), style: d === today ? { color: 'var(--primary)' } : null }, h('div', {}, d.slice(8)), h('div', { class: 'small' }, WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()][0]))),
      ['P', 'HD', 'A', 'Leave', 'Late', 'Hours', 'OT h'].map((x) => h('th', {}, x)))),
    h('tbody', {}, data.rows.map((r) => h('tr', {},
      h('td', {}, h('strong', {}, r.name), h('div', { class: 'small muted' }, `${r.code} · ${r.branch_name}`)),
      r.days.map((d) => h('td', {}, STATUS_SHORT[d.status] !== '' || d.override ? h('span', {
        class: `c ${d.status}${d.override ? ' ovr' : ''}${d.flags.length ? ' flag' : ''}`,
        title: `${fmtDate(d.date)}: ${STATUS_LABEL[d.status] || d.status}${d.first_in ? ` · ${d.first_in}–${d.last_out || '?'}` : ''}${d.flags.length ? ` · ${d.flags.map((x) => FLAG_LABEL[x]).join(', ')}` : ''}`,
        onclick: () => editDay(r, d, data.finalized),
      }, STATUS_SHORT[d.status] || '·') : h('span', { class: 'c', onclick: () => editDay(r, d, data.finalized) }, '·'))),
      h('td', {}, r.summary.present), h('td', {}, r.summary.half_day), h('td', {}, r.summary.absent + r.summary.not_marked),
      h('td', {}, r.summary.paid_leave + r.summary.unpaid_leave), h('td', {}, r.summary.late_days),
      h('td', {}, (r.summary.worked_minutes / 60).toFixed(1)), h('td', {}, (r.summary.ot_payable_minutes / 60).toFixed(1))))))) : h('div', { class: 'empty' }, 'No employees.');

  el.replaceChildren(
    pageHead('Attendance register',
      h('a', { class: 'btn', href: `/api/admin/attendance.csv?month=${month}${branchId ? `&branch_id=${branchId}` : ''}` }, 'Download Excel (CSV)')),
    h('div', { class: 'toolbar' },
      monthPicker(month, (m) => go('attendance', { month: m, branch_id: branchId })),
      branchSelect(branchId, (v) => go('attendance', { month, branch_id: v }))),
    data.finalized ? h('div', { class: 'card', style: { marginBottom: '12px' } }, '🔒 Payroll for this month is finalized. Reopen it on the Payroll page to make corrections.') : '',
    grid,
    h('p', { class: 'small muted' }, 'P present · HD half day · A absent · PL/UL paid/unpaid leave · WO week off · H holiday · W working now · – not marked. Dashed border = corrected by admin, red dot = needs attention. Click any cell to correct it.'));
}

function editDay(r, d, finalized) {
  if (finalized) return toast('This month is finalized. Reopen payroll to edit.', 'error');
  const info = h('dl', { class: 'kv', style: { marginBottom: '14px' } },
    h('dt', {}, 'Calculated'), h('dd', {}, STATUS_LABEL[d.status] || d.status),
    h('dt', {}, 'In / Out'), h('dd', {}, `${d.first_in || '—'} / ${d.last_out || '—'}`),
    h('dt', {}, 'Worked'), h('dd', {}, fmtMinutes(d.worked_minutes)),
    d.late_minutes ? [h('dt', {}, 'Late'), h('dd', {}, fmtMinutes(d.late_minutes))] : '',
    d.ot_minutes ? [h('dt', {}, 'Overtime'), h('dd', {}, `${fmtMinutes(d.ot_minutes)} (${d.ot_status})`)] : '',
    d.flags.length ? [h('dt', {}, 'Attention'), h('dd', {}, d.flags.map((x) => FLAG_LABEL[x]).join(', '))] : '');
  const dlg = formDialog({
    title: `${r.name} · ${fmtDate(d.date)}`,
    fields: [
      { name: 'status', label: 'Set status', type: 'select', value: d.override ? d.status : '',
        options: [{ value: '', label: 'Automatic (from punches)' }, ...['present', 'half_day', 'absent', 'paid_leave', 'unpaid_leave', 'week_off', 'holiday'].map((s) => ({ value: s, label: STATUS_LABEL[s] }))] },
      { name: 'worked_minutes', label: 'Worked minutes (optional)', type: 'number', min: 0, max: 1440, value: d.override?.worked_minutes ?? '', hint: 'Used for hourly-paid staff. Leave blank to keep punched hours.' },
      { name: 'note', label: 'Reason', type: 'text', value: d.override?.note || '', placeholder: 'e.g. Forgot to punch out, verified with manager' },
    ],
    async onSubmit(v) {
      await api('PUT', '/api/admin/attendance/override', {
        employee_id: r.employee_id, date: d.date, status: v.status || null, worked_minutes: v.worked_minutes === '' ? null : Number(v.worked_minutes), note: v.note,
      });
      toast('Attendance updated');
      route();
      return true;
    },
  });
  document.querySelector('.modal .form').prepend(info, h('p', { class: 'small' }, h('a', { href: `#/punches?date=${d.date}&employee_id=${r.employee_id}`, onclick: () => dlg.close() }, 'See selfies for this day →')));
}

// ---------------------------------------------------------------- overtime

async function pageOvertime(el, params) {
  const month = params.get('month') || thisMonth();
  const data = await api('GET', `/api/admin/overtime?month=${month}`);
  const statusKind = { approved: 'ok', rejected: 'bad', pending: 'warn' };
  const decide = (r, status, minutes) => run(async () => {
    await api('POST', '/api/admin/overtime/decision', { employee_id: r.employee_id, date: r.date, status, approved_minutes: minutes });
    toast(status ? `Overtime ${status}` : 'Decision cleared');
    route();
  });
  el.replaceChildren(
    pageHead('Overtime'),
    h('div', { class: 'toolbar' }, monthPicker(month, (m) => go('overtime', { month: m }))),
    h('p', { class: 'muted small' }, data.requires_approval
      ? 'Staff use “Start Overtime” / “End Overtime” with a selfie and location. Only approved overtime is paid, at the same hourly rate as regular work.'
      : 'Overtime approval is turned off in Settings, so all recorded overtime is paid automatically.'),
    table([
      { label: 'Date', render: (r) => fmtDate(r.date) },
      { label: 'Employee', render: (r) => h('div', {}, h('strong', {}, r.name), h('div', { class: 'small muted' }, `${r.code} · ${r.branch_name}`)) },
      { label: 'OT start – end', render: (r) => `${r.ot_start || '—'} – ${r.ot_end || (r.flags.includes('missing_ot_out') ? 'not ended' : '—')}` },
      { label: 'Recorded', class: 'num', render: (r) => fmtMinutes(r.ot_minutes) },
      { label: 'Paid', class: 'num', render: (r) => fmtMinutes(r.ot_payable_minutes) },
      { label: 'Status', render: (r) => (r.ot_status ? badge(r.ot_status, statusKind[r.ot_status]) : badge('incomplete', 'bad')) },
      { label: '', render: (r) => (data.requires_approval && r.ot_minutes ? h('div', { class: 'row' },
        r.ot_status !== 'approved' ? h('button', { class: 'btn btn-sm btn-ok', onclick: () => decide(r, 'approved') }, 'Approve') : '',
        h('button', { class: 'btn btn-sm', onclick: () => formDialog({
          title: 'Approve part of the overtime',
          fields: [{ name: 'minutes', label: 'Minutes to pay', type: 'number', min: 0, max: r.ot_minutes, value: r.ot_payable_minutes || r.ot_minutes, required: true }],
          submitLabel: 'Approve',
          onSubmit: async (v) => { await decide(r, 'approved', Number(v.minutes)); return true; },
        }) }, 'Edit'),
        r.ot_status !== 'rejected' ? h('button', { class: 'btn btn-sm', onclick: () => decide(r, 'rejected') }, 'Reject') : '',
        h('a', { class: 'btn btn-sm', href: `#/punches?date=${r.date}&employee_id=${r.employee_id}` }, 'Selfies')) : '') },
    ], data.rows, { empty: 'No overtime recorded this month.' }));
}

// ---------------------------------------------------------------- leaves

async function pageLeaves(el, params) {
  const status = params.get('status') || '';
  const rows = await api('GET', `/api/admin/leaves${status ? `?status=${status}` : ''}`);
  const statusKind = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: 'neutral' };
  const decide = (l, s) => async (e) => {
    if (await run(() => api('POST', `/api/admin/leaves/${l.id}/decision`, { status: s }), e.currentTarget)) {
      toast(`Leave ${s}`);
      route();
    }
  };
  el.replaceChildren(
    pageHead('Leave requests'),
    h('div', { class: 'toolbar' }, h('select', { onchange: (e) => go('leaves', { status: e.target.value }), 'aria-label': 'Status' },
      [['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled']]
        .map(([v, l]) => h('option', { value: v, selected: v === status }, l)))),
    table([
      { label: 'Employee', render: (l) => h('div', {}, h('strong', {}, l.name), h('div', { class: 'small muted' }, l.code)) },
      { label: 'Dates', render: (l) => (l.from_date === l.to_date ? fmtDate(l.from_date) : `${fmtDate(l.from_date)} → ${fmtDate(l.to_date)}`) },
      { label: 'Type', render: (l) => (l.leave_type === 'paid' ? 'Paid' : 'Unpaid') },
      { label: 'Reason', render: (l) => l.reason || '—' },
      { label: 'Status', render: (l) => badge(l.status, statusKind[l.status]) },
      { label: '', render: (l) => (l.status === 'cancelled' ? '' : h('div', { class: 'row' },
        l.status !== 'approved' ? h('button', { class: 'btn btn-sm btn-ok', onclick: decide(l, 'approved') }, 'Approve') : '',
        l.status !== 'rejected' ? h('button', { class: 'btn btn-sm', onclick: decide(l, 'rejected') }, 'Reject') : '')) },
    ], rows, { empty: 'No leave requests.' }));
}

// ---------------------------------------------------------------- employees

async function pageEmployees(el) {
  await Promise.all([loadBranches(), loadEmployees()]);
  const rate = (e) => `${money(e.salary_paise)} / ${{ monthly: 'month', daily: 'day', hourly: 'hour' }[e.salary_type]}`;
  el.replaceChildren(
    pageHead('Employees', h('button', { class: 'btn btn-primary', onclick: () => employeeForm() }, '+ Add employee')),
    !A.branches.length ? h('div', { class: 'card' }, 'Add a ', h('a', { href: '#/branches' }, 'branch'), ' first — every employee belongs to a branch.') : '',
    table([
      { label: 'Employee', render: (e) => h('div', {}, h('strong', {}, e.name), h('div', { class: 'small muted' }, `${e.code}${e.designation ? ` · ${e.designation}` : ''}${e.phone ? ` · ${e.phone}` : ''}`)) },
      { label: 'Branch', render: (e) => e.branch_name },
      { label: 'Salary', render: (e) => rate(e) },
      { label: 'Shift', render: (e) => `${e.shift_start}–${e.shift_end}` },
      { label: 'Week off', render: (e) => e.weekly_offs.split(',').filter(Boolean).map((d) => WEEKDAYS[d]).join(', ') || 'None' },
      { label: 'Docs', class: 'num', render: (e) => h('a', { href: `#/documents?employee_id=${e.id}` }, String(e.document_count)) },
      { label: 'Status', render: (e) => (e.active ? badge('active', 'ok') : badge('inactive', 'neutral')) },
      { label: '', render: (e) => h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm', onclick: () => employeeForm(e) }, 'Edit'),
        h('button', { class: 'btn btn-sm', onclick: () => resetPin(e) }, 'Reset PIN')) },
    ], A.employees, { empty: 'No employees yet. Click “Add employee”.' }));
}

function employeeForm(e) {
  const isNew = !e;
  const fields = [
    { type: 'heading', label: 'Basic details' },
    { name: 'code', label: 'Employee ID', required: true, value: e?.code, hint: 'Staff log in with this. Letters, digits, - or _.', autocomplete: 'off' },
    { name: 'name', label: 'Full name', required: true, value: e?.name },
    { name: 'phone', label: 'Phone', type: 'tel', value: e?.phone },
    { name: 'designation', label: 'Designation', value: e?.designation },
    { name: 'branch_id', label: 'Branch', type: 'select', required: true, value: e?.branch_id, options: A.branches.filter((b) => b.active || b.id === e?.branch_id).map((b) => ({ value: b.id, label: b.name })) },
    { name: 'joined_on', label: 'Joining date', type: 'date', required: true, value: e?.joined_on || todayIST() },
    { type: 'heading', label: 'Salary & shift' },
    { name: 'salary_type', label: 'Salary type', type: 'select', value: e?.salary_type || 'monthly',
      options: [{ value: 'monthly', label: 'Monthly' }, { value: 'daily', label: 'Daily wage' }, { value: 'hourly', label: 'Hourly' }] },
    { name: 'salary', label: 'Salary amount (₹)', type: 'number', step: '0.01', min: 0, required: true, value: e ? e.salary_paise / 100 : '', hint: 'Per month, per day or per hour depending on salary type. Overtime is paid at the same hourly rate.' },
    { name: 'shift_start', label: 'Shift start', type: 'time', required: true, value: e?.shift_start || '09:00' },
    { name: 'shift_end', label: 'Shift end', type: 'time', required: true, value: e?.shift_end || '18:00' },
    { name: 'weekly_offs', label: 'Weekly off days', type: 'checks', value: e ? e.weekly_offs.split(',').filter(Boolean) : ['0'], options: WEEKDAYS.map((d, i) => ({ value: String(i), label: d })) },
    isNew
      ? { name: 'pin', label: 'Login PIN (4–6 digits)', type: 'text', inputmode: 'numeric', required: true, maxlength: 6, value: String(Math.floor(1000 + Math.random() * 9000)), hint: 'Share this with the employee. They can change it later.' }
      : { name: 'active', label: 'Active (can log in and is included in payroll)', type: 'checkbox', value: !!e.active },
  ];
  formDialog({
    title: isNew ? 'Add employee' : `Edit ${e.name}`,
    fields,
    wide: true,
    async onSubmit(v) {
      if (isNew) {
        await api('POST', '/api/admin/employees', v);
        toast(`Employee added. Login: ${v.code} / PIN ${v.pin}`);
      } else {
        await api('PUT', `/api/admin/employees/${e.id}`, v);
        toast('Employee updated');
      }
      route();
      return true;
    },
  });
}

function resetPin(e) {
  formDialog({
    title: `Reset PIN for ${e.name}`,
    fields: [{ name: 'pin', label: 'New PIN (4–6 digits)', inputmode: 'numeric', required: true, maxlength: 6, value: String(Math.floor(1000 + Math.random() * 9000)) }],
    submitLabel: 'Reset PIN',
    async onSubmit(v) {
      await api('POST', `/api/admin/employees/${e.id}/reset-pin`, v);
      toast(`New PIN for ${e.code}: ${v.pin}`);
      return true;
    },
  });
}

// ---------------------------------------------------------------- documents

async function pageDocuments(el, params) {
  await loadEmployees();
  const f = { status: params.get('status') || '', employee_id: params.get('employee_id') || '' };
  const rows = await api('GET', `/api/admin/documents?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`);
  const statusKind = { pending: 'warn', verified: 'ok', rejected: 'bad' };
  const review = (d, status) => async (e) => {
    let note = '';
    if (status === 'rejected') {
      note = prompt('Reason for rejecting (shown to the employee):', 'Not clear, please re-upload') ?? null;
      if (note === null) return;
    }
    if (await run(() => api('POST', `/api/admin/documents/${d.id}/review`, { status, note }), e.currentTarget)) route();
  };
  el.replaceChildren(
    pageHead('Documents', h('button', { class: 'btn btn-primary', onclick: () => uploadFor(f.employee_id) }, '+ Upload for employee')),
    h('div', { class: 'toolbar' },
      employeeSelect(f.employee_id, (v) => go('documents', { ...f, employee_id: v })),
      h('select', { onchange: (e) => go('documents', { ...f, status: e.target.value }), 'aria-label': 'Status' },
        [['', 'All'], ['pending', 'To verify'], ['verified', 'Verified'], ['rejected', 'Rejected']].map(([v, l]) => h('option', { value: v, selected: v === f.status }, l)))),
    h('p', { class: 'small muted' }, 'Files are encrypted on the server. Every time an admin opens a document it is recorded in the audit log. Only the last 4 digits of Aadhaar numbers are stored.'),
    table([
      { label: 'Employee', render: (d) => h('div', {}, h('strong', {}, d.name), h('div', { class: 'small muted' }, d.code)) },
      { label: 'Document', render: (d) => h('div', {}, DOC_LABEL[d.doc_type], d.label ? h('div', { class: 'small muted' }, d.label) : '') },
      { label: 'Number', render: (d) => d.doc_number || '—' },
      { label: 'Uploaded', render: (d) => h('div', {}, fmtDateTime(d.uploaded_at), h('div', { class: 'small muted' }, `by ${d.uploaded_by} · ${Math.round(d.size_bytes / 1024)} KB`)) },
      { label: 'Status', render: (d) => h('div', {}, badge(d.status, statusKind[d.status]), d.review_note ? h('div', { class: 'small muted' }, d.review_note) : '') },
      { label: '', render: (d) => h('div', { class: 'row' },
        h('a', { class: 'btn btn-sm', href: `/api/admin/documents/${d.id}/file`, target: '_blank', rel: 'noopener' }, 'View'),
        d.status !== 'verified' ? h('button', { class: 'btn btn-sm btn-ok', onclick: review(d, 'verified') }, 'Verify') : '',
        d.status !== 'rejected' ? h('button', { class: 'btn btn-sm', onclick: review(d, 'rejected') }, 'Reject') : '',
        h('button', { class: 'btn btn-sm', onclick: async (e) => {
          if (!(await confirmDialog('Delete document?', `This permanently deletes ${DOC_LABEL[d.doc_type]} of ${d.name}.`, 'Delete', true))) return;
          if (await run(() => api('DELETE', `/api/admin/documents/${d.id}`), e.currentTarget)) route();
        } }, 'Delete')) },
    ], rows, { empty: 'No documents.' }));
}

function uploadFor(employeeId) {
  formDialog({
    title: 'Upload document for employee',
    fields: [
      { name: 'employee_id', label: 'Employee', type: 'select', required: true, value: employeeId, options: employeeOptions() },
      { name: 'doc_type', label: 'Document', type: 'select', options: Object.entries(DOC_LABEL).map(([value, label]) => ({ value, label })) },
      { name: 'doc_number', label: 'Document number', hint: 'Aadhaar: only the last 4 digits are stored. PAN: e.g. ABCDE1234F.' },
      { name: 'label', label: 'Note (optional)' },
      { name: 'file', label: 'Photo or PDF', type: 'file', accept: 'image/jpeg,image/png,application/pdf', required: true },
    ],
    submitLabel: 'Upload',
    async onSubmit(v) {
      const file = await prepareUpload(v.file);
      await api('POST', '/api/admin/documents', { ...v, file });
      toast('Document uploaded and marked verified');
      route();
      return true;
    },
  });
}

// ---------------------------------------------------------------- branches

async function pageBranches(el) {
  await loadBranches();
  el.replaceChildren(
    pageHead('Branches', h('button', { class: 'btn btn-primary', onclick: () => branchForm() }, '+ Add branch')),
    h('p', { class: 'muted small' }, 'Staff can punch at any active branch. If they are outside every branch’s radius, the punch is either flagged for your review or blocked, depending on their home branch’s setting.'),
    table([
      { label: 'Branch', render: (b) => h('div', {}, h('strong', {}, b.name), b.address ? h('div', { class: 'small muted' }, b.address) : '') },
      { label: 'Location', render: (b) => h('div', {}, `${b.lat.toFixed(5)}, ${b.lng.toFixed(5)} `, mapLink(b.lat, b.lng)) },
      { label: 'Radius', class: 'num', render: (b) => `${b.radius_m} m` },
      { label: 'Outside radius', render: (b) => (b.geofence_mode === 'block' ? badge('Block punch', 'bad') : badge('Allow & flag', 'warn')) },
      { label: 'Staff', class: 'num', render: (b) => String(b.employee_count) },
      { label: 'Status', render: (b) => (b.active ? badge('active', 'ok') : badge('inactive', 'neutral')) },
      { label: '', render: (b) => h('button', { class: 'btn btn-sm', onclick: () => branchForm(b) }, 'Edit') },
    ], A.branches, { empty: 'No branches yet. Add your first branch — stand inside it and use “Use my current location”.' }));
}

function branchForm(b) {
  formDialog({
    title: b ? `Edit ${b.name}` : 'Add branch',
    fields: [
      { name: 'name', label: 'Branch name', required: true, value: b?.name },
      { name: 'address', label: 'Address', type: 'textarea', value: b?.address },
      { type: 'button', label: '📍 Use my current location', hint: 'Do this while standing inside the branch, or paste coordinates from Google Maps (right-click a spot → copy the numbers).',
        onclick(form, btn) {
          if (!navigator.geolocation) return toast('Location not available in this browser', 'error');
          btn.disabled = true;
          btn.textContent = 'Locating…';
          navigator.geolocation.getCurrentPosition((pos) => {
            form.querySelector('[name=lat]').value = pos.coords.latitude.toFixed(6);
            form.querySelector('[name=lng]').value = pos.coords.longitude.toFixed(6);
            btn.disabled = false;
            btn.textContent = `📍 Got it (±${Math.round(pos.coords.accuracy)} m)`;
          }, (err) => {
            btn.disabled = false;
            btn.textContent = '📍 Use my current location';
            toast(`Could not get location: ${err.message}`, 'error');
          }, { enableHighAccuracy: true, timeout: 20000 });
        } },
      { name: 'lat', label: 'Latitude', type: 'number', step: 'any', required: true, value: b?.lat, placeholder: '19.076090' },
      { name: 'lng', label: 'Longitude', type: 'number', step: 'any', required: true, value: b?.lng, placeholder: '72.877426' },
      { name: 'radius_m', label: 'Allowed radius (metres)', type: 'number', min: 20, max: 5000, required: true, value: b?.radius_m ?? 150, hint: 'Phone GPS is usually accurate to 10–50 m. 100–200 m works well for most offices.' },
      { name: 'geofence_mode', label: 'When an employee of this branch is outside every branch radius', type: 'select', value: b?.geofence_mode || 'flag',
        options: [{ value: 'flag', label: 'Allow the punch but flag it for review' }, { value: 'block', label: 'Block the punch' }] },
      ...(b ? [{ name: 'active', label: 'Active', type: 'checkbox', value: !!b.active }] : []),
    ],
    async onSubmit(v) {
      const body = { ...v, radius_m: Number(v.radius_m), active: b ? v.active : true };
      if (b) await api('PUT', `/api/admin/branches/${b.id}`, body);
      else await api('POST', '/api/admin/branches', body);
      toast('Branch saved');
      route();
      return true;
    },
  });
}

// ---------------------------------------------------------------- holidays

async function pageHolidays(el, params) {
  await loadBranches();
  const year = params.get('year') || todayIST().slice(0, 4);
  const rows = await api('GET', `/api/admin/holidays?year=${year}`);
  el.replaceChildren(
    pageHead('Holidays', h('button', { class: 'btn btn-primary', onclick: () => formDialog({
      title: 'Add holiday',
      fields: [
        { name: 'date', label: 'Date', type: 'date', required: true },
        { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Diwali' },
        { name: 'branch_id', label: 'Applies to', type: 'select', options: [{ value: '', label: 'All branches' }, ...A.branches.map((b) => ({ value: b.id, label: b.name }))] },
      ],
      async onSubmit(v) {
        await api('POST', '/api/admin/holidays', v);
        route();
        return true;
      },
    }) }, '+ Add holiday')),
    h('div', { class: 'toolbar' },
      h('button', { class: 'icon-btn', onclick: () => go('holidays', { year: Number(year) - 1 }) }, '‹'), h('strong', {}, year),
      h('button', { class: 'icon-btn', onclick: () => go('holidays', { year: Number(year) + 1 }) }, '›')),
    h('p', { class: 'small muted' }, 'Holidays are paid for monthly-salaried staff. If someone works on a holiday, that day counts as a normal present day.'),
    table([
      { label: 'Date', render: (x) => `${fmtDate(x.date)} (${WEEKDAYS[new Date(`${x.date}T00:00:00Z`).getUTCDay()]})` },
      { label: 'Holiday', render: (x) => x.name },
      { label: 'Branch', render: (x) => x.branch_name || 'All' },
      { label: '', render: (x) => h('button', { class: 'btn btn-sm', onclick: async (e) => { if (await run(() => api('DELETE', `/api/admin/holidays/${x.id}`), e.currentTarget)) route(); } }, 'Delete') },
    ], rows, { empty: `No holidays added for ${year}.` }));
}

// ---------------------------------------------------------------- payroll

async function pagePayroll(el, params) {
  await loadEmployees();
  const month = params.get('month') || shiftMonth(thisMonth(), -1);
  const tab = params.get('tab') || 'sheet';
  const head = [
    pageHead('Payroll'),
    h('div', { class: 'toolbar' }, monthPicker(month, (m) => go('payroll', { month: m, tab }))),
    h('div', { class: 'tabs' }, [['sheet', 'Salary sheet'], ['advances', 'Advances'], ['adjustments', 'Bonus & deductions']].map(([k, l]) =>
      h('button', { class: tab === k ? 'active' : '', onclick: () => go('payroll', { month, tab: k }) }, l))),
  ];
  if (tab === 'advances') return payrollAdvances(el, month, head);
  if (tab === 'adjustments') return payrollAdjustments(el, month, head);

  const p = await api('GET', `/api/admin/payroll?month=${month}`);
  const pendingOt = p.rows.filter((r) => r.attendance.ot_pending_minutes > 0);
  const isPast = month < thisMonth();
  const sum = (xs) => xs.reduce((t, x) => t + x.amount_paise, 0);

  const finalizeBtn = p.finalized
    ? h('button', { class: 'btn', onclick: async (e) => {
      if (!(await confirmDialog('Reopen payroll?', 'Reopening unlocks attendance edits for this month. Payslips disappear from the staff app until you finalize again.', 'Reopen'))) return;
      if (await run(() => api('DELETE', `/api/admin/payroll/${month}/finalize`), e.currentTarget)) route();
    } }, 'Reopen month')
    : h('button', { class: 'btn btn-primary', disabled: !isPast, title: isPast ? '' : 'You can finalize a month after it ends', onclick: async (e) => {
      if (!(await confirmDialog('Finalize payroll?', `This locks attendance for ${fmtMonth(month)} and publishes payslips to staff.`, 'Finalize'))) return;
      if (await run(() => api('POST', `/api/admin/payroll/${month}/finalize`, {}), e.currentTarget)) {
        toast('Payroll finalized. Payslips are now visible to staff.');
        route();
      }
    } }, 'Finalize & publish payslips');

  el.replaceChildren(...head,
    h('div', { class: 'spread', style: { marginBottom: '12px' } },
      h('div', {}, p.finalized
        ? h('span', {}, '🔒 Finalized ', h('span', { class: 'muted small' }, `on ${fmtDateTime(p.finalized_at)}${p.finalized_by ? ` by ${p.finalized_by}` : ''}`))
        : h('span', { class: 'muted small' }, month >= thisMonth() ? 'Month in progress — figures cover days up to today.' : 'Draft — review, then finalize.')),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: `/api/admin/payroll.csv?month=${month}` }, 'Download Excel (CSV)'), finalizeBtn)),
    pendingOt.length && !p.finalized
      ? h('div', { class: 'card', style: { marginBottom: '12px', borderColor: 'var(--warn)' } },
        `⚠ ${pendingOt.length} employee(s) have overtime waiting for approval: ${pendingOt.map((r) => r.name).join(', ')}. `,
        h('a', { href: `#/overtime?month=${month}` }, 'Review overtime →'))
      : '',
    h('div', { class: 'stats', style: { marginBottom: '12px' } },
      h('div', { class: 'stat' }, h('div', { class: 'v' }, money(p.totals.net_paise)), h('div', { class: 'l' }, 'Total net pay')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, money(p.totals.ot_paise)), h('div', { class: 'l' }, 'Overtime pay')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, String(p.rows.length)), h('div', { class: 'l' }, 'Employees'))),
    table([
      { label: 'Employee', render: (r) => h('div', {}, h('strong', {}, r.name), h('div', { class: 'small muted' }, `${r.code} · ${r.branch_name}`)) },
      { label: 'Salary', render: (r) => h('div', {}, money(r.salary_paise), h('div', { class: 'small muted' }, r.salary_type)) },
      { label: 'Paid days', class: 'num', render: (r) => h('span', { title: `P ${r.attendance.present} · HD ${r.attendance.half_day} · PL ${r.attendance.paid_leave} · WO ${r.attendance.week_off} · H ${r.attendance.holiday} · A ${r.attendance.absent + r.attendance.not_marked}` }, String(r.paid_days)) },
      { label: 'Base', class: 'num', render: (r) => money(r.base_paise) },
      { label: 'OT', class: 'num', render: (r) => h('div', {}, money(r.ot_paise), h('div', { class: 'small muted' }, `${r.ot_hours} h`)) },
      { label: '+ Add', class: 'num', render: (r) => money(sum(r.additions)) },
      { label: '− Ded.', class: 'num', render: (r) => money(sum(r.deductions) + sum(r.advances)) },
      { label: 'Net pay', class: 'num', render: (r) => h('strong', {}, money(r.net_paise)) },
      { label: '', render: (r) => h('button', { class: 'btn btn-sm', onclick: () => openPayslip(p.company_name, month, r) }, 'Payslip') },
    ], p.rows, { empty: 'No employees for this month.' }),
    h('details', { class: 'card', style: { marginTop: '12px' } }, h('summary', {}, 'How salary is calculated'),
      h('ul', { class: 'small' },
        h('li', {}, 'Monthly: per-day pay = monthly salary ÷ days in the month. Paid days = present + ½ × half days + paid leave + week offs + holidays.'),
        h('li', {}, 'Daily wage: daily rate × (present + ½ × half days + paid leave). Week offs and holidays are unpaid.'),
        h('li', {}, 'Hourly: rate × hours worked (paid leave counts as one full shift).'),
        h('li', {}, 'Overtime: approved OT hours × the same hourly rate (monthly: per-day ÷ shift hours; daily: daily rate ÷ shift hours).'),
        h('li', {}, `Full day = the employee’s shift length minus the ${A.me.settings.grace_minutes}-minute grace (9:00–18:00 → ${fmtMinutes(540 - A.me.settings.grace_minutes)} worked). Half day needs ${A.me.settings.half_day_hours} h. A missing punch-out counts as a half day until you correct it.`),
        h('li', {}, 'Net = base + OT + additions − deductions − advances.'))));
}

async function payrollAdvances(el, month, head) {
  const rows = await api('GET', `/api/admin/advances?month=${month}`);
  el.replaceChildren(...head,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => formDialog({
      title: 'Record salary advance',
      fields: [
        { name: 'employee_id', label: 'Employee', type: 'select', required: true, options: employeeOptions() },
        { name: 'amount', label: 'Amount (₹)', type: 'number', step: '0.01', min: 1, required: true },
        { name: 'given_on', label: 'Given on', type: 'date', required: true, value: todayIST() },
        { name: 'deduct_month', label: 'Deduct from salary of', type: 'month', required: true, value: month },
        { name: 'note', label: 'Note' },
      ],
      async onSubmit(v) {
        await api('POST', '/api/admin/advances', v);
        go('payroll', { month: v.deduct_month, tab: 'advances' });
        return true;
      },
    }) }, '+ Record advance')),
    table([
      { label: 'Employee', render: (a) => `${a.name} (${a.code})` },
      { label: 'Given on', render: (a) => fmtDate(a.given_on) },
      { label: 'Amount', class: 'num', render: (a) => money(a.amount_paise) },
      { label: 'Note', render: (a) => a.note || '—' },
      { label: '', render: (a) => h('button', { class: 'btn btn-sm', onclick: async (e) => { if (await run(() => api('DELETE', `/api/admin/advances/${a.id}`), e.currentTarget)) route(); } }, 'Delete') },
    ], rows, { empty: `No advances to deduct in ${fmtMonth(month)}.` }));
}

async function payrollAdjustments(el, month, head) {
  const rows = await api('GET', `/api/admin/adjustments?month=${month}`);
  el.replaceChildren(...head,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => formDialog({
      title: `Bonus or deduction · ${fmtMonth(month)}`,
      fields: [
        { name: 'employee_id', label: 'Employee', type: 'select', required: true, options: employeeOptions() },
        { name: 'kind', label: 'Type', type: 'select', options: [{ value: 'addition', label: 'Addition (bonus, incentive, allowance)' }, { value: 'deduction', label: 'Deduction (fine, PF, damage)' }] },
        { name: 'label', label: 'Label', required: true, placeholder: 'e.g. Diwali bonus' },
        { name: 'amount', label: 'Amount (₹)', type: 'number', step: '0.01', min: 1, required: true },
      ],
      async onSubmit(v) {
        await api('POST', '/api/admin/adjustments', { ...v, month });
        route();
        return true;
      },
    }) }, '+ Add bonus / deduction')),
    table([
      { label: 'Employee', render: (a) => `${a.name} (${a.code})` },
      { label: 'Type', render: (a) => (a.kind === 'addition' ? badge('addition', 'ok') : badge('deduction', 'bad')) },
      { label: 'Label', render: (a) => a.label },
      { label: 'Amount', class: 'num', render: (a) => money(a.amount_paise) },
      { label: '', render: (a) => h('button', { class: 'btn btn-sm', onclick: async (e) => { if (await run(() => api('DELETE', `/api/admin/adjustments/${a.id}`), e.currentTarget)) route(); } }, 'Delete') },
    ], rows, { empty: `No bonuses or deductions for ${fmtMonth(month)}.` }));
}

// ---------------------------------------------------------------- settings

async function pageSettings(el, params) {
  const tab = params.get('tab') || 'general';
  const tabs = h('div', { class: 'tabs' }, [['general', 'General'], ['admins', 'Admins'], ['audit', 'Audit log']].map(([k, l]) =>
    h('button', { class: tab === k ? 'active' : '', onclick: () => go('settings', { tab: k }) }, l)));

  if (tab === 'admins') {
    const admins = await api('GET', '/api/admin/admins');
    el.replaceChildren(pageHead('Settings'), tabs,
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-primary', onclick: () => formDialog({
          title: 'Add admin',
          fields: [
            { name: 'name', label: 'Name', required: true },
            { name: 'username', label: 'Username', required: true },
            { name: 'password', label: 'Password (min 8 chars)', type: 'password', required: true, autocomplete: 'new-password' },
          ],
          async onSubmit(v) { await api('POST', '/api/admin/admins', v); route(); return true; },
        }) }, '+ Add admin'),
        h('button', { class: 'btn', onclick: () => formDialog({
          title: 'Change my password',
          fields: [
            { name: 'current_password', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
            { name: 'new_password', label: 'New password (min 8 chars)', type: 'password', required: true, autocomplete: 'new-password' },
          ],
          async onSubmit(v) { await api('POST', '/api/admin/password', v); toast('Password changed'); return true; },
        }) }, 'Change my password')),
      table([
        { label: 'Name', render: (a) => a.name },
        { label: 'Username', render: (a) => a.username },
        { label: 'Added', render: (a) => fmtDateTime(a.created_at) },
      ], admins));
    return;
  }

  if (tab === 'audit') {
    const rows = await api('GET', '/api/admin/audit');
    el.replaceChildren(pageHead('Settings'), tabs,
      table([
        { label: 'When', render: (x) => fmtDateTime(x.at) },
        { label: 'Who', render: (x) => `${x.actor_name || x.actor_kind}` },
        { label: 'Action', render: (x) => x.action },
        { label: 'Details', render: (x) => h('code', { class: 'small' }, x.detail) },
      ], rows, { empty: 'Nothing logged yet.' }));
    return;
  }

  const s = await api('GET', '/api/admin/settings');
  const form = h('div', { class: 'card', style: { maxWidth: '560px' } },
    h('dl', { class: 'kv' },
      h('dt', {}, 'Company'), h('dd', {}, s.company_name),
      h('dt', {}, 'Full day'), h('dd', {}, `Shift length minus grace (9:00–18:00 → ${fmtMinutes(540 - s.grace_minutes)} worked)`),
      h('dt', {}, 'Half day'), h('dd', {}, `${s.half_day_hours} hours worked`),
      h('dt', {}, 'Late after'), h('dd', {}, `${s.grace_minutes} minutes past shift start`),
      h('dt', {}, 'GPS accuracy'), h('dd', {}, `Flag punches worse than ±${s.max_accuracy_m} m`),
      h('dt', {}, 'Overtime'), h('dd', {}, s.ot_requires_approval ? 'Needs admin approval before it is paid' : 'Paid automatically')),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', onclick: () => formDialog({
      title: 'Edit settings',
      fields: [
        { name: 'company_name', label: 'Company name', required: true, value: s.company_name },
        { name: 'half_day_hours', label: 'Hours for a half day', type: 'number', step: '0.25', min: 0.5, max: 24, required: true, value: s.half_day_hours, hint: 'Less than this counts as absent.' },
        { name: 'grace_minutes', label: 'Late grace period (minutes)', type: 'number', min: 0, max: 240, required: true, value: s.grace_minutes, hint: 'Also sets the full day: shift length minus this grace.' },
        { name: 'max_accuracy_m', label: 'Flag punches with GPS accuracy worse than (metres)', type: 'number', min: 10, max: 5000, required: true, value: s.max_accuracy_m },
        { name: 'ot_requires_approval', label: 'Overtime needs admin approval', type: 'checkbox', value: s.ot_requires_approval },
      ],
      async onSubmit(v) {
        const saved = await api('PUT', '/api/admin/settings', v);
        A.me.settings = saved;
        toast('Settings saved');
        route();
        return true;
      },
    }) }, 'Edit settings')));
  el.replaceChildren(pageHead('Settings'), tabs, form);
}

const PAGE_FNS = {
  dashboard: pageDashboard,
  punches: pagePunches,
  attendance: pageAttendance,
  overtime: pageOvertime,
  leaves: pageLeaves,
  employees: pageEmployees,
  documents: pageDocuments,
  branches: pageBranches,
  holidays: pageHolidays,
  payroll: pagePayroll,
  settings: pageSettings,
};

boot();
