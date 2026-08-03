#!/usr/bin/env bash
# test-call-rls.sh — run the 066 call-session RLS assertions against a real
# Postgres. Two roles, deliberately:
#
#   ADMIN  seeds and removes the fixtures. RLS does not apply to a superuser or
#          to a table's owner, which is exactly why it can seed a chat: `chats`
#          has RLS enabled and NO insert policy, so an ordinary role cannot
#          insert one at all (see the note in 004_rls.sql, which describes that
#          as "unrestricted" — with RLS on and no policy it is the opposite).
#   APP    runs the assertions. This has to be the unprivileged, non-owning role
#          or the whole exercise proves nothing: every policy would be bypassed
#          and every check would pass.
#
# Usage:
#   PGHOST=/var/run/postgresql PGPORT=5432 PGDATABASE=vaultchat_test \
#   ADMIN_USER=postgres APP_USER=vaultchat_app ./scripts/test-call-rls.sh
#
# It WRITES. Point it at a scratch database with the migrations applied, never
# at production.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_USER="${ADMIN_USER:-postgres}"
APP_USER="${APP_USER:-vaultchat_app}"

ANN=aaaaaaaa-0000-4000-8000-0000000000a1
BOB=bbbbbbbb-0000-4000-8000-0000000000b1
EVE=eeeeeeee-0000-4000-8000-0000000000e1
CHAT=cccccccc-0000-4000-8000-0000000000c1

admin() { psql -U "$ADMIN_USER" -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() {
  admin -c "DELETE FROM calls        WHERE chat_id = '$CHAT';
            DELETE FROM chat_members WHERE chat_id = '$CHAT';
            DELETE FROM chats        WHERE id      = '$CHAT';
            DELETE FROM users        WHERE id IN ('$ANN','$BOB','$EVE');" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup   # in case a previous run died mid-way
admin -c "
  INSERT INTO users (id, email, name) VALUES
    ('$ANN','ann@rls.test','Ann'), ('$BOB','bob@rls.test','Bob'), ('$EVE','eve@rls.test','Eve');
  INSERT INTO chats (id, type) VALUES ('$CHAT','group');
  INSERT INTO chat_members (chat_id, user_id, role) VALUES
    ('$CHAT','$ANN','owner'), ('$CHAT','$BOB','member');
" >/dev/null

psql -U "$APP_USER" -v ON_ERROR_STOP=1 -f "$HERE/test-call-rls.sql"
