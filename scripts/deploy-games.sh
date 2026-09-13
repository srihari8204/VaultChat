#!/usr/bin/env bash
#
# Deploy the mini-games backend: migrations 124 + 125 and four Go files.
#
# WHY THIS IS A SCRIPT AND NOT SOMETHING THE AGENT RAN
# ----------------------------------------------------
# Every prod write from the assistant is refused by the harness classifier, so
# this exists to make the deploy one command for a human instead of a dozen.
# Everything it does was rehearsed read-only against prod on 2026-09-02:
# the four Go files there are byte-identical to repo HEAD (no local drift to
# lose), the ledger is at 123, and `messages` is 877 rows / 2 MB so the CHECK
# swap in 124 is instantaneous.
#
# WHAT IT CHANGES
#   124_game_invite_message.sql  widens messages.type to admit 'game_invite'
#                                (strict superset of 075 — it can only accept
#                                rows that were previously rejected)
#   125_games_live_tables.sql    adds games_live_tables (new table, additive)
#   chats_helpers.go             accepts + validates the game_invite type
#   games.go                     GET/DELETE /games/tables, scoped by user
#   games_notify.go              records a live table beside the push
#   jobs.go                      14-day sweep for that table
#
# WITHOUT IT: sending a game invite returns 400 "invalid type", and the
# "Your games" list is permanently empty (GET /games/tables → 404).
#
# Usage:  bash scripts/deploy-games.sh
# You will be prompted for the sudo password on the box (there is no NOPASSWD).
# Safe to re-run: both migrations are idempotent and the ledger insert is
# ON CONFLICT DO NOTHING.

set -euo pipefail

HOST="${VAULTCHAT_PROD_HOST:-srihari@65.21.229.167}"
DEST=/home/srihari/vaultchat
STAGE=/tmp/vc-games-$$
PG=vaultchat-postgres-1

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mABORT: %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. PRE-FLIGHT ─────────────────────────────────────────────────────
say "Pre-flight"
ssh "$HOST" 'echo ok' >/dev/null || die "cannot ssh to $HOST"

LEDGER=$(ssh "$HOST" "docker exec $PG psql -U vaultchat -d vaultchat -tAc 'select max(version::int) from schema_migrations'" | tr -d '\r')
echo "ledger on prod: $LEDGER"
case "$LEDGER" in
  12[0-3]) : ;;
  12[45]) echo "(already at $LEDGER — the migration steps will no-op)" ;;
  *) die "unexpected ledger '$LEDGER'; look before you leap" ;;
esac

# The compose invocation must match the RUNNING stack; box.yml exists on the
# host and is NOT in use. Read it off the container rather than guessing.
COMPOSE_FILES=$(ssh "$HOST" "docker inspect vaultchat-go-api-1 --format '{{index .Config.Labels \"com.docker.compose.project.config_files\"}}'" | tr -d '\r')
[ -n "$COMPOSE_FILES" ] || die "could not read the compose config_files label"
COMPOSE_ARGS=$(printf '%s' "$COMPOSE_FILES" | tr ',' '\n' | sed 's|.*/||' | sed 's/^/-f /' | tr '\n' ' ')
echo "compose: $COMPOSE_ARGS"

# Prod has been ahead of the repo on chats_helpers.go before. Diff first,
# LF-normalised — CRLF alone would look like a difference that is not one.
say "Checking prod has no local changes we would overwrite"
for f in internal/routes/chats_helpers.go internal/routes/games.go \
         internal/routes/games_notify.go internal/jobs/jobs.go; do
  remote=$(ssh "$HOST" "cat $DEST/vaultchat-backend-go/$f" | tr -d '\r' | md5sum | cut -d' ' -f1)
  head=$(git show "HEAD:vaultchat-backend-go/$f" | tr -d '\r' | md5sum | cut -d' ' -f1)
  if [ "$remote" != "$head" ]; then
    die "$f on prod differs from repo HEAD. Someone edited it there — diff it by hand before deploying."
  fi
  echo "ok  $f matches HEAD"
done

# ── 2. BACKUP ─────────────────────────────────────────────────────────
say "Backing up the files we are about to replace"
BAK=/home/srihari/vc-bak-$(date +%Y%m%d-%H%M%S)
ssh "$HOST" "mkdir -p $BAK && cd $DEST && cp vaultchat-backend-go/internal/routes/chats_helpers.go \
  vaultchat-backend-go/internal/routes/games.go vaultchat-backend-go/internal/routes/games_notify.go \
  vaultchat-backend-go/internal/jobs/jobs.go $BAK/ && ls $BAK"
echo "backup: $BAK"

# ── 3. STAGE (unprivileged) ───────────────────────────────────────────
# Never `echo PASS | sudo -S tee file`: sudo eats stdin for the password and
# tee then writes ZERO bytes over the target. Land in /tmp, then sudo cp.
say "Staging"
ssh "$HOST" "mkdir -p $STAGE/routes $STAGE/jobs $STAGE/migrations"
scp -q vaultchat-backend-go/internal/routes/chats_helpers.go \
       vaultchat-backend-go/internal/routes/games.go \
       vaultchat-backend-go/internal/routes/games_notify.go "$HOST:$STAGE/routes/"
scp -q vaultchat-backend-go/internal/jobs/jobs.go "$HOST:$STAGE/jobs/"
scp -q vaultchat-backend/migrations/124_game_invite_message.sql \
       vaultchat-backend/migrations/125_games_live_tables.sql "$HOST:$STAGE/migrations/"

say "Installing (sudo password prompt follows)"
ssh -t "$HOST" "sudo cp $STAGE/routes/chats_helpers.go $STAGE/routes/games.go $STAGE/routes/games_notify.go \
                     $DEST/vaultchat-backend-go/internal/routes/ && \
                sudo cp $STAGE/jobs/jobs.go $DEST/vaultchat-backend-go/internal/jobs/ && \
                sudo cp $STAGE/migrations/*.sql $DEST/vaultchat-backend/migrations/ && echo INSTALLED"

say "Verifying by checksum — an exit code is not evidence the bytes landed"
for pair in \
  "vaultchat-backend-go/internal/routes/chats_helpers.go" \
  "vaultchat-backend-go/internal/routes/games.go" \
  "vaultchat-backend-go/internal/routes/games_notify.go" \
  "vaultchat-backend-go/internal/jobs/jobs.go" \
  "vaultchat-backend/migrations/124_game_invite_message.sql" \
  "vaultchat-backend/migrations/125_games_live_tables.sql"
do
  l=$(md5sum "$pair" | cut -d' ' -f1)
  r=$(ssh "$HOST" "sudo md5sum $DEST/$pair 2>/dev/null | cut -d' ' -f1" | tr -d '\r' || true)
  [ "$l" = "$r" ] || die "$pair did NOT land (local $l / remote ${r:-missing})"
  echo "ok  $pair"
done

# ── 4. MIGRATE ────────────────────────────────────────────────────────
# ON_ERROR_STOP so a failed statement is a failed step, not a green light.
# The ledger row carries migrate.js's checksum: sha256 of the LF-normalised
# file, first 16 hex chars — matching it keeps `migrate.js --verify` quiet.
say "Applying 124 and 125"
for m in 124_game_invite_message 125_games_live_tables; do
  sum=$(tr -d '\r' < "vaultchat-backend/migrations/$m.sql" | sha256sum | cut -c1-16)
  ver=${m%%_*}
  ssh "$HOST" "docker exec -i $PG psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 \
                 -f - < $DEST/vaultchat-backend/migrations/$m.sql" \
    || die "migration $m failed — nothing after this ran"
  ssh "$HOST" "docker exec $PG psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -c \
    \"INSERT INTO schema_migrations (version, filename, checksum) \
      VALUES ('$ver', '$m.sql', '$sum') ON CONFLICT (version) DO NOTHING\"" >/dev/null
  echo "applied $m"
done

# ── 5. REBUILD ────────────────────────────────────────────────────────
say "Rebuilding go-api"
# --pull is not optional. The Dockerfile builds from the FLOATING tag
# golang:1.26-alpine, so without it the build silently reuses whichever base
# layer this box cached — production was three patch releases behind on
# go1.26.5, with standard-library fixes in 1.26.6/.7/.8, and nothing said so.
# GET /build now reports the toolchain; this is what keeps it current.
ssh -t "$HOST" "cd $DEST && sudo docker compose $COMPOSE_ARGS build --pull go-api && \
                sudo docker compose $COMPOSE_ARGS up -d go-api"

# ── 6. VERIFY — THE PROBE THAT ACTUALLY PROVES IT ─────────────────────
# A 404 means the OLD binary is still serving: the route does not exist. A 401
# means the new one is up and asking for a session, which is the correct answer
# to an unauthenticated request. This is the same 404→401 probe that settled the
# MPIN deploy; do not accept "it built fine" as evidence.
say "Verifying"
ssh "$HOST" "sleep 6; curl -sS localhost/health || true; echo"
LED=$(ssh "$HOST" "docker exec $PG psql -U vaultchat -d vaultchat -tAc 'select max(version::int) from schema_migrations'" | tr -d '\r')
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://api.corefinite.com/games/tables || echo "?")
TBL=$(ssh "$HOST" "docker exec $PG psql -U vaultchat -d vaultchat -tAc \"select to_regclass('public.games_live_tables') is not null\"" | tr -d '\r')
CHK=$(ssh "$HOST" "docker exec $PG psql -U vaultchat -d vaultchat -tAc \"select position('game_invite' in pg_get_constraintdef(oid)) > 0 from pg_constraint where conname='messages_type_check'\"" | tr -d '\r')

echo
echo "  ledger              : $LED   (want 125)"
echo "  /games/tables       : $CODE  (want 401 — 404 means the old binary is still running)"
echo "  games_live_tables   : $TBL   (want t)"
echo "  messages accepts    : $CHK   (want t — the game_invite CHECK)"
echo
if [ "$LED" = "125" ] && [ "$CODE" = "401" ] && [ "$TBL" = "t" ] && [ "$CHK" = "t" ]; then
  printf '\033[32mDEPLOYED. Send a game invite from the app — the card should post instead of "invalid type".\033[0m\n'
else
  printf '\033[31mNOT FULLY DEPLOYED — see the four lines above. Backup is at %s\033[0m\n' "$BAK"
  exit 1
fi
