#!/usr/bin/env bash
# Migrations 105 + 106 + 107 → REAL prod DB (container vaultchat-postgres-1, db
# vaultchat, role vaultchat — the one the Go API actually uses).
#
# Same shape as apply103-104.sh, for the same reasons:
#
# WHY NOT migrate.js: ~/migrate-run/.env points at pgbouncer:6432 as
# vaultchat_app, which from the host resolves to the ABANDONED legacy Postgres
# (ledger frozen at 060). `migrate.js up` there would fire 40+ "pending"
# migrations at a dead database.
#
# ALL THREE ARE ADDITIVE AND BACKWARDS-COMPATIBLE, so schema-first is the
# correct order and the currently-deployed API (which predates all of them) is
# unaffected:
#
#   105  ADD COLUMN IF NOT EXISTS visibility ('public' default) + host_left_at
#        (nullable), 2 partial indexes, and REPLACES the broadcast_sessions /
#        broadcast_chat SELECT policies. The policy change is a no-op in
#        practice: every existing row defaults to visibility='public', so the
#        new predicate admits exactly what USING(TRUE) did — and RLS is inert
#        on this deployment anyway (docs/RLS_ENFORCEMENT.md).
#   106  CREATE TABLE IF NOT EXISTS broadcast_polls + broadcast_poll_votes.
#        Nothing existing is read or written.
#   107  ADD COLUMN IF NOT EXISTS description (NOT NULL DEFAULT '' — metadata
#        only in PG11+, no table rewrite) + CREATE TABLE broadcast_invite_links.
#
# Nothing is dropped. Nothing existing is rewritten.
#
# Transactional and gated: every precondition is checked BEFORE any SQL runs,
# and each migration applies with its ledger row in ONE transaction.
set -e
echo "running as: $(whoami) on $(hostname)"

RUN=/home/srihari/migrate-run
cd "$RUN"

# NO -i on the gate queries: this script arrives on bash's stdin and an
# interactive docker exec would swallow the rest of it (see apply102.sh).
PSQL="docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tA"

MAX=$($PSQL -c "SELECT max(version) FROM schema_migrations")
[ "$MAX" = "104" ] || { echo "ABORT: ledger max is $MAX, expected 104 — nothing executed"; exit 1; }
echo "PRECHECK: ledger at 104 (real prod DB confirmed — legacy answers 060)"

# The objects each migration creates must NOT already exist.
C1=$($PSQL -c "SELECT count(*) FROM information_schema.columns WHERE table_name='broadcast_sessions' AND column_name='visibility'")
[ "$C1" = "0" ] || { echo "ABORT: broadcast_sessions.visibility already exists — nothing executed"; exit 1; }
C2=$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_name='broadcast_polls'")
[ "$C2" = "0" ] || { echo "ABORT: broadcast_polls already exists — nothing executed"; exit 1; }
C3=$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_name='broadcast_invite_links'")
[ "$C3" = "0" ] || { echo "ABORT: broadcast_invite_links already exists — nothing executed"; exit 1; }
echo "PRECHECK: 105, 106 and 107 all pending"

# broadcast_sessions must exist (079) or 105 has nothing to alter.
HASB=$($PSQL -c "SELECT count(*) FROM information_schema.tables WHERE table_name='broadcast_sessions'")
[ "$HASB" = "1" ] || { echo "ABORT: broadcast_sessions missing — 079 not applied?"; exit 1; }
echo "PRECHECK: broadcast_sessions present"

for V in 105:105_golive_visibility 106:106_golive_polls 107:107_golive_invite_links; do
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
$PSQL -c "SELECT 'visibility_col: '||count(*) FROM information_schema.columns WHERE table_name='broadcast_sessions' AND column_name='visibility'"
$PSQL -c "SELECT 'host_left_at_col: '||count(*) FROM information_schema.columns WHERE table_name='broadcast_sessions' AND column_name='host_left_at'"
$PSQL -c "SELECT 'description_col: '||count(*) FROM information_schema.columns WHERE table_name='broadcast_sessions' AND column_name='description'"
$PSQL -c "SELECT 'poll_tables: '||count(*) FROM information_schema.tables WHERE table_name IN ('broadcast_polls','broadcast_poll_votes')"
$PSQL -c "SELECT 'invite_links_table: '||count(*) FROM information_schema.tables WHERE table_name='broadcast_invite_links'"
# Every pre-existing broadcast must still be public — the new column must not
# have hidden anyone's history behind the private gate.
$PSQL -c "SELECT 'existing_rows_public: '||count(*)||'/'||(SELECT count(*) FROM broadcast_sessions) FROM broadcast_sessions WHERE visibility='public'"
