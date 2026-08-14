#!/usr/bin/env bash
# Migration 102 → REAL prod DB (container vaultchat-postgres-1, db vaultchat,
# role vaultchat — the one the Go API uses). Transactional, ledgered, and
# gated: every precondition is checked BEFORE any SQL executes; any failure
# aborts with the reason. Absolute paths — no reliance on ~ or login HOME.
set -e
echo "running as: $(whoami) on $(hostname)"

RUN=/home/srihari/migrate-run
MIG="$RUN/migrations/102_ops_summary_business.sql"
test -f "$MIG" || { echo "ABORT: missing $MIG"; exit 1; }
cd "$RUN"

CS=$(node -e 'const fs=require("fs"),c=require("crypto");console.log(c.createHash("sha256").update(fs.readFileSync("migrations/102_ops_summary_business.sql","utf8").replace(/\r\n/g,"\n")).digest("hex").slice(0,16))')
echo "checksum=$CS"

# NO -i here: this script arrives on bash's stdin, and an interactive docker
# exec inside it would swallow the remainder of the script as its own stdin
# (observed: silent stop after the checksum line). Only the apply pipeline
# below attaches stdin, and there it is the pipe, not the script.
PSQL="docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tA"

N102=$($PSQL -c "SELECT count(*) FROM schema_migrations WHERE version='102'")
[ "$N102" = "0" ] || { echo "ABORT: migration 102 already recorded ($N102 rows) — nothing executed"; exit 1; }
echo "PRECHECK: migration 102 pending"

MAX=$($PSQL -c "SELECT max(version) FROM schema_migrations")
[ "$MAX" = "101" ] || { echo "ABORT: ledger max is $MAX, expected 101 — nothing executed"; exit 1; }
echo "PRECHECK: current migration 101"

HASNEW=$($PSQL -c "SELECT count(*) FROM pg_proc WHERE proname='space_ops_summary' AND pg_get_functiondef(oid) LIKE '%leaveMonth%'")
[ "$HASNEW" = "0" ] || { echo "ABORT: function already contains leaveMonth — nothing executed"; exit 1; }
echo "PRECHECK: production function is pre-102"

# All gates passed. Apply the migration + exactly one ledger row in ONE
# transaction (-1): any SQL failure rolls back both.
{ cat "$MIG"
  printf "INSERT INTO schema_migrations(version,filename,checksum) VALUES ('102','102_ops_summary_business.sql','%s');\n" "$CS"
} | docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -1
echo APPLIED_OK

$PSQL -c "SELECT 'ledger_max: '||max(version) FROM schema_migrations"
$PSQL -c "SELECT 'ops_fn_updated: '||count(*) FROM pg_proc WHERE proname='space_ops_summary' AND pg_get_functiondef(oid) LIKE '%leaveMonth%'"
$PSQL -c "SELECT 'migration_102_count: '||count(*) FROM schema_migrations WHERE version='102'"
