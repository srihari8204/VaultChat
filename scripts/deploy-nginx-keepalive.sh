#!/usr/bin/env bash
#
# Deploy nginx/sites/vaultchat.conf to vaultchatprod01.
#
# WHAT THIS CHANGES
#   * upstream keep-alive to Caddy (a local $vc_conn_upgrade map, so the shared
#     map in nginx.conf — which games/admin/monitor/portainer also use — is left
#     alone)
#   * wider TLS session cache
#   * NOTHING about /vaultchat-media, which is carried through verbatim
#
# WHY A SCRIPT
#   The live vhost is a REGULAR FILE at /etc/nginx/sites-enabled/vaultchat, not
#   a symlink into sites-available, and it had already drifted from the repo
#   once (the /vaultchat-media block existed only on the box). A hand `scp` over
#   it is exactly how that block gets destroyed and every attachment upload dies
#   silently. So: diff first, back up, test, reload, VERIFY, auto-rollback.
#
# There is no NOPASSWD on this box — you will be prompted for sudo.
#
# Usage:  bash scripts/deploy-nginx-keepalive.sh [-y]

set -euo pipefail

# root, not srihari: root authenticates by KEY on this box, while srihari has no
# NOPASSWD and would block on a sudo password prompt in any non-interactive run.
# Override with VAULTCHAT_PROD_HOST=srihari@... if you are at a terminal.
HOST="${VAULTCHAT_PROD_HOST:-root@65.21.229.167}"
LIVE=/etc/nginx/sites-enabled/vaultchat
SRC=nginx/sites/vaultchat.conf
BASE=https://api.corefinite.com
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/tmp/vaultchat.nginx.$STAMP.bak"
ASSUME_YES=${1:-}

say()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
die()  { printf '\n\033[31mABORT: %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32m  ok\033[0m  %s\n' "$1"; }
bad()  { printf '\033[31m  FAIL\033[0m %s\n' "$1"; }

[ -f "$SRC" ] || die "$SRC not found — run from the repo root"

# ── 1. show what will change ─────────────────────────────────────────
say "Diffing live vhost against $SRC"
ssh -o BatchMode=yes "$HOST" "cat $LIVE" > /tmp/vc-live.$STAMP.conf \
  || die "could not read $LIVE (is the host reachable?)"

if diff -u /tmp/vc-live.$STAMP.conf "$SRC"; then
  say "Live is already identical — nothing to deploy."; exit 0
fi

# The one block that must survive: it exists only on the box's history and
# carries presigned uploads. If the new file lost it, stop before any damage.
grep -q 'location /vaultchat-media' "$SRC" \
  || die "$SRC is missing the /vaultchat-media block — deploying it would break attachment uploads"

if [ "$ASSUME_YES" != "-y" ]; then
  printf '\nApply the diff above to production? [type yes] '
  read -r reply
  [ "$reply" = "yes" ] || die "cancelled"
fi

# ── 2. stage + back up + install ─────────────────────────────────────
say "Staging and backing up"
scp -q "$SRC" "$HOST:/tmp/vaultchat.new.$STAMP"
ssh -t "$HOST" "sudo cp $LIVE $BACKUP && sudo cp /tmp/vaultchat.new.$STAMP $LIVE && echo 'backup: $BACKUP'"

restore() {
  printf '\n\033[31mrolling back\033[0m\n'
  ssh -t "$HOST" "sudo cp $BACKUP $LIVE && sudo nginx -t && sudo nginx -s reload && echo restored"
}

# ── 3. syntax test BEFORE reload ─────────────────────────────────────
say "nginx -t"
if ! ssh -t "$HOST" "sudo nginx -t"; then
  restore; die "config failed nginx -t — live config restored, nothing was reloaded"
fi

# ── 4. reload ────────────────────────────────────────────────────────
say "Reloading nginx"
ssh -t "$HOST" "sudo nginx -s reload" || { restore; die "reload failed"; }
sleep 2

# ── 5. verify — any failure rolls back ───────────────────────────────
# Baselines measured before the change: health 200, internal 404, media 403,
# websocket upgrade 101. The websocket one is the whole risk of this change:
# an upstream keep-alive misconfiguration shows up as a failed Upgrade.
say "Verifying"
fail=0
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true; }

h=$(code "$BASE/health");              [ "$h" = 200 ] && ok "/health 200" || { bad "/health = $h (want 200)"; fail=1; }
i=$(code "$BASE/internal/emit");       [ "$i" = 404 ] && ok "/internal/* still blocked (404)" || { bad "/internal/emit = $i (want 404)"; fail=1; }
m=$(code "$BASE/vaultchat-media/");    [ "$m" = 403 ] && ok "/vaultchat-media reaches MinIO (403)" || { bad "/vaultchat-media = $m (want 403)"; fail=1; }

w=$(curl -s -o /dev/null -w '%{http_code}' --http1.1 --max-time 8 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
      "$BASE/socket.io/?EIO=4&transport=websocket" || true)
[ "$w" = 101 ] && ok "websocket upgrade 101" || { bad "websocket upgrade = $w (want 101)"; fail=1; }

if [ "$fail" -ne 0 ]; then
  restore; die "verification failed — live config restored"
fi

say "Deployed. Backup on the box: $BACKUP"
echo "Manual rollback:  ssh $HOST 'sudo cp $BACKUP $LIVE && sudo nginx -t && sudo nginx -s reload'"
