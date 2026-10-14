#!/usr/bin/env bash
# One-shot setup: the radio at https://yourdomain.com/radio on a Debian/Ubuntu server running Apache.
#
#   sudo git clone https://github.com/epicgamer133/4adio.git /opt/radio-station
#   sudo bash /opt/radio-station/deploy/setup-subpath.sh yourdomain.com
#
# Safe for the site already running on that domain:
# - The website's files are never touched. The radio lives in /opt/radio-station.
# - The only Apache change is ONE "Include" line in the domain's virtual host, after a backup.
# - If the Apache config test fails, or the homepage answers differently afterwards, the backup is restored.
# - Re-running it is fine (it updates the radio and skips what's already done).
#
# Undo the Apache part:  sudo bash /opt/radio-station/deploy/setup-subpath.sh yourdomain.com --uninstall
set -euo pipefail

DOMAIN="$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')"
MODE="${2:-}"
APP=/opt/radio-station
REPO=https://github.com/epicgamer133/4adio.git
SNIPPET=/etc/apache2/radio-subpath.conf
INCLUDE="Include $SNIPPET"
PORT=8090

say()  { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mStopped: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
[ -n "$DOMAIN" ] || die "usage: sudo bash $0 yourdomain.com [--uninstall]"
command -v apache2ctl >/dev/null || die "Apache (apache2) not found on this server"

# --- find the domain's Apache config file(s) --------------------------------------
DOM_RE="${DOMAIN//./\\.}"
mapfile -t VHOSTS < <(grep -liE "^\s*Server(Name|Alias)\s(.*\s)?(www\.)?${DOM_RE}(\s|:|$)" /etc/apache2/sites-enabled/* 2>/dev/null | xargs -r -n1 readlink -f | sort -u)
ALL_BLOCKS=no
if [ "${#VHOSTS[@]}" -eq 0 ]; then
  # No site names the domain. On a one-site server the default site (000-default.conf) answers for it.
  mapfile -t ENABLED < <(ls /etc/apache2/sites-enabled/* 2>/dev/null | xargs -r -n1 readlink -f | sort -u)
  [ "${#ENABLED[@]}" -eq 1 ] || die "no enabled Apache site names $DOMAIN, and there are ${#ENABLED[@]} enabled sites, so I can't tell which one serves it. Nothing was changed."
  echo "No Apache site names $DOMAIN, but there is exactly one enabled site: ${ENABLED[0]}"
  echo "It answers for every domain pointed at this server, so /radio will work on all of them."
  if [ "$MODE" != "--uninstall" ]; then
    read -rp "Add the radio to that site? [y/N] " OK
    [[ "$OK" =~ ^[Yy] ]] || die "cancelled. Nothing was changed."
  fi
  VHOSTS=("${ENABLED[0]}")
  ALL_BLOCKS=yes
fi
HTTPS=no
grep -qlE "<VirtualHost[^>]*:443" "${VHOSTS[@]}" && HTTPS=yes

# Is the site behind Cloudflare? (Cloudflare then provides the HTTPS, and visitor IPs arrive via its proxies.)
PUBLIC_HEADERS=$(curl -sI --max-time 10 "https://$DOMAIN/" 2>/dev/null || true)
CLOUDFLARE=no
grep -qi '^server: *cloudflare' <<<"$PUBLIC_HEADERS" && CLOUDFLARE=yes
PUBLIC_HTTPS=$HTTPS
[ -n "$PUBLIC_HEADERS" ] && PUBLIC_HTTPS=yes

homepage() { curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$1://$DOMAIN/" --resolve "$DOMAIN:443:127.0.0.1" --resolve "$DOMAIN:80:127.0.0.1" || true; }
SCHEME=http; [ "$HTTPS" = yes ] && SCHEME=https
PUBLIC_SCHEME=http; [ "$PUBLIC_HTTPS" = yes ] && PUBLIC_SCHEME=https

BACKUP="/root/radio-apache-backup-$(date +%Y%m%d-%H%M%S)"
restore() {
  for f in "${VHOSTS[@]}"; do cp -a "$BACKUP/$(basename "$f")" "$f"; done
  apache2ctl configtest >/dev/null 2>&1 && systemctl reload apache2
}

if [ "$MODE" = "--uninstall" ]; then
  say "Removing the radio from $DOMAIN's Apache config"
  mkdir -p "$BACKUP"
  for f in "${VHOSTS[@]}"; do cp -a "$f" "$BACKUP/"; sed -i "\#^\s*${INCLUDE}\s*\$#d" "$f"; done
  apache2ctl configtest || { restore; die "config test failed, restored the backup"; }
  systemctl reload apache2
  systemctl disable --now radio-station 2>/dev/null || true
  echo "Done. /radio is gone from the site, the radio service is stopped. (Backup: $BACKUP)"
  echo "The app files are still in $APP; delete with: sudo rm -rf $APP"
  exit 0
fi

# --- 1. packages ---------------------------------------------------------------------
say "Installing ffmpeg, git, curl"
apt-get update -qq
apt-get install -y -qq ffmpeg git curl ca-certificates >/dev/null
NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  say "Installing Node.js 22 (found: $(node -v 2>/dev/null || echo none))"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN=$(command -v node)

# --- 2. the app ----------------------------------------------------------------------
if [ -d "$APP/.git" ]; then
  say "Updating $APP"
  git -c safe.directory="$APP" -C "$APP" pull --ff-only
else
  say "Downloading the radio to $APP"
  git clone "$REPO" "$APP"
fi
cd "$APP"
npm install --omit=dev --no-audit --no-fund --loglevel=error

# --- 3. settings (.env) --------------------------------------------------------------
setenv() { # setenv KEY VALUE: replace or append (value goes through the environment, so any character is safe)
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
    index($0, k "=") == 1 { print k "=" v; done = 1; next } { print }
    END { if (!done) print k "=" v }' .env > .env.tmp && cat .env.tmp > .env && rm -f .env.tmp
}
if [ ! -f .env ]; then
  cp .env.example .env
  say "Choose the admin password (for $DOMAIN/radio/admin)"
  while :; do
    read -rsp "Admin password (12+ characters): " PW; echo
    [ "${#PW}" -ge 12 ] || { echo "Too short."; continue; }
    read -rsp "Again: " PW2; echo
    [ "$PW" = "$PW2" ] && break || echo "Didn't match, try again."
  done
  setenv ADMIN_PASSWORD "$PW"
  unset PW PW2
fi
setenv BASE_PATH /radio
setenv HOST 127.0.0.1
setenv PORT "$PORT"
setenv SECURE_COOKIES "$([ "$PUBLIC_HTTPS" = yes ] && echo true || echo false)"
if [ "$CLOUDFLARE" = yes ]; then
  # Trust Cloudflare's proxies so each listener is counted by their own IP (stream and like limits),
  # not by the Cloudflare server they came through. Cloudflare's free plan also caps uploads at 100 MB.
  CF_IPS=$( { curl -fsS --max-time 10 https://www.cloudflare.com/ips-v4; echo; curl -fsS --max-time 10 https://www.cloudflare.com/ips-v6; } | grep -E '^[0-9a-fA-F:.]+/[0-9]+$' | paste -sd, - || true)
  [ -n "$CF_IPS" ] || die "couldn't download Cloudflare's IP list. Check the server's internet access and re-run."
  setenv TRUST_PROXY "loopback,$CF_IPS"
  setenv MAX_UPLOAD_MB 100
else
  setenv TRUST_PROXY loopback
fi

# --- 4. run it as a service ----------------------------------------------------------
say "Starting the radio service"
id radio >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin radio
mkdir -p data
chown -R radio:radio "$APP"
chmod 600 .env
sed "s#^ExecStart=.*#ExecStart=$NODE_BIN server/index.js#" deploy/radio-station.service > /etc/systemd/system/radio-station.service
systemctl daemon-reload
systemctl enable radio-station >/dev/null 2>&1
systemctl restart radio-station
for _ in $(seq 1 20); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/radio/api/state" && break
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/radio/api/state" \
  || die "the radio didn't start. See: journalctl -u radio-station -n 50  (Apache was not touched)"

# --- 5. Apache: one Include line, with backup + automatic rollback -------------------
say "Connecting $DOMAIN/radio in Apache"
a2enmod -q proxy proxy_http headers >/dev/null
cp deploy/apache-radio-subpath.conf "$SNIPPET"

BEFORE=$(homepage "$SCHEME")
mkdir -p "$BACKUP"
for f in "${VHOSTS[@]}"; do
  cp -a "$f" "$BACKUP/"
  grep -qF "$INCLUDE" "$f" && continue
  # Add the Include before </VirtualHost> in this domain's block(s): only the :443 ones when HTTPS exists.
  # (ALL=yes: the single default site, which names no domain, so every block in it.)
  INC="    $INCLUDE" DOM="$DOMAIN" HTTPS="$HTTPS" ALL="$ALL_BLOCKS" awk '
    function isdomain(w) { sub(/:[0-9]+$/, "", w); return w == ENVIRON["DOM"] || w == "www." ENVIRON["DOM"] }
    /^[[:space:]]*<VirtualHost/ { inblk = 1; is443 = ($0 ~ /:443/); hit = (ENVIRON["ALL"] == "yes") }
    inblk && /^[[:space:]]*<\/VirtualHost>/ {
      if (hit && (ENVIRON["HTTPS"] == "no" || is443)) print ENVIRON["INC"]
      print; inblk = 0; next
    }
    inblk {
      n = split(tolower($0), w, /[[:space:]]+/)
      for (i = 1; i <= n; i++) if (w[i] == "servername" || w[i] == "serveralias") { for (j = i + 1; j <= n; j++) if (isdomain(w[j])) hit = 1; break }
    }
    { print }
  ' "$BACKUP/$(basename "$f")" > "$f"
done

if ! apache2ctl configtest; then
  restore
  die "Apache config test failed, so your original config was restored. The website was not affected."
fi
systemctl reload apache2
sleep 2
AFTER=$(homepage "$SCHEME")
if [ "$BEFORE" != "$AFTER" ]; then
  restore
  die "the homepage answered $AFTER instead of $BEFORE after the change, so the original config was restored."
fi

RADIO=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$SCHEME://$DOMAIN/radio/api/state" --resolve "$DOMAIN:443:127.0.0.1" --resolve "$DOMAIN:80:127.0.0.1" || true)
[ "$RADIO" = 200 ] || echo "Warning: $SCHEME://$DOMAIN/radio answered $RADIO. Check: journalctl -u radio-station -n 50"

say "Done"
echo "Main site:  $PUBLIC_SCHEME://$DOMAIN/          (still answering $AFTER, same as before)"
echo "Radio:      $PUBLIC_SCHEME://$DOMAIN/radio/"
echo "Admin:      $PUBLIC_SCHEME://$DOMAIN/radio/admin"
echo "Apache backup: $BACKUP"
echo "Logs:       journalctl -u radio-station -f"
if [ "$CLOUDFLARE" = yes ]; then
  echo "Cloudflare: detected. In the Cloudflare dashboard, turn on SSL/TLS > Edge Certificates > 'Always Use HTTPS'"
  echo "            (admin login only works over https). Uploads are limited to 100 MB per file."
fi
[ "$PUBLIC_HTTPS" = yes ] || echo "Note: $DOMAIN isn't reachable over HTTPS, so admin cookies are not marked Secure. Add HTTPS, then re-run this script."
