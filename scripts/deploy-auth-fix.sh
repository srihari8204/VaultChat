#!/usr/bin/env bash
#
# Deploy the account-takeover fix + the Play legal pages to vaultchatprod01.
#
# WHY THIS IS A SCRIPT AND NOT `git pull`
# ---------------------------------------
# There is no git-based deploy. root on the box has no GitHub credentials and
# the repo is private, so prod is updated by COPYING SOURCE FILES and rebuilding
# the container. The checkout on the box is NOT what is running — its git log is
# months behind while its working tree carries the live code.
#
# WHAT THIS SCRIPT WILL NOT DO
# ----------------------------
# It refuses to touch Caddyfile or docker-compose.yml. Prod's copies are locally
# modified and uncommitted, and copying the repo's version wholesale over a prod
# config has already crash-looped a service here once: the repo copy was missing
# an api_key the prod copy carried. Those two changes are printed for you to
# apply by hand, against the line you mean, with a backup taken first.
#
# Usage:  bash scripts/deploy-auth-fix.sh
# You will be prompted for the sudo password on the box (there is no NOPASSWD).

set -euo pipefail

HOST="${VAULTCHAT_PROD_HOST:-srihari@65.21.229.167}"
DEST=/home/srihari/vaultchat
STAGE=/tmp/vc-deploy-$$

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mABORT: %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. PRE-FLIGHT ─────────────────────────────────────────────────────
# cmd/api/main.go now refuses to boot on an empty JWT_SECRET. That is the
# correct behaviour — an empty HS256 key makes forged tokens pass every
# authenticated route — but it means a deploy onto a box whose env_file lost
# that line would take the API down instead of starting it. Prove the secret is
# there BEFORE shipping the code that insists on it.
say "Pre-flight"
ssh "$HOST" 'docker exec vaultchat-go-api-1 printenv JWT_SECRET' > /tmp/vc-jwt-probe 2>/dev/null || true
if [ ! -s /tmp/vc-jwt-probe ]; then
  rm -f /tmp/vc-jwt-probe
  die "JWT_SECRET is EMPTY or unreadable on prod. The new boot guard would refuse to start.
       Fix the env_file first — and note that if it really is empty, prod is currently
       accepting forged tokens on every authenticated route."
fi
printf 'JWT_SECRET present (%s chars)\n' "$(tr -d '\n' < /tmp/vc-jwt-probe | wc -c)"
rm -f /tmp/vc-jwt-probe

# Read the compose invocation off the RUNNING container rather than guessing;
# box.yml exists on the host but is not what is in use.
COMPOSE_FILES=$(ssh "$HOST" "docker inspect vaultchat-go-api-1 --format '{{index .Config.Labels \"com.docker.compose.project.config_files\"}}'")
[ -n "$COMPOSE_FILES" ] || die "could not read the compose config_files label"
COMPOSE_ARGS=$(printf '%s' "$COMPOSE_FILES" | tr ',' '\n' | sed 's|.*/||' | sed 's/^/-f /' | tr '\n' ' ')
echo "compose: $COMPOSE_ARGS"

# ── 2. STAGE (as srihari, no sudo) ────────────────────────────────────
# Never `echo PASS | sudo -S tee file`: sudo consumes stdin for the password and
# tee then writes ZERO bytes over the target. It silently emptied a source file
# here once. Always land in /tmp unprivileged, then a SEPARATE sudo cp.
say "Staging source to $STAGE"
ssh "$HOST" "mkdir -p $STAGE/routes $STAGE/cmdapi $STAGE/public"

scp -q vaultchat-backend-go/internal/routes/auth.go "$HOST:$STAGE/routes/"
scp -q vaultchat-backend-go/internal/routes/user.go "$HOST:$STAGE/routes/"
scp -q vaultchat-backend-go/internal/routes/auth_setup_ticket_test.go "$HOST:$STAGE/routes/"
scp -q vaultchat-backend-go/cmd/api/main.go "$HOST:$STAGE/cmdapi/"
scp -q caddy/public/privacy.html caddy/public/delete-account.html "$HOST:$STAGE/public/"

# ── 3. INSTALL + VERIFY BY CHECKSUM ───────────────────────────────────
# The copy is only believable if the bytes match afterwards. Compare md5 both
# sides; a mismatch means the file did not land, whatever the exit code said.
say "Installing (sudo password prompt follows)"
ssh -t "$HOST" "sudo cp $STAGE/routes/auth.go                   $DEST/vaultchat-backend-go/internal/routes/auth.go && \
                sudo cp $STAGE/routes/user.go                   $DEST/vaultchat-backend-go/internal/routes/user.go && \
                sudo cp $STAGE/routes/auth_setup_ticket_test.go $DEST/vaultchat-backend-go/internal/routes/ && \
                sudo cp $STAGE/cmdapi/main.go                   $DEST/vaultchat-backend-go/cmd/api/main.go && \
                sudo mkdir -p $DEST/caddy/public && \
                sudo cp $STAGE/public/privacy.html $STAGE/public/delete-account.html $DEST/caddy/public/ && \
                echo INSTALLED"

say "Verifying checksums"
for pair in \
  "vaultchat-backend-go/internal/routes/auth.go" \
  "vaultchat-backend-go/internal/routes/user.go" \
  "vaultchat-backend-go/cmd/api/main.go" \
  "caddy/public/privacy.html" \
  "caddy/public/delete-account.html"
do
  local_md5=$(md5sum "$pair" | cut -d' ' -f1)
  remote_md5=$(ssh "$HOST" "sudo md5sum $DEST/$pair 2>/dev/null | cut -d' ' -f1" || true)
  if [ "$local_md5" != "$remote_md5" ]; then
    die "$pair did NOT land (local $local_md5 / remote ${remote_md5:-missing})"
  fi
  echo "ok  $pair"
done

# ── 4. REBUILD ────────────────────────────────────────────────────────
say "Rebuilding go-api"
ssh -t "$HOST" "cd $DEST && sudo docker compose $COMPOSE_ARGS build go-api && \
                sudo docker compose $COMPOSE_ARGS up -d go-api"

say "Health"
ssh "$HOST" "sleep 5; curl -sS localhost/health || true; echo"
ssh "$HOST" "docker logs --tail 20 vaultchat-go-api-1 2>&1 | grep -i 'boot\|panic\|fatal' || echo '(no boot complaints)'"

# ── 5. WHAT YOU STILL HAVE TO DO BY HAND ──────────────────────────────
cat <<'MANUAL'

============================================================
STILL TO DO BY HAND — two config files this script will not touch
============================================================
Prod's Caddyfile and docker-compose.yml are locally modified and uncommitted.
Copying the repo versions over them would revert live prod config. Back each up
first, edit the ONE place that matters, and grep the change back afterwards.
Prod config files also carry CRLF endings, so a sed anchored on `$` matches
nothing — target line numbers, not end-of-line patterns.

1) docker-compose.yml — add the static mount to the caddy service, next to the
   existing Caddyfile mount:

      - ./caddy/public:/srv/public:ro

2) caddy/Caddyfile — add this block immediately BEFORE the final
   `handle { reverse_proxy go-api:4000 }`:

      @legal path /privacy /privacy.html /delete-account /delete-account.html
      handle @legal {
              root * /srv/public
              rewrite /privacy /privacy.html
              rewrite /delete-account /delete-account.html
              header Content-Type "text/html; charset=utf-8"
              file_server
      }

   Then:  sudo docker compose <files> up -d caddy
   Verify: curl -sI https://api.corefinite.com/privacy   → expect 200 text/html

============================================================
VERIFY THE SECURITY FIX ACTUALLY LANDED
============================================================
The takeover is closed when this returns 401 rather than 200:

  curl -sS -o /dev/null -w '%{http_code}\n' \
    -X POST https://api.corefinite.com/auth/mpin/set \
    -H 'Content-Type: application/json' \
    -d '{"userId":"00000000-0000-0000-0000-000000000000","mpin":"246813"}'

  401 = fixed (no setup ticket).   200 or 404 = the old binary is still running.

MANUAL

say "Done"
