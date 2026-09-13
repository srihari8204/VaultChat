#!/usr/bin/env bash
#
# deploy.sh — ship vaultchat-backend-go to the box, or leave the box exactly as
# it was. Run from the repo root, on your machine:
#
#   bash scripts/deploy.sh
#   bash scripts/deploy.sh --yes          # skip the confirmation prompt (CI)
#
# WHAT THIS REPLACES, AND WHY
# ---------------------------
# Six ad-hoc deploy-*.sh scripts, each one written for a single file, each one
# carrying hardcoded md5s of the two revisions it knew about. They were correct
# — and they are still in scripts/, deliberately untouched, because each one
# documents an incident worth keeping. But between them they encoded the actual
# deploy process as folklore, and the folklore was: scp the file you changed
# over a git checkout that is ~370 commits behind origin with hundreds of
# modified files on top. Nobody could say what was running. That is finding
# P0-02 of the architecture review, and this script is the answer to it.
#
# THE FOUR THINGS THIS DOES THAT SCP DID NOT
# ------------------------------------------
# 1. REFUSES A DIRTY OR STALE CHECKOUT. If your tree is not clean and not equal
#    to origin, the thing you are about to deploy has no name. Stop.
#
# 2. RSYNC --delete, NOT SCP. scp adds; it never removes. A .go file deleted in
#    the repo stayed on the box forever, compiled into the binary, and — since
#    the fingerprint hashes every .go file present — quietly changed what the
#    build identified as. --delete is what makes the box a copy rather than an
#    accumulation.
#
# 3. GATES ON THE FINGERPRINT *BEFORE* BUILDING. The same hash is recomputed on
#    the box over the synced tree and compared to the local one. Mismatch means
#    the build would produce a binary that is not this source, so we abort and
#    restore — rather than discover it afterwards from /build.
#
# 4. BUILDS WITH --pull. golang:1.26-alpine is a FLOATING tag. Without --pull
#    the box reuses whichever base layer it cached: production sat on go1.26.5
#    for weeks while 1.26.6/.7/.8 shipped standard-library fixes, and nothing
#    anywhere said so. This is not a nicety.
#
# SAFETY RULES BAKED IN. Do not remove them:
#   * ONLY the go-api service is touched (--no-deps). NEVER --remove-orphans:
#     compose knows ~19 services while 17 vaultchat containers run, so that flag
#     would delete both LiveKit servers and both egress containers — every call
#     AND every broadcast, at once.
#   * Never `down`, never `down -v`.
#   * Every destructive step has its rollback defined BEFORE it runs.
#   * Migrations are the one thing with no automatic undo — see apply_migrations.
set -euo pipefail

HOST="${VAULTCHAT_PROD_HOST:-root@65.21.229.167}"
ROOT=/home/srihari/vaultchat
BRANCH="${VAULTCHAT_DEPLOY_BRANCH:-hetzner-deploy}"
STAMP=$(date +%Y%m%d-%H%M%S)
BAK="/home/srihari/deploy-predeploy.$STAMP"
# All three files, in this order. Dropping the third is silent: go-api keeps
# starting, keeps answering /health, and writes every attachment to a MinIO
# bucket no client has a URL for.
DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml"
ASSUME_YES=0
[ "${1:-}" = "--yes" ] && ASSUME_YES=1

say(){ printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok(){  printf '\033[32m  ok\033[0m   %s\n' "$1"; }
die(){ printf '\n\033[31mABORT: %s\033[0m\n' "$1" >&2; exit 1; }

# ───────────────────────────────────────────────────────────────────────────
say "1/8  local pre-flight"
# ───────────────────────────────────────────────────────────────────────────
[ -f scripts/fingerprint-go.sh ] || die "run this from the repo root"
[ -d vaultchat-backend-go ]      || die "vaultchat-backend-go/ missing — wrong directory"

# rsync is not in Git Bash on Windows. Say so plainly rather than failing with
# "command not found" halfway through a deploy.
command -v rsync >/dev/null \
  || die "rsync not found. Git Bash does not ship it — run this from WSL, or install rsync."

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git checkout"
[ -z "$(git status --porcelain)" ] \
  || die "working tree is dirty. Deploying an unnamed tree is how the box got 370 commits behind with 255 modified files on top. Commit or stash first."

git fetch --quiet origin "$BRANCH" || die "cannot reach origin"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
[ "$LOCAL" = "$REMOTE" ] \
  || die "HEAD ($(git rev-parse --short HEAD)) != origin/$BRANCH ($(git rev-parse --short "origin/$BRANCH")). Push or pull first — a deploy from a divergent checkout cannot be reproduced by anyone else."

FP_LOCAL=$(bash scripts/fingerprint-go.sh)
ok "tree clean, at origin/$BRANCH $(git rev-parse --short HEAD)"
ok "source fingerprint: $FP_LOCAL"

# ───────────────────────────────────────────────────────────────────────────
say "2/8  box pre-flight"
# ───────────────────────────────────────────────────────────────────────────
ssh "$HOST" "test -d $ROOT" || die "no checkout at $HOST:$ROOT"
ssh "$HOST" "test -f $ROOT/docker-compose.box.yml" \
  || die "$ROOT/docker-compose.box.yml missing. It is gitignored on purpose — build it from deploy/docker-compose.box.yml.example and ./.env first."
ssh "$HOST" "test -d $ROOT/secrets" \
  || die "$ROOT/secrets missing. prod.yml bind-mounts three files from it; a missing mount source is a hard container start failure."

FP_BOX_BEFORE=$(ssh "$HOST" "curl -s -m 10 http://127.0.0.1:8095/build" \
  | sed -n 's/.*"source":"\([^"]*\)".*/\1/p')
if [ "$FP_BOX_BEFORE" = "$FP_LOCAL" ]; then
  ok "box already runs $FP_LOCAL — nothing to deploy"
  exit 0
fi
# Live calls survive a go-api restart badly: sockets drop and reconnect. Worth
# one line of warning, not worth blocking on.
LIVE=$(ssh "$HOST" "docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tAc \
  \"SELECT count(*) FROM calls WHERE ended_at IS NULL;\"" 2>/dev/null | tr -d ' \r')
ok "box currently runs: ${FP_BOX_BEFORE:-<unreadable>}"
ok "live calls right now: ${LIVE:-unknown}  (a restart briefly drops their sockets)"

if [ "$ASSUME_YES" = 0 ]; then
  printf '\n  Deploy %s -> %s ? [y/N] ' "$FP_LOCAL" "$HOST"
  read -r reply </dev/tty
  case "$reply" in y|Y) ;; *) die "cancelled, nothing was touched" ;; esac
fi

# ───────────────────────────────────────────────────────────────────────────
say "3/8  backup (source tree + the image now serving)"
# ───────────────────────────────────────────────────────────────────────────
# Written BEFORE anything is changed, because a rollback defined after the
# destructive step is a rollback you do not have.
ssh "$HOST" "mkdir -p $BAK && tar czf $BAK/vaultchat-backend-go.tgz -C $ROOT vaultchat-backend-go" \
  || die "backup failed — nothing was changed"
IMG_ID=$(ssh "$HOST" "docker images -q vaultchat-go-api | head -1" | tr -d '\r')
ok "source -> $HOST:$BAK/vaultchat-backend-go.tgz"
ok "image  -> ${IMG_ID:-<none>}  (retagged on failure)"

rollback() {
  printf '\n\033[31m!! ROLLING BACK\033[0m\n'
  ssh "$HOST" "rm -rf $ROOT/vaultchat-backend-go && tar xzf $BAK/vaultchat-backend-go.tgz -C $ROOT" \
    && ok "source restored"
  if [ -n "${IMG_ID:-}" ]; then
    ssh "$HOST" "docker tag $IMG_ID vaultchat-go-api:latest && cd $ROOT && $DC up -d --no-deps go-api" \
      && ok "go-api back on the previous image"
  fi
  printf '  The box is as it was. Nothing else was touched.\n'
  printf '  NOTE: applied migrations are NOT rolled back — see step 5.\n'
  exit 1
}

# ───────────────────────────────────────────────────────────────────────────
say "4/8  rsync source (--delete: the box becomes a copy, not a pile)"
# ───────────────────────────────────────────────────────────────────────────
# Excludes are the point of this list:
#   .env / secrets / *.bak*  live ONLY on the box and must survive a sync
#   _test.go                 excluded from the fingerprint, so syncing them
#                            would be noise — but they are cheap, so they go;
#                            what must NOT go is anything the box owns.
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' \
  vaultchat-backend-go/ "$HOST:$ROOT/vaultchat-backend-go/" || rollback
ok "vaultchat-backend-go synced"

# Migrations and the compose/proxy config travel too — the API queries columns a
# migration creates, and a compose file that disagrees with the source is how
# the 14000-webhook port went missing.
rsync -az vaultchat-backend/migrations/ "$HOST:$ROOT/vaultchat-backend/migrations/" || rollback
rsync -az docker-compose.yml docker-compose.prod.yml "$HOST:$ROOT/" || rollback
rsync -az caddy/ "$HOST:$ROOT/caddy/" || rollback
ok "migrations, compose and Caddyfile synced (docker-compose.box.yml untouched)"

# ── THE GATE ───────────────────────────────────────────────────────────────
# Recompute the fingerprint ON THE BOX, over the tree that will actually be
# compiled, using the byte-identical pipeline from scripts/fingerprint-go.sh and
# the Dockerfile. If this disagrees, the build would produce a binary that is
# not this source — and the only honest thing to do is stop before building it.
FP_SYNCED=$(ssh "$HOST" "cd $ROOT/vaultchat-backend-go && LC_ALL=C; export LC_ALL; \
  find . -type f \( -name '*.go' -not -name '*_test.go' \) -o -name 'go.mod' -o -name 'go.sum' \
  | sort \
  | while read -r f; do tr -d '\r' < \"\$f\" | sha256sum | cut -d' ' -f1; echo \"\$f\"; done \
  | sha256sum | cut -c1-16" | tr -d ' \r')
[ "$FP_SYNCED" = "$FP_LOCAL" ] || {
  printf '  local:  %s\n  box:    %s\n' "$FP_LOCAL" "$FP_SYNCED"
  printf '  The synced tree is not this source. Most likely an rsync exclude, or a\n'
  printf '  stray .go file on the box that --delete should have removed.\n'
  rollback
}
ok "box tree fingerprints $FP_SYNCED — matches local"

# ───────────────────────────────────────────────────────────────────────────
say "5/8  migrations (BEFORE the binary: the API queries columns these create)"
# ───────────────────────────────────────────────────────────────────────────
# Ordering is not stylistic. Every migration in this repo is additive — a new
# nullable column or a new table — so the OLD binary tolerates the NEW schema
# and simply ignores what it does not know. The reverse is not true: a new
# binary against an old schema queries a column that does not exist and 500s
# every request that touches it. Schema first, always.
#
# THERE IS NO AUTOMATIC DOWN, and pretending otherwise would be worse than
# saying so. Each file runs in its OWN transaction with ON_ERROR_STOP, so a bad
# file rolls itself back and stops the run with the ledger still consistent —
# but a file that COMMITTED and then turns out to be wrong is undone by writing
# the next migration, not by this script.
#
# Applied by piping SQL into psql inside the postgres container rather than with
# vaultchat-backend/migrate.js: no Node runtime remains on this box, and the
# box's own ~/migrate-run/.env points at an abandoned legacy Postgres. This is
# the same shape apply118/119/120.sh used, which is the path that is proven here.
#
# `sed 's/\r$//'` matches migrate.js's `.replace(/\r\n/g,'\n')` exactly — this
# repo is developed on Windows and checks out mixed CRLF/LF, and a checksum that
# notices line endings reports every migration as drifted from a Windows tree.
# Observed: 80 of 81 "drifted", all of them purely CRLF, which is enough noise to
# hide the one real mismatch.
ssh "$HOST" "bash -s" <<REMOTE || rollback
set -euo pipefail
cd $ROOT/vaultchat-backend/migrations
PSQL="docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat"
Q="docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tA"

\$Q -c "CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY, filename TEXT NOT NULL,
          checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())" >/dev/null

APPLIED=\$(\$Q -c "SELECT version FROM schema_migrations" | tr -d ' \r')
PENDING=0
for f in \$(ls *.sql 2>/dev/null | sort); do
  v=\${f%%_*}
  printf '%s\n' "\$APPLIED" | grep -qx "\$v" && continue
  cs=\$(sed 's/\r\$//' "\$f" | sha256sum | cut -c1-16)
  echo "  applying \$f (checksum \$cs)"
  { sed 's/\r\$//' "\$f"
    printf "INSERT INTO schema_migrations(version,filename,checksum) VALUES ('%s','%s','%s');\n" "\$v" "\$f" "\$cs"
  } | \$PSQL -v ON_ERROR_STOP=1 -1
  PENDING=\$((PENDING+1))
done
echo "  applied \$PENDING migration(s); ledger now at \$(\$Q -c 'SELECT max(version) FROM schema_migrations' | tr -d ' \r')"
REMOTE
ok "schema is ahead of, or level with, the binary about to ship"

# ───────────────────────────────────────────────────────────────────────────
say "6/8  build --pull go-api"
# ───────────────────────────────────────────────────────────────────────────
# --pull is not optional. See the header: the base image is a floating tag and
# without it the box silently keeps a stale Go toolchain.
ssh "$HOST" "cd $ROOT && $DC build --pull go-api" || rollback
ok "image built"

# ───────────────────────────────────────────────────────────────────────────
say "7/8  restart go-api ONLY"
# ───────────────────────────────────────────────────────────────────────────
ssh "$HOST" "cd $ROOT && $DC up -d --no-deps go-api" || rollback
ok "go-api recreated"

# ───────────────────────────────────────────────────────────────────────────
say "8/8  verify"
# ───────────────────────────────────────────────────────────────────────────
# health first (process is alive), then ready (it can actually serve — /ready
# 503s on a dead database, which is the whole reason it exists), then the
# fingerprint (it is serving THIS source and not a cached image).
for i in $(seq 1 30); do
  H=$(ssh "$HOST" "curl -s -m 5 http://127.0.0.1:8095/health" 2>/dev/null || true)
  case "$H" in *'"status":"ok"'*) ok "health ok after ${i}s"; break;; esac
  [ "$i" = 30 ] && { printf '  health never came up\n'; rollback; }
  sleep 1
done

R=$(ssh "$HOST" "curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:8095/ready" | tr -d ' \r')
[ "$R" = "200" ] || { printf '  GET /ready -> %s (503 = database unreachable)\n' "$R"; rollback; }
ok "ready 200"

FP_BOX=$(ssh "$HOST" "curl -s -m 10 http://127.0.0.1:8095/build" \
  | sed -n 's/.*"source":"\([^"]*\)".*/\1/p')
[ "$FP_BOX" = "$FP_LOCAL" ] || {
  printf '  local:  %s\n  /build: %s\n' "$FP_LOCAL" "$FP_BOX"
  printf '  The running binary is not this source — a stale image was reused.\n'
  rollback
}
ok "GET /build reports $FP_BOX — the box is running this commit"

GOV=$(ssh "$HOST" "curl -s -m 10 http://127.0.0.1:8095/build" | sed -n 's/.*"go":"\([^"]*\)".*/\1/p')
ok "toolchain: $GOV  (bumps every deploy because of --pull; if it never moves, --pull is not working)"

cat <<NOTE

DEPLOYED.  $FP_BOX

  Rollback, if something surfaces later:
    ssh $HOST
    rm -rf $ROOT/vaultchat-backend-go
    tar xzf $BAK/vaultchat-backend-go.tgz -C $ROOT
    cd $ROOT && $DC build go-api && $DC up -d --no-deps go-api

  Migrations applied in step 5 are NOT undone by that. They are additive, so the
  previous binary tolerates them — which is exactly why they run first.
NOTE
