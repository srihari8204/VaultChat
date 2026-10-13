#!/usr/bin/env bash
#
# Deploy the Caddyfile + assetlinks.json + the compose port fix, together.
#
# THESE THREE MUST SHIP AS ONE. The Caddyfile now serves assetlinks from
# /srv/public instead of an inline `respond`, so shipping it without
# caddy/public/assetlinks.json 404s the App Links endpoint and every Private
# Live invitation link starts opening a browser instead of the app.
#
# It recreates the caddy container, which is the operation the live compose
# comment warns about: a previous `up -d caddy` could not bind :80 against the
# host nginx and took the site down. Hence backup, validate, recreate, verify
# seven things, and roll the whole lot back on any failure.
#
# DO NOT RUN THIS UNTIL THE TWO THINGS BELOW ARE CHECKED (noted 2026-10-13).
# Both predate the discovery that the live stack moved, and either one can take
# the site down. Verified facts, not suspicions:
#
#  1. DEST BELOW IS PROBABLY THE WRONG TREE. The live stack is deployed from
#     /home/srihari/vaultchat-clean under compose project "vaultchat" —
#     scripts/deploy.sh's header documents this and says /home/srihari/vaultchat
#     is a STALE checkout (git HEAD 2026-08-11). Staging files into the stale
#     tree writes a file nothing serves, and the verify step below would then
#     fail against the UNCHANGED endpoint and roll back. Confirm which tree the
#     running caddy actually mounts /srv/public from before trusting DEST:
#       docker inspect vaultchat-caddy-1 --format '{{json .Mounts}}'
#
#  2. THE COMPOSE INVOCATIONS ARE MISSING -f docker-compose.box.yml. Every
#     `up -d caddy` here passes only docker-compose.yml and .prod.yml, and omits
#     the box overlay — the same omission that, for go-api, would have dropped
#     MSG91_AUTH_KEY and caused a total login outage. For caddy the risk is
#     recreating it from a partial config, and this script's own header records
#     that a previous `up -d caddy` could not bind :80 against the host nginx
#     and TOOK THE SITE DOWN. Add the third -f, or do not recreate caddy.
#
# assetlinks.json is a STATIC FILE served by file_server, so changing it needs
# no reload at all — scp it to the path caddy really mounts and it is live.
# Recreating caddy to publish a JSON edit is the risky way to do a safe thing.
#
# Usage:  bash scripts/deploy-caddy-assetlinks.sh
set -euo pipefail
HOST="${VAULTCHAT_PROD_HOST:-root@65.21.229.167}"
DEST=/home/srihari/vaultchat
BASE=https://api.corefinite.com
STAMP=$(date +%Y%m%d-%H%M%S)
say(){ printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok(){  printf '\033[32m  ok\033[0m   %s\n' "$1"; }
bad(){ printf '\033[31m  FAIL\033[0m %s\n' "$1"; }
die(){ printf '\n\033[31mABORT: %s\033[0m\n' "$1" >&2; exit 1; }

say "Backing up live copies"
ssh "$HOST" "cp $DEST/caddy/Caddyfile /tmp/Caddyfile.$STAMP.bak && \
             cp $DEST/docker-compose.prod.yml /tmp/compose.prod.$STAMP.bak && \
             echo '  /tmp/Caddyfile.$STAMP.bak' && echo '  /tmp/compose.prod.$STAMP.bak'"

say "Staging new files"
scp -q caddy/Caddyfile "$HOST:$DEST/caddy/Caddyfile"
ssh "$HOST" "mkdir -p $DEST/caddy/public"
scp -q caddy/public/assetlinks.json caddy/public/README.md "$HOST:$DEST/caddy/public/"
scp -q docker-compose.prod.yml "$HOST:$DEST/docker-compose.prod.yml"

restore() {
  printf '\n\033[31mrolling back\033[0m\n'
  ssh "$HOST" "cp /tmp/Caddyfile.$STAMP.bak $DEST/caddy/Caddyfile && \
               cp /tmp/compose.prod.$STAMP.bak $DEST/docker-compose.prod.yml && \
               cd $DEST && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d caddy" || true
}

say "Validating the new Caddyfile"
ssh "$HOST" "docker run --rm -v $DEST/caddy/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine \
             caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" \
  || { restore; die "Caddyfile failed validation - nothing was recreated"; }

say "Recreating caddy"
ssh "$HOST" "cd $DEST && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d caddy" \
  || { restore; die "compose up failed"; }
sleep 4

say "Verifying"
fail=0
code(){ curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true; }
h=$(code "$BASE/health");                      [ "$h" = 200 ] && ok "/health 200"                 || { bad "/health=$h";     fail=1; }
i=$(code "$BASE/internal/emit");               [ "$i" = 404 ] && ok "/internal/* still blocked"   || { bad "/internal=$i";   fail=1; }
m=$(code "$BASE/vaultchat-media/");            [ "$m" = 403 ] && ok "media reaches MinIO"         || { bad "/media=$m";      fail=1; }
a=$(code "$BASE/.well-known/assetlinks.json"); [ "$a" = 200 ] && ok "assetlinks served from file" || { bad "/assetlinks=$a"; fail=1; }

_al=$(curl -s --max-time 10 "$BASE/.well-known/assetlinks.json")
printf '%s' "$_al" | grep -q "5F:C1:97" \
  && ok "assetlinks carries the debug fingerprint" || { bad "assetlinks body is wrong"; fail=1; }
# The RELEASE cert, and it is the one that matters. Checking only the debug
# fingerprint is how this endpoint stayed green while being wrong for the
# artifact people actually install: the manifest marks
# https://api.corefinite.com/live/join autoVerify="true", so a cert that is not
# listed here fails App Links verification SILENTLY and every Private Live
# invitation opens a browser instead of the app. Nothing logs it.
#   CN=VaultChat upload key, from:
#   apksigner verify --print-certs android/app/build/outputs/apk/release/app-release.apk
printf '%s' "$_al" | grep -q "69:03:8D:5F" \
  && ok "assetlinks carries the RELEASE fingerprint" || { bad "assetlinks is missing the release cert — deep links will open a browser"; fail=1; }

w=$(curl -s -o /dev/null -w '%{http_code}' --http1.1 --max-time 8 \
     -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
     -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
     "$BASE/socket.io/?EIO=4&transport=websocket" || true)
[ "$w" = 101 ] && ok "websocket 101" || { bad "websocket=$w"; fail=1; }

# The whole point of the compose change: neither cleartext port may answer from
# outside, while nginx keeps reaching Caddy on loopback (proved by /health above).
e=$(code "http://65.21.229.167:8095/health")
[ "$e" = "000" ] && ok "8095 not reachable externally" || { bad "8095 still answering ($e)"; fail=1; }
t=$(code "http://65.21.229.167:3000/health")
[ "$t" = "000" ] && ok "3000 not reachable externally" || { bad "3000 still answering ($t)"; fail=1; }

[ "$fail" -eq 0 ] || { restore; die "verification failed - rolled back"; }

say "Deployed."
echo "Rollback: ssh $HOST 'cp /tmp/Caddyfile.$STAMP.bak $DEST/caddy/Caddyfile && cp /tmp/compose.prod.$STAMP.bak $DEST/docker-compose.prod.yml && cd $DEST && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d caddy'"
