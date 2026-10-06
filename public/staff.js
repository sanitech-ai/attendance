'use strict';
/* Staff app: punch in/out with selfie + GPS, attendance calendar, leaves, documents, payslips. */

// Admins open /?preview=<employee id> to see an employee's app read-only.
const PREVIEW_ID = new URLSearchParams(location.search).get('preview');
const EMP = PREVIEW_ID ? `/api/admin/preview/${encodeURIComponent(PREVIEW_ID)}` : '/api/employee';

// ---- "Add to Home Screen" ----
let installPrompt = null; // Android/Chrome hands us this when the app can be installed with one tap
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  refreshInstallCards();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  refreshInstallCards();
});
if ('serviceWorker' in navigator && !PREVIEW_ID) navigator.serviceWorker.register('/sw.js').catch(() => {});

function isInstalled() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function installCard() {
  if (PREVIEW_ID || isInstalled()) return h('div', { class: 'install-card hidden' });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let body;
  if (installPrompt) {
    body = h('button', { class: 'btn btn-primary btn-block', onclick: async () => {
      const p = installPrompt;
      installPrompt = null;
      await p.prompt();
      await p.userChoice.catch(() => null);
      refreshInstallCards();
    } }, '📲 Add to Home Screen');
  } else if (ios) {
    body = h('ol', { class: 'small' },
      h('li', {}, 'Open this page in ', h('b', {}, 'Safari'), '.'),
      h('li', {}, 'Tap the ', h('b', {}, 'Share'), ' button (square with an arrow ⬆) at the bottom.'),
      h('li', {}, 'Scroll down and tap ', h('b', {}, 'Add to Home Screen'), ', then ', h('b', {}, 'Add'), '.'));
  } else {
    body = h('ol', { class: 'small' },
      h('li', {}, 'In ', h('b', {}, 'Chrome'), ', tap the ', h('b', {}, '⋮'), ' menu at the top right.'),
      h('li', {}, 'Tap ', h('b', {}, 'Add to Home screen'), ' (or ', h('b', {}, 'Install app'), '), then ', h('b', {}, 'Install'), '.'));
  }
  return h('div', { class: 'card install-card' },
    h('div', { class: 'row', style: { marginBottom: '8px' } }, h('img', { src: '/icon-192.png', alt: '', width: 36, height: 36, style: { borderRadius: '8px' } }),
      h('div', {}, h('strong', {}, 'Add Sanitech to your Home Screen'), h('div', { class: 'small muted' }, 'Open it like an app with one tap, every day.'))),
    body);
}

function refreshInstallCards() {
  document.querySelectorAll('.install-card').forEach((el) => el.replaceWith(installCard()));
}

const S = { me: null, tab: 'home', month: thisMonth(), salaryMonth: thisMonth(), clockTimer: null };
const root = document.getElementById('root');

setUnauthorizedHandler(() => {
  S.me = null;
  if (PREVIEW_ID) location.href = '/admin';
  else showLogin();
});

// ---------------------------------------------------------------- login

function showLogin() {
  clearInterval(S.clockTimer);
  const code = h('input', { id: 'code', autocomplete: 'username', autocapitalize: 'none', required: true, placeholder: 'e.g. SECPL0025' });
  const pin = h('input', { id: 'pin', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Staff: 4–6 digit PIN' });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Log in');
  const form = h('form', { class: 'form card login-card' },
    h('img', { src: '/logo.svg', alt: 'Sanitech Engineers & Consultants', class: 'logo' }),
    h('h1', {}, 'Sanitech'),
    h('div', { class: 'muted', style: { marginBottom: '8px' } }, 'Staff attendance'),
    h('p', { class: 'muted' }, 'Staff: log in with the Employee ID and PIN given by your manager. Admins: use your username and password.'),
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'Employee ID / admin username'), code),
    h('div', { class: 'field' }, h('label', { for: 'pin' }, 'PIN / password'), pin),
    btn,
    h('p', { class: 'small muted', style: { marginTop: '16px', textAlign: 'center' } }, 'Forgot your PIN? Ask your manager to reset it.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await run(async () => {
      const id = code.value.trim();
      // One login box for everyone: try staff (ID + PIN) first, then admin (username + password).
      try {
        await api('POST', '/api/employee/login', { code: id, pin: pin.value });
        await boot();
        return;
      } catch (err) {
        if (err.status !== 401) throw err;
      }
      try {
        await api('POST', '/api/admin/login', { username: id, password: pin.value });
      } catch (err) {
        if (err.status === 401) throw new Error('Wrong Employee ID / username or PIN / password');
        throw err;
      }
      location.href = '/admin';
    }, btn);
  });
  root.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login-stack' }, form, installCard())));
  code.focus();
}

// ---------------------------------------------------------------- shell

async function refreshMe() {
  S.me = await api('GET', `${EMP}/me`);
}

/** Shown every time the app is opened until all details are in. */
function remindProfile() {
  const missing = S.me.profile_missing || [];
  if (!missing.length || PREVIEW_ID) return;
  const dlg = modal('Please complete your details', h('div', {},
    h('p', {}, 'The company needs these to pay your salary and keep your records:'),
    h('ul', { class: 'checklist' }, Object.keys(MISSING_LABEL).map((k) => h('li', { class: missing.includes(k) ? 'todo' : 'done' }, missing.includes(k) ? '◻ ' : '✅ ', MISSING_LABEL[k]))),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn', onclick: () => dlg.close() }, 'Later'),
      h('button', { class: 'btn btn-primary', onclick: () => { dlg.close(); S.tab = 'more'; renderShell(); } }, 'Do it now'))));
}

async function boot() {
  try {
    S.me = await api('GET', `${EMP}/me`);
  } catch (err) {
    if (err.status === 401) return PREVIEW_ID ? (location.href = '/admin') : showLogin();
    root.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'card' }, `Could not connect: ${err.message}`)));
    return;
  }
  renderShell();
  remindProfile();
}

const TABS = [
  ['home', '⏱', 'Today'],
  ['attendance', '📅', 'Attendance'],
  ['salary', '₹', 'Salary'],
  ['leaves', '🌴', 'Leaves'],
  ['more', '☰', 'More'],
];

function renderShell() {
  const main = h('main', { class: 'app-main' });
  // Managers get a Team tab to check what the app flagged for their team.
  const tabs = S.me.employee.is_manager ? [...TABS.slice(0, 4), ['team', '👥', 'Team'], TABS[4]] : TABS;
  const bar = h('nav', { class: 'tabbar', style: { gridTemplateColumns: `repeat(${tabs.length}, 1fr)` } }, tabs.map(([key, ico, label]) =>
    h('button', { class: S.tab === key ? 'active' : '', onclick: () => { S.tab = key; renderShell(); } },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, ico), label)));
  const missing = S.me.profile_missing || [];
  root.replaceChildren(
    PREVIEW_ID ? h('div', { class: 'preview-banner' }, `👁 Preview of ${S.me.employee.name}'s app · read-only`) : '',
    missing.length ? h('button', { class: 'profile-banner', onclick: () => { S.tab = 'more'; renderShell(); } },
      `⚠ Please add your ${missing.map((m) => MISSING_LABEL[m].split(' (')[0]).join(', ')} — tap here`) : '',
    h('header', { class: 'app-header' },
      h('div', {}, h('div', { class: 'who' }, S.me.employee.name), h('div', { class: 'small muted' }, `${S.me.employee.code} · ${S.me.branch?.name || ''}`)),
      h('div', { class: 'small muted' }, S.me.company_name)),
    main, bar);
  clearInterval(S.clockTimer);
  ({ home: renderHome, attendance: renderAttendance, salary: renderSalary, leaves: renderLeaves, team: renderTeam, more: renderMore })[S.tab](main);
}

// ---------------------------------------------------------------- today / punch

async function renderHome(main) {
  const clock = h('div', { class: 'clock' }, fmtTime(Date.now()));
  S.clockTimer = setInterval(() => { clock.textContent = fmtTime(Date.now()); }, 10000);
  main.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'muted' }, fmtDate(todayIST())), clock), h('div', { class: 'empty' }, 'Loading…'));

  const t = await run(() => api('GET', `${EMP}/today`));
  if (!t) return;
  const d = t.day;
  const actions = h('div', { class: 'punch-actions' }, t.allowed.map((kind) =>
    h('button', { class: `btn btn-primary punch-btn ${kind.startsWith('OT') ? 'ot' : ''}`, onclick: () => punchFlow(kind, t) }, PUNCH_LABEL[kind])),
    t.can_visit && t.on_duty ? h('button', { class: 'btn punch-btn visit', onclick: () => visitFlow(t) }, '📍 Field visit selfie (bank, client, office…)') : '');

  const facts = h('dl', { class: 'kv' },
    h('dt', {}, 'Shift'), h('dd', {}, `${t.shift.start} – ${t.shift.end}`),
    h('dt', {}, 'Status'), h('dd', {}, statusBadge(d.status) || '—', d.late_minutes ? [' ', badge(lateText(d, S.me.late_warnings), lateKind(d))] : ''),
    h('dt', {}, 'In / Out'), h('dd', {}, `${d.first_in || '—'} / ${d.last_out || '—'}`),
    h('dt', {}, 'Worked'), h('dd', {}, fmtMinutes(d.worked_minutes)),
    d.ot_minutes || d.ot_start ? [h('dt', {}, 'Overtime'), h('dd', {}, `${fmtMinutes(d.ot_minutes)} `, d.ot_status ? badge(d.ot_status, d.ot_status === 'approved' ? 'ok' : d.ot_status === 'rejected' ? 'bad' : 'warn') : '')] : '');

  const visitKind = { pending: ['Waiting for review', 'warn'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'bad'] };
  const visitItems = (t.visits || []).map((v) => ({ at: v.at, el: h('li', {},
    h('img', { src: `${EMP}/visits/${v.id}/selfie`, alt: 'Field visit selfie', loading: 'lazy' }),
    h('div', { style: { flex: 1 } },
      h('div', {}, h('span', { class: 't' }, fmtTime(v.at)), ' 📍 ', v.note),
      v.place ? h('div', { class: 'small muted' }, v.place) : '',
      h('div', { class: 'small muted' }, mapLink(v.lat, v.lng, 'Map'), ' · ', badge(...visitKind[v.status])))) }));
  const punchItems = t.punches.map((p) => ({ at: p.at, el: h('li', {},
      h('img', { src: `${EMP}/punches/${p.id}/selfie`, alt: 'Selfie', loading: 'lazy' }),
      h('div', { style: { flex: 1 } },
        h('div', {}, h('span', { class: 't' }, fmtTime(p.at)), ' ', PUNCH_LABEL[p.kind]),
        p.note ? h('div', { class: 'small' }, '📍 ', p.note, p.place ? h('span', { class: 'muted' }, ` · ${p.place}`) : '') : '',
        h('div', { class: 'small muted' },
          p.inside_geofence ? `At ${p.branch_name || 'branch'}` : p.distance_m !== null ? `${fmtDistance(p.distance_m)} from ${p.branch_name || 'branch'}` : '',
          p.status === 'flagged' ? [' · ', badge('Under review', 'warn')] : p.status === 'rejected' ? [' · ', badge('Rejected', 'bad')] : ''))) }));
  const items = [...punchItems, ...visitItems].sort((a, b) => a.at - b.at);
  const timeline = items.length
    ? h('ul', { class: 'timeline' }, items.map((x) => x.el))
    : h('div', { class: 'empty' }, 'No punches yet today.');

  main.replaceChildren(
    h('div', { class: 'card' },
      h('div', { class: 'spread' }, h('div', {}, h('div', { class: 'muted' }, fmtDate(t.work_date)), clock)),
      actions),
    h('div', { class: 'card' }, h('h2', {}, t.work_date === todayIST() ? 'Today' : `Shift of ${fmtDate(t.work_date)}`), facts),
    h('div', { class: 'card' }, h('h2', {}, 'Punches'), timeline));
}

function visitFlow(today) {
  formDialog({
    title: '📍 Field visit selfie',
    fields: [{ name: 'note', label: 'Where are you?', required: true, placeholder: 'e.g. HDFC Bank, Banjara Hills / GST office / client name' }],
    submitLabel: 'Open camera',
    async onSubmit(v) {
      setTimeout(() => punchFlow('VISIT', today, v.note), 0);
      return true;
    },
  });
}

function punchFlow(kind, today, note = '') {
  if (PREVIEW_ID) {
    toast(`Preview: ${S.me.employee.name} would now take a selfie and confirm "${PUNCH_LABEL[kind]}" on their phone.`);
    return;
  }
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
  // Punching from a bank, GST office, client office…: show the detected address and ask where they are.
  const placeLine = h('div', { class: 'small' }, '📍 Finding the address…');
  const offsiteNote = h('input', { type: 'text', maxlength: 200, placeholder: 'e.g. HDFC Bank Ameerpet – depositing cheques', 'aria-label': 'Where are you punching from?' });
  const offsite = h('div', { class: 'camera-offsite hidden' },
    h('strong', {}, 'You are not at your branch. Where are you punching from?'), placeLine, offsiteNote,
    h('div', { class: 'small' }, 'Your selfie, exact location and this note go to the admin for approval.'));
  const overlay = h('div', { class: 'camera' },
    h('div', { class: 'camera-view' }, video, preview,
      h('div', { class: 'camera-top' }, h('strong', {}, PUNCH_LABEL[kind]), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, '✕')),
      geo, offsite),
    h('div', { class: 'camera-bar' }, shutter, retake, confirm));
  document.body.append(overlay);

  function close() {
    if (done) return;
    done = true;
    if (stream) stream.getTracks().forEach((tr) => tr.stop());
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    overlay.remove();
  }

  /** Inside one of their own sites if possible, else the closest company site of any kind. */
  function nearestBranch(lat, lng) {
    const all = today.branches.map((b) => ({ b, dist: distanceM(lat, lng, b.lat, b.lng) })).sort((x, y) => x.dist - y.dist);
    const at = all.find((m) => m.b.mine !== false && m.dist <= m.b.radius_m);
    return at ? { ...at, inside: true } : all[0] ? { ...all[0], inside: false } : null;
  }

  const maxAcc = today.max_accuracy_m || 100;
  const home = today.branches.find((b) => b.id === today.home_branch_id);
  const opened = Date.now();
  // Phones often report a rough network location first and a precise GPS fix a few seconds later.
  // Wait for a good fix (or 25 seconds) so the punch isn't measured from a wrong spot.
  const gpsReady = () => position && (position.coords.accuracy <= maxAcc || Date.now() - opened > 25000);

  function updateGeo() {
    if (!position) return;
    const { latitude, longitude, accuracy } = position.coords;
    const n = nearestBranch(latitude, longitude);
    const rough = accuracy > maxAcc;
    geo.className = `camera-geo ${rough ? 'wait' : n?.inside ? 'ok' : 'bad'}`;
    geo.replaceChildren(
      rough
        ? h('div', {}, h('strong', {}, '⏳ Finding your exact location…'), h('div', { class: 'small' }, 'Stay still for a few seconds, ideally near a window or outdoors.'))
        : h('div', {}, h('strong', {}, n?.inside ? `✓ At ${n.b.name}` : n ? `${fmtDistance(n.dist)} from ${n.b.name}` : 'No branch set up'),
          n && !n.inside ? h('span', {}, n.b.mine === false ? ' — not one of your locations' : ' — outside branch area') : ''),
      !rough && n && !n.inside && n.b.id !== today.home_branch_id && home
        ? h('div', { class: 'small' }, `Your branch ${home.name}: ${fmtDistance(distanceM(latitude, longitude, home.lat, home.lng))}`) : '',
      h('div', { class: 'small' }, `GPS accuracy ±${Math.round(accuracy)} m`));
    updateOffsite(n, rough);
    if (captured) confirm.disabled = !gpsReady();
  }

  let lookedUpAt = null;
  const needsNote = () => !offsite.classList.contains('hidden');
  function updateOffsite(n, rough) {
    const show = kind !== 'VISIT' && !rough && n && !n.inside;
    offsite.classList.toggle('hidden', !show);
    if (!show) return;
    if (!today.offsite_allowed) {
      offsite.replaceChildren(h('strong', {}, 'You are not at your site.'), h('div', { class: 'small' }, 'Punching from other places is not allowed for you. Go to your site, or ask the admin.'));
      return;
    }
    const { latitude, longitude } = position.coords;
    // Look the address up once, and again only if they move more than 100 m.
    if (lookedUpAt && distanceM(latitude, longitude, lookedUpAt.lat, lookedUpAt.lng) < 100) return;
    lookedUpAt = { lat: latitude, lng: longitude };
    api('GET', `${EMP}/place?lat=${latitude}&lng=${longitude}`)
      .then((r) => { placeLine.textContent = r.place ? `📍 ${r.place}` : `📍 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`; })
      .catch(() => { placeLine.textContent = `📍 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`; });
  }
  const readyTimer = setInterval(() => { if (done) clearInterval(readyTimer); else updateGeo(); }, 1000);

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
      `${S.me.employee.name} (${S.me.employee.code}) · ${PUNCH_LABEL[kind]}${note ? ` · ${note}` : ''}`,
      new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    ];
    if (position) {
      const n = nearestBranch(position.coords.latitude, position.coords.longitude);
      lines.push(`${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)} ±${Math.round(position.coords.accuracy)}m`);
      if (n) lines.push(n.inside ? `At ${n.b.name}` : `${fmtDistance(n.dist)} from ${n.b.name}`);
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
    confirm.disabled = !gpsReady();
    if (!gpsReady()) toast('Waiting for an accurate location before you can confirm…');
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
    if (!captured || !gpsReady()) return;
    const body = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy, selfie: captured };
    if (kind === 'VISIT') {
      const done = await run(() => api('POST', `${EMP}/visit`, { ...body, note }), confirm);
      if (!done) return;
      close();
      toast(`Field visit saved at ${fmtTime(done.at)}. The admin will review it.`);
      renderShell();
      return;
    }
    const where = needsNote() ? offsiteNote.value.trim() : '';
    if (needsNote() && today.offsite_allowed && where.length < 3) {
      toast('Write where you are punching from (bank, GST office, client name…)', 'error');
      offsiteNote.focus();
      return;
    }
    const res = await run(() => api('POST', `${EMP}/punch`, { kind, ...body, note: where }), confirm);
    if (!res) return;
    close();
    if (res.status === 'flagged') toast(`${PUNCH_LABEL[kind]} saved at ${fmtTime(res.at)}, but flagged for review: ${res.flag_reason}`, 'error');
    else toast(`${PUNCH_LABEL[kind]} done at ${fmtTime(res.at)}`);
    if (res.late) {
      toast(res.late.review
        ? `You are ${fmtMinutes(res.late.minutes)} late. More than ${S.me.late_max_minutes} minutes late counts as a half day; the admin may review it later.`
        : res.late.half_day
          ? `You are late by ${fmtMinutes(res.late.minutes)}. This is late #${res.late.mark} this month — every ${res.late.every}rd late counts as a half day, so today is a half day.`
          : `You are late by ${fmtMinutes(res.late.minutes)}. This is late #${res.late.mark} this month — every ${res.late.every}rd late counts as a half day.`, 'error');
    }
    renderShell();
  });
}

// ---------------------------------------------------------------- attendance

async function renderAttendance(main) {
  main.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  const data = await run(() => api('GET', `${EMP}/attendance?month=${S.month}`));
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
      stat(s.paid_leave + s.unpaid_leave, 'Leave'), stat(s.late_days, `Late (over ${S.me.grace_minutes ?? 15} min)`),
      stat(s.late_hour_days, `Late over ${(S.me.late_max_minutes ?? 60) / 60} hour`),
      stat(s.late_minutes ? fmtMinutes(s.late_minutes) : '0', 'Total late time'),
      stat((s.ot_payable_minutes / 60).toFixed(1), 'OT hours (approved)'),
      S.me.late_offsets_ot ? stat(fmtMinutes(Math.max(0, s.ot_payable_minutes - s.late_minutes)), 'OT paid (after late)') : ''),
    S.me.late_offsets_ot && (s.late_minutes || s.ot_payable_minutes)
      ? h('p', { class: 'small muted' }, `Your total late time this month (${fmtMinutes(s.late_minutes)}) is taken off your approved overtime (${fmtMinutes(s.ot_payable_minutes)}) before it is paid.`) : '',
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
  const list = await run(() => api('GET', `${EMP}/leaves`));
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
          onclick: async (e) => { if (await run(() => api('POST', `${EMP}/leaves/${l.id}/cancel`), e.target)) renderShell(); },
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
      await api('POST', `${EMP}/leaves`, v);
      toast('Leave request sent');
      renderShell();
      return true;
    },
  });
}

// ---------------------------------------------------------------- more: documents, payslips, PIN

async function renderMore(main) {
  const docs = await run(() => api('GET', `${EMP}/documents`));
  if (!docs) return;
  const e = S.me.employee;
  const docKind = { pending: 'warn', verified: 'ok', rejected: 'bad' };
  main.replaceChildren(
    h('div', { class: 'card' }, h('h2', {}, 'My details'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Employee ID'), h('dd', {}, e.code),
        h('dt', {}, 'Designation'), h('dd', {}, e.designation || '—'),
        h('dt', {}, 'Branch'), h('dd', {}, S.me.branch?.name || '—'),
        h('dt', {}, 'Shift'), h('dd', {}, `${e.shift_start} – ${e.shift_end}`),
        h('dt', {}, 'Joined'), h('dd', {}, e.joined_on ? fmtDate(e.joined_on) : '—'))),
    paymentCard(e),
    h('div', { class: 'card' },
      h('div', { class: 'spread' }, h('h2', {}, 'My documents'), h('button', { class: 'btn btn-primary btn-sm', onclick: uploadDocument }, '+ Upload')),
      h('p', { class: 'small muted' }, 'Upload Aadhaar, PAN and other KYC documents. Files are encrypted and only visible to your employer’s admins.'),
      docs.length
        ? h('ul', { class: 'timeline' }, docs.map((d) => h('li', {},
          h('div', { style: { flex: 1 } },
            h('div', {}, h('strong', {}, DOC_LABEL[d.doc_type]), d.label ? ` · ${d.label}` : ''),
            h('div', { class: 'small muted' }, d.doc_number || '', d.review_note ? ` · ${d.review_note}` : '')),
          badge(d.status, docKind[d.status]),
          h('button', { class: 'btn btn-sm', onclick: () => openDocument(`${EMP}/documents/${d.id}/file`, d.mime, DOC_LABEL[d.doc_type]) }, 'View'))))
        : h('div', { class: 'empty' }, 'No documents uploaded yet.')),
    installCard(),
    h('div', { class: 'card row' },
      h('button', { class: 'btn', onclick: changePin }, 'Change PIN'),
      PREVIEW_ID ? '' : h('button', { class: 'btn', onclick: async () => { await run(() => api('POST', `${EMP}/logout`)); showLogin(); } }, 'Log out')));
}

// ---------------------------------------------------------------- team (managers)

async function renderTeam(main) {
  main.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  const t = await run(() => api('GET', `${EMP}/team`));
  if (!t) return;
  const verify = (body, label) => formDialog({
    title: label,
    fields: [{ name: 'note', label: 'Note for the admin (optional)', type: 'textarea', placeholder: 'e.g. He was at the site office, I saw him' }],
    submitLabel: 'Send',
    async onSubmit(v) {
      await api('POST', `${EMP}/team/verify`, { ...body, note: v.note });
      toast('Sent to the admin. Thank you!');
      renderTeam(main);
      return true;
    },
  });
  const actions = (body, v) => h('div', { class: 'row', style: { marginTop: '8px' } },
    v ? h('div', { class: `badge badge-${v.verdict === 'ok' ? 'ok' : 'bad'}`, style: { whiteSpace: 'normal', width: '100%' } },
      v.verdict === 'ok' ? `You marked: looks fine${v.note ? ` · ${v.note}` : ''}` : `You marked: doubtful${v.note ? ` · ${v.note}` : ''}`) : '',
    h('button', { class: 'btn btn-sm btn-ok', onclick: () => verify({ ...body, verdict: 'ok' }, 'Looks fine') }, '✓ Looks fine'),
    h('button', { class: 'btn btn-sm', onclick: () => verify({ ...body, verdict: 'doubt' }, 'Doubtful') }, '⚠ Doubtful'));
  const section = (title, items, render, empty) => h('div', { class: 'card' }, h('h2', {}, `${title} (${items.length})`),
    items.length ? h('ul', { class: 'timeline' }, items.map(render)) : h('p', { class: 'muted' }, empty));

  main.replaceChildren(
    h('div', { class: 'card' }, h('h1', {}, 'Team checks'),
      h('p', { class: 'small muted' }, `Things the app flagged for your team (${t.team_size} people, ${t.scope === 'all' ? 'all branches' : 'your branch'}). Tell the admin if each looks fine or doubtful — the admin makes the final decision. You can't change attendance from here.`)),
    section('Punches from outside the site / weak GPS', t.punches, (p) => h('li', { style: { alignItems: 'flex-start' } },
      h('img', { src: `${EMP}/team/punches/${p.id}/selfie`, alt: 'Selfie', loading: 'lazy', style: { width: '64px', height: '64px', borderRadius: '10px' } }),
      h('div', { style: { flex: 1 } },
        h('div', {}, h('strong', {}, p.name), ` · ${PUNCH_LABEL[p.kind]}`),
        h('div', { class: 'small muted' }, `${fmtDateTime(p.at)} · ${p.flag_reason || ''} · `, mapLink(p.lat, p.lng, 'Map')),
        actions({ kind: 'punch', punch_id: p.id }, p.verification))), 'Nothing flagged. 👍'),
    section('Very late arrivals', t.late, (x) => h('li', { style: { alignItems: 'flex-start' } },
      h('div', { style: { flex: 1 } },
        h('div', {}, h('strong', {}, x.name), ` · ${fmtDate(x.date)}`),
        h('div', { class: 'small muted' }, `Shift ${x.shift_start} · came ${x.first_in} (${fmtMinutes(x.late_minutes)} late) · left ${x.last_out || '—'}`),
        actions({ kind: 'late', employee_id: x.employee_id, date: x.date }, x.verification))), 'No very late arrivals waiting.'),
    section('Overtime waiting for approval', t.overtime, (x) => h('li', { style: { alignItems: 'flex-start' } },
      h('div', { style: { flex: 1 } },
        h('div', {}, h('strong', {}, x.name), ` · ${fmtDate(x.date)}`),
        h('div', { class: 'small muted' }, `${x.ot_start || '—'} – ${x.ot_end || '—'} · ${fmtMinutes(x.ot_minutes)}`),
        actions({ kind: 'overtime', employee_id: x.employee_id, date: x.date }, x.verification))), 'No overtime waiting.'));
}

// ---------------------------------------------------------------- salary (live + finalized)

async function renderSalary(main) {
  const picker = h('div', { class: 'spread', style: { marginBottom: '12px' } },
    monthPicker(S.salaryMonth, (m) => { S.salaryMonth = m; renderSalary(main); }));
  main.replaceChildren(picker, h('div', { class: 'empty' }, 'Loading…'));
  const [d, slips] = await Promise.all([
    api('GET', `${EMP}/salary?month=${S.salaryMonth}`).catch((err) => ({ error: err.message })),
    api('GET', `${EMP}/payslips`).catch(() => []),
  ]);
  const past = slips.length
    ? h('div', { class: 'card' }, h('h2', {}, 'Final payslips'),
      h('ul', { class: 'timeline' }, slips.map((p) => h('li', {},
        h('div', { style: { flex: 1 } }, h('strong', {}, fmtMonth(p.month)), h('div', { class: 'small muted' }, `Net pay ${money(p.net_paise)}`)),
        h('button', { class: 'btn btn-sm', onclick: () => { S.salaryMonth = p.month; renderSalary(main); } }, 'View')))))
    : '';
  if (d.error) {
    main.replaceChildren(picker, h('div', { class: 'card' }, h('p', { class: 'muted' }, d.error)), past);
    return;
  }
  const r = d.row;
  const a = r.attendance;
  const line = (label, value, opts = {}) => h('div', { class: `pay-line${opts.total ? ' total' : ''}` },
    h('div', {}, label, opts.note ? h('div', { class: 'small muted' }, opts.note) : ''), h('div', { class: 'num' }, value));
  const sum = (xs) => xs.reduce((t, x) => t + x.amount_paise, 0);
  const rateNote = `${money(r.salary_paise)}/month ÷ ${r.days_in_month} days = ${money(r.per_day_paise)}/day × ${r.paid_days} paid days`;
  const status = d.status === 'final'
    ? badge('Final payslip', 'ok')
    : d.status === 'live' ? badge(`Live · updated ${fmtTime(d.as_of)}`, 'info') : badge('Not finalized yet', 'warn');
  const deductions = [...r.deductions, ...r.advances.map((x) => ({ label: `Advance (${fmtDate(x.given_on)})${x.note ? ` · ${x.note}` : ''}`, amount_paise: x.amount_paise }))];

  main.replaceChildren(
    picker,
    h('div', { class: 'card' },
      h('div', { class: 'spread' }, h('div', { class: 'muted' }, d.status === 'final' ? 'Net pay' : 'Net pay so far'), status),
      h('div', { class: 'clock' }, money(r.net_paise)),
      d.status === 'live'
        ? h('p', { class: 'small muted' }, `Calculated from your attendance up to today (${fmtDate(d.counted_until)}). Today counts once you punch out, and overtime counts once approved. It updates every time you open this page.`,
          r.total_deductions_paise ? ' Monthly deductions (PF, ESIC, PT, advances) are taken in full, so early in the month this figure is low or even negative — it grows with every day you work.' : '')
        : d.status === 'pending' ? h('p', { class: 'small muted' }, 'Your employer has not finalized this month yet, so these figures can still change.') : '',
      h('button', { class: 'btn btn-block', style: { marginTop: '8px' }, onclick: () => openPayslip(d.company_name, d.month, r, { provisional: d.status !== 'final', asOf: d.as_of }) },
        d.status === 'final' ? 'Download / print payslip' : 'Download / print statement')),
    h('div', { class: 'card' }, h('h2', {}, 'Attendance'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Days in month'), h('dd', {}, String(r.days_in_month)),
        h('dt', {}, 'Paid days'), h('dd', {}, String(r.paid_days)),
        h('dt', {}, 'Present'), h('dd', {}, String(a.present)),
        h('dt', {}, 'Half days'), h('dd', {}, String(a.half_day), a.late_penalties ? h('span', { class: 'muted' }, ` (${a.late_penalties} from late marks)`) : ''),
        h('dt', {}, 'Absent'), h('dd', {}, String(a.absent + a.not_marked)),
        h('dt', {}, 'Paid / unpaid leave'), h('dd', {}, `${a.paid_leave} / ${a.unpaid_leave}`),
        h('dt', {}, 'Week offs / holidays'), h('dd', {}, `${a.week_off} / ${a.holiday}`),
        h('dt', {}, 'Late marks'), h('dd', {}, `${a.late_days}`, h('span', { class: 'muted' }, ` (every ${S.me.late_warnings + 1}rd late is a half day)`)),
        a.late_pending ? [h('dt', {}, 'Very late, awaiting decision'), h('dd', {}, `${a.late_pending} day(s) — counted provisionally`)] : '',
        h('dt', {}, 'Total late time'), h('dd', {}, r.late_minutes ? fmtMinutes(r.late_minutes) : '—'),
        h('dt', {}, 'Overtime approved'), h('dd', {}, fmtMinutes(r.ot_approved_minutes ?? Math.round(r.ot_hours * 60))),
        r.late_offset_minutes ? [h('dt', {}, 'Overtime paid'), h('dd', {}, `${fmtMinutes(r.ot_approved_minutes)} − ${fmtMinutes(r.late_offset_minutes)} late = ${fmtMinutes(r.ot_paid_minutes)}`)] : '',
        a.ot_pending_minutes ? [h('dt', {}, 'Overtime awaiting approval'), h('dd', {}, `${fmtMinutes(a.ot_pending_minutes)} (not included yet)`)] : '')),
    h('div', { class: 'card' }, h('h2', {}, 'Earnings'),
      line('Basic pay', money(r.base_paise), { note: rateNote }),
      line('Overtime', money(r.ot_paise), { note: r.late_offset_minutes ? `${fmtMinutes(r.ot_approved_minutes)} − ${fmtMinutes(r.late_offset_minutes)} late = ${fmtMinutes(r.ot_paid_minutes)} × ${money(r.hourly_rate_paise)}/hour` : `${r.ot_hours} h × ${money(r.hourly_rate_paise)}/hour` }),
      r.additions.map((x) => line(x.label, money(x.amount_paise))),
      line('Gross earnings', money(r.gross_paise), { total: true })),
    h('div', { class: 'card' }, h('h2', {}, 'Deductions'),
      deductions.length ? deductions.map((x) => line(x.label, `− ${money(x.amount_paise)}`)) : h('p', { class: 'muted' }, 'No deductions.'),
      line('Total deductions', `− ${money(r.total_deductions_paise)}`, { total: true })),
    h('div', { class: 'card' }, line('Net pay', money(r.net_paise), { total: true })),
    past);
}

/** Phone + where salary should be paid, with a checklist of what is still missing. */
function paymentCard(e) {
  const missing = S.me.profile_missing || [];
  return h('div', { class: 'card' },
    h('div', { class: 'spread' }, h('h2', {}, 'Payment & contact details'),
      h('button', { class: `btn btn-sm${missing.includes('phone') || missing.includes('payment') ? ' btn-primary' : ''}`, onclick: () => editPayment(e) }, 'Edit')),
    missing.length
      ? h('ul', { class: 'checklist' }, Object.keys(MISSING_LABEL).map((k) => h('li', { class: missing.includes(k) ? 'todo' : 'done' }, missing.includes(k) ? '◻ ' : '✅ ', MISSING_LABEL[k])))
      : h('p', { class: 'small ok-text' }, '✅ All details received. Thank you!'),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Mobile'), h('dd', {}, e.phone || '—'),
      h('dt', {}, 'UPI ID'), h('dd', {}, e.upi_id || '—'),
      h('dt', {}, 'Bank account'), h('dd', {}, e.bank_account ? `${e.bank_account} · ${e.bank_ifsc}` : '—')),
    missing.includes('aadhaar') || missing.includes('pan')
      ? h('p', { class: 'small muted' }, 'Upload Aadhaar and PAN under “My documents” below.') : '');
}

function editPayment(e) {
  formDialog({
    title: 'Payment & contact details',
    fields: [
      { name: 'phone', label: 'Mobile number', type: 'tel', inputmode: 'numeric', value: e.phone, required: true, maxlength: 20, placeholder: '98xxxxxxxx' },
      { type: 'heading', label: 'Where should we pay your salary? (UPI or bank — either is fine)' },
      { name: 'upi_id', label: 'UPI ID', value: e.upi_id, placeholder: 'e.g. 98xxxxxxxx@ybl', hint: 'Find it in PhonePe / GPay / Paytm under your profile.' },
      { name: 'bank_account', label: 'Bank account number', inputmode: 'numeric', value: e.bank_account, maxlength: 20 },
      { name: 'bank_ifsc', label: 'IFSC code', value: e.bank_ifsc, placeholder: 'e.g. SBIN0001234', maxlength: 11, hint: 'Printed on your passbook or cheque book.' },
    ],
    async onSubmit(v) {
      if (!v.upi_id.trim() && !v.bank_account.trim()) throw new Error('Enter a UPI ID or bank account so we can pay you');
      await api('POST', `${EMP}/profile`, v);
      await refreshMe();
      toast('Details saved');
      renderShell();
      return true;
    },
  });
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
      await api('POST', `${EMP}/documents`, { doc_type: v.doc_type, doc_number: v.doc_number, label: v.label, file });
      toast('Document uploaded');
      await refreshMe();
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
      await api('POST', `${EMP}/pin`, { current_pin: v.current_pin, new_pin: v.new_pin });
      toast('PIN changed');
      return true;
    },
  });
}

boot();
