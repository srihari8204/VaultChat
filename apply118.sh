#!/usr/bin/env bash
# Migration 118 (chat_codes) → REAL prod DB (container vaultchat-postgres-1, db
# vaultchat, role vaultchat — the one the Go API actually uses).
#
# Same shape as apply105-107.sh, for the same reasons.
#
# WHY NOT migrate.js: ~/migrate-run/.env points at pgbouncer:6432 as
# vaultchat_app, which from the host resolves to the ABANDONED legacy Postgres
# (ledger frozen at 060). `migrate.js up` there would fire 50+ "pending"
# migrations at a dead database.
#
# 118 IS PURELY ADDITIVE, so schema-first is the correct order and the currently
# deployed API (which has no chat-codes routes at all) is unaffected by it:
#
#   118  CREATE TABLE IF NOT EXISTS chat_codes + three indexes + RLS policies.
#        Nothing existing is read, written, altered or dropped. No other table
#        is touched. If the API rollout that follows is abandoned, this table
#        simply sits empty.
#
# Transactional and gated: every precondition is checked BEFORE any SQL runs,
# and the migration applies with its ledger row in ONE transaction.
set -e
echo "running as: $(whoami) on $(hostname)"

RUN=/home/srihari/migrate-run
cd "$RUN"

# NO -i on the gate queries: this script arrives on bash's stdin and an
# interactive docker exec would swallow the rest of it (see apply102.sh).
PSQL="docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tA"

MAX=$($PSQL -c "SELECT max(version) FROM schema_migrations")
[ "$MAX" = "117" ] || { echo "ABORT: ledger max is $MAX, expected 117 — nothing executed"; exit 1; }
echo "PRECHECK: ledger at 117 (real prod DB confirmed — legacy answers 060)"

N=$($PSQL -c "SELECT count(*) FROM schema_migrations WHERE version='118'")
[ "$N" = "0" ] || { echo "ABORT: 118 already recorded — nothing executed"; exit 1; }

C1=$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_name='chat_codes'")
[ "$C1" = "0" ] || { echo "ABORT: chat_codes already exists — nothing executed"; exit 1; }
echo "PRECHECK: 118 pending, chat_codes absent"

# users is the FK target for owner_id and used_by; ghost_mode is what the
# redeem path writes its presence defaults into. Neither is altered here, but a
# missing one means this box is not the database we think it is.
for T in users ghost_mode chats chat_members; do
  H=$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_name='$T'")
  [ "$H" = "1" ] || { echo "ABORT: table $T missing — wrong database?"; exit 1; }
done
echo "PRECHECK: users, ghost_mode, chats, chat_members all present"

# vc_current_user_id() is what every RLS policy in this migration calls. A
# missing function would make the CREATE POLICY statements fail mid-migration.
HASF=$($PSQL -c "SELECT count(*) FROM pg_proc WHERE proname='vc_current_user_id'")
[ "$HASF" -ge 1 ] || { echo "ABORT: vc_current_user_id() missing — RLS policies would fail"; exit 1; }
echo "PRECHECK: vc_current_user_id() present"

NAME=118_chat_codes
MIG="$RUN/migrations/$NAME.sql"
test -f "$MIG" || { echo "ABORT: missing $MIG"; exit 1; }

CS=$(node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('migrations/$NAME.sql','utf8').replace(/\r\n/g,'\n')).digest('hex').slice(0,16))")
echo "applying 118 ($NAME) checksum=$CS"

{ cat "$MIG"
  printf "INSERT INTO schema_migrations(version,filename,checksum) VALUES ('118','%s.sql','%s');\n" "$NAME" "$CS"
} | docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -1
echo "APPLIED_OK 118"

echo "=== VERIFY ==="
$PSQL -c "SELECT 'ledger_max: '||max(version) FROM schema_migrations"
$PSQL -c "SELECT 'chat_codes_table: '||count(*) FROM information_schema.tables WHERE table_name='chat_codes'"
$PSQL -c "SELECT 'columns: '||count(*) FROM information_schema.columns WHERE table_name='chat_codes'"
# The two partial unique indexes are the security story, not bookkeeping:
# one live code per owner, and no two live codes sharing six digits.
$PSQL -c "SELECT 'indexes: '||string_agg(indexname,',' ORDER BY indexname) FROM pg_indexes WHERE tablename='chat_codes'"
$PSQL -c "SELECT 'rls_enabled: '||relrowsecurity||' forced: '||relforcerowsecurity FROM pg_class WHERE relname='chat_codes'"
$PSQL -c "SELECT 'policies: '||count(*) FROM pg_policies WHERE tablename='chat_codes'"
# Nothing else may have moved.
$PSQL -c "SELECT 'users_rows_unchanged_check: '||count(*) FROM users"
