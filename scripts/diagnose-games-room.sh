#!/usr/bin/env bash
#
# Diagnose a stuck games room (e.g. `chess-main`) on games.corefinite.com.
#
# READ-ONLY. This script changes NOTHING. It ends by printing what it found and
# what the options are; the fix is deliberately a separate, human decision at
# the bottom, because the right one depends on what this discovers.
#
# WHY THIS IS A SCRIPT AND NOT SOMETHING THE AGENT RAN
# ----------------------------------------------------
# Same reason as scripts/deploy-games.sh: every prod action from the assistant
# is refused by the harness classifier — SSH included, even read-only. So this
# exists to make the diagnosis one command for a human.
#
# WHAT WE KNOW (verified 2026-09-07, without touching the box)
#   * games.corefinite.com resolves to 65.21.229.167 — the SAME host as
#     api.corefinite.com and prod. It is not a third party.
#   * The service is HEALTHY: GET /healthz -> 200, /chess/ws and /ludo/ws -> 426
#     (correct WebSocket upgrade). This is stuck ROOM STATE, not a dead service.
#   * It installs under /opt/vaultgames (docs/GAMES_INTEGRATION.md references
#     /opt/vaultgames/keys/notify.pub).
#   * Its SOURCE IS NOT IN THIS REPO. docs/GAMES_PROTOCOL.md says the protocol
#     was reverse-engineered from the deployed clients. So this script
#     DISCOVERS how it runs rather than assuming.
#
# THE SYMPTOM THIS IS FOR
#   In room `chess-main`, "Add a bot" is accepted and no bot is ever seated, so
#   "Start game" stays disabled forever. A FRESH room starts instantly, which is
#   what points at that one room's state rather than at the code.
#   Reproduce:  vaultchat://games?game=chess&auto=1&bot=1     (stuck)
#               vaultchat://games?game=chess&room=xyz123&auto=1&bot=1  (works)
#
# Usage:  bash scripts/diagnose-games-room.sh
#         VAULTCHAT_PROD_HOST=srihari@65.21.229.167 bash scripts/...
#
set -uo pipefail          # NOT -e: a probe that finds nothing must not abort

HOST="${VAULTCHAT_PROD_HOST:-srihari@65.21.229.167}"
ROOM="${ROOM:-chess-main}"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }

say "Target"
note "host : $HOST"
note "room : $ROOM"
note "This script is READ-ONLY. It will not restart, delete or modify anything."

say "1. How does the games service run?"
ssh "$HOST" '
  echo "-- systemd units matching game/vault --"
  systemctl list-units --type=service --all 2>/dev/null | grep -iE "game|vault" | head -20 || true
  echo "-- docker containers --"
  (docker ps -a --format "{{.Names}}\t{{.Image}}\t{{.Status}}" 2>/dev/null || sudo docker ps -a --format "{{.Names}}\t{{.Image}}\t{{.Status}}" 2>/dev/null) | head -20 || true
  echo "-- pm2 --"
  (pm2 list 2>/dev/null | head -20) || echo "   (no pm2)"
  echo "-- /opt/vaultgames --"
  ls -la /opt/vaultgames 2>/dev/null | head -20 || sudo ls -la /opt/vaultgames 2>/dev/null | head -20 || echo "   (not readable without sudo)"
'

say "2. Is room state IN MEMORY or PERSISTED?"
note "This decides everything: if in-memory, a restart clears it (and every"
note "other live game with it). If persisted, a restart will NOT help."
ssh "$HOST" '
  echo "-- any redis? --"
  (redis-cli ping 2>/dev/null && redis-cli --scan --pattern "*chess*" 2>/dev/null | head -20) || echo "   (no local redis / not reachable)"
  echo "-- state files under /opt/vaultgames --"
  sudo find /opt/vaultgames -maxdepth 3 \( -name "*.db" -o -name "*.sqlite*" -o -name "*.json" -o -name "*state*" -o -name "*room*" \) 2>/dev/null | head -20 || true
  echo "-- does it use postgres? --"
  sudo docker exec vaultchat-postgres-1 psql -U postgres -l 2>/dev/null | head -15 || echo "   (could not list databases)"
'

say "3. What does the service say about this room?"
ssh "$HOST" "
  echo '-- recent logs mentioning the room / addbot --'
  (journalctl -u vaultgames --since '2 hours ago' --no-pager 2>/dev/null | grep -iE '$ROOM|addbot|bot' | tail -30) \
    || (sudo docker logs --since 2h \$(sudo docker ps --format '{{.Names}}' | grep -i game | head -1) 2>&1 | grep -iE '$ROOM|addbot|bot' | tail -30) \
    || echo '   (no logs found by either route — check the unit/container name from step 1)'
"

say "4. Health, from the box itself"
ssh "$HOST" '
  curl -s -o /dev/null -w "   local /healthz -> %{http_code}\n" http://127.0.0.1/healthz 2>/dev/null || true
  echo "-- listening ports --"
  sudo ss -ltnp 2>/dev/null | grep -E ":(80|443|8080|8090|8095|3000)" | head -10 || true
'

cat <<'EOF'

== What to do with the answer ==

DO NOT run any of these blind. Pick based on step 2.

A. State is IN MEMORY (no redis keys, no state files)
   A restart clears chess-main — AND every other room, including live games in
   progress. Do it when the tables are empty. Check first:
       sudo docker logs --tail 50 <games-container>     # any active play?
   Then the service's own restart, e.g.
       sudo systemctl restart vaultgames
       # or: sudo docker restart <games-container>
   Verify:  curl -s -o /dev/null -w '%{http_code}\n' https://games.corefinite.com/healthz
   Then reproduce the deep link above and confirm a bot seats.

B. State is PERSISTED (redis keys / a state file / a table)
   A restart will NOT fix it. Remove only the ONE room, never a wildcard:
       redis-cli DEL "<exact key for chess-main>"        # exact key only
   Take a backup of the key/row first. A wildcard delete here would drop every
   room on the server.

C. Nothing conclusive
   Stop. The games server's source is not in this repo, so anything past this
   point is guessing at another service's internals on production. Get its
   maintainer, or its source, before mutating state.

== The client side is already handled ==
Regardless of which applies, the app no longer fails silently: "Add a bot" now
reports when no seat appears within 6s (lib/games/useAddBot.ts). That is a
symptom fix, not a cure — this room still needs clearing.
EOF
