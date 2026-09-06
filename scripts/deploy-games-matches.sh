#!/usr/bin/env bash
#
# Deploy the Pool/Deals rummy match layer: migration 126 and two Go files.
#
# WHY THIS IS A SCRIPT AND NOT SOMETHING THE AGENT RAN
# ----------------------------------------------------
# The harness classifier refuses `scp` to prod from the assistant. Read-only ssh
# works (that is how the pre-flight below was rehearsed on 2026-09-06: ledger is
# 125, and prod's games.go is byte-identical to repo HEAD, so there is no local
# drift to lose). So this exists to make the deploy one command for a human.
#
# NO SUDO. `/home/srihari/vaultchat` is root:root and `sudo -n` fails on this
# box, so the install runs as root INSIDE a container with the checkout bind
# mounted. `--entrypoint sh` is mandatory: the image's own entrypoint starts the
# API and dies on an empty JWT_SECRET instead of copying. `--user 0:0` is needed
# for the migrations directory specifically.
#
# WHAT IT CHANGES
#   126_games_matches.sql   adds games_matches (new table, additive, idempotent)
#   games_matches.go        NEW — POST/GET /games/matches, POST /games/matches/deal
#   games.go                one added line registering those routes
#
# WITHOUT IT: the app's Pool & Deals panel offers a match, every call 404s and
# it silently stays on "Start a match" — by design, but the feature is inert.
#
# Usage:  bash scripts/deploy-games-matches.sh
# Safe to re-run: the migration is idempotent and the ledger insert is
# ON CONFLICT DO NOTHING.

set -euo pipefail

HOST="${VAULTCHAT_PROD_HOST:-srihari@65.21.229.167}"
DEST=/home/srihari/vaultchat
STAGE=/tmp/vc-matches-$$
PG=vaultchat-postgres-1
IMG=vaultchat-go-api:latest

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mABORT: %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. PRE-FLIGHT ─────────────────────────────────────────────────────
say "Pre-flight"
ssh "$HOST" 'echo ok' >/dev/null || die "cannot ssh to $HOST"

LEDGER=$(ssh "$HOST" "docker exec $PG psql -U vaultchat -d vaultchat -tAc 'select max(version::int) from schema_migrations'" | tr -d '\r')
echo "ledger on prod: $LEDGER"
case "$LEDGER" in
  125) : ;;
  126) echo "(already at 126 — the migration step will no-op)" ;;
  *) die "unexpected ledger '$LEDGER'; 126 expects 125. Look before you leap." ;;
esac

# The compose invocation must match the RUNNING stack; box.yml exists on the
# host and the running container's label lists THREE files. Read it off the
# container rather than guessing.
COMPOSE_FILES=$(ssh "$HOST" "docker inspect vaultchat-go-api-1 --format '{{index .Config.Labels \"com.docker.compose.project.config_files\"}}'" | tr -d '\r')
[ -n "$COMPOSE_FILES" ] || die "could not read the compose config_files label"
COMPOSE_ARGS=$(printf '%s' "$COMPOSE_FILES" | tr ',' '\n' | sed 's|.*/||' | sed 's/^/-f /' | tr '\n' ' ')
echo "compose: $COMPOSE_ARGS"

# Prod has been ahead of the repo before (chats_helpers.go carried a feature the
# repo lacked). Diff first, LF-normalised — CRLF alone would look like a
# difference that is not one. games_matches.go is new, so it has nothing to
# clobber; only games.go is being replaced.
say "Checking prod has no local changes we would overwrite"
remote=$(ssh "$HOST" "cat $DEST/vaultchat-backend-go/internal/routes/games.go" | tr -d '\r' | md5sum | cut -d' ' -f1)
head=$(git show "HEAD:vaultchat-backend-go/internal/routes/games.go" | tr -d '\r' | md5sum | cut -d' ' -f1)
[ "$remote" = "$head" ] || die "games.go on prod differs from repo HEAD. Someone edited it there — diff it by hand before deploying."
echo "ok  games.go matches HEAD"

# ── 2. BACKUP ─────────────────────────────────────────────────────────
say "Backing up the file we are about to replace"
BAK=/home/srihari/vc-bak-$(date +%Y%m%d-%H%M%S)
ssh "$HOST" "mkdir -p $BAK && cp $DEST/vaultchat-backend-go/internal/routes/games.go $BAK/ && ls $BAK"
echo "backup: $BAK"

# ── 3. STAGE, THEN INSTALL AS ROOT IN A CONTAINER ─────────────────────
say "Staging"
ssh "$HOST" "mkdir -p $STAGE/routes $STAGE/migrations"
scp -q vaultchat-backend-go/internal/routes/games.go \
       vaultchat-backend-go/internal/routes/games_matches.go "$HOST:$STAGE/routes/"
scp -q vaultchat-backend/migrations/126_games_matches.sql "$HOST:$STAGE/migrations/"

say "Installing"
ssh "$HOST" "docker run --rm --user 0:0 --entrypoint sh \
  -v $DEST:/w -v /tmp:/m $IMG -c \
  'cp /m/${STAGE#/tmp/}/routes/games.go /m/${STAGE#/tmp/}/routes/games_matches.go /w/vaultchat-backend-go/internal/routes/ && \
   cp /m/${STAGE#/tmp/}/migrations/126_games_matches.sql /w/vaultchat-backend/migrations/ && echo INSTALLED'"

say "Verifying by checksum — an exit code is not evidence the bytes landed"
for f in \
  "vaultchat-backend-go/internal/routes/games.go" \
  "vaultchat-backend-go/internal/routes/games_matches.go" \
  "vaultchat-backend/migrations/126_games_matches.sql"
do
  l=$(tr -d '\r' < "$f" | md5sum | cut -d' ' -f1)
  r=$(ssh "$HOST" "cat $DEST/$f 2>/dev/null" | tr -d '\r' | md5sum | cut -d' ' -f1)
  [ "$l" = "$r" ] || die "$f did NOT land (local $l / remote ${r:-missing})"
  echo "ok  $f"
done

# ── 4. MIGRATE ────────────────────────────────────────────────────────
# ON_ERROR_STOP so a failed statement is a failed step, not a green light.
# The ledger row carries migrate.js's checksum: sha256 of the LF-normalised
# file, first 16 hex chars — matching it keeps `migrate.js --verify` quiet.
say "Applying 126"
sum=$(tr -d '\r' < vaultchat-backend/migrations/126_games_matches.sql | sha256sum | cut -c1-16)
ssh "$HOST" "docker exec -i $PG psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 \
               -f - < $DEST/vaultchat-backend/migrations/126_games_matches.sql" \
  || die "migration 126 failed — nothing after this ran"
ssh "$HOST" "docker exec $PG psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -c \
  \"INSERT INTO schema_migrations (version, filename, checksum) \
    VALUES ('126', '126_games_matches.sql', '$sum') ON CONFLICT (version) DO NOTHING\"" >/dev/null
echo "applied 126"

# The DB-side guarantees the Go handler leans on and cannot check itself:
# the CHECKs, one-running-match-per-table, and the exactly-once deal guard.
# Self-cleaning — it rolls itself back.
say "Proving the schema (migrations/tests/126_games_matches_test.sql)"
ssh "$HOST" "docker exec -i $PG psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -f -" \
  < vaultchat-backend/migrations/tests/126_games_matches_test.sql \
  || die "the schema test failed — 126 is applied but does not behave as designed"

# ── 5. REBUILD ────────────────────────────────────────────────────────
say "Rebuilding go-api"
ssh "$HOST" "cd $DEST && docker compose $COMPOSE_ARGS build go-api && \
             docker compose $COMPOSE_ARGS up -d go-api"

# ── 6. VERIFY — THE PROBE THAT ACTUALLY PROVES IT ─────────────────────
# A 404 means the OLD binary is still serving: the route does not exist. A 401
# means the new one is up and asking for a session, which is the correct answer
# to an unauthenticated request. Same 404→401 probe that settled /games/tables
# and the MPIN deploy; do not accept "it built fine" as evidence.
say "Verifying"
ssh "$HOST" "sleep 6; curl -sS localhost/health || true; echo"
LED=$(ssh "$HOST" "docker exec $PG psql -U vaultchat -d vaultchat -tAc 'select max(version::int) from schema_migrations'" | tr -d '\r')
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://api.corefinite.com/games/matches?tableId=probe" || echo "?")
TBL=$(ssh "$HOST" "docker exec $PG psql -U vaultchat -d vaultchat -tAc \"select to_regclass('public.games_matches') is not null\"" | tr -d '\r')
IDX=$(ssh "$HOST" "docker exec $PG psql -U vaultchat -d vaultchat -tAc \"select count(*) > 0 from pg_indexes where indexname='games_matches_live_table_idx'\"" | tr -d '\r')

echo
echo "  ledger              : $LED   (want 126)"
echo "  /games/matches      : $CODE  (want 401 — 404 means the old binary is still running)"
echo "  games_matches       : $TBL   (want t)"
echo "  one-match-per-table : $IDX   (want t)"
echo
if [ "$LED" = "126" ] && [ "$CODE" = "401" ] && [ "$TBL" = "t" ] && [ "$IDX" = "t" ]; then
  printf '\033[32mDEPLOYED. Open a practice rummy table and pick a variant — the scoreboard should appear instead of the panel staying on "Start a match".\033[0m\n'
else
  printf '\033[31mNOT FULLY DEPLOYED — see the four lines above. Backup is at %s\033[0m\n' "$BAK"
  exit 1
fi
