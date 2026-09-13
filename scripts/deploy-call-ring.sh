#!/usr/bin/env bash
# deploy-call-ring.sh — ship POST /calls/{id}/ring to prod, or leave prod exactly as it was.
#
#   scp scripts/deploy-call-ring.sh srihari@65.21.229.167:/home/srihari/
#   ssh srihari@65.21.229.167
#   sudo bash /home/srihari/deploy-call-ring.sh
#
# Everything here was verified from outside before this script was written:
#   * the staged file compiles AND vets under golang:1.26-alpine — prod's own
#     toolchain, taken from prod's Dockerfile
#   * prod's current call_sessions.go is byte-identical to repo HEAD, so this
#     overwrite adds only the new endpoint and deletes nothing
#   * migration ledger is 122; this change needs NO migration
#   * there were 0 live calls at the time of writing — check again before running
#
# SAFETY RULES BAKED IN. Do not remove them:
#   * ONLY the go-api service is touched (--no-deps). NEVER --remove-orphans:
#     compose knows 8 services while 17 vaultchat containers run, so that flag
#     would delete both LiveKit servers and both egress containers — every call
#     AND every Go Live broadcast, at once.
#   * Never `down`, never `down -v`.
#   * Any failure restores the previous source AND retags the previous image, so
#     a broken build cannot leave prod serving nothing.
set -uo pipefail

ROOT=/home/srihari/vaultchat
R="$ROOT/vaultchat-backend-go/internal/routes/call_sessions.go"
NEW=/home/srihari/call_sessions.go.new
NEW_MD5=eb602bfd594737cf63cc23dfae21bd23
OLD_MD5=b231922ec257f106328bd075116c3f18
STAMP=$(date +%Y%m%d-%H%M%S)
BAK=/home/srihari/call_sessions.go.predeploy.$STAMP
DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml"

say() { echo; echo "== $* =="; }
die() { echo "!! $*" >&2; exit 1; }

cd "$ROOT" || die "no checkout at $ROOT"

say "1/6 pre-flight"
[ -f "$NEW" ] || die "staged file missing: $NEW"
[ "$(md5sum "$NEW" | cut -d' ' -f1)" = "$NEW_MD5" ] || die "staged file hash mismatch - re-upload it"
CUR=$(md5sum "$R" | cut -d' ' -f1)
if [ "$CUR" = "$NEW_MD5" ]; then echo "already deployed; nothing to do"; exit 0; fi
[ "$CUR" = "$OLD_MD5" ] || die "prod file is NOT the expected baseline ($CUR) - someone changed it; diff before deploying"
LIVE=$(docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tAc \
  "SELECT count(*) FROM calls WHERE ended_at IS NULL;" 2>/dev/null | tr -d ' ')
echo "ok: staged file verified, prod file is the expected baseline"
echo "live calls right now: ${LIVE:-unknown}  (restart briefly interrupts any in progress)"

say "2/6 backup (source + current image)"
cp "$R" "$BAK" || die "backup failed"
IMG_ID=$(docker images -q vaultchat-go-api | head -1)
echo "source -> $BAK"
echo "image  -> ${IMG_ID:-<none>}  (restored on failure)"

say "3/6 install source"
cp "$NEW" "$R" || die "install failed"
grep -q callSessionRing "$R" || { cp "$BAK" "$R"; die "post-copy check failed, source restored"; }
echo "ok: /calls/{id}/ring present in source"

rollback() {
  echo; echo "!! ROLLING BACK"
  cp "$BAK" "$R" && echo "   source restored"
  if [ -n "${IMG_ID:-}" ]; then
    docker tag "$IMG_ID" vaultchat-go-api:latest && echo "   image restored"
    $DC up -d --no-deps go-api && echo "   go-api back on the previous image"
  fi
  echo "   prod is as it was. Nothing else was touched."
  exit 1
}

# --pull is not optional. The Dockerfile builds from the FLOATING tag

# golang:1.26-alpine, so without it the build silently reuses whichever base

# layer this box cached — production was three patch releases behind on

# go1.26.5, with standard-library fixes in 1.26.6/.7/.8, and nothing said so.

# GET /build now reports the toolchain; this is what keeps it current.

say "4/6 build --pull go-api"
$DC build --pull go-api || rollback

say "5/6 restart go-api only"
$DC up -d --no-deps go-api || rollback

say "6/6 verify"
for i in $(seq 1 30); do
  H=$(curl -s -m 5 http://127.0.0.1:8095/health 2>/dev/null)
  case "$H" in *'"status":"ok"'*) echo "health ok after ${i}s"; break;; esac
  [ "$i" = 30 ] && { echo "health never came up"; rollback; }
  sleep 1
done

CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8095/calls/x/ring)
echo "POST /calls/x/ring      -> $CODE   (401 = deployed, 404 = route missing)"
[ "$CODE" = "401" ] || { echo "the new route did not appear"; rollback; }

CTL=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8095/calls/x/sfu-token)
echo "POST /calls/x/sfu-token -> $CTL   (401 = existing call routes still fine)"
[ "$CTL" = "401" ] || { echo "an EXISTING route regressed"; rollback; }

echo
echo "DEPLOYED. /calls/{id}/ring is live; existing call routes unaffected."
echo
echo "Rollback if anything shows up later:"
echo "  sudo cp $BAK $R"
echo "  cd $ROOT && $DC build go-api && $DC up -d --no-deps go-api"
echo
echo "NOT done here, deliberately: livekit.yaml max_participants is still 100."
echo "Raise it only AFTER this route is confirmed live - it is the only ceiling"
echo "prod currently has."
