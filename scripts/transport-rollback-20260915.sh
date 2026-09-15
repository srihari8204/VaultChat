#!/usr/bin/env bash
# Run on the server only after review. Also supplies rollout's shared checks.
set -Eeuo pipefail
umask 077
ROOT=/home/srihari/vaultchat-clean
RELEASE=/home/srihari/vaultchat-releases/transport-20260915
OVERRIDE="$ROOT/docker-compose.transport-20260915.yml"
DIRECT=http://127.0.0.1:14000
PUBLIC=https://api.corefinite.com
COMPOSE=(docker compose --project-name vaultchat --project-directory "$ROOT"
  -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.prod.yml"
  -f "$ROOT/docker-compose.box.yml" -f "$ROOT/docker-compose.ccwire.yml")

die() { printf '%s\n' "$*" >&2; exit 1; }
fetch() { curl --silent --show-error --fail --connect-timeout 4 --max-time 8 "$1"; }
build_source() { fetch "$1/build" | python3 -c 'import json,sys; print(json.load(sys.stdin)["source"])'; }
auth_required() {
  local code
  code=$(curl --silent --show-error --connect-timeout 4 --max-time 8 \
    --output /dev/null --write-out '%{http_code}' "$1/ccwire/v1") || return 1
  [[ "$code" == 401 ]]
}
healthy() {
  fetch "$1/health" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("db") is True and d.get("redis") is True else 1)' || return 1
  fetch "$1/ready" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ready") is True else 1)'
}
verify_release() {
  local expected=$1 attempt
  for attempt in {1..20}; do
    if healthy "$DIRECT" && [[ "$(build_source "$DIRECT")" == "$expected" ]] && auth_required "$DIRECT"; then
      # External TLS/proxy checks are required as well as the loopback check.
      healthy "$PUBLIC" && [[ "$(build_source "$PUBLIC")" == "$expected" ]] && auth_required "$PUBLIC" && return 0
    fi
    sleep 2
  done
  return 1
}
rollback() {
  local old_image old_build current
  [[ -f "$RELEASE/rollback/compose.yml" && -f "$RELEASE/rollback/old-image" && -f "$RELEASE/rollback/old-build" ]] || return 1
  old_image=$(cat "$RELEASE/rollback/old-image")
  old_build=$(cat "$RELEASE/rollback/old-build")
  [[ "$old_image" =~ ^sha256:[0-9a-f]{64}$ && "$old_build" =~ ^[0-9a-f]{16}$ ]] || return 1
  docker image inspect "$old_image" >/dev/null || return 1
  # Preserve base compose files, secrets, canonical source and all other services.
  # Keep the immutable rollback image pinned in the same durable override.
  cp "$RELEASE/rollback/compose.yml" "$OVERRIDE.tmp" || return 1
  mv "$OVERRIDE.tmp" "$OVERRIDE" || return 1
  "${COMPOSE[@]}" -f "$OVERRIDE" config --quiet || return 1
  "${COMPOSE[@]}" -f "$OVERRIDE" up -d --no-deps --no-build --pull never go-api || return 1
  current=$("${COMPOSE[@]}" -f "$OVERRIDE" ps -q go-api) || return 1
  [[ -n "$current" && "$(docker inspect --format '{{.Image}}' "$current")" == "$old_image" ]] || return 1
  verify_release "$old_build" || return 1
  date -u +%FT%TZ > "$RELEASE/rollback/verified-at"
  printf 'Rollback verified. Keep including %s in subsequent Compose commands.\n' "$OVERRIDE"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ -d "$RELEASE/rollback" ]] || die 'No prepared rollback state exists.'
  exec 9> /home/srihari/vaultchat-releases/.transport-rollout.lock
  flock -n 9 || die 'Another transport rollout or rollback is active.'
  rollback || die 'ROLLBACK FAILED: inspect go-api and restore the retained image manually; no other services were requested to restart.'
fi
