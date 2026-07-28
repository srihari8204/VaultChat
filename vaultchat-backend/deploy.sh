#!/usr/bin/env bash
# VaultChat backend deploy — build locally, ship the bundle, apply DB
# migrations, zero-downtime reload. Idempotent + safe to re-run.
#
# Prereqs on the server: the backend repo checked out at $REMOTE_DIR with its
# node_modules installed (migrate.js needs `pg` + `dotenv`), pm2 running the
# api process, and .env pointing at the prod Postgres.
#
# Usage:
#   SSH_HOST=root@65.21.229.167 REMOTE_DIR=/root/vaultchat/vaultchat-backend ./deploy.sh
set -euo pipefail

SSH_HOST="${SSH_HOST:?set SSH_HOST, e.g. root@65.21.229.167}"
REMOTE_DIR="${REMOTE_DIR:-/root/vaultchat/vaultchat-backend}"
PM2_APP="${PM2_APP:-vaultchat-api}"

echo "==> 1/5  Build bundle (esbuild -> dist/server.js + dist/migrations)"
npm run build

echo "==> 2/5  Ship runtime bundle + migration files to $SSH_HOST:$REMOTE_DIR"
# dist/ = server.js, package.json, node_modules (native deps), migrations/
rsync -az --delete dist/            "$SSH_HOST:$REMOTE_DIR/dist/"
# migrate.js + the source migrations dir are what `migrate.js up` reads.
rsync -az migrate.js migrations/    "$SSH_HOST:$REMOTE_DIR/" 2>/dev/null || \
  scp migrate.js "$SSH_HOST:$REMOTE_DIR/migrate.js"

echo "==> 3/5  Show pending migrations (read-only)"
ssh "$SSH_HOST" "cd $REMOTE_DIR && node migrate.js status | tail -20"

echo "==> 4/5  Apply migrations 024–032 (ledgered + idempotent)"
ssh "$SSH_HOST" "cd $REMOTE_DIR && node migrate.js up"

echo "==> 5/5  Zero-downtime reload"
ssh "$SSH_HOST" "pm2 reload $PM2_APP && pm2 save && sleep 1 && curl -fsS http://localhost:3000/health && echo ' health OK'"

echo "==> Done."
