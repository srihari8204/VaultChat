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

curl -s --max-time 10 "$BASE/.well-known/assetlinks.json" | grep -q "5F:C1:97" \
  && ok "assetlinks carries the fingerprint" || { bad "assetlinks body is wrong"; fail=1; }

w=$(curl -s -o /dev/null -w '%{http_code}' --http1.1 --max-time 8 \
     -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
     -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
     "$BASE/socket.io/?EIO=4&transport=websocket" || true)
[ "$w" = 101 ] && ok "websocket 101" || { bad "websocket=$w"; fail=1; }

# The whole point of the compose change: 8095 must stop answering from outside
# while nginx keeps reaching it on loopback (proved by /health above).
e=$(code "http://65.21.229.167:8095/health")
[ "$e" = "000" ] && ok "8095 no longer reachable externally" || { bad "8095 still answering ($e)"; fail=1; }

[ "$fail" -eq 0 ] || { restore; die "verification failed - rolled back"; }

say "Deployed."
echo "Rollback: ssh $HOST 'cp /tmp/Caddyfile.$STAMP.bak $DEST/caddy/Caddyfile && cp /tmp/compose.prod.$STAMP.bak $DEST/docker-compose.prod.yml && cd $DEST && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d caddy'"
