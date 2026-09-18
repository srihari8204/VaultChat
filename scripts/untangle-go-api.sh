#!/usr/bin/env bash
# One-shot repair: hand the go-api container back to Docker Compose.
#
# WHY THIS EXISTS
# The container serving the API (557e477bdd13, started 2026-09-16) was created
# by hand with `docker run`, not by compose: `docker inspect` shows empty
# com.docker.compose.project / .service / .config-hash labels, and
# `docker compose ps` does not list go-api at all. So every
# `compose up -d --no-deps go-api` tries to create `vaultchat-go-api-1`, finds
# that name held by a container it does not manage, and fails. scripts/deploy.sh
# hit exactly this at its step 7, and its rollback hit it again on the way back.
#
# Compose's go-api definition was diffed against the running container first:
# port 127.0.0.1:14000->4000, the same four binds, network vaultchat_default,
# restart unless-stopped, CCWIRE_WS=1, MESSAGE_BODIES=1, CCWIRE_APP_EVENTS=1.
# Recreating from compose is not a config change.
#
# SAFETY
#  * The live container is RENAMED and kept, never deleted. Rollback is one
#    rename plus one start, and is performed automatically if compose fails.
#  * The previous image stays tagged vaultchat-go-api:latest-ccwire.
#  * Downtime is the gap between stop and up: a few seconds. Check live calls
#    are 0 first (scripts/capture-baseline.ps1 section 6).
#
# Run it over stdin so no quoting has to survive the trip:
#   ssh root@65.21.229.167 "cat > /tmp/untangle.sh" < scripts/untangle-go-api.sh
#   ssh root@65.21.229.167 "sed -i 's/\r$//' /tmp/untangle.sh; bash /tmp/untangle.sh"

set -euo pipefail

ROOT=/home/srihari/vaultchat-clean
NEW_TAG=vaultchat-go-api:fp-45cb100cdc2f0338
OLD=vaultchat-go-api-1-manual-20260919-preswap
DC="docker compose -p vaultchat -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml"

cd "$ROOT"

say() { printf '\n== %s\n' "$1"; }

say "pre-flight"
docker image inspect "$NEW_TAG" >/dev/null \
  || { echo "ABORT: $NEW_TAG missing - nothing to deploy"; exit 1; }
docker inspect vaultchat-go-api-1 >/dev/null 2>&1 \
  || { echo "ABORT: vaultchat-go-api-1 not found - state is not what this script expects"; exit 1; }
echo "  new image:  $(docker images "$NEW_TAG" --format '{{.ID}}')"
echo "  rollback:   $(docker images vaultchat-go-api:latest-ccwire --format '{{.ID}}')  (tag: latest-ccwire)"
echo "  serving:    $(curl -s -m 10 http://127.0.0.1:8095/build || echo unreadable)"

say "point :latest at the built binary"
docker tag "$NEW_TAG" vaultchat-go-api:latest
echo "  latest -> $(docker images vaultchat-go-api:latest --format '{{.ID}}')"

say "move the unmanaged container aside (kept, not deleted)"
docker rename vaultchat-go-api-1 "$OLD"
docker stop "$OLD" >/dev/null
echo "  stopped $OLD  -- DOWNTIME STARTS"

say "let compose create a properly labelled container"
if $DC up -d --no-deps go-api; then
  echo "  compose up ok -- DOWNTIME ENDS"
else
  echo "  !! compose up FAILED - restoring the previous container"
  $DC rm -f go-api >/dev/null 2>&1 || true
  docker rename "$OLD" vaultchat-go-api-1
  docker start vaultchat-go-api-1 >/dev/null
  echo "  previous container is back up; nothing else was changed"
  exit 1
fi

say "health"
sleep 4
# A container that starts and then dies still answers nothing; check, do not assume.
printf '  health=%s ready=%s\n' \
  "$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8095/health)" \
  "$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8095/ready)"
echo "  build: $(curl -s -m 10 http://127.0.0.1:8095/build)"

say "compose now manages it"
$DC ps --format '{{.Name}} | {{.Service}} | {{.State}} | {{.Image}}' | grep go-api || true

cat <<'NOTE'

  The previous container is kept, stopped, as:
    vaultchat-go-api-1-manual-20260919-preswap
  Roll back with:
    docker compose -p vaultchat -f docker-compose.yml -f docker-compose.prod.yml \
      -f docker-compose.box.yml rm -f -s go-api
    docker rename vaultchat-go-api-1-manual-20260919-preswap vaultchat-go-api-1
    docker start vaultchat-go-api-1
  Delete it only once the new one has held for a day.
NOTE
