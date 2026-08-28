#!/usr/bin/env bash
# Migration 119 (anonymous code chats) → REAL prod DB (container
# vaultchat-postgres-1, db vaultchat, role vaultchat — the one the Go API uses).
#
# Same shape as apply118.sh, for the same reasons.
#
# WHY NOT migrate.js: ~/migrate-run/.env points at pgbouncer:6432 as
# vaultchat_app, which from the host resolves to the ABANDONED legacy Postgres
# (ledger frozen at 060).
#
# 119 IS PURELY ADDITIVE AND CHANGES NO EXISTING ROW'S BEHAVIOUR:
#
#   ADD COLUMN chats.anon              BOOLEAN NOT NULL DEFAULT FALSE
#   ADD COLUMN chat_members.saved_peer BOOLEAN NOT NULL DEFAULT FALSE
#   two partial indexes
#
# Both defaults are FALSE, and FALSE means "behave exactly as before": a chat
# that is not anon is never masked, whatever saved_peer says. So the currently
# deployed binary — which does not know these columns exist — is unaffected, and
# schema-first is the correct order.
#
# NOT NULL DEFAULT FALSE on an existing table is metadata-only in PG11+, so
# neither ALTER rewrites the table. chats and chat_members are two of the
# largest tables on this box; a rewrite would be an outage, not a migration.
#
# Nothing is dropped. Nothing existing is rewritten.
set -e
echo "running as: $(whoami) on $(hostname)"

RUN=/home/srihari/migrate-run
cd "$RUN"

# NO -i on the gate queries: this script arrives on bash's stdin and an
# interactive docker exec would swallow the rest of it (see apply102.sh).
PSQL="docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tA"

MAX=$($PSQL -c "SELECT max(version) FROM schema_migrations")
[ "$MAX" = "118" ] || { echo "ABORT: ledger max is $MAX, expected 118 — nothing executed"; exit 1; }
echo "PRECHECK: ledger at 118 (real prod DB confirmed — legacy answers 060)"

N=$($PSQL -c "SELECT count(*) FROM schema_migrations WHERE version='119'")
[ "$N" = "0" ] || { echo "ABORT: 119 already recorded — nothing executed"; exit 1; }

C1=$($PSQL -c "SELECT count(*) FROM information_schema.columns WHERE table_name='chats' AND column_name='anon'")
[ "$C1" = "0" ] || { echo "ABORT: chats.anon already exists — nothing executed"; exit 1; }
C2=$($PSQL -c "SELECT count(*) FROM information_schema.columns WHERE table_name='chat_members' AND column_name='saved_peer'")
[ "$C2" = "0" ] || { echo "ABORT: chat_members.saved_peer already exists — nothing executed"; exit 1; }
echo "PRECHECK: 119 pending, neither column present"

# 118 must be in place: chat_codes is what marks a chat anon in the first place.
HASC=$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_name='chat_codes'")
[ "$HASC" = "1" ] || { echo "ABORT: chat_codes missing — 118 not applied?"; exit 1; }
echo "PRECHECK: chat_codes present (118 applied)"

# Row counts BEFORE, so the verify step can prove nothing moved.
CHATS_BEFORE=$($PSQL -c "SELECT count(*) FROM chats")
MEM_BEFORE=$($PSQL -c "SELECT count(*) FROM chat_members")
echo "PRECHECK: chats=$CHATS_BEFORE chat_members=$MEM_BEFORE"

NAME=119_anon_chats
MIG="$RUN/migrations/$NAME.sql"
test -f "$MIG" || { echo "ABORT: missing $MIG"; exit 1; }

CS=$(node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('migrations/$NAME.sql','utf8').replace(/\r\n/g,'\n')).digest('hex').slice(0,16))")
echo "applying 119 ($NAME) checksum=$CS"

{ cat "$MIG"
  printf "INSERT INTO schema_migrations(version,filename,checksum) VALUES ('119','%s.sql','%s');\n" "$NAME" "$CS"
} | docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -1
echo "APPLIED_OK 119"

echo "=== VERIFY ==="
$PSQL -c "SELECT 'ledger_max: '||max(version) FROM schema_migrations"
$PSQL -c "SELECT 'anon_col: '||column_name||' default='||column_default||' nullable='||is_nullable FROM information_schema.columns WHERE table_name='chats' AND column_name='anon'"
$PSQL -c "SELECT 'saved_peer_col: '||column_name||' default='||column_default||' nullable='||is_nullable FROM information_schema.columns WHERE table_name='chat_members' AND column_name='saved_peer'"
$PSQL -c "SELECT 'indexes: '||coalesce(string_agg(indexname,',' ORDER BY indexname),'NONE') FROM pg_indexes WHERE indexname IN ('chat_members_unsaved_idx','chats_anon_idx')"

# THE SAFETY ASSERTIONS. Every existing chat must still be non-anonymous and
# every existing member unsaved — i.e. the migration changed nobody's behaviour.
# If either is non-zero, real conversations just went anonymous.
$PSQL -c "SELECT 'chats_now_anon (MUST BE 0): '||count(*) FROM chats WHERE anon"
$PSQL -c "SELECT 'members_now_saved (MUST BE 0): '||count(*) FROM chat_members WHERE saved_peer"
$PSQL -c "SELECT 'chats_rowcount: '||count(*)||' (was $CHATS_BEFORE)' FROM chats"
$PSQL -c "SELECT 'members_rowcount: '||count(*)||' (was $MEM_BEFORE)' FROM chat_members"
