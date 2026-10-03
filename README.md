# Attendance

Selfie + GPS attendance, overtime, KYC documents and payroll for a multi-branch company (50–100 staff).
Similar in spirit to PagarBook, self-hosted, with no per-employee fees.

- **Staff app** (`/`): phone-friendly web app. Staff log in with **Employee ID + PIN**, then
  **Punch In / Punch Out / Start Overtime / End Overtime**. Each punch needs a live selfie from the front camera
  (no gallery uploads) and the phone's GPS location. The selfie is stamped with name, time and coordinates.
  Staff can also see their attendance calendar, request leave, upload Aadhaar/PAN/other documents and view payslips.
- **Admin dashboard** (`/admin`): today's attendance per branch, selfie review, flagged punches, attendance
  register with manual corrections, overtime approval, leave approval, employees, branches (geofences),
  holidays, documents, payroll with advances/bonuses/deductions, payslips and Excel (CSV) exports, audit log.

## How it works

| Topic | Behaviour |
|---|---|
| Time | Server time in IST is used for every punch, so changing the phone clock does nothing. |
| Branches / geofence | Each branch has a GPS point and radius. Staff may punch at **any** active branch. Outside every radius, the punch is **flagged** for review or **blocked**, depending on the employee's home-branch setting. Poor GPS accuracy (default > 100 m) is also flagged. |
| Regular attendance | IN → OUT pairs (several per day allowed). Default shift 9:00 AM – 6:00 PM. Late if the first IN is more than 15 minutes after shift start. **Late marks:** the 1st and 2nd late days in a calendar month are warnings (shown to the employee at punch-in); the 3rd and every later late day that month counts as a half day. Someone up to 60 minutes late who stays until shift end is otherwise a full day; arriving later than that falls under the hours rule. Days an admin corrects are not counted. Full day = the employee's shift length minus the grace period (9–6 → 8 h 45 m worked, so arriving at 9:15 and leaving at 6 PM is still a full day); half day ≥ 4 h; less = absent. Grace and half-day hours are editable in Settings; shift times are set per employee. A missing punch-out counts as a half day until an admin corrects it. Overnight shifts are supported: an OUT after midnight belongs to the day the shift started. |
| Overtime | Separate **Start Overtime / End Overtime** punches, each with selfie + GPS. OT is paid at the **same hourly rate** as regular work, and only after admin approval (can be turned off in Settings). Admins can approve part of the recorded OT. |
| Salary | **Monthly**: salary ÷ days in month × paid days (present + ½ half days + paid leave + week offs + holidays). **Daily**: rate × (present + ½ half days + paid leave). **Hourly**: rate × hours worked. Hourly rate for OT = per-day ÷ shift hours. Net = base + OT + additions − deductions − advances. |
| Fixed monthly items | Per-employee PF, ESIC, Professional Tax, TDS (deductions) and conveyance/room rent (earnings) are applied in full every month that has at least one paid day. One-off bonuses/fines go under Payroll → Bonus & deductions. |
| Branch location | Paste a Google Maps link (short `maps.app.goo.gl` links work too) and the latitude/longitude are read from it automatically, or use the phone's current location. |
| Bulk import | Employees → Import from CSV: validates every row first (nothing is written if any row has a problem), creates missing branches, sets fixed pay items and generates PINs, shown once for download. An optional `branch_maps_link` column gives each new branch its location straight from a Google Maps link. Branches without one have no GPS location until you paste a link (Branches → Set location); punches there are flagged meanwhile. |
| Payroll lock | Finalizing a past month stores a snapshot, locks that month's attendance edits and publishes payslips to staff. It can be reopened. |
| Documents | Aadhaar is stored **masked** (only the last 4 digits). Files are checked for type (JPG/PNG/PDF), **encrypted at rest** (AES-256-GCM) and only served to admins and the owning employee. Every admin view is written to the audit log. |
| Security | PINs and passwords are hashed with scrypt. 5 wrong attempts lock the account for 15 minutes. Session cookies are HttpOnly + SameSite=Strict (+ Secure in production). |

## Run locally

Requires **Node.js 22.13+** (uses the built-in SQLite, so there's no database server to install).

```bash
npm install
npm start            # http://localhost:3000  (admin: http://localhost:3000/admin)
npm test
```

On first visit to `/admin` you create the owner account. Then add branches (stand inside the branch and click
"Use my current location"), then add employees with a PIN, and share the staff link with them.

> Phones only allow camera and GPS on **https://** sites (or `localhost`). For real use, deploy behind HTTPS.

## Deploy

You need one small server with a **persistent disk** and **HTTPS**. For 100 staff, the smallest plan of any VPS
provider (1 vCPU / 1 GB RAM) is plenty.

**Quickest: one-command setup on a fresh Ubuntu server** (Oracle Cloud Always Free, AWS Lightsail, DigitalOcean…)

Point the domain's DNS `A` record at the server, open ports 80/443 in the provider's firewall, then on the server:

```bash
curl -fsSL https://raw.githubusercontent.com/sanitech-ai/attendance/main/scripts/setup-server.sh | sudo bash -s app.sanitech.in
```

It installs Node.js and Caddy (automatic HTTPS), opens the server firewall, runs the app as a service, generates
`APP_SECRET` in `/etc/attendance.env`, and sets up nightly backups to `/var/backups/attendance` (14 days).
Later updates: `sudo attendance-update`. To deploy a branch other than `main`, add `BRANCH=<name>` after `sudo`.

**Option A (manual): VPS with Caddy for automatic HTTPS**

```bash
# on the server (Ubuntu), after installing Node 22 and Caddy
git clone <this repo> /opt/attendance && cd /opt/attendance && npm ci --omit=dev
sudo mkdir -p /var/lib/attendance
# create /opt/attendance/.env from .env.example and fill APP_SECRET
# run it with systemd (EnvironmentFile=/opt/attendance/.env, ExecStart=/usr/bin/npm start)
# /etc/caddy/Caddyfile:
#   app.sanitech.in {
#     reverse_proxy localhost:3000
#   }
```

**Option B: Docker**

```bash
docker build -t attendance .
docker run -d --restart=always -p 3000:3000 -v attendance-data:/data -e APP_SECRET=... attendance
```

Then point a domain at it and put HTTPS in front (Caddy, Nginx + Let's Encrypt, or your platform's built-in TLS).
Platforms such as Render or Railway also work if you attach a persistent volume and set `DATA_DIR` to it.

### Domain: app.sanitech.in

Keep the main website on `sanitech.in` as it is and run the app on the sub-domain **app.sanitech.in**.
In the DNS settings wherever `sanitech.in` is registered (GoDaddy, Hostinger, Cloudflare, etc.), add:

| Type | Name | Value |
|---|---|---|
| A | `app` | the public IP address of your server |

Caddy (Option A) then gets the HTTPS certificate automatically. Staff use `https://app.sanitech.in`
and admins `https://app.sanitech.in/admin`. You can also add a "Staff login" link on sanitech.in pointing there.

### Backups

Everything lives in `DATA_DIR`: `attendance.db` (plus `-wal`/`-shm` files) and `files/` (encrypted selfies and
documents). Back up that folder daily, and store `APP_SECRET` separately: without it the files cannot be decrypted.

### Forgot the admin password?

```bash
npm run reset-admin -- owner 'new-password-here'
```

## Not included (yet)

- **Paying salaries to UPI / bank automatically**: needs a payout provider account (RazorpayX, Cashfree Payouts,
  or your bank's bulk-payment API) with business KYC. The payroll CSV can be used for bank bulk uploads meanwhile.
- **Verifying Aadhaar/PAN with UIDAI/NSDL**: needs a licensed verification provider (paid per check). Admins verify
  documents manually today.
- **Face matching** (proving the selfie is the same person every time): admins review selfies by eye.
- **Fake-GPS detection**: a browser can't detect mock-location apps; the geofence, accuracy check and selfie make
  cheating harder but not impossible. A native Android wrapper could add this later.
- PF / ESI / TDS / professional tax calculations and filings.

## Project layout

```
server/
  index.js        entry point (env config)
  app.js          Express app, sessions, encrypted file storage, error handling
  db.js           SQLite schema and settings
  attendance.js   day-by-day attendance rules
  payroll.js      salary calculation
  common.js       shared helpers (punch state, documents)
  routes/         employee.js (staff API), admin.js (admin API)
public/           staff app (index.html, staff.js), admin (admin.html, admin.js), shared common.js + styles.css
scripts/          reset-admin-password.js
test/             node:test API + calculation tests
```
