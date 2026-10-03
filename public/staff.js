'use strict';
/* Staff app: punch in/out with selfie + GPS, attendance calendar, leaves, documents, payslips. */

const S = { me: null, tab: 'home', month: thisMonth(), clockTimer: null };
const root = document.getElementById('root');

setUnauthorizedHandler(() => {
  S.me = null;
  showLogin();
});

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------- login

function showLogin() {
  clearInterval(S.clockTimer);
  const code = h('input', { id: 'code', autocomplete: 'username', autocapitalize: 'characters', required: true, placeholder: 'e.g. E001' });
  const pin = h('input', { id: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', maxlength: 6, required: true, placeholder: '4–6 digits' });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Log in');
  const form = h('form', { class: 'form card login-card' },
    h('img', { src: '/icon.svg', alt: '', class: 'logo' }),
    h('h1', {}, 'Staff Attendance'),
    h('p', { class: 'muted' }, 'Log in with the Employee ID and PIN given by your manager.'),
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'Employee ID'), code),
    h('div', { class: 'field' }, h('label', { for: 'pin' }, 'PIN'), pin),
    btn,
    h('p', { class: 'small muted', style: { marginTop: '16px', textAlign: 'center' } }, 'Forgot your PIN? Ask your manager to reset it.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await run(async () => {
      await api('POST', '/api/employee/login', { code: code.value.trim(), pin: pin.value });
      await boot();
    }, btn);
  });
  root.replaceChildren(h('div', { class: 'login-wrap' }, form));
  code.focus();
}

// ---------------------------------------------------------------- shell

async function boot() {
  try {
    S.me = await api('GET', '/api/employee/me');
  } catch (err) {
    if (err.status === 401) return showLogin();
    root.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'card' }, `Could not connect: ${err.message}`)));
    return;
  }
  renderShell();
}

const TABS = [
  ['home', '⏱', 'Today'],
  ['attendance', '📅', 'Attendance'],
  ['leaves', '🌴', 'Leaves'],
  ['more', '☰', 'More'],
];

function renderShell() {
  const main = h('main', { class: 'app-main' });
  const bar = h('nav', { class: 'tabbar' }, TABS.map(([key, ico, label]) =>
    h('button', { class: S.tab === key ? 'active' : '', onclick: () => { S.tab = key; renderShell(); } },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, ico), label)));
  root.replaceChildren(
    h('header', { class: 'app-header' },
      h('div', {}, h('div', { class: 'who' }, S.me.employee.name), h('div', { class: 'small muted' }, `${S.me.employee.code} · ${S.me.branch?.name || ''}`)),
      h('div', { class: 'small muted' }, S.me.company_name)),
    main, bar);
  clearInterval(S.clockTimer);
  ({ home: renderHome, attendance: renderAttendance, leaves: renderLeaves, more: renderMore })[S.tab](main);
}

// ---------------------------------------------------------------- today / punch

async function renderHome(main) {
  const clock = h('div', { class: 'clock' }, fmtTime(Date.now()));
  S.clockTimer = setInterval(() => { clock.textContent = fmtTime(Date.now()); }, 10000);
  main.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'muted' }, fmtDate(todayIST())), clock), h('div', { class: 'empty' }, 'Loading…'));

  const t = await run(() => api('GET', '/api/employee/today'));
  if (!t) return;
  const d = t.day;
  const actions = h('div', { class: 'punch-actions' }, t.allowed.map((kind) =>
    h('button', { class: `btn btn-primary punch-btn ${kind.startsWith('OT') ? 'ot' : ''}`, onclick: () => punchFlow(kind, t) }, PUNCH_LABEL[kind])));

  const facts = h('dl', { class: 'kv' },
    h('dt', {}, 'Shift'), h('dd', {}, `${t.shift.start} – ${t.shift.end}`),
    h('dt', {}, 'Status'), h('dd', {}, statusBadge(d.status) || '—', d.late_minutes ? [' ', badge(lateText(d, S.me.late_warnings), d.flags.includes('late_penalty') ? 'bad' : 'warn')] : ''),
    h('dt', {}, 'In / Out'), h('dd', {}, `${d.first_in || '—'} / ${d.last_out || '—'}`),
    h('dt', {}, 'Worked'), h('dd', {}, fmtMinutes(d.worked_minutes)),
    d.ot_minutes || d.ot_start ? [h('dt', {}, 'Overtime'), h('dd', {}, `${fmtMinutes(d.ot_minutes)} `, d.ot_status ? badge(d.ot_status, d.ot_status === 'approved' ? 'ok' : d.ot_status === 'rejected' ? 'bad' : 'warn') : '')] : '');

  const timeline = t.punches.length
    ? h('ul', { class: 'timeline' }, t.punches.map((p) => h('li', {},
      h('img', { src: `/api/employee/punches/${p.id}/selfie`, alt: 'Selfie', loading: 'lazy' }),
      h('div', { style: { flex: 1 } },
        h('div', {}, h('span', { class: 't' }, fmtTime(p.at)), ' ', PUNCH_LABEL[p.kind]),
        h('div', { class: 'small muted' },
          p.inside_geofence ? `At branch (${p.distance_m} m)` : p.distance_m !== null ? `${p.distance_m} m from branch` : '',
          p.status === 'flagged' ? [' · ', badge('Under review', 'warn')] : p.status === 'rejected' ? [' · ', badge('Rejected', 'bad')] : '')))))
    : h('div', { class: 'empty' }, 'No punches yet today.');

  main.replaceChildren(
    h('div', { class: 'card' },
      h('div', { class: 'spread' }, h('div', {}, h('div', { class: 'muted' }, fmtDate(t.work_date)), clock)),
      actions),
    h('div', { class: 'card' }, h('h2', {}, t.work_date === todayIST() ? 'Today' : `Shift of ${fmtDate(t.work_date)}`), facts),
    h('div', { class: 'card' }, h('h2', {}, 'Punches'), timeline));
}

function punchFlow(kind, today) {
  let stream = null;
  let watchId = null;
  let position = null;
  let captured = null;
  let done = false;

  const video = h('video', { autoplay: true, playsinline: true, muted: true });
  const preview = h('img', { class: 'hidden', alt: 'Selfie preview' });
  const geo = h('div', { class: 'camera-geo wait' }, 'Getting your location…');
  const shutter = h('button', { class: 'shutter', 'aria-label': 'Take selfie', disabled: true });
  const retake = h('button', { class: 'btn hidden' }, 'Retake');
  const confirm = h('button', { class: 'btn btn-primary hidden', style: { minWidth: '160px' } }, `Confirm ${PUNCH_LABEL[kind]}`);
  const overlay = h('div', { class: 'camera' },
    h('div', { class: 'camera-view' }, video, preview,
      h('div', { class: 'camera-top' }, h('strong', {}, PUNCH_LABEL[kind]), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, '✕')),
      geo),
    h('div', { class: 'camera-bar' }, shutter, retake, confirm));
  document.body.append(overlay);

  function close() {
    if (done) return;
    done = true;
    if (stream) stream.getTracks().forEach((tr) => tr.stop());
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    overlay.remove();
  }

  function nearestBranch(lat, lng) {
    let best = null;
    for (const b of today.branches) {
      const dist = distanceM(lat, lng, b.lat, b.lng);
      if (!best || dist < best.dist) best = { b, dist };
    }
    return best;
  }

  function updateGeo() {
    if (!position) return;
    const { latitude, longitude, accuracy } = position.coords;
    const n = nearestBranch(latitude, longitude);
    const inside = n && n.dist <= n.b.radius_m;
    geo.className = `camera-geo ${inside ? 'ok' : 'bad'}`;
    geo.replaceChildren(
      h('div', {}, h('strong', {}, inside ? `✓ At ${n.b.name}` : n ? `${Math.round(n.dist)} m from ${n.b.name}` : 'No branch set up'),
        inside ? '' : h('span', {}, ' — outside branch area')),
      h('div', { class: 'small' }, `GPS accuracy ±${Math.round(accuracy)} m`));
    if (captured) confirm.disabled = false;
  }

  if (!navigator.geolocation) {
    geo.className = 'camera-geo bad';
    geo.textContent = 'This phone/browser cannot share location.';
  } else {
    watchId = navigator.geolocation.watchPosition(
      (pos) => { position = pos; updateGeo(); },
      (err) => {
        geo.className = 'camera-geo bad';
        geo.textContent = err.code === 1
          ? 'Location permission is blocked. Allow location for this site in your browser settings, then try again.'
          : 'Could not get your location. Turn on GPS / Location and step near a window.';
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Camera is not available. Open this app over https:// in Chrome or Safari.', 'error');
  } else {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 960 } }, audio: false })
      .then((s) => {
        if (done) return s.getTracks().forEach((tr) => tr.stop());
        stream = s;
        video.srcObject = s;
        video.onloadedmetadata = () => { shutter.disabled = false; };
      })
      .catch((err) => {
        toast(err.name === 'NotAllowedError'
          ? 'Camera permission is blocked. Allow camera for this site in browser settings.'
          : `Camera error: ${err.message}`, 'error');
      });
  }

  shutter.addEventListener('click', () => {
    const w = video.videoWidth;
    const hgt = video.videoHeight;
    if (!w || !hgt) return;
    const scale = Math.min(1, 720 / Math.max(w, hgt));
    const canvas = h('canvas', { width: Math.round(w * scale), height: Math.round(hgt * scale) });
    const c = canvas.getContext('2d');
    c.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Stamp name, time and location onto the photo (like a geotag camera).
    const lines = [
      `${S.me.employee.name} (${S.me.employee.code}) · ${PUNCH_LABEL[kind]}`,
      new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    ];
    if (position) {
      const n = nearestBranch(position.coords.latitude, position.coords.longitude);
      lines.push(`${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)} ±${Math.round(position.coords.accuracy)}m`);
      if (n) lines.push(`${Math.round(n.dist)} m from ${n.b.name}`);
    }
    const fs = Math.max(14, Math.round(canvas.width / 34));
    c.font = `600 ${fs}px system-ui, sans-serif`;
    const boxH = lines.length * (fs + 6) + 12;
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(0, canvas.height - boxH, canvas.width, boxH);
    c.fillStyle = '#fff';
    lines.forEach((line, i) => c.fillText(line, 10, canvas.height - boxH + 8 + fs + i * (fs + 6)));
    captured = canvas.toDataURL('image/jpeg', 0.75);
    preview.src = captured;
    preview.classList.remove('hidden');
    video.classList.add('hidden');
    shutter.classList.add('hidden');
    retake.classList.remove('hidden');
    confirm.classList.remove('hidden');
    confirm.disabled = !position;
    if (!position) toast('Waiting for your location before you can confirm…');
  });

  retake.addEventListener('click', () => {
    captured = null;
    preview.classList.add('hidden');
    video.classList.remove('hidden');
    shutter.classList.remove('hidden');
    retake.classList.add('hidden');
    confirm.classList.add('hidden');
  });

  confirm.addEventListener('click', async () => {
    if (!captured || !position) return;
    const res = await run(() => api('POST', '/api/employee/punch', {
      kind,
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      selfie: captured,
    }), confirm);
    if (!res) return;
    close();
    if (res.status === 'flagged') toast(`${PUNCH_LABEL[kind]} saved at ${fmtTime(res.at)}, but flagged for review: ${res.flag_reason}`, 'error');
    else toast(`${PUNCH_LABEL[kind]} done at ${fmtTime(res.at)}`);
    if (res.late) {
      toast(res.late.half_day
        ? `You are late by ${fmtMinutes(res.late.minutes)}. This is late #${res.late.mark} this month, so today counts as a half day.`
        : `You are late by ${fmtMinutes(res.late.minutes)}. Warning ${res.late.mark} of ${res.late.warnings} this month — after ${res.late.warnings} warnings, each late day counts as a half day.`, 'error');
    }
    renderShell();
  });
}

// ---------------------------------------------------------------- attendance

async function renderAttendance(main) {
  main.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  const data = await run(() => api('GET', `/api/employee/attendance?month=${S.month}`));
  if (!data) return;
  const s = data.summary;
  const first = new Date(`${S.month}-01T00:00:00Z`).getUTCDay();
  const today = todayIST();
  const cal = h('div', { class: 'cal' },
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => h('div', { class: 'dow' }, x)),
    Array.from({ length: first }, () => h('div', { class: 'd blank' })),
    data.days.map((d) => h('button', {
      class: `d ${d.status} ${d.date === today ? 'today' : ''}`,
      onclick: () => dayDetails(d),
      'aria-label': `${fmtDate(d.date)}: ${STATUS_LABEL[d.status] || ''}`,
    }, String(Number(d.date.slice(8))), h('span', { class: 's' }, STATUS_SHORT[d.status] || ''))));

  main.replaceChildren(
    h('div', { class: 'spread', style: { marginBottom: '12px' } },
      monthPicker(S.month, (m) => { S.month = m; renderAttendance(main); })),
    h('div', { class: 'stats' },
      stat(s.present, 'Present'), stat(s.half_day, 'Half days'), stat(s.absent + s.not_marked, 'Absent'),
      stat(s.paid_leave + s.unpaid_leave, 'Leave'), stat(`${s.late_days} / ${S.me.late_warnings}`, 'Late days / warnings'),
      stat((s.ot_payable_minutes / 60).toFixed(1), 'OT hours (approved)')),
    h('div', { class: 'card', style: { marginTop: '12px' } }, cal,
      h('p', { class: 'small muted' }, 'P present · HD half day · A absent · PL/UL leave · WO week off · H holiday. Tap a day for details.')));
}

function stat(v, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'v' }, String(v)), h('div', { class: 'l' }, label));
}

function dayDetails(d) {
  modal(fmtDate(d.date), h('dl', { class: 'kv' },
    h('dt', {}, 'Status'), h('dd', {}, statusBadge(d.status) || '—'),
    d.holiday ? [h('dt', {}, 'Holiday'), h('dd', {}, d.holiday)] : '',
    h('dt', {}, 'In / Out'), h('dd', {}, `${d.first_in || '—'} / ${d.last_out || '—'}`),
    h('dt', {}, 'Worked'), h('dd', {}, fmtMinutes(d.worked_minutes)),
    h('dt', {}, 'Late'), h('dd', {}, d.late_minutes ? lateText(d, S.me.late_warnings) : 'No'),
    h('dt', {}, 'Overtime'), h('dd', {}, d.ot_minutes ? `${fmtMinutes(d.ot_minutes)} (${d.ot_status})` : '—'),
    d.override ? [h('dt', {}, 'Corrected by admin'), h('dd', {}, d.override.note || 'Yes')] : '',
    d.flags.length ? [h('dt', {}, 'Notes'), h('dd', {}, d.flags.map((f) => FLAG_LABEL[f] || f).join(', '))] : ''));
}

// ---------------------------------------------------------------- leaves

async function renderLeaves(main) {
  const list = await run(() => api('GET', '/api/employee/leaves'));
  if (!list) return;
  const kind = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: 'neutral' };
  main.replaceChildren(
    h('div', { class: 'spread', style: { marginBottom: '12px' } }, h('h1', {}, 'Leaves'),
      h('button', { class: 'btn btn-primary', onclick: requestLeave }, '+ Request leave')),
    list.length
      ? list.map((l) => h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('strong', {}, l.from_date === l.to_date ? fmtDate(l.from_date) : `${fmtDate(l.from_date)} → ${fmtDate(l.to_date)}`),
          badge(l.status, kind[l.status])),
        h('div', { class: 'small muted' }, `${l.leave_type === 'paid' ? 'Paid' : 'Unpaid'} leave${l.reason ? ` · ${l.reason}` : ''}`),
        l.status === 'pending' ? h('button', {
          class: 'btn btn-sm', style: { marginTop: '8px' },
          onclick: async (e) => { if (await run(() => api('POST', `/api/employee/leaves/${l.id}/cancel`), e.target)) renderShell(); },
        }, 'Cancel request') : ''))
      : h('div', { class: 'empty' }, 'No leave requests yet.'));
}

function requestLeave() {
  formDialog({
    title: 'Request leave',
    fields: [
      { name: 'from_date', label: 'From', type: 'date', required: true, value: todayIST() },
      { name: 'to_date', label: 'To', type: 'date', required: true, value: todayIST() },
      { name: 'leave_type', label: 'Type', type: 'select', options: [{ value: 'paid', label: 'Paid leave' }, { value: 'unpaid', label: 'Unpaid leave' }] },
      { name: 'reason', label: 'Reason', type: 'textarea' },
    ],
    submitLabel: 'Send request',
    async onSubmit(v) {
      await api('POST', '/api/employee/leaves', v);
      toast('Leave request sent');
      renderShell();
      return true;
    },
  });
}

// ---------------------------------------------------------------- more: documents, payslips, PIN

async function renderMore(main) {
  const [docs, slips] = await Promise.all([run(() => api('GET', '/api/employee/documents')), run(() => api('GET', '/api/employee/payslips'))]);
  if (!docs || !slips) return;
  const e = S.me.employee;
  const docKind = { pending: 'warn', verified: 'ok', rejected: 'bad' };
  main.replaceChildren(
    h('div', { class: 'card' }, h('h2', {}, 'My details'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Employee ID'), h('dd', {}, e.code),
        h('dt', {}, 'Designation'), h('dd', {}, e.designation || '—'),
        h('dt', {}, 'Branch'), h('dd', {}, S.me.branch?.name || '—'),
        h('dt', {}, 'Shift'), h('dd', {}, `${e.shift_start} – ${e.shift_end}`),
        h('dt', {}, 'Joined'), h('dd', {}, fmtDate(e.joined_on)))),
    h('div', { class: 'card' },
      h('div', { class: 'spread' }, h('h2', {}, 'My documents'), h('button', { class: 'btn btn-primary btn-sm', onclick: uploadDocument }, '+ Upload')),
      h('p', { class: 'small muted' }, 'Upload Aadhaar, PAN and other KYC documents. Files are encrypted and only visible to your employer’s admins.'),
      docs.length
        ? h('ul', { class: 'timeline' }, docs.map((d) => h('li', {},
          h('div', { style: { flex: 1 } },
            h('div', {}, h('strong', {}, DOC_LABEL[d.doc_type]), d.label ? ` · ${d.label}` : ''),
            h('div', { class: 'small muted' }, d.doc_number || '', d.review_note ? ` · ${d.review_note}` : '')),
          badge(d.status, docKind[d.status]),
          h('a', { class: 'btn btn-sm', href: `/api/employee/documents/${d.id}/file`, target: '_blank', rel: 'noopener' }, 'View'))))
        : h('div', { class: 'empty' }, 'No documents uploaded yet.')),
    h('div', { class: 'card' }, h('h2', {}, 'Payslips'),
      slips.length
        ? h('ul', { class: 'timeline' }, slips.map((p) => h('li', {},
          h('div', { style: { flex: 1 } }, h('strong', {}, fmtMonth(p.month)), h('div', { class: 'small muted' }, `Net pay ${money(p.net_paise)}`)),
          h('button', { class: 'btn btn-sm', onclick: () => viewPayslip(p.month) }, 'Open'))))
        : h('div', { class: 'empty' }, 'Payslips appear here once your employer finalizes the month’s salary.')),
    h('div', { class: 'card row' },
      h('button', { class: 'btn', onclick: changePin }, 'Change PIN'),
      h('button', { class: 'btn', onclick: async () => { await run(() => api('POST', '/api/employee/logout')); showLogin(); } }, 'Log out')));
}

async function viewPayslip(month) {
  const slip = await run(() => api('GET', `/api/employee/payslips/${month}`));
  if (slip) openPayslip(slip.company_name, slip.month, slip.row);
}

function uploadDocument() {
  formDialog({
    title: 'Upload document',
    fields: [
      { name: 'doc_type', label: 'Document', type: 'select', options: Object.entries(DOC_LABEL).map(([value, label]) => ({ value, label })) },
      { name: 'doc_number', label: 'Document number', hint: 'Aadhaar: only the last 4 digits are kept. PAN: e.g. ABCDE1234F.' },
      { name: 'label', label: 'Note (optional)', placeholder: 'e.g. front side' },
      { name: 'file', label: 'Photo or PDF', type: 'file', accept: 'image/jpeg,image/png,application/pdf', required: true },
    ],
    submitLabel: 'Upload',
    async onSubmit(v) {
      const file = await prepareUpload(v.file);
      await api('POST', '/api/employee/documents', { doc_type: v.doc_type, doc_number: v.doc_number, label: v.label, file });
      toast('Document uploaded');
      renderShell();
      return true;
    },
  });
}

function changePin() {
  formDialog({
    title: 'Change PIN',
    fields: [
      { name: 'current_pin', label: 'Current PIN', type: 'password', inputmode: 'numeric', required: true, maxlength: 6 },
      { name: 'new_pin', label: 'New PIN (4–6 digits)', type: 'password', inputmode: 'numeric', required: true, maxlength: 6 },
      { name: 'confirm', label: 'Repeat new PIN', type: 'password', inputmode: 'numeric', required: true, maxlength: 6 },
    ],
    async onSubmit(v) {
      if (v.new_pin !== v.confirm) throw new Error('New PINs do not match');
      await api('POST', '/api/employee/pin', { current_pin: v.current_pin, new_pin: v.new_pin });
      toast('PIN changed');
      return true;
    },
  });
}

boot();
