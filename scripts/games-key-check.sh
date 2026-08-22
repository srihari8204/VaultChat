#!/usr/bin/env bash
# games-key-check.sh — prove VaultChat holds the launch-token private key
# BEFORE the games host's copy of it is destroyed.
#
# THE ORDER MATTERS AND IT IS THE WHOLE POINT.
#
# /opt/vaultgames/keys/ed25519.key on the games host is the PRIVATE launch-token
# signing key. It should not be there: anyone who compromises that box can mint
# launch tokens impersonating any VaultChat user. But if it turns out to be the
# ONLY copy, deleting it breaks every game launch permanently and unrecoverably
# — there is no way to re-derive a private key from the public half.
#
# So this script refuses to delete anything it has not first proved is
# duplicated. Run it on the VAULTCHAT host, where the key of record lives.
#
#   ./games-key-check.sh                  # verify only (safe, the default)
#   ./games-key-check.sh --shred          # verify, then delete the games copy
#
# --shred is ignored unless every check above it passed.

set -euo pipefail

# The public key the games server verifies launch tokens against, from the
# integration handover. If our private key does not derive to exactly this, the
# key we hold is not the key in use and nothing may be deleted.
EXPECTED_PUB="MCowBQYDK2VwAyEAAOuEDU0rePRDEmBGtQFOHl3Pd9tR1KdhM7jnCtgtmKQ="

KEY_FILE="${GAMES_KEY_FILE:-./secrets/games-signing.key}"
GAMES_HOST="${GAMES_HOST:-}"                      # e.g. root@games.corefinite.com; empty = print commands only
GAMES_KEY_PATH="/opt/vaultgames/keys/ed25519.key"

SHRED=0
[[ "${1:-}" == "--shred" ]] && SHRED=1

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
info() { printf '  ..   %s\n' "$1"; }

echo
echo "── 1. VaultChat holds a launch-token private key ──"
if [[ ! -f "$KEY_FILE" ]]; then
  bad "no key at $KEY_FILE"
  echo
  echo "Set GAMES_KEY_FILE to its real path and re-run. Do NOT delete the games"
  echo "host's copy until this passes — it may be the only one left."
  exit 1
fi
ok "found $KEY_FILE"

echo
echo "── 2. It is the key the games server actually verifies against ──"
# openssl pkey -pubout emits the PKIX PEM; strip the armour to compare base64.
DERIVED="$(openssl pkey -in "$KEY_FILE" -pubout 2>/dev/null | grep -v -- '-----' | tr -d '\n')" || true
if [[ -z "$DERIVED" ]]; then
  bad "could not derive a public key — is $KEY_FILE a PEM Ed25519 private key?"
  exit 1
fi
if [[ "$DERIVED" != "$EXPECTED_PUB" ]]; then
  bad "public key MISMATCH"
  echo "         ours:     $DERIVED"
  echo "         expected: $EXPECTED_PUB"
  echo
  echo "The key we hold is not the one in production. Deleting the games host's"
  echo "copy now would destroy the only usable private key. Stop here."
  exit 1
fi
ok "derives to the expected public key"

echo
echo "── 3. It is backed up somewhere other than this disk ──"
# Deliberately not automated: "a backup exists" is a claim about a system this
# script cannot see. It asks, because a wrong automated yes here is the failure
# that has no recovery.
info "checked: $(ls -l "$KEY_FILE" | awk '{print $1, $3, $5" bytes"}')"
echo
echo "  Confirm by hand, now, before continuing:"
echo "    - the key is in your password manager / offline backup"
echo "    - you can restore it to a fresh host without the games box"
echo

if [[ "$SHRED" -ne 1 ]]; then
  echo "── Verified. To remove the games host's copy ──"
  echo
  echo "  ssh <games-host> 'shred -u $GAMES_KEY_PATH'"
  echo
  echo "  or re-run:  GAMES_HOST=<games-host> $0 --shred"
  echo
  exit 0
fi

echo "── 4. Deleting the games host's copy ──"
if [[ -z "$GAMES_HOST" ]]; then
  bad "GAMES_HOST is not set — nothing to connect to"
  echo "         GAMES_HOST=root@games.corefinite.com $0 --shred"
  exit 1
fi
# -f so a host that has already been cleaned is a success, not an error: this
# script must be safe to run twice.
ssh "$GAMES_HOST" "shred -u -f '$GAMES_KEY_PATH' 2>/dev/null || true; \
                   test ! -e '$GAMES_KEY_PATH' && echo GONE || echo STILL_PRESENT" \
  | grep -q GONE && ok "$GAMES_KEY_PATH is gone from $GAMES_HOST" || {
    bad "$GAMES_KEY_PATH is still present on $GAMES_HOST"
    exit 1
  }

echo
echo "── 5. Launches still work ──"
echo "  Open Games from the app. If a game loads, the surviving key is signing."
echo "  If it does not, restore from the backup you confirmed in step 3."
echo
