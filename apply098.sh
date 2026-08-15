#!/usr/bin/env bash
# Migration 098_drop_vaultlens → REAL prod DB (container vaultchat-postgres-1).
#
# Same target and same reasoning as apply102.sh / apply103-104.sh: straight to
# the container, NOT migrate.js, whose .env resolves to the abandoned legacy
# Postgres (ledger frozen at 060).
#
# THIS ONE IS DESTRUCTIVE — that is the difference from 103/104.
#
# 098 DROPs vaultlens_generation and vaultlens_face. There is no `down`: a drop
# cannot be reversed from inside the database, only restored from a dump. So the
# gates below additionally require a backup that DEMONSTRABLY contains the
# tables, verified by reading it, not by trusting its filename.
#
# Why it is safe (from 098's own header, re-verified 2026-08-15):
#   - No inbound foreign keys: nothing REFERENCES vaultlens anywhere.
#   - Both tables reference OUT to users(id); dropping a table that HOLDS a
#     foreign key does not touch the table it points at, so `users` is fine.
#   - All VaultLens code (Go routes, Node worker, client screens) is already
#     deleted from the repo. The only survivor is the running worker container,
#     removed separately AFTER this succeeds.
#   - MinIO objects (vaultlens/faces/*) are deliberately NOT touched. Dropping
#     the rows orphans them; object cleanup is a separate reviewed operation and
#     does not belong on the deploy path.
#
# Applied OUT OF ORDER: the ledger is already at 104 because 098 was skipped
# during the original rollout. That is expected here and the gate asserts it.
set -e
echo "running as: $(whoami) on $(hostname)"

RUN=/home/srihari/migrate-run
cd "$RUN"

# NO -i on the gate queries: this script may arrive on bash's stdin and an
# interactive docker exec would swallow the rest of it (see apply102.sh).
PSQL="docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tA"

# ── gate 1: correct database ────────────────────────────────────────────
MAX=$($PSQL -c "SELECT max(version) FROM schema_migrations")
[ "$MAX" = "104" ] || { echo "ABORT: ledger max is $MAX, expected 104 — nothing executed"; exit 1; }
echo "PRECHECK: ledger at 104 (real prod DB confirmed — legacy answers 060)"

# ── gate 2: 098 genuinely pending ───────────────────────────────────────
N=$($PSQL -c "SELECT count(*) FROM schema_migrations WHERE version='098'")
[ "$N" = "0" ] || { echo "ABORT: 098 already recorded — nothing executed"; exit 1; }

HASTBL=$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('vaultlens_face','vaultlens_generation')")
[ "$HASTBL" = "2" ] || { echo "ABORT: expected 2 vaultlens tables, found $HASTBL — nothing executed"; exit 1; }
echo "PRECHECK: 098 pending, both tables present"

# ── gate 3: nothing references them ─────────────────────────────────────
FK=$($PSQL -c "SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.confrelid WHERE c.contype='f' AND t.relname IN ('vaultlens_face','vaultlens_generation')")
[ "$FK" = "0" ] || { echo "ABORT: $FK inbound foreign key(s) reference vaultlens — nothing executed"; exit 1; }
echo "PRECHECK: no inbound foreign keys"

# ── gate 4: a backup that PROVABLY contains the tables ──────────────────
BK=$(ls -1t /home/srihari/vaultchat-backups/vaultchat-*.sql.gz 2>/dev/null | head -1)
[ -n "$BK" ] || { echo "ABORT: no backup found — nothing executed"; exit 1; }
HITS=$(zcat "$BK" | grep -c 'vaultlens_face\|vaultlens_generation' || true)
[ "$HITS" -gt 0 ] || { echo "ABORT: newest backup $BK does not contain vaultlens — nothing executed"; exit 1; }
echo "PRECHECK: backup $BK contains vaultlens ($HITS refs)"

# Row counts recorded before the drop, so the log says what was destroyed.
echo "DESTROYING: vaultlens_face=$($PSQL -c 'SELECT count(*) FROM vaultlens_face') vaultlens_generation=$($PSQL -c 'SELECT count(*) FROM vaultlens_generation')"

MIG="$RUN/migrations/098_drop_vaultlens.sql"
test -f "$MIG" || { echo "ABORT: missing $MIG"; exit 1; }

CS=$(node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('migrations/098_drop_vaultlens.sql','utf8').replace(/\r\n/g,'\n')).digest('hex').slice(0,16))")
echo "applying 098 (098_drop_vaultlens) checksum=$CS"

# Drop + ledger row in ONE transaction: either both, or neither.
{ cat "$MIG"
  printf "INSERT INTO schema_migrations(version,filename,checksum) VALUES ('098','098_drop_vaultlens.sql','%s');\n" "$CS"
} | docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -1
echo "APPLIED_OK 098"

echo "=== VERIFY ==="
$PSQL -c "SELECT 'ledger_max: '||max(version) FROM schema_migrations"
$PSQL -c "SELECT 'ledger_count: '||count(*) FROM schema_migrations"
$PSQL -c "SELECT 'has_098: '||count(*) FROM schema_migrations WHERE version='098'"
$PSQL -c "SELECT 'vaultlens_tables_remaining: '||count(*) FROM information_schema.tables WHERE table_name IN ('vaultlens_face','vaultlens_generation')"
$PSQL -c "SELECT 'users_intact: '||count(*) FROM users"
