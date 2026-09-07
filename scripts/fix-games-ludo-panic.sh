#!/usr/bin/env bash
#
# FIX: a Ludo turn timeout crashes the ENTIRE games server (chess included).
#
# Run on vaultchatprod01 (65.21.229.167) as a user who can sudo.
#   sudo bash scripts/fix-games-ludo-panic.sh
#
# WHY THIS IS A SCRIPT AND NOT SOMETHING THE AGENT RAN
# ----------------------------------------------------
# The read-only investigation was done from the assistant over SSH. The deploy
# was not: /opt/vaultgames/go-server is root-owned and sudo on this box is
# password-gated (no NOPASSWD), and /opt/vaultgames/keys is 0700. Same reason
# scripts/deploy-games.sh exists.
#
# ROOT CAUSE (proven from the running server's own stack trace)
# ------------------------------------------------------------
#   panic: runtime error: invalid memory address or nil pointer dereference
#     realtime.(*LudoRoomManager).doRoll        ludorooms.go:442
#     realtime.(*LudoRoomManager).autoPlay      ludorooms.go:598
#     realtime.(*LudoRoomManager).onTurnTimeout ludorooms.go:593
#     realtime.(*LudoRoomManager).startTurnClock.func1  ludorooms.go:560
#     created by time.goFunc
#
#   armTurn() mints r.commit and starts the turn clock.
#   doRoll() spends it — `r.commit = nil` — and does NOT stop that clock.
#   So a player who ROLLS and then runs out of time BEFORE MOVING reaches
#   onTurnTimeout -> autoPlay -> doRoll with r.commit == nil, and line 442
#   dereferences it.
#
#   Roll() (the human path) already guards this: `if r.commit == nil { ...
#   "no roll ready"; return }`. autoPlay() does not.
#
#   An unrecovered panic in a timer goroutine kills the WHOLE Go process. There
#   is no recover() in ludorooms.go. So one abandoned Ludo turn takes down
#   chess, ludo and every live room on the server. Observed: RestartCount=6.
#
# THE FIX — two guards, no behaviour change on any working path
#   1. doRoll(): return early if the commitment is already spent. This is the
#      choke point, so no future caller can repeat the mistake.
#   2. autoPlay(): only roll when a commitment is outstanding. A player who
#      already rolled just needs their MOVE played — the existing code right
#      after the roll already handles that via st.PendingDie, so auto-play now
#      completes the turn instead of crashing.
#
# NOT CHANGED: the WebSocket protocol, room semantics, matchmaking, private
# rooms, bot behaviour, reconnect, chess, the fairness commit-reveal scheme,
# room allocation, defaultRoom, chess-main/ludo-main.
#
set -euo pipefail

F=/opt/vaultgames/go-server/internal/realtime/ludorooms.go
BASE_SHA=9c6102fe11d699bc5e56fa5e2576234e62019de3c61de1bb520a5fee43a1ec97
STAMP=$(date +%Y%m%d-%H%M%S)
BAK=/opt/vaultgames/backups/ludo-panic-$STAMP

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mABORT: %s\033[0m\n' "$1" >&2; exit 1; }

say "0. Preflight"
[ "$(id -u)" = 0 ] || die "run with sudo"
test -f "$F" || die "source not found at $F"
GOT=$(sha256sum "$F" | cut -d' ' -f1)
[ "$GOT" = "$BASE_SHA" ] || die "ludorooms.go has changed since this patch was written.
  expected $BASE_SHA
  got      $GOT
  Re-derive the patch against the current file rather than forcing it."

# ACTIVE-GAME PROTECTION. Recreating the container drops every live socket.
say "1. Active games check"
WS=$(docker logs --since 10m vaultchat-games 2>&1 | grep -cE '"status":101' || true)
echo "   websocket upgrades in the last 10 min: $WS"
if [ "${WS:-0}" -gt 0 ]; then
  echo "   Someone may be mid-game. Ctrl-C now and come back when it is quiet,"
  echo "   or continue if you know those are your own test sessions."
  read -r -p "   continue? [y/N] " a; [ "$a" = y ] || die "stopped by operator"
fi

say "2. Backup (source + current image id)"
mkdir -p "$BAK"
cp -a "$F" "$BAK/ludorooms.go.orig"
docker inspect vaultchat-games --format '{{.Image}}' > "$BAK/image-id.txt"
docker tag vaultchat-games:latest "vaultchat-games:pre-ludo-panic-$STAMP"
echo "   source -> $BAK/ludorooms.go.orig"
echo "   image  -> vaultchat-games:pre-ludo-panic-$STAMP ($(cat "$BAK/image-id.txt"))"

say "3. Apply the two guards"
# Exact-string surgery, NOT `patch`: this file is Go and indented with TABS, and
# a unified diff loses them the moment it passes through a nested heredoc. The
# patcher re-checks the base sha, requires exactly one match per edit, and is
# idempotent (re-running reports ALREADY PATCHED and exits 0).
python3 "$(dirname "$0")/fix-games-ludo-panic.py" --check || die "pre-check failed"
python3 "$(dirname "$0")/fix-games-ludo-panic.py" --apply || die "apply failed"

say "4. Build"
cd /opt/vaultgames/go-server
docker build -t vaultchat-games:latest . || die "build failed — source is patched but the OLD image is still running, so production is unaffected. Restore with step R1 if you want the source back."

say "5. Recreate the container (uses the project's own run.sh)"
/opt/vaultgames/run.sh || die "run.sh reported a degraded start — see rollback R2"

say "6. Verify"
sleep 3
curl -sf -o /dev/null -w '   /healthz          -> %{http_code}\n' http://127.0.0.1:8096/healthz || die "unhealthy"
curl -s -o /dev/null -w '   public /healthz    -> %{http_code}\n' https://games.corefinite.com/healthz
curl -s -o /dev/null -w '   /chess/ws (426 ok) -> %{http_code}\n' https://games.corefinite.com/chess/ws
curl -s -o /dev/null -w '   /ludo/ws  (426 ok) -> %{http_code}\n' https://games.corefinite.com/ludo/ws
echo "   restart count (should be 0 on the fresh container):"
docker inspect vaultchat-games --format '     {{.RestartCount}}'
echo "   panics since start (want 0):"
docker logs vaultchat-games 2>&1 | grep -c 'panic: runtime error' || true

cat <<EOF

== Reproduce the original crash to confirm it is gone ==
  1. Open Ludo vs a bot, roll the dice, then DO NOT move.
  2. Let the turn clock expire.
     Before: the server panicked and every room died.
     After:  the bot plays your move and the game continues.
  3. Confirm no new panic:
       docker logs --since 10m vaultchat-games 2>&1 | grep -c 'panic: runtime error'

== Rollback ==
  R1 source only:
       cp -a $BAK/ludorooms.go.orig $F
  R2 full (source + image + container):
       cp -a $BAK/ludorooms.go.orig $F
       docker tag vaultchat-games:pre-ludo-panic-$STAMP vaultchat-games:latest
       /opt/vaultgames/run.sh
     The previous image is kept as vaultchat-games:pre-ludo-panic-$STAMP and is
     not pruned by this script.
EOF
