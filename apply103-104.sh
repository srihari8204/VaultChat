#!/usr/bin/env bash
# Migrations 103 + 104 → REAL prod DB (container vaultchat-postgres-1, db
# vaultchat, role vaultchat — the one the Go API actually uses).
#
# WHY NOT migrate.js: ~/migrate-run/.env points at pgbouncer:6432 as
# vaultchat_app, which from the host resolves to the ABANDONED legacy
# Postgres (ledger frozen at 060). Running `migrate.js up` there would fire
# 40+ "pending" migrations at a dead database. Same reason apply102.sh went
# straight to the container.
#
# Both migrations are additive and non-destructive:
#   103  CREATE TABLE IF NOT EXISTS space_locations (+2 indexes, +1 view)
#   104  ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS (2 nullable cols;
#        metadata-only in PG11+, no table rewrite, no default backfill)
# Nothing existing is read, written or dropped, so the currently-deployed API
# (which predates both) is unaffected — schema-first is the correct order.
#
# Transactional and gated: every precondition is checked BEFORE any SQL runs;
# each migration applies with its ledger row in ONE transaction.
set -e
echo "running as: $(whoami) on $(hostname)"

RUN=/home/srihari/migrate-run
cd "$RUN"

# NO -i on the gate queries: this script arrives on bash's stdin and an
# interactive docker exec would swallow the rest of it (see apply102.sh).
PSQL="docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tA"

MAX=$($PSQL -c "SELECT max(version) FROM schema_migrations")
[ "$MAX" = "102" ] || { echo "ABORT: ledger max is $MAX, expected 102 — nothing executed"; exit 1; }
echo "PRECHECK: ledger at 102 (real prod DB confirmed — legacy answers 060)"

HASTBL=$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_name='space_locations'")
[ "$HASTBL" = "0" ] || { echo "ABORT: space_locations already exists — nothing executed"; exit 1; }
HASCOL=$($PSQL -c "SELECT count(*) FROM information_schema.columns WHERE table_name='chat_members' AND column_name='location_sharing_enabled'")
[ "$HASCOL" = "0" ] || { echo "ABORT: location_sharing_enabled already exists — nothing executed"; exit 1; }
echo "PRECHECK: 103 and 104 both pending"

for V in 103:103_space_locations 104:104_location_sharing_state; do
  NUM="${V%%:*}"; NAME="${V##*:}"; MIG="$RUN/migrations/$NAME.sql"
  test -f "$MIG" || { echo "ABORT: missing $MIG"; exit 1; }

  N=$($PSQL -c "SELECT count(*) FROM schema_migrations WHERE version='$NUM'")
  [ "$N" = "0" ] || { echo "ABORT: $NUM already recorded — nothing further executed"; exit 1; }

  CS=$(node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('migrations/$NAME.sql','utf8').replace(/\r\n/g,'\n')).digest('hex').slice(0,16))")
  echo "applying $NUM ($NAME) checksum=$CS"

  { cat "$MIG"
    printf "INSERT INTO schema_migrations(version,filename,checksum) VALUES ('%s','%s.sql','%s');\n" "$NUM" "$NAME" "$CS"
  } | docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -1
  echo "APPLIED_OK $NUM"
done

echo "=== VERIFY ==="
$PSQL -c "SELECT 'ledger_max: '||max(version) FROM schema_migrations"
$PSQL -c "SELECT 'space_locations: '||count(*) FROM information_schema.tables WHERE table_name='space_locations'"
$PSQL -c "SELECT 'latest_view: '||count(*) FROM information_schema.views WHERE table_name='space_locations_latest'"
$PSQL -c "SELECT 'indexes: '||count(*) FROM pg_indexes WHERE tablename='space_locations'"
$PSQL -c "SELECT 'sharing_cols: '||count(*) FROM information_schema.columns WHERE table_name='chat_members' AND column_name LIKE 'location_sharing%'"
$PSQL -c "SELECT 'rows_in_new_table: '||count(*) FROM space_locations"
