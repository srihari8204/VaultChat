#!/usr/bin/env bash
# Migration 120 (self-destructing chats) → REAL prod DB.
#
# Same shape as apply118/119.sh, for the same reasons (~/migrate-run/.env points
# at the abandoned legacy Postgres, so migrate.js cannot be used here).
#
# 120 IS PURELY ADDITIVE:
#
#   ADD COLUMN chats.expires_at TIMESTAMPTZ   (nullable, no default)
#   one partial index
#
# NULL means "never expires", which is what every existing chat gets and what
# the reaper's `expires_at IS NOT NULL` clause refuses to touch. Nullable with
# no default means no table rewrite. The currently deployed binary has no reaper
# at all, so schema-first is safe: the column simply sits unused until the new
# binary ships.
set -e
echo "running as: $(whoami) on $(hostname)"

RUN=/home/srihari/migrate-run
cd "$RUN"

PSQL="docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tA"

MAX=$($PSQL -c "SELECT max(version) FROM schema_migrations")
[ "$MAX" = "119" ] || { echo "ABORT: ledger max is $MAX, expected 119 — nothing executed"; exit 1; }
echo "PRECHECK: ledger at 119"

N=$($PSQL -c "SELECT count(*) FROM schema_migrations WHERE version='120'")
[ "$N" = "0" ] || { echo "ABORT: 120 already recorded — nothing executed"; exit 1; }

C1=$($PSQL -c "SELECT count(*) FROM information_schema.columns WHERE table_name='chats' AND column_name='expires_at'")
[ "$C1" = "0" ] || { echo "ABORT: chats.expires_at already exists — nothing executed"; exit 1; }
echo "PRECHECK: 120 pending, column absent"

CHATS_BEFORE=$($PSQL -c "SELECT count(*) FROM chats")
echo "PRECHECK: chats=$CHATS_BEFORE"

NAME=120_chat_expiry
MIG="$RUN/migrations/$NAME.sql"
test -f "$MIG" || { echo "ABORT: missing $MIG"; exit 1; }

CS=$(node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('migrations/$NAME.sql','utf8').replace(/\r\n/g,'\n')).digest('hex').slice(0,16))")
echo "applying 120 ($NAME) checksum=$CS"

{ cat "$MIG"
  printf "INSERT INTO schema_migrations(version,filename,checksum) VALUES ('120','%s.sql','%s');\n" "$NAME" "$CS"
} | docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 -1
echo "APPLIED_OK 120"

echo "=== VERIFY ==="
$PSQL -c "SELECT 'ledger_max: '||max(version) FROM schema_migrations"
$PSQL -c "SELECT 'expires_at: '||column_name||' type='||data_type||' nullable='||is_nullable||' default='||coalesce(column_default,'NONE') FROM information_schema.columns WHERE table_name='chats' AND column_name='expires_at'"
$PSQL -c "SELECT 'index: '||coalesce(string_agg(indexname,','),'MISSING') FROM pg_indexes WHERE indexname='chats_expires_idx'"

# THE SAFETY ASSERTION. Every existing chat must have a NULL deadline — i.e.
# nothing on this box is now scheduled for deletion. If this is not 0, the
# reaper that ships next would start deleting real conversations.
$PSQL -c "SELECT 'chats_with_a_deadline (MUST BE 0): '||count(*) FROM chats WHERE expires_at IS NOT NULL"
$PSQL -c "SELECT 'chats_rowcount: '||count(*)||' (was $CHATS_BEFORE)' FROM chats"
