#!/usr/bin/env bash
# One-time setup of the attendance app on a fresh Ubuntu 22.04 / 24.04 server
# (tested target: Oracle Cloud Always Free). Safe to run again to repair a setup.
#
# Usage (on the server):
#   curl -fsSL https://raw.githubusercontent.com/sanitech-ai/attendance/main/scripts/setup-server.sh | sudo bash -s app.sanitech.in
#
# It installs Node.js 22 and Caddy (automatic HTTPS), opens ports 80/443, runs the app as a
# service that restarts on reboot, generates the encryption key, and sets up nightly backups.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/sanitech-ai/attendance.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/attendance
DATA_DIR=/var/lib/attendance
BACKUP_DIR=/var/backups/attendance
ENV_FILE=/etc/attendance.env

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run this with sudo."
[ -n "$DOMAIN" ] || die "Give the domain, e.g.: ... | sudo bash -s app.sanitech.in"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "This script expects Ubuntu (found: ${PRETTY_NAME:-unknown})."
export DEBIAN_FRONTEND=noninteractive

say "Installing system packages"
apt-get update -y
apt-get install -y curl git sqlite3 gnupg ca-certificates debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

# Small free servers have 1 GB RAM; a swap file keeps installs from running out of memory.
if [ "$(swapon --show | wc -l)" = 0 ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ]; then
  say "Adding 1 GB swap"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js 22.13 or newer is required (found $(node --version))."

if ! command -v caddy >/dev/null; then
  say "Installing Caddy (web server with automatic HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

say "Opening ports 80 and 443 in the server firewall"
# Oracle's Ubuntu images ship iptables rules that reject everything except SSH.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    reject_line=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
    if [ -n "$reject_line" ]; then
      iptables -I INPUT "$reject_line" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    else
      iptables -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
  fi
done
netfilter-persistent save >/dev/null
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp && ufw allow 443/tcp
fi

say "Downloading the app ($BRANCH)"
id attendance >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin attendance
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown attendance:attendance "$DATA_DIR"
chmod 700 "$DATA_DIR" "$BACKUP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  say "Generating the encryption key"
  umask 077
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATA_DIR=$DATA_DIR
APP_SECRET=$(openssl rand -hex 32)
EOF
fi
chmod 600 "$ENV_FILE"

say "Creating the app service"
cat > /etc/systemd/system/attendance.service <<EOF
[Unit]
Description=Attendance app
After=network.target

[Service]
User=attendance
Group=attendance
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable attendance >/dev/null
systemctl restart attendance

say "Configuring HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl enable caddy >/dev/null
systemctl restart caddy

say "Setting up nightly backups (kept for 14 days in $BACKUP_DIR)"
cat > /usr/local/bin/attendance-backup <<EOF
#!/usr/bin/env bash
set -euo pipefail
stamp=\$(date +%F)
tmp=\$(mktemp -d)
sqlite3 $DATA_DIR/attendance.db ".backup '\$tmp/attendance.db'"
tar czf $BACKUP_DIR/attendance-\$stamp.tar.gz -C "\$tmp" attendance.db -C $DATA_DIR files
rm -rf "\$tmp"
find $BACKUP_DIR -name 'attendance-*.tar.gz' -mtime +14 -delete
EOF
chmod 700 /usr/local/bin/attendance-backup
# 20:30 UTC = 02:00 IST
echo "30 20 * * * root /usr/local/bin/attendance-backup" > /etc/cron.d/attendance-backup

cat > /usr/local/bin/attendance-update <<EOF
#!/usr/bin/env bash
# Pulls the latest code and restarts the app. Run: sudo attendance-update
set -euo pipefail
/usr/local/bin/attendance-backup
git -C $APP_DIR fetch --depth 1 origin $BRANCH
git -C $APP_DIR reset --hard FETCH_HEAD
(cd $APP_DIR && npm ci --omit=dev --no-audit --no-fund)
systemctl restart attendance
echo "Updated and restarted."
EOF
chmod 700 /usr/local/bin/attendance-update

say "Checking the app"
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3000/api/admin/setup-status >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:3000/api/admin/setup-status >/dev/null || die "The app did not start. See: sudo journalctl -u attendance -n 50"

MY_IP=$(curl -fsS -4 https://api.ipify.org 2>/dev/null || echo unknown)
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
SECRET=$(grep '^APP_SECRET=' "$ENV_FILE" | cut -d= -f2)

printf '\n\033[1;32mAll done!\033[0m\n\n'
if [ "$MY_IP" != "$DNS_IP" ]; then
  printf '\033[1;33mNote:\033[0m %s points to %s, but this server is %s.\n' "$DOMAIN" "${DNS_IP:-nothing yet}" "$MY_IP"
  printf 'Fix the A record in GoDaddy. HTTPS starts working automatically once it points here.\n\n'
fi
cat <<EOF
  Admin (create your account):  https://$DOMAIN/admin
  Staff app:                    https://$DOMAIN/

  IMPORTANT - save this encryption key somewhere safe (e.g. a password manager).
  Without it, selfies and documents cannot be recovered from a backup:

      $SECRET

  Backups:   $BACKUP_DIR (nightly, 14 days)
  Update:    sudo attendance-update
  Logs:      sudo journalctl -u attendance -f
EOF
