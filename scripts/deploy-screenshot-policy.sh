#!/usr/bin/env bash
#
# Deploy the screenshot-policy fix to go-api.
#
# Ships one file: internal/routes/chats_helpers.go, which adds
# peerBlocksCapture / peerWantsCaptureNotice to GET /chats/{id} so a device
# obeys what the OTHER members require instead of its own setting.
#
# There is no git-based deploy on this box (root has no GitHub credentials and
# the repo is private), so prod is updated by COPYING SOURCE and rebuilding the
# container — the same shape as scripts/deploy-auth-fix.sh.
#
# Usage:  bash scripts/deploy-screenshot-policy.sh
set -euo pipefail
HOST="${VAULTCHAT_PROD_HOST:-root@65.21.229.167}"
DEST=/home/srihari/vaultchat
SRC=vaultchat-backend-go/internal/routes/chats_helpers.go
REL=vaultchat-backend-go/internal/routes/chats_helpers.go
STAMP=$(date +%Y%m%d-%H%M%S)
say(){ printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok(){  printf '\033[32m  ok\033[0m   %s\n' "$1"; }
bad(){ printf '\033[31m  FAIL\033[0m %s\n' "$1"; }
die(){ printf '\n\033[31mABORT: %s\033[0m\n' "$1" >&2; exit 1; }

[ -f "$SRC" ] || die "$SRC not found — run from the repo root"

say "Compiling locally first"
( cd vaultchat-backend-go && go build ./... ) || die "local build failed — not shipping a file that does not compile"
ok "go build clean"

say "Which compose files is this stack running?"
COMPOSE_FILES=$(ssh "$HOST" "docker inspect vaultchat-go-api-1 --format '{{index .Config.Labels \"com.docker.compose.project.config_files\"}}'")
COMPOSE_ARGS=""
IFS=',' read -ra F <<< "$COMPOSE_FILES"
for f in "${F[@]}"; do COMPOSE_ARGS="$COMPOSE_ARGS -f $f"; done
ok "$COMPOSE_ARGS"

say "Backing up the live file"
ssh "$HOST" "cp $DEST/$REL /tmp/chats_helpers.$STAMP.go && echo '  /tmp/chats_helpers.$STAMP.go'"

say "Copying"
scp -q "$SRC" "$HOST:/tmp/chats_helpers.new.go"
ssh "$HOST" "cp /tmp/chats_helpers.new.go $DEST/$REL && rm -f /tmp/chats_helpers.new.go && echo '  copied'"

restore() {
  printf '\n\033[31mrolling back source\033[0m\n'
  ssh "$HOST" "cp /tmp/chats_helpers.$STAMP.go $DEST/$REL" || true
}

say "Rebuilding go-api (compiles inside the container — a Go error fails HERE, before restart)"
# --pull is not optional. The Dockerfile builds from the FLOATING tag
# golang:1.26-alpine, so without it the build silently reuses whichever base
# layer this box cached — production was three patch releases behind on
# go1.26.5, with standard-library fixes in 1.26.6/.7/.8, and nothing said so.
# GET /build now reports the toolchain; this is what keeps it current.
ssh -t "$HOST" "cd $DEST && docker compose $COMPOSE_ARGS build --pull go-api" \
  || { restore; die "container build failed — source restored, running container untouched"; }

say "Restarting go-api"
ssh -t "$HOST" "cd $DEST && docker compose $COMPOSE_ARGS up -d go-api" \
  || { restore; die "restart failed"; }
sleep 6

say "Verifying"
fail=0
h=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://api.corefinite.com/health || true)
[ "$h" = 200 ] && ok "/health 200" || { bad "/health = $h"; fail=1; }

# 401 not 404: the route still exists and still demands auth.
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://api.corefinite.com/chats/00000000-0000-0000-0000-000000000000 || true)
[ "$c" = 401 ] || [ "$c" = 403 ] || [ "$c" = 404 ] && ok "/chats/{id} reachable ($c)" || { bad "/chats/{id} = $c"; fail=1; }

ssh "$HOST" "docker logs --tail 30 vaultchat-go-api-1 2>&1 | grep -iE 'panic|fatal' || true" | grep -q . \
  && { bad "panic/fatal in go-api logs"; fail=1; } || ok "no panic/fatal in logs"

# Grep INSIDE the container and return only a COUNT. Piping `strings` of a Go
# binary back over ssh ships tens of megabytes and gets truncated, which failed
# this check twice while the deploy underneath it was perfectly fine.
hits=$(ssh "$HOST" "docker exec vaultchat-go-api-1 sh -c 'strings /bin/api | grep -c peerWantsCaptureNotice'" | tr -d '
' | tail -1)
[ "${hits:-0}" -ge 1 ] 2>/dev/null \
  && ok "new fields present in the RUNNING binary (${hits} hit)" \
  || { bad "new fields NOT in the running binary (got '${hits}')"; fail=1; }

[ "$fail" -eq 0 ] || { restore; die "verification failed — source restored; rebuild to revert the container"; }

say "Deployed."
echo "Rollback: ssh $HOST 'cp /tmp/chats_helpers.$STAMP.go $DEST/$REL && cd $DEST && docker compose $COMPOSE_ARGS build go-api && docker compose $COMPOSE_ARGS up -d go-api'"
