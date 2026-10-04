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
    h('img', { src: '/logo.svg', alt: 'Sanitech Engineers & Consultants', class: 'logo' }), h('h1', {}, title), h('p', { class: 'muted' }, subtitle),
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
  loginShell('Sanitech Admin', 'Attendance & payroll dashboard', [
    { name: 'username', label: 'Username', autocomplete: 'username' },
    { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' },
  ], 'Log in', async (v) => {
    try {
      await api('POST', '/api/admin/login', v);
      location.reload();
      return;
    } catch (err) {
      if (err.status !== 401) throw err;
    }
    // Staff who open the admin page by mistake: accept their ID + PIN and send them to the staff app.
    try {
      await api('POST', '/api/employee/login', { code: v.username.trim(), pin: v.password });
    } catch (err) {
      if (err.status === 401) throw new Error('Wrong username or password');
      throw err;
    }
    location.href = '/';
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
  ['late', 'Late approvals', 'late_approvals'],
  ['leaves', 'Leave requests', 'leaves'],
  ['payroll', 'Payroll'],
  ['employees', 'Employees'],
  ['preview', 'Staff preview'],
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
    h('img', { src: '/logo.svg', alt: '', class: 'brand-logo' }),
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
  const unlocated = A.branches.filter((b) => b.active && !b.location_set);
  const locationWarning = unlocated.length
    ? h('div', { class: 'card', style: { marginBottom: '16px', borderColor: 'var(--warn)' } },
      `⚠ ${unlocated.length} branch(es) have no GPS location yet: ${unlocated.map((b) => b.name).join(', ')}. Punches from their staff are flagged until you `,
      h('a', { href: '#/branches' }, 'set the location'), '.')
    : '';
  el.replaceChildren(
    pageHead('Dashboard', h('input', { type: 'date', value: date, onchange: (e) => go('dashboard', { date: e.target.value }) })),
    gettingStarted,
    locationWarning,
    h('div', { class: 'stats' },
      tile(t.employees, 'Active staff'), tile(t.in, 'Present / working'), tile(t.absent, 'Absent / not marked'),
      tile(t.late, 'Late'), tile(t.on_leave, 'On leave'), tile(t.off, 'Week off / holiday'), tile(t.on_ot, 'On overtime now')),
    h('div', { class: 'stats', style: { marginTop: '10px' } },
      tile(d.pending.flagged_punches, 'Flagged punches to review', '#/punches?status=flagged'),
      tile(d.pending.leaves, 'Leave requests pending', '#/leaves?status=pending'),
      tile(d.pending.documents, 'Documents to verify', '#/documents?status=pending'),
      tile(d.pending.late_approvals, 'Very late arrivals to review', '#/late')),
    h('h2', { style: { margin: '20px 0 10px' } }, `Staff on ${fmtDate(date)}`),
    table([
      { label: 'Employee', render: (r) => h('div', {}, h('strong', {}, r.name), h('div', { class: 'small muted' }, `${r.code} · ${r.branch_name}`)) },
      { label: 'Status', render: (r) => [statusBadge(r.day.status), r.day.late_minutes ? [' ', badge(lateText(r.day, A.me.settings.late_warnings), lateKind(r.day))] : ''] },
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
      { label: 'Status', render: (p) => h('div', {}, badge(p.status, statusKind[p.status]), p.flag_reason ? h('div', { class: 'small muted' }, p.flag_reason) : '', verifBadge(p.verification)) },
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
      h('td', {}, r.summary.paid_leave + r.summary.unpaid_leave), h('td', { title: r.summary.late_penalties ? `${r.summary.late_penalties} counted as half day` : null }, r.summary.late_penalties ? `${r.summary.late_days} (${r.summary.late_penalties} HD)` : r.summary.late_days),
      h('td', {}, (r.summary.worked_minutes / 60).toFixed(1)), h('td', {}, (r.summary.ot_payable_minutes / 60).toFixed(1))))))) : h('div', { class: 'empty' }, 'No employees.');

  el.replaceChildren(
    pageHead('Attendance register',
      A.me.admin.can_edit_attendance ? h('button', { class: 'btn', onclick: bulkMark }, 'Mark days for everyone') : '',
      h('a', { class: 'btn', href: `/api/admin/attendance.csv?month=${month}${branchId ? `&branch_id=${branchId}` : ''}` }, 'Download Excel (CSV)')),
    h('div', { class: 'toolbar' },
      monthPicker(month, (m) => go('attendance', { month: m, branch_id: branchId })),
      branchSelect(branchId, (v) => go('attendance', { month, branch_id: v }))),
    data.finalized ? h('div', { class: 'card', style: { marginBottom: '12px' } }, '🔒 Payroll for this month is finalized. Reopen it on the Payroll page to make corrections.') : '',
    grid,
    h('p', { class: 'small muted' }, 'P present · HD half day · A absent · PL/UL paid/unpaid leave · WO week off · H holiday · W working now · – not marked. Dashed border = corrected by admin, red dot = needs attention. Click any cell to correct it.'));
}

function bulkMark() {
  formDialog({
    title: 'Mark days for everyone',
    fields: [
      { name: 'from', label: 'From', type: 'date', required: true, value: `${thisMonth()}-01` },
      { name: 'to', label: 'To', type: 'date', required: true, value: todayIST() },
      { name: 'status', label: 'Mark as', type: 'select', value: 'present', options: ['present', 'half_day', 'absent', 'paid_leave', 'unpaid_leave', 'holiday'].map((v) => ({ value: v, label: STATUS_LABEL[v] })) },
      { name: 'branch_id', label: 'Staff of', type: 'select', options: [{ value: '', label: 'All branches' }, ...A.branches.filter((b) => b.active).map((b) => ({ value: b.id, label: b.name }))] },
      { name: 'note', label: 'Reason', required: true, placeholder: 'e.g. Before the app went live' },
      { name: 'include_week_offs', label: 'Also mark weekly off days (Sundays)', type: 'checkbox', value: false },
    ],
    submitLabel: 'Mark days',
    async onSubmit(v) {
      const r = await api('POST', '/api/admin/attendance/bulk-override', { ...v, branch_id: v.branch_id || null });
      toast(`Marked ${r.days} day(s) for ${r.employees} employee(s).`);
      route();
      return true;
    },
  });
}

function editDay(r, d, finalized) {
  if (!A.me.admin.can_edit_attendance) {
    modal(`${r.name} · ${fmtDate(d.date)}`, h('div', {},
      h('dl', { class: 'kv' },
        h('dt', {}, 'Status'), h('dd', {}, STATUS_LABEL[d.status] || d.status),
        h('dt', {}, 'In / Out'), h('dd', {}, `${d.first_in || '—'} / ${d.last_out || '—'}`),
        h('dt', {}, 'Worked'), h('dd', {}, fmtMinutes(d.worked_minutes)),
        d.late_minutes ? [h('dt', {}, 'Late'), h('dd', {}, lateText(d, A.me.settings.late_warnings))] : '',
        d.override ? [h('dt', {}, 'Corrected'), h('dd', {}, d.override.note || 'Yes')] : ''),
      h('p', { class: 'small muted', style: { marginTop: '12px' } }, 'Only admins with permission to change the attendance register can correct this day.')));
    return;
  }
  if (finalized) return toast('This month is finalized. Reopen payroll to edit.', 'error');
  const info = h('dl', { class: 'kv', style: { marginBottom: '14px' } },
    h('dt', {}, 'Calculated'), h('dd', {}, STATUS_LABEL[d.status] || d.status),
    h('dt', {}, 'In / Out'), h('dd', {}, `${d.first_in || '—'} / ${d.last_out || '—'}`),
    h('dt', {}, 'Worked'), h('dd', {}, fmtMinutes(d.worked_minutes)),
    d.late_minutes ? [h('dt', {}, 'Late'), h('dd', {}, lateText(d, A.me.settings.late_warnings))] : '',
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
      { label: 'Status', render: (r) => h('div', {}, r.ot_status ? badge(r.ot_status, statusKind[r.ot_status]) : badge('incomplete', 'bad'), verifBadge(r.verification)) },
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

// ---------------------------------------------------------------- very late arrivals

async function pageLate(el, params) {
  const month = params.get('month') || thisMonth();
  const data = await api('GET', `/api/admin/late-approvals?month=${month}`);
  const kind = { pending: 'warn', present: 'ok', half_day: 'bad' };
  const label = { pending: 'Half day · not reviewed', present: 'Full day (granted)', half_day: 'Half day (confirmed)' };
  const decide = (r, status) => run(async () => {
    await api('POST', '/api/admin/late-approvals/decision', { employee_id: r.employee_id, date: r.date, status });
    toast(status ? `${r.name}: ${label[status]} on ${fmtDate(r.date)}` : 'Decision cleared');
    route();
  });
  el.replaceChildren(
    pageHead('Late approvals'),
    h('div', { class: 'toolbar' }, monthPicker(month, (m) => go('late', { month: m }))),
    h('p', { class: 'muted small' }, `Arriving more than ${data.late_max_minutes} minutes late counts as a half day and is flagged here for review. Review whenever convenient: grant a full day if it was justified, or confirm the half day. These days are not part of the "every 3rd late is a half day" count.`),
    table([
      { label: 'Date', render: (r) => fmtDate(r.date) },
      { label: 'Employee', render: (r) => h('div', {}, h('strong', {}, r.name), h('div', { class: 'small muted' }, `${r.code} · ${r.branch_name}`)) },
      { label: 'Shift', render: (r) => `${r.shift_start}–${r.shift_end}` },
      { label: 'In / Out', render: (r) => `${r.first_in || '—'} / ${r.last_out || (r.status === 'working' ? 'working' : '—')}` },
      { label: 'Late by', class: 'num', render: (r) => fmtMinutes(r.late_minutes) },
      { label: 'Worked', class: 'num', render: (r) => fmtMinutes(r.worked_minutes) },
      { label: 'Decision', render: (r) => h('div', {}, badge(label[r.late_review], kind[r.late_review]), verifBadge(r.verification)) },
      { label: '', render: (r) => h('div', { class: 'row' },
        r.late_review !== 'present' ? h('button', { class: 'btn btn-sm btn-ok', onclick: () => decide(r, 'present') }, 'Full day') : '',
        r.late_review !== 'half_day' ? h('button', { class: 'btn btn-sm', onclick: () => decide(r, 'half_day') }, 'Half day') : '',
        r.late_review !== 'pending' ? h('button', { class: 'btn btn-sm', onclick: () => decide(r, null) }, 'Undo') : '',
        h('a', { class: 'btn btn-sm', href: `#/punches?date=${r.date}&employee_id=${r.employee_id}` }, 'Selfies')) },
    ], data.rows, { empty: `Nobody was more than ${data.late_max_minutes} minutes late this month.`, rowClass: (r) => (r.late_review === 'pending' ? 'row-flag' : null) }));
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
    pageHead('Employees',
      h('button', { class: 'btn', onclick: importEmployees }, 'Import from CSV'),
      h('button', { class: 'btn btn-primary', onclick: () => employeeForm() }, '+ Add employee')),
    !A.branches.length ? h('div', { class: 'card' }, 'Add a ', h('a', { href: '#/branches' }, 'branch'), ' first — every employee belongs to a branch.') : '',
    table([
      { label: 'Employee', render: (e) => h('div', {}, h('strong', {}, e.name), e.is_manager ? [' ', badge(e.manager_scope === 'all' ? 'Manager · all branches' : 'Manager', 'info')] : '', h('div', { class: 'small muted' }, `${e.code}${e.designation ? ` · ${e.designation}` : ''}${e.phone ? ` · ${e.phone}` : ''}`)) },
      { label: 'Branch', render: (e) => h('div', {}, e.branch_name, e.extra_location_ids ? h('div', { class: 'small muted' }, `+ ${e.extra_location_ids.split(',').length} more location(s)`) : '') },
      { label: 'Salary', render: (e) => rate(e) },
      { label: 'Shift', render: (e) => h('div', {}, `${e.shift_start}–${e.shift_end}`, h('div', { class: 'small muted' }, e.follow_branch_shift ? 'branch timing' : 'personal')) },
      { label: 'Week off', render: (e) => e.weekly_offs.split(',').filter(Boolean).map((d) => WEEKDAYS[d]).join(', ') || 'None' },
      { label: 'Docs', class: 'num', render: (e) => h('a', { href: `#/documents?employee_id=${e.id}` }, String(e.document_count)) },
      { label: 'Status', render: (e) => (e.active ? badge('active', 'ok') : badge('inactive', 'neutral')) },
      { label: '', render: (e) => h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm', onclick: () => employeeForm(e) }, 'Edit'),
        h('button', { class: 'btn btn-sm', onclick: () => payItems(e) }, 'PF / allowances'),
        h('a', { class: 'btn btn-sm', href: `#/preview?employee_id=${e.id}` }, 'Preview'),
        h('button', { class: 'btn btn-sm', onclick: () => resetPin(e) }, 'Reset PIN'),
        h('button', { class: 'btn btn-sm', title: 'Delete permanently', onclick: () => deleteEmployee(e) }, 'Delete')) },
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
    { name: 'joined_on', label: 'Joining date', type: 'date', value: e ? e.joined_on : todayIST(), hint: 'Leave blank if not known.' },
    { type: 'heading', label: 'Salary & shift' },
    { name: 'salary_type', label: 'Salary type', type: 'select', value: e?.salary_type || 'monthly',
      options: [{ value: 'monthly', label: 'Monthly' }, { value: 'daily', label: 'Daily wage' }, { value: 'hourly', label: 'Hourly' }] },
    { name: 'salary', label: 'Salary amount (₹)', type: 'number', step: '0.01', min: 0, required: true, value: e ? e.salary_paise / 100 : '', hint: 'Per month, per day or per hour depending on salary type. Overtime is paid at the same hourly rate.' },
    { name: 'follow_branch_shift', label: 'Use the branch’s office timings', type: 'checkbox', value: e ? !!e.follow_branch_shift : true },
    { name: 'shift_start', label: 'Personal shift start', type: 'time', value: e?.shift_start || '09:00', hint: 'Only used when “Use the branch’s office timings” is unticked.' },
    { name: 'shift_end', label: 'Personal shift end', type: 'time', value: e?.shift_end || '18:00' },
    { name: 'weekly_offs', label: 'Weekly off days', type: 'checks', value: e ? e.weekly_offs.split(',').filter(Boolean) : ['0'], options: WEEKDAYS.map((d, i) => ({ value: String(i), label: d })) },
    { type: 'heading', label: 'Locations' },
    { name: 'extra_locations', label: 'Also allowed to check in/out at', type: 'checks',
      value: String(e?.extra_location_ids || '').split(',').filter(Boolean),
      options: A.branches.filter((b) => b.active && b.id !== e?.branch_id).map((b) => ({ value: b.id, label: b.name })) },
    { type: 'heading', label: 'Manager' },
    { name: 'is_manager', label: 'Manager — can check what the app flags for their team (no power to change anything)', type: 'checkbox', value: !!e?.is_manager },
    { name: 'manager_scope', label: 'Manager covers', type: 'select', value: e?.manager_scope || 'branch',
      options: [{ value: 'branch', label: 'Staff of their own branch' }, { value: 'all', label: 'Staff of all branches' }] },
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

async function payItems(e) {
  const items = await run(() => api('GET', `/api/admin/employees/${e.id}/pay-items`));
  if (!items) return;
  const body = h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, 'These are applied every month in full (not reduced for absent days) whenever the employee has at least one paid day. For one-off bonuses or fines, use Payroll → Bonus & deductions.'),
    table([
      { label: 'Type', render: (x) => (x.kind === 'addition' ? badge('earning', 'ok') : badge('deduction', 'bad')) },
      { label: 'Item', render: (x) => x.label },
      { label: 'Monthly amount', class: 'num', render: (x) => money(x.amount_paise) },
      { label: '', render: (x) => h('button', { class: 'btn btn-sm', onclick: async (ev) => {
        if (await run(() => api('DELETE', `/api/admin/pay-items/${x.id}`), ev.currentTarget)) { dlg.close(); payItems(e); }
      } }, 'Remove') },
    ], items, { empty: 'No fixed pay items.' }),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', onclick: () => {
      dlg.close();
      formDialog({
        title: `Add fixed monthly item · ${e.name}`,
        fields: [
          { name: 'kind', label: 'Type', type: 'select', options: [{ value: 'deduction', label: 'Deduction (PF, ESIC, PT, TDS…)' }, { value: 'addition', label: 'Earning (conveyance, room rent…)' }] },
          { name: 'label', label: 'Name', required: true, placeholder: 'e.g. PF' },
          { name: 'amount', label: 'Monthly amount (₹)', type: 'number', step: '0.01', min: 1, required: true },
        ],
        async onSubmit(v) {
          await api('POST', `/api/admin/employees/${e.id}/pay-items`, v);
          setTimeout(() => payItems(e), 0);
          return true;
        },
      });
    } }, '+ Add item')));
  const dlg = modal(`PF / allowances · ${e.name}`, body, { wide: true });
}

function importEmployees() {
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const out = h('div', { class: 'stack' });
  let csv = '';
  const check = h('button', { class: 'btn btn-primary', onclick: async (ev) => {
    if (!file.files[0]) return toast('Choose a CSV file first', 'error');
    csv = await file.files[0].text();
    const res = await run(() => api('POST', '/api/admin/employees/import', { csv, dry_run: true }), ev.currentTarget);
    if (res) showPreview(res);
  } }, 'Check file');
  const help = h('details', { class: 'small' }, h('summary', {}, 'File format'),
    h('p', {}, 'Save your Excel sheet as CSV with a header row. Columns (any order):'),
    h('ul', {},
      h('li', {}, h('b', {}, 'employee_id, name, branch, salary'), ' – required. Branches that don’t exist yet are created; you then set their location.'),
      h('li', {}, 'designation, phone, joined_on (DD-MM-YYYY, may be blank), salary_type (monthly/daily/hourly, default monthly)'),
      h('li', {}, 'shift_start, shift_end (default 09:00 and 18:00), weekly_off (default Sun), branch_radius_m (default 150)'),
      h('li', {}, 'branch_maps_link – Google Maps link of the branch (needed on one row per branch); its location is read automatically'),
      h('li', {}, 'pf, esic, pt, tds – fixed monthly deductions; conveyance, room_rent – fixed monthly earnings'),
      h('li', {}, 'pin – optional; if blank a random 4-digit PIN is created and shown after import')));

  function showPreview(res) {
    const bad = res.error_count;
    out.replaceChildren(
      h('p', {}, bad
        ? h('strong', { style: { color: 'var(--bad)' } }, `${bad} row(s) have problems. Fix them in the file and check again. Nothing has been imported.`)
        : h('strong', {}, `${res.rows.length} employee(s) ready to import.`),
      res.new_branches.length ? ` New branches to be created: ${res.new_branches.map((b) => `${b.name}${b.located ? ' 📍' : ''}`).join(', ')}.` : '',
      res.new_branches.some((b) => !b.located) ? ' Branches without 📍 have no location yet — you can set it afterwards on the Branches page.' : ''),
    res.link_warnings?.length ? h('div', { class: 'card', style: { borderColor: 'var(--warn)' } },
      h('strong', {}, '⚠ Could not read these Maps links (the import can still go ahead; set these locations afterwards):'),
      h('ul', { class: 'small' }, res.link_warnings.map((w) => h('li', {}, w)))) : '',
      table([
        { label: 'Line', render: (r) => String(r.line) },
        { label: 'Employee', render: (r) => h('div', {}, h('strong', {}, r.name || '—'), h('div', { class: 'small muted' }, `${r.code} · ${r.designation || ''}`)) },
        { label: 'Branch', render: (r) => r.branch },
        { label: 'Salary', class: 'num', render: (r) => money(r.salary_paise) },
        { label: 'Joined', render: (r) => (r.joined_on ? fmtDate(r.joined_on) : '—') },
        { label: 'Fixed items', render: (r) => r.items.map((i) => `${i.label} ${i.kind === 'deduction' ? '−' : '+'}${money(i.amount_paise)}`).join(', ') || '—' },
        { label: 'Problems', render: (r) => (r.errors.length ? h('span', { style: { color: 'var(--bad)' } }, r.errors.join('; ')) : '✓') },
      ], res.rows, { rowClass: (r) => (r.errors.length ? 'row-flag' : null) }),
      bad ? '' : h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', onclick: async (ev) => {
        const done = await run(() => api('POST', '/api/admin/employees/import', { csv }), ev.currentTarget);
        if (done) showDone(done);
      } }, `Import ${res.rows.length} employee(s)`)));
  }

  function showDone(done) {
    const pinsCsv = ['Employee ID,Name,Branch,PIN', ...done.created.map((c) => [c.code, c.name, c.branch, c.pin].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))].join('\r\n');
    out.replaceChildren(
      h('p', {}, h('strong', {}, `Imported ${done.created.length} employee(s).`),
        ' Download the PIN list now — PINs are stored encrypted and cannot be shown again (you can always reset a PIN).'),
      h('div', { class: 'row' },
        h('a', { class: 'btn btn-primary', href: URL.createObjectURL(new Blob([`\uFEFF${pinsCsv}`], { type: 'text/csv' })), download: 'staff-pins.csv' }, 'Download PIN list'),
        done.new_branches.length ? h('a', { class: 'btn', href: '#/branches', onclick: () => dlg.close() }, 'Set branch locations →') : ''),
      table([
        { label: 'Employee ID', render: (c) => c.code },
        { label: 'Name', render: (c) => c.name },
        { label: 'Branch', render: (c) => c.branch },
        { label: 'PIN', render: (c) => h('code', {}, c.pin) },
      ], done.created));
    file.disabled = true;
    check.remove();
  }

  const dlg = modal('Import employees from CSV', h('div', { class: 'stack' }, help, h('div', { class: 'row' }, file, check), out),
    { wide: true, onClose: () => route() });
}

async function deleteEmployee(e) {
  const ok = await confirmDialog(`Delete ${e.name}?`,
    `This permanently deletes ${e.name} (${e.code}) and all their attendance, selfies, documents, leaves and pay items. It cannot be undone. `
    + 'If the person has left the company, use Edit → untick "Active" instead, which keeps their records for payroll.', 'Delete permanently', true);
  if (!ok) return;
  if (await run(() => api('DELETE', `/api/admin/employees/${e.id}`))) {
    toast(`${e.name} deleted`);
    route();
  }
}

function resetStaff() {
  formDialog({
    title: 'Delete all staff and branches',
    fields: [
      { type: 'heading', label: 'This cannot be undone' },
      { name: 'info', label: 'What is deleted', type: 'textarea', value: 'Every employee with all their attendance, selfies, documents, leaves, advances and pay items, and every branch. Admin accounts, settings, company-wide holidays and finalized payroll are kept.' },
      { name: 'password', label: 'Your admin password', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'confirm', label: 'Type DELETE to confirm', required: true, placeholder: 'DELETE' },
    ],
    submitLabel: 'Delete everything',
    async onSubmit(v) {
      if (v.confirm !== 'DELETE') throw new Error('Type DELETE in capital letters to confirm');
      const r = await api('POST', '/api/admin/reset-staff', { password: v.password, confirm: v.confirm });
      toast(`Deleted ${r.employees} employee(s) and ${r.branches} branch(es). You can import fresh data now.`);
      go('employees');
      return true;
    },
  });
  const info = document.querySelector('.modal [name=info]');
  if (info) info.readOnly = true;
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
    h('p', { class: 'muted small' }, 'Staff punch at their own branch, plus any extra locations you allow on their employee page. Anywhere else, the punch is flagged for your review or blocked, depending on their branch’s setting.'),
    table([
      { label: 'Branch', render: (b) => h('div', {}, h('strong', {}, b.name), b.address ? h('div', { class: 'small muted' }, b.address) : '') },
      { label: 'Location', render: (b) => (b.location_set
        ? h('div', {}, `${b.lat.toFixed(5)}, ${b.lng.toFixed(5)} `, mapLink(b.lat, b.lng))
        : h('button', { class: 'btn btn-sm btn-primary', onclick: () => branchForm(b) }, '⚠ Set location')) },
      { label: 'Timing', render: (b) => `${b.shift_start}–${b.shift_end}` },
      { label: 'Radius', class: 'num', render: (b) => `${b.radius_m} m` },
      { label: 'Outside radius', render: (b) => (b.geofence_mode === 'block' ? badge('Block punch', 'bad') : badge('Allow & flag', 'warn')) },
      { label: 'Staff', class: 'num', render: (b) => String(b.employee_count) },
      { label: 'Status', render: (b) => (b.active ? badge('active', 'ok') : badge('inactive', 'neutral')) },
      { label: '', render: (b) => h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm', onclick: () => branchForm(b) }, 'Edit'),
        b.all_employee_count ? '' : h('button', { class: 'btn btn-sm', onclick: async (ev) => {
          if (!(await confirmDialog(`Delete ${b.name}?`, 'This branch has no employees. It will be removed permanently.', 'Delete', true))) return;
          if (await run(() => api('DELETE', `/api/admin/branches/${b.id}`), ev.currentTarget)) route();
        } }, 'Delete')) },
    ], A.branches, { empty: 'No branches yet. Add your first branch — stand inside it and use “Use my current location”.' }));
}

/** Reads coordinates from a pasted Google Maps link as soon as it is entered. */
function autoLocateFromLink(form) {
  const linkInput = form.querySelector('[name=maps_link]');
  const status = h('div', { class: 'hint' });
  linkInput.closest('.field').append(status);
  let timer = null;
  let seq = 0;
  const lookup = async () => {
    const link = linkInput.value.trim();
    if (!link) { status.textContent = ''; return; }
    const mine = ++seq;
    status.textContent = '⏳ Reading location from link…';
    try {
      const r = await api('POST', '/api/admin/maps/resolve', { link });
      if (mine !== seq) return;
      form.querySelector('[name=lat]').value = r.lat.toFixed(6);
      form.querySelector('[name=lng]').value = r.lng.toFixed(6);
      status.replaceChildren('✅ Location found: ', mapLink(r.lat, r.lng, `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`), ' — check it is the right place.');
    } catch (err) {
      if (mine === seq) status.textContent = `⚠ ${err.message}`;
    }
  };
  linkInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(lookup, 500); });
}

function branchForm(b) {
  const dlg = formDialog({
    title: b ? `Edit ${b.name}` : 'Add branch',
    fields: [
      { name: 'name', label: 'Branch name', required: true, value: b?.name },
      { name: 'address', label: 'Address', type: 'textarea', value: b?.address },
      { name: 'maps_link', label: 'Google Maps link', value: b?.maps_link, placeholder: 'https://maps.app.goo.gl/…',
        hint: 'In Google Maps, long-press the exact spot to drop a pin → Share → Copy link, then paste it here. The location is read from the link automatically.' },
      { type: 'button', label: '📍 Use my current location instead', hint: 'Or do this on a phone while standing inside the branch.',
        onclick(form, btn) {
          if (!navigator.geolocation) return toast('Location not available in this browser', 'error');
          btn.disabled = true;
          btn.textContent = 'Locating…';
          navigator.geolocation.getCurrentPosition((pos) => {
            form.querySelector('[name=maps_link]').value = '';
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
      { name: 'lat', label: 'Latitude', type: 'number', step: 'any', value: b?.location_set ? b.lat : '', placeholder: 'filled from the link' },
      { name: 'lng', label: 'Longitude', type: 'number', step: 'any', value: b?.location_set ? b.lng : '', placeholder: 'filled from the link' },
      { name: 'shift_start', label: 'Office opens', type: 'time', required: true, value: b?.shift_start || '09:00' },
      { name: 'shift_end', label: 'Office closes', type: 'time', required: true, value: b?.shift_end || '18:00', hint: 'Staff of this branch who follow the branch timing get these hours automatically (late marks and full days are counted from them).' },
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
  autoLocateFromLink(dlg.form);
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
    p.rows.some((r) => r.attendance.late_pending) && !p.finalized
      ? h('div', { class: 'card', style: { marginBottom: '12px', borderColor: 'var(--warn)' } },
        `ℹ Very late arrivals counted as half days, not yet reviewed: ${p.rows.filter((r) => r.attendance.late_pending).map((r) => r.name).join(', ')}. `,
        h('a', { href: `#/late?month=${month}` }, 'Review →'))
      : '',
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
        h('li', {}, `Late arrivals: every ${A.me.settings.late_warnings + 1}${A.me.settings.late_warnings + 1 === 3 ? 'rd' : 'th'} late in a month counts as a half day; the others are warnings. Someone up to ${A.me.settings.late_max_minutes} min late who stays until shift end is otherwise a full day. Later than ${A.me.settings.late_max_minutes} min: half day, flagged on Late approvals where you can grant a full day.`),
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

// ---------------------------------------------------------------- staff app preview

async function pagePreview(el, params) {
  await loadEmployees();
  const empId = params.get('employee_id') || A.employees.find((e) => e.active)?.id || '';
  const emp = A.employees.find((e) => String(e.id) === String(empId));
  const src = `/?preview=${empId}`;
  el.replaceChildren(
    pageHead('Staff preview', emp ? h('a', { class: 'btn', href: src, target: '_blank', rel: 'noopener' }, 'Open in new tab ↗') : ''),
    h('div', { class: 'toolbar' }, employeeSelect(empId, (v) => go('preview', { employee_id: v }), 'Choose an employee')),
    h('p', { class: 'small muted' }, 'This is exactly what the employee sees in their app — their attendance, leaves, documents and payslips. It is read-only: nothing can be punched or changed here. Opening a preview is recorded in the audit log.'),
    emp
      ? h('div', { class: 'phone' }, h('iframe', { src, title: `${emp.name}'s app`, class: 'phone-screen' }))
      : h('div', { class: 'empty' }, 'Add employees first.'));
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
        { label: 'Name', render: (a) => h('span', {}, a.name, a.id === A.me.admin.id ? h('span', { class: 'muted' }, ' (you)') : '') },
        { label: 'Username', render: (a) => a.username },
        { label: 'Can change attendance register', render: (a) => (A.me.admin.can_edit_attendance
          ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!a.can_edit_attendance, onchange: async (ev) => {
            const want = ev.target.checked;
            const ok = await run(() => api('PUT', `/api/admin/admins/${a.id}/permissions`, { can_edit_attendance: want }));
            if (!ok) { ev.target.checked = !want; return; }
            toast(`${a.name} ${want ? 'can now' : 'can no longer'} change the attendance register`);
            route();
          } }), a.can_edit_attendance ? 'Yes' : 'No')
          : (a.can_edit_attendance ? badge('Yes', 'ok') : badge('No', 'neutral'))) },
        { label: 'Added', render: (a) => fmtDateTime(a.created_at) },
        { label: '', render: (a) => h('div', { class: 'row' },
          h('button', { class: 'btn btn-sm', onclick: () => formDialog({
            title: `Edit ${a.name}`,
            fields: [
              { name: 'name', label: 'Name', required: true, value: a.name },
              { name: 'username', label: 'Username (used to log in)', required: true, value: a.username },
            ],
            async onSubmit(v) {
              await api('PUT', `/api/admin/admins/${a.id}`, v);
              if (a.id === A.me.admin.id) A.me.admin = { ...A.me.admin, ...v };
              toast('Admin updated');
              route();
              return true;
            },
          }) }, 'Edit'),
          a.id === A.me.admin.id ? '' : h('button', { class: 'btn btn-sm', onclick: () => formDialog({
            title: `Reset password · ${a.name}`,
            fields: [
              { name: 'new_password', label: `New password for ${a.username} (min 8 chars)`, type: 'password', required: true, autocomplete: 'new-password' },
              { name: 'password', label: 'Your own password (to confirm)', type: 'password', required: true, autocomplete: 'current-password' },
            ],
            submitLabel: 'Reset password',
            async onSubmit(v) {
              await api('POST', `/api/admin/admins/${a.id}/password`, v);
              toast(`Password reset. ${a.name} has been logged out and must use the new password.`);
              return true;
            },
          }) }, 'Reset password'),
          a.id === A.me.admin.id ? '' : h('button', { class: 'btn btn-sm', onclick: () => formDialog({
            title: `Remove admin ${a.name}?`,
            fields: [
              { type: 'heading', label: `${a.name} will no longer be able to log in. Their past approvals stay in the records.` },
              { name: 'password', label: 'Your own password (to confirm)', type: 'password', required: true, autocomplete: 'current-password' },
            ],
            submitLabel: 'Remove admin',
            async onSubmit(v) {
              await api('DELETE', `/api/admin/admins/${a.id}`, v);
              toast(`${a.name} removed`);
              route();
              return true;
            },
          }) }, 'Remove')) },
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
      h('dt', {}, 'Late rule'), h('dd', {}, `Every ${s.late_warnings + 1}${s.late_warnings + 1 === 3 ? 'rd' : 'th'} late in a month is a half day (others are warnings)`),
      h('dt', {}, 'Very late'), h('dd', {}, `More than ${s.late_max_minutes} min late: half day, flagged for your review`),
      h('dt', {}, 'Staff salary view'), h('dd', {}, `From ${fmtMonth(s.salary_visible_from)} onwards`),
      h('dt', {}, 'GPS accuracy'), h('dd', {}, `Flag punches worse than ±${s.max_accuracy_m} m`),
      h('dt', {}, 'Overtime'), h('dd', {}, s.ot_requires_approval ? 'Needs admin approval before it is paid' : 'Paid automatically')),
    h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', onclick: () => formDialog({
      title: 'Edit settings',
      fields: [
        { name: 'company_name', label: 'Company name', required: true, value: s.company_name },
        { name: 'half_day_hours', label: 'Hours for a half day', type: 'number', step: '0.25', min: 0.5, max: 24, required: true, value: s.half_day_hours, hint: 'Less than this counts as absent.' },
        { name: 'grace_minutes', label: 'Late grace period (minutes)', type: 'number', min: 0, max: 240, required: true, value: s.grace_minutes, hint: 'Also sets the full day: shift length minus this grace.' },
        { name: 'late_warnings', label: 'Warnings between half days', type: 'number', min: 0, max: 31, step: 1, required: true, value: s.late_warnings, hint: 'With 2: the 3rd, 6th, 9th… late in a month is a half day; the others are warnings.' },
        { name: 'late_max_minutes', label: 'Arrivals later than this (minutes) count as a half day and are flagged for review', type: 'number', min: 0, max: 480, required: true, value: s.late_max_minutes },
        { name: 'salary_visible_from', label: 'Staff can see salary from (month)', type: 'month', required: true, value: s.salary_visible_from },
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
  const danger = h('div', { class: 'card', style: { maxWidth: '560px', marginTop: '16px', borderColor: 'var(--bad)' } },
    h('h2', {}, 'Danger zone'),
    h('p', { class: 'small muted' }, 'Start over: delete every employee and branch (for example to re-import staff from a corrected file).'),
    h('button', { class: 'btn btn-danger', onclick: resetStaff }, 'Delete all staff and branches…'));
  el.replaceChildren(pageHead('Settings'), tabs, form, danger);
}

const PAGE_FNS = {
  dashboard: pageDashboard,
  punches: pagePunches,
  attendance: pageAttendance,
  overtime: pageOvertime,
  late: pageLate,
  leaves: pageLeaves,
  employees: pageEmployees,
  preview: pagePreview,
  documents: pageDocuments,
  branches: pageBranches,
  holidays: pageHolidays,
  payroll: pagePayroll,
  settings: pageSettings,
};

boot();
