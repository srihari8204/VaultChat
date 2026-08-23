#!/usr/bin/env bash
# prod-hardening.sh — the three production changes the launch audit called
# blocking. Run ON THE PRODUCTION HOST, as root, one step at a time.
#
#   ./prod-hardening.sh status     what is / is not done  (READ-ONLY, safe)
#   ./prod-hardening.sh uploads    fix presigned media uploads
#   ./prod-hardening.sh verify     prove a large upload now works end to end
#   ./prod-hardening.sh offsite    push nightly backups off the box
#   ./prod-hardening.sh ssh        keys only, no password logins   ← DO LAST
#
# Every step is idempotent and backs up what it touches to /root/vc-backups/.
# `ssh` is last on purpose: it ends password logins, so any session that is not
# using a key will not be able to reconnect.

set -euo pipefail

VC=/home/srihari/vaultchat
VHOST=/etc/nginx/sites-available/vaultchat
ENVF=$VC/.env
BACKUP_SH=/home/srihari/vaultchat-backups/backup.sh
TS=$(date +%Y%m%d-%H%M%S)
BK=/root/vc-backups/hardening-$TS

ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; }
hm(){ printf '  \033[33m!\033[0m %s\n' "$1"; }
say(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

need_root(){ [ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }; }

# ─────────────────────────────────────────────────────────────── status ──
cmd_status() {
  say "1. Presigned media uploads"
  local ep
  ep=$(cd "$VC" && docker compose -f docker-compose.yml -f docker-compose.prod.yml config 2>/dev/null \
        | awk '/S3_PUBLIC_ENDPOINT:/{print $2; exit}')
  echo "     signing endpoint: ${ep:-unknown}"
  case "$ep" in
    https://*) ok "endpoint is TLS and publicly routable" ;;
    *) no "endpoint is not publicly reachable — uploads over ~2 MB fail silently" ;;
  esac
  grep -q 'vaultchat-media' "$VHOST" 2>/dev/null && ok "nginx bucket route present" || no "nginx bucket route missing"

  say "2. Offsite backups"
  if command -v rclone >/dev/null 2>&1 || [ -f /root/.config/rclone/rclone.conf ]; then
    ok "rclone config present"
  else no "no rclone config — backups never leave this disk"; fi
  grep -q 'rclone' "$BACKUP_SH" 2>/dev/null && ok "backup.sh pushes offsite" || no "backup.sh has no offsite step"

  say "3. SSH"
  grep -qE '^\s*PasswordAuthentication\s+no' /etc/ssh/sshd_config && ok "password auth disabled" \
    || no "password auth ENABLED — $(journalctl -u ssh --since '24 hours ago' 2>/dev/null | grep -c 'Failed password') failed attempts in 24h"
  grep -qE '^\s*PermitRootLogin\s+(no|prohibit-password)' /etc/ssh/sshd_config && ok "root password login disabled" \
    || no "root may log in with a password"
  echo "     installed keys: $(grep -c '^ssh-' /root/.ssh/authorized_keys 2>/dev/null || echo 0) root, $(grep -c '^ssh-' /home/srihari/.ssh/authorized_keys 2>/dev/null || echo 0) srihari"
}

# ────────────────────────────────────────────────────────────── uploads ──
# Large media is uploaded by the CLIENT straight to the object store using a
# presigned URL. Those URLs are signed for S3_PUBLIC_ENDPOINT, which pointed at
# http://<ip>:19000 — a port the firewall drops. The client could never reach
# it, so the row was written and the bytes never arrived.
#
# There is no DNS record for a media subdomain and no wildcard, so the bucket is
# published by PATH on the host that already has a certificate.
cmd_uploads() {
  need_root; mkdir -p "$BK"; cp "$VHOST" "$BK/vaultchat.nginx"; cp "$ENVF" "$BK/env"
  echo "backup: $BK"

  if grep -q 'vaultchat-media' "$VHOST"; then
    hm "nginx route already present, leaving it alone"
  else
    # SigV4 signs the Host header, so nginx must pass it through UNCHANGED —
    # rewriting it invalidates every signature and turns uploads into 403s.
    # client_max_body_size 0 + buffering off: a 792 MB upload must stream to the
    # store, not spool to nginx's disk first.
    awk '
      /^    location \/ \{/ && !d {
        print "    # Object store — presigned attachment uploads."
        print "    # Host passed through unchanged: SigV4 signs it, and rewriting it"
        print "    # invalidates every signature. Body limit lifted and buffering off so"
        print "    # a large upload streams straight through instead of spooling to disk."
        print "    location /vaultchat-media/ {"
        print "        proxy_pass              http://127.0.0.1:19000;"
        print "        proxy_http_version      1.1;"
        print "        proxy_set_header        Host              $host;"
        print "        proxy_set_header        X-Real-IP         $remote_addr;"
        print "        proxy_set_header        X-Forwarded-For   $proxy_add_x_forwarded_for;"
        print "        proxy_set_header        X-Forwarded-Proto $scheme;"
        print "        client_max_body_size    0;"
        print "        proxy_request_buffering off;"
        print "        proxy_buffering         off;"
        print "        proxy_read_timeout      3600;"
        print "        proxy_send_timeout      3600;"
        print "    }"
        print ""
        d=1
      } { print }' "$VHOST" > "$VHOST.new"
    mv "$VHOST.new" "$VHOST"
    ok "nginx bucket route added"
  fi

  nginx -t || { no "nginx config invalid — restoring"; cp "$BK/vaultchat.nginx" "$VHOST"; exit 1; }
  nginx -s reload; ok "nginx reloaded"

  if grep -q '^S3_PUBLIC_ENDPOINT=' "$ENVF"; then
    sed -i 's|^S3_PUBLIC_ENDPOINT=.*|S3_PUBLIC_ENDPOINT=https://api.corefinite.com|' "$ENVF"
  else
    printf '\n# Presigned uploads are signed for this host and reach MinIO through the\n# /vaultchat-media/ location in nginx. Must be publicly reachable over TLS.\nS3_PUBLIC_ENDPOINT=https://api.corefinite.com\n' >> "$ENVF"
  fi
  ok "S3_PUBLIC_ENDPOINT -> https://api.corefinite.com"

  (cd "$VC" && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d go-api)
  ok "go-api recreated — now run: $0 verify"
}

# ─────────────────────────────────────────────────────────────── verify ──
# A real presigned PUT of a file larger than anything that has ever succeeded,
# through the public hostname, using the store's own credentials. Proves the
# whole path: DNS, TLS, nginx, Host preservation, signature, MinIO.
cmd_verify() {
  need_root
  local AK SK
  AK=$(docker exec vaultchat-minio-1 printenv MINIO_ROOT_USER)
  SK=$(docker exec vaultchat-minio-1 printenv MINIO_ROOT_PASSWORD)
  [ -n "$AK" ] && [ -n "$SK" ] || { no "could not read store credentials"; exit 1; }

  local TMP; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  head -c 250000000 /dev/urandom > "$TMP/big.bin"      # 250 MB — past the old 100 MB cap
  echo "  test object: 250 MB"

  docker run --rm --network host -v "$TMP:/w" -e AK -e SK minio/mc:latest sh -c '
    mc alias set pub https://api.corefinite.com "$AK" "$SK" >/dev/null 2>&1 || exit 3
    mc cp /w/big.bin pub/vaultchat-media/healthcheck/upload-test.bin >/dev/null 2>&1 || exit 4
    mc stat pub/vaultchat-media/healthcheck/upload-test.bin | head -3
    mc rm pub/vaultchat-media/healthcheck/upload-test.bin >/dev/null 2>&1
  ' && ok "250 MB uploaded and removed through https://api.corefinite.com" \
    || { no "upload FAILED — the path is still broken"; exit 1; }
}

# ────────────────────────────────────────────────────────────── offsite ──
# Nightly dumps are good — verified, self-checking, 14 days — but every copy
# lives on the same array as the database it protects. RAID survives a disk; it
# does not survive the host, a bad rm, or a lost account.
#
# Needs a remote called `offsite` in /root/.config/rclone/rclone.conf first, eg
# Cloudflare R2:
#   [offsite]
#   type = s3
#   provider = Cloudflare
#   access_key_id = ...
#   secret_access_key = ...
#   endpoint = https://<account>.r2.cloudflarestorage.com
#   acl = private
cmd_offsite() {
  need_root
  [ -f /root/.config/rclone/rclone.conf ] || { no "create /root/.config/rclone/rclone.conf with an [offsite] remote first (see comments in this script)"; exit 1; }
  grep -q '^\[offsite\]' /root/.config/rclone/rclone.conf || { no "no [offsite] remote in rclone.conf"; exit 1; }
  mkdir -p "$BK"; cp "$BACKUP_SH" "$BK/backup.sh"

  if grep -q 'rclone' "$BACKUP_SH"; then
    hm "backup.sh already pushes offsite"
  else
    cat >> "$BACKUP_SH" <<'PUSH'

# ── Offsite copy ─────────────────────────────────────────────────────────
# A backup on the same disk as the database is not a backup; it is a second
# copy of the same failure. Runs after verification above, so only a dump that
# has been checked is ever shipped. Non-fatal: a network problem must not make
# the local backup look failed.
if [ -f /root/.config/rclone/rclone.conf ]; then
  if docker run --rm -v /root/.config/rclone:/config/rclone:ro -v "$DIR:/data:ro" \
       rclone/rclone:latest copy "/data/$(basename "$OUT")" offsite:vaultchat-backups/ >/dev/null 2>&1; then
    echo "[backup] offsite ok $(basename "$OUT")"
  else
    echo "[backup] OFFSITE PUSH FAILED $(basename "$OUT")" >&2
  fi
fi
PUSH
    ok "offsite push appended to backup.sh"
  fi

  echo "  testing a real push of the newest dump..."
  local NEW; NEW=$(ls -t /home/srihari/vaultchat-backups/*.sql.gz | head -1)
  docker run --rm -v /root/.config/rclone:/config/rclone:ro -v /home/srihari/vaultchat-backups:/data:ro \
    rclone/rclone:latest copy "/data/$(basename "$NEW")" offsite:vaultchat-backups/ \
    && ok "pushed $(basename "$NEW") offsite" || { no "offsite push failed"; exit 1; }
  docker run --rm -v /root/.config/rclone:/config/rclone:ro rclone/rclone:latest ls offsite:vaultchat-backups/ | tail -3
}

# ────────────────────────────────────────────────────────────────── ssh ──
# Refuses unless key-based login is PROVEN to work, because the failure mode is
# locking everyone out of the box permanently.
cmd_ssh() {
  need_root
  local KEYS ACCEPTED
  KEYS=$(grep -c '^ssh-\|^ecdsa-' /root/.ssh/authorized_keys 2>/dev/null || echo 0)
  ACCEPTED=$(journalctl -u ssh --since '30 days ago' 2>/dev/null | grep -c 'Accepted publickey' || echo 0)
  echo "  authorized keys: $KEYS    successful key logins (30d): $ACCEPTED"
  [ "$KEYS" -ge 1 ] || { no "no keys installed — this would lock you out. Add one first."; exit 1; }
  [ "$ACCEPTED" -ge 1 ] || { no "no key login has ever succeeded — verify one works before running this."; exit 1; }

  mkdir -p "$BK"; cp /etc/ssh/sshd_config "$BK/sshd_config"
  sed -i -E 's/^\s*#?\s*PasswordAuthentication\s+.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i -E 's/^\s*#?\s*PermitRootLogin\s+.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  grep -qE '^PasswordAuthentication no' /etc/ssh/sshd_config || echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config
  grep -qE '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin prohibit-password' >> /etc/ssh/sshd_config

  sshd -t || { no "sshd config invalid — restoring"; cp "$BK/sshd_config" /etc/ssh/sshd_config; exit 1; }
  systemctl reload ssh
  ok "password logins disabled; root may only use a key"
  hm "KEEP THIS SESSION OPEN until you have confirmed a new key-based login works."
}

case "${1:-status}" in
  status)  cmd_status ;;
  uploads) cmd_uploads ;;
  verify)  cmd_verify ;;
  offsite) cmd_offsite ;;
  ssh)     cmd_ssh ;;
  *) echo "usage: $0 {status|uploads|verify|offsite|ssh}"; exit 1 ;;
esac
