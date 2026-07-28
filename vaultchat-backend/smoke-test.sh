#!/usr/bin/env bash
# VaultChat post-deploy smoke test — read-only. Verifies the live backend +
# the new /api/admin surface came up correctly. No writes, no broadcast, no
# session revokes (those are opt-in below). Exits non-zero on any failure.
#
# Usage:
#   BASE=https://api.corefinite.com ADMIN_KEY=xxxxx ./smoke-test.sh
#   # or run on the server against localhost:
#   BASE=http://localhost:3000 ADMIN_KEY=$(grep ^ADMIN_KEY= .env|cut -d= -f2) ./smoke-test.sh

set -uo pipefail
BASE="${BASE:-https://api.corefinite.com}"
ADMIN_KEY="${ADMIN_KEY:-}"
BODY=/tmp/vc_smoke_body
PASS=0; FAIL=0
ok(){  printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad(){ printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

# req METHOD PATH [curl args...] -> prints HTTP code, body in $BODY
req(){ local m=$1 p=$2; shift 2; curl -sS -m 15 -o "$BODY" -w '%{http_code}' -X "$m" "$BASE$p" "$@" 2>/dev/null; }
has(){ grep -qE "$1" "$BODY"; }

echo "VaultChat smoke test → $BASE"
echo "────────────────────────────────────────"

# 1. Health (db + redis)
echo "[ infra ]"
code=$(req GET /health)
if [ "$code" = 200 ] && has '"db":true'; then ok "health — db up";
else bad "health (code=$code, $(head -c160 "$BODY"))"; fi
has '"redis":true' && ok "health — redis up" || bad "health — redis not connected"

# 2. Normal auth still enforced (no token -> 401)
echo "[ auth ]"
code=$(req GET /user/profile); [ "$code" = 401 ] && ok "protected route rejects no-token (401)" || bad "user/profile no-token gave $code (expected 401)"

# 3. Admin surface
echo "[ admin ]"
if [ -z "$ADMIN_KEY" ]; then
  echo "  (ADMIN_KEY not set — skipping admin checks)"
else
  AH=(-H "x-admin-key: $ADMIN_KEY")
  code=$(req GET /api/admin/stats);                 [ "$code" = 401 ] && ok "admin rejects missing key (401)" || bad "admin no-key gave $code (expected 401)"
  code=$(req GET /api/admin/stats -H "x-admin-key: wrong-key-xyz"); [ "$code" = 401 ] && ok "admin rejects bad key (401)" || bad "admin bad-key gave $code (expected 401)"

  code=$(req GET /api/admin/stats "${AH[@]}")
  if [ "$code" = 200 ] && has '"totalUsers"' && has '"onlineNow"'; then ok "GET /stats ($(grep -oE '"totalUsers":[0-9]+' "$BODY"), $(grep -oE '"onlineNow":[0-9]+' "$BODY"))";
  else bad "GET /stats (code=$code, $(head -c160 "$BODY"))"; fi

  code=$(req GET /api/admin/health-detail "${AH[@]}")
  { [ "$code" = 200 ] && has '"postgres"' && has '"system"'; } && ok "GET /health-detail (pg ping $(grep -oE '"pingMs":[0-9]+' "$BODY"|head -1))" || bad "GET /health-detail (code=$code)"

  code=$(req GET "/api/admin/users?limit=1" "${AH[@]}")
  { [ "$code" = 200 ] && has '"users"'; } && ok "GET /users" || bad "GET /users (code=$code)"

  # PRIVACY ASSERTION: message metadata must NEVER include content/ciphertext.
  code=$(req GET "/api/admin/messages?limit=3" "${AH[@]}")
  if [ "$code" = 200 ] && has '"messages"'; then
    if has '"(content|ciphertext|plaintext)"'; then bad "messages LEAK content — PRIVACY BUG"; else ok "GET /messages — metadata only (no content)"; fi
  else bad "GET /messages (code=$code)"; fi

  code=$(req GET /api/admin/sessions "${AH[@]}")
  { [ "$code" = 200 ] && has '"sessions"'; } && ok "GET /sessions" || bad "GET /sessions (code=$code)"
fi

echo "────────────────────────────────────────"
printf 'Result: \033[32m%d passed\033[0m, ' "$PASS"
[ "$FAIL" -gt 0 ] && printf '\033[31m%d failed\033[0m\n' "$FAIL" || printf '0 failed\n'
echo ""
echo "Also confirm on the server (no source needed):  node migrate.js status   → 0 pending"
[ "$FAIL" -eq 0 ]
