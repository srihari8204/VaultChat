#!/usr/bin/env bash
# Deploy openspec change microservices-prepare (phase 2 of the service split)
# to the Hetzner box. Run ON THE BOX, from the repo root:
#
#   ./deploy/microservices-prepare.sh            deploy the code (default mode)
#   ./deploy/microservices-prepare.sh migrate    then, separately, migration 139
#   ./deploy/microservices-prepare.sh rollback   put the previous go-api back
#
# WHAT THE DEPLOY CHANGES: nothing a user sees. No new env vars are set, so
# SERVICES defaults to all, access tokens stay HS256, and the new internal
# endpoints are unused. The one new runtime behaviour is that every background
# job takes a Postgres advisory lock while it runs.
#
# HOW IT STAYS SAFE
#   1. Refuses unless the running go-api reports the source this change was
#      built on (GET /build), because the box builds from a working tree and
#      copying files onto a tree that differs could break the build.
#   2. Copies only the files the change touched, as plain file writes (the git
#      index is not touched), and checks the resulting tree's fingerprint
#      equals the change's before building anything.
#   3. Builds the new image while the old container keeps serving; a failed
#      build restores the files and stops there.
#   4. Tags the running image first, so `rollback` is a restart, not a rebuild.
set -euo pipefail

BASE=ee3e282                       # the commit the box is expected to run
TARGET=8b3ef0f                     # the last code commit of the change
EXPECT_BEFORE=5cde069e0e0d9c1e     # scripts/fingerprint-go.sh at BASE
EXPECT_AFTER=e0156aa0295d17a7      # scripts/fingerprint-go.sh at TARGET
STATE=.deploy-microservices-prepare # backup tarball, image name, added files

cd "$(dirname "$0")/.."
[ -f docker-compose.box.yml ] || { echo "run this on the box: docker-compose.box.yml is missing" >&2; exit 1; }
dc() { docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml "$@"; }
say() { printf '\n== %s\n' "$*"; }
build_source() { curl -fsS -m 5 http://127.0.0.1:8095/build | sed -n 's/.*"source":"\([^"]*\)".*/\1/p'; }
health_ok() { curl -fsS -m 5 http://127.0.0.1:8095/health | grep -q '"status":"ok"'; }
changed_files() {
  git diff --name-only --diff-filter=AM "$BASE" "$TARGET" -- \
    vaultchat-backend-go vaultchat-backend/migrations/139_service_roles.sql \
    vaultchat-backend/migrations/tests/139_service_roles_test.sql
}

restore_files() {
  [ -f "$STATE/files.tgz" ] && tar xzf "$STATE/files.tgz"
  if [ -f "$STATE/added.txt" ]; then xargs -r rm -f < "$STATE/added.txt"; fi
}

wait_for() {   # wait_for <expected source>
  for _ in $(seq 1 30); do
    if health_ok && [ "$(build_source)" = "$1" ]; then return 0; fi
    sleep 2
  done
  return 1
}

deploy() {
  say "1/7 what is running now"
  running=$(build_source || true)
  echo "running source: ${running:-unreachable}"
  if [ "$running" = "$EXPECT_AFTER" ]; then echo "already deployed"; exit 0; fi
  if [ "$running" != "$EXPECT_BEFORE" ] && [ "${FORCE:-}" != "1" ]; then
    echo "expected $EXPECT_BEFORE (commit $BASE). The box runs other code, so" >&2
    echo "copying this change onto it is not known to build. Diff first; FORCE=1 overrides." >&2
    exit 1
  fi

  say "2/7 fetch the change"
  git fetch -q origin hetzner-deploy
  git cat-file -e "$TARGET^{commit}"

  say "3/7 back up and copy $(changed_files | wc -l) files"
  mkdir -p "$STATE"
  : > "$STATE/added.txt"
  existing=()
  while read -r f; do
    if [ -e "$f" ]; then existing+=("$f"); else echo "$f" >> "$STATE/added.txt"; fi
  done < <(changed_files)
  tar czf "$STATE/files.tgz" "${existing[@]}"
  while read -r f; do
    mkdir -p "$(dirname "$f")"
    git show "$TARGET:$f" > "$f"
  done < <(changed_files)

  say "4/7 fingerprint of the tree"
  local_fp=$(./scripts/fingerprint-go.sh)
  echo "tree: $local_fp (want $EXPECT_AFTER)"
  if [ "$local_fp" != "$EXPECT_AFTER" ]; then
    restore_files
    echo "the tree does not match the change; files restored, nothing built" >&2
    exit 1
  fi

  say "5/7 tag the running image, build the new one (old container keeps serving)"
  cid=$(dc ps -q go-api)
  image=$(docker inspect -f '{{.Config.Image}}' "$cid")
  image=${image%:latest}           # compose names it vaultchat-go-api; tag it by name
  docker tag "$(docker inspect -f '{{.Image}}' "$cid")" "$image:pre-microservices-prepare"
  echo "$image" > "$STATE/image.txt"
  if ! dc build go-api; then
    restore_files
    echo "build failed; files restored, the running go-api is untouched" >&2
    exit 1
  fi

  say "6/7 swap go-api"
  dc up -d --no-build go-api
  if ! wait_for "$EXPECT_AFTER"; then
    echo "new go-api did not come up healthy with source $EXPECT_AFTER — rolling back" >&2
    rollback
    exit 1
  fi

  say "7/7 checks"
  curl -fsS http://127.0.0.1:8095/health; echo
  curl -fsS http://127.0.0.1:8095/build; echo
  dc logs go-api --since 5m 2>&1 | grep -E '\[boot\] (services|access tokens)' || true
  if ! dc logs go-api --since 5m 2>&1 | grep -q 'services: calls, core, family, games, golive, maps, shopbook'; then
    echo "WARNING: boot log does not list all seven services — check SERVICES in the env files" >&2
  fi
  cat <<'EOF'

Deployed. Now, by hand:
  - two phones: log in, send a message, place a call, open a Family Space and ShopBook
  - for the next day, watch for lock errors and held connections:
      dc logs go-api --since 1h | grep -E '\[jobs\] .*lock'
      dc exec postgres psql -U vaultchat -d vaultchat -tc \
        "SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction'"
    (a handful at most, and only while a job runs)
  - roll back at any time: ./deploy/microservices-prepare.sh rollback
EOF
}

rollback() {
  say "rollback"
  [ -f "$STATE/image.txt" ] || { echo "no saved image; nothing to roll back to" >&2; exit 1; }
  image=$(cat "$STATE/image.txt")
  docker tag "$image:pre-microservices-prepare" "$image"
  restore_files
  dc up -d --no-build go-api
  if wait_for "$EXPECT_BEFORE"; then
    echo "rolled back: running $EXPECT_BEFORE again"
  else
    echo "rollback started but /build does not report $EXPECT_BEFORE yet — check dc logs go-api" >&2
    exit 1
  fi
}

migrate() {
  say "pending migrations"
  dc --profile legacy run --rm api node migrate.js status
  echo
  echo "This applies every pending migration up to 139 — possibly more than 139 (for"
  echo "example 138_pet_care_cap). 139 creates NOLOGIN roles and a view: inert until a"
  echo "role is given a password. Take a snapshot or dump first."
  read -r -p "Apply them now? Type yes: " ok
  [ "$ok" = "yes" ] || { echo "not applied"; exit 1; }
  dc --profile legacy run --rm api node migrate.js up --to 139
  say "migration 139 test (rolls itself back)"
  dc exec -T postgres psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -q \
    < vaultchat-backend/migrations/tests/139_service_roles_test.sql
}

case "${1:-deploy}" in
  deploy) deploy ;;
  rollback) rollback ;;
  migrate) migrate ;;
  *) echo "usage: $0 [deploy|migrate|rollback]" >&2; exit 2 ;;
esac
