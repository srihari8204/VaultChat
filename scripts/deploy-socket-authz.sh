#!/usr/bin/env bash
# deploy-socket-authz.sh — close the self-asserted chat-room join on prod.
#
#   scp scripts/deploy-socket-authz.sh srihari@65.21.229.167:/home/srihari/
#   scp vaultchat-backend-go/internal/realtime/handlers.go srihari@…:/home/srihari/handlers.go.new
#   scp vaultchat-backend-go/internal/realtime/server.go   srihari@…:/home/srihari/server.go.new
#   ssh srihari@65.21.229.167 'sudo bash /home/srihari/deploy-socket-authz.sh'
#
# WHAT IT FIXES
#
# registerChatHandlers joined whatever chatId arrived on `join_chat`. Room
# membership was therefore SELF-ASSERTED: any authenticated socket could join
# chat:<id> and receive that chat's fan-out — FanOutToChat emits unfiltered
# straight to the room, and the same file sends live_location_update,
# trip_update, trip_end, reaction_updated and message_delivered there too.
#
# Guessing a chat UUID is not the threat. A REMOVED MEMBER is: they already know
# the id, and nothing re-checked whether they still belong, so a stale client
# kept listening to a chat it had been removed from.
#
# VERIFIED BEFORE THIS SCRIPT WAS WRITTEN
#
#   * prod's handlers.go and server.go differ from local ONLY by this fix plus
#     the liveLocAllowed -> chatMemberAllowed rename. Checked line by line:
#     prod has NO unique feature that copying would destroy. (That check is not
#     paranoia — prod has carried repo-absent code before.)
#   * the rename spans BOTH files, so they deploy together or not at all.
#   * server.go is the same 279 lines on both sides; it is a pure rename.
#
# SAFETY RULES BAKED IN. Do not remove them:
#   * ONLY the go-api service is touched (--no-deps). NEVER --remove-orphans:
#     compose knows 8 services while 17 vaultchat containers run, so that flag
#     would delete both LiveKit servers and both egress containers — every call
#     AND every broadcast, at once.
#   * Never `down`, never `down -v`.
#   * Any failure restores BOTH source files AND retags the previous image, so a
#     broken build cannot leave prod serving nothing.
set -uo pipefail

ROOT=/home/srihari/vaultchat
RT="$ROOT/vaultchat-backend-go/internal/realtime"
NEW_H_MD5=4f6f9bf724203b3a1a5a84ac6fec6c5c
NEW_S_MD5=9bdbc4f5dfa84ae463c4fdba74ddc177
STAMP=$(date +%Y%m%d-%H%M%S)
BAK=/home/srihari/socket-authz-predeploy.$STAMP
DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml"

say() { echo; echo "== $* =="; }
die() { echo "!! $*" >&2; exit 1; }

cd "$ROOT" || die "no checkout at $ROOT"

say "1/6 pre-flight"
[ -f /home/srihari/handlers.go.new ] || die "missing /home/srihari/handlers.go.new"
[ -f /home/srihari/server.go.new ]   || die "missing /home/srihari/server.go.new"
[ "$(md5sum /home/srihari/handlers.go.new | cut -d' ' -f1)" = "$NEW_H_MD5" ] \
  || die "handlers.go.new hash mismatch - re-upload it"
[ "$(md5sum /home/srihari/server.go.new | cut -d' ' -f1)" = "$NEW_S_MD5" ] \
  || die "server.go.new hash mismatch - re-upload it"
if [ "$(md5sum "$RT/handlers.go" | cut -d' ' -f1)" = "$NEW_H_MD5" ]; then
  echo "already deployed; nothing to do"; exit 0
fi
LIVE=$(docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tAc \
  "SELECT count(*) FROM calls WHERE ended_at IS NULL;" 2>/dev/null | tr -d ' ')
echo "ok: staged files verified"
echo "live calls right now: ${LIVE:-unknown}  (a restart briefly drops sockets)"

say "2/6 backup (both sources + current image)"
mkdir -p "$BAK" || die "cannot create $BAK"
cp "$RT/handlers.go" "$RT/server.go" "$BAK/" || die "backup failed"
IMG_ID=$(docker images -q vaultchat-go-api | head -1)
echo "source -> $BAK"
echo "image  -> ${IMG_ID:-<none>}  (restored on failure)"

say "3/6 install both sources"
cp /home/srihari/handlers.go.new "$RT/handlers.go" || die "install handlers.go failed"
cp /home/srihari/server.go.new   "$RT/server.go"   || die "install server.go failed"
grep -q chatMemberAllowed "$RT/handlers.go" \
  || { cp "$BAK"/handlers.go "$BAK"/server.go "$RT/"; die "post-copy check failed, sources restored"; }
grep -q chatMemberOk "$RT/server.go" \
  || { cp "$BAK"/handlers.go "$BAK"/server.go "$RT/"; die "server.go missing the renamed field, restored"; }
echo "ok: chatMemberAllowed + chatMemberOk present"

rollback() {
  echo; echo "!! ROLLING BACK"
  cp "$BAK"/handlers.go "$BAK"/server.go "$RT/" && echo "   sources restored"
  if [ -n "${IMG_ID:-}" ]; then
    docker tag "$IMG_ID" vaultchat-go-api:latest && echo "   image restored"
    $DC up -d --no-deps go-api && echo "   go-api back on the previous image"
  fi
  echo "   prod is as it was. Nothing else was touched."
  exit 1
}

say "4/6 build go-api"
$DC build go-api || rollback

say "5/6 restart go-api only"
$DC up -d --no-deps go-api || rollback

say "6/6 verify"
for i in $(seq 1 30); do
  H=$(curl -s -m 5 http://127.0.0.1:8095/health 2>/dev/null)
  case "$H" in *'"status":"ok"'*) echo "health ok after ${i}s"; break;; esac
  [ "$i" = 30 ] && { echo "health never came up"; rollback; }
  sleep 1
done

# An EXISTING route must still answer exactly as before.
CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8095/calls/x/sfu-token)
echo "POST /calls/x/sfu-token -> $CODE   (401 = existing call routes unaffected)"
[ "$CODE" = "401" ] || { echo "an EXISTING route regressed"; rollback; }

echo
echo "DEPLOYED. join_chat now refuses a socket that is not a current member."
echo "A refusal logs: [join_chat] refused uid=… chat=… (not a current member)"
echo "and increments socket_join_chat_refused."
echo
echo "Watch for refusals (a burst would mean a legitimate client was broken):"
echo "  docker logs --since 10m vaultchat-go-api-1 2>&1 | grep join_chat"
echo
echo "Rollback:"
echo "  sudo cp $BAK/handlers.go $BAK/server.go $RT/"
echo "  cd $ROOT && $DC build go-api && $DC up -d --no-deps go-api"
