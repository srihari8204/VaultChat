#!/usr/bin/env bash
#
# VaultChat maintenance window — items that need a container restart.
#
# Everything here was deferred from the 2026-08-09 audit BECAUSE it interrupts
# service. The zero-impact items (firewall, .env perms, backups, Ollama removal)
# are already done and are NOT repeated here.
#
# Run on the host as `srihari`:
#     bash maintenance-2026-08-09.sh            # dry run: prints, changes nothing
#     APPLY=1 bash maintenance-2026-08-09.sh    # actually apply
#
# Steps are independent. Set SKIP_<n>=1 to skip one, e.g. SKIP_4=1.
#
# EXPECTED DISRUPTION
#   step 1 (redis auth) : socket connections drop, clients reconnect. ~10s.
#   step 2 (port binds) : restarts redis+postgres. API errors for ~15s.
#   step 5 (go-api)     : API unavailable ~10s.
# Do steps 1 and 2 together — both restart Redis, so pay the cost once.

set -uo pipefail

APPLY="${APPLY:-0}"
DIR=/home/srihari/vaultchat
COMPOSE="docker compose"
say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run()  { if [ "$APPLY" = "1" ]; then eval "$@"; else echo "   [dry-run] $*"; fi; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }

cd "$DIR" || { echo "cannot cd $DIR"; exit 1; }

# ── PRE-FLIGHT ────────────────────────────────────────────────────────────
say "PRE-FLIGHT"
# A verified backup FIRST. Every step below is reversible, but a restore is the
# only thing that covers the case none of them anticipated.
if [ "$APPLY" = "1" ]; then
  /home/srihari/vaultchat-backups/backup.sh || { echo "BACKUP FAILED — stopping"; exit 1; }
fi
ok "backup taken (or dry-run)"
cp -n docker-compose.yml "docker-compose.yml.bak-$(date +%Y%m%d)" 2>/dev/null && ok "compose backed up" || warn "compose backup already exists"

# ── 1. REDIS PASSWORD ─────────────────────────────────────────────────────
# Redis currently has requirepass empty AND protected-mode no. The firewall is
# the only thing in front of it. This adds the lock behind the door.
#
# BOTH sides must move together: if Redis gets a password and go-api does not,
# real-time messaging breaks for every user.
if [ "${SKIP_1:-0}" != "1" ]; then
  say "1. Redis requirepass"
  PASS=$(openssl rand -hex 32)
  echo "   generated a 64-char secret (written to .env, not printed here)"
  run "grep -q '^REDIS_PASSWORD=' vaultchat-backend/.env || echo 'REDIS_PASSWORD=$PASS' >> vaultchat-backend/.env"
  echo "   NOW EDIT docker-compose.yml BY HAND:"
  echo '     redis:'
  echo '       command: redis-server --requirepass ${REDIS_PASSWORD} --protected-mode yes'
  echo '     go-api:'
  echo '       environment:'
  echo '         REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379'
  echo "   then:  $COMPOSE up -d redis go-api"
  echo "   verify: docker exec vaultchat-redis-1 redis-cli PING          -> NOAUTH (good)"
  echo "           docker exec vaultchat-redis-1 redis-cli -a \$REDIS_PASSWORD PING -> PONG"
  echo "           curl -s https://api.corefinite.com/health             -> redis:true"
fi

# ── 2. BIND PUBLISHED PORTS TO LOCALHOST ──────────────────────────────────
# The DOCKER-USER firewall rules protect these today, but they are runtime
# state. Binding to 127.0.0.1 makes it declarative: the ports are never on a
# public interface at all, so a flushed iptables chain cannot re-expose them.
if [ "${SKIP_2:-0}" != "1" ]; then
  say "2. Bind internal ports to 127.0.0.1 (compose)"
  echo "   EDIT docker-compose.yml ports:  \"16379:6379\" -> \"127.0.0.1:16379:6379\""
  for p in "16379:6379 redis" "15432:5432 postgres" "19092:9092 kafka" "19000:9000 minio" "14000:4000 go-api"; do
    echo "     $p"
  done
  echo "   then: $COMPOSE up -d"
  echo "   verify from your laptop: nc -zv 65.21.229.167 16379   -> refused/timeout"
  echo "   NOTE: keep the DOCKER-USER rules as belt-and-braces; they cost nothing."
fi

# ── 3. VAULTLENS WORKER ───────────────────────── DONE 2026-08-09 20:5x ───
# RESOLVED — kept here as the record of what was wrong, not as work to do.
#
# It was not merely "unhealthy", it was DEAD: `getaddrinfo EAI_AGAIN redis`
# for 10+ days, so every VaultLens job users submitted queued and was never
# processed. VaultLens is a live feature (app/vaultlens.tsx, lib/vaultlens/api.ts),
# so this was user-facing breakage, not idle infrastructure.
#
# Two separate faults:
#   1. the worker lost Redis and never recovered  → fixed by `docker restart`
#   2. the image's healthcheck curls localhost:3000, but this is a QUEUE worker
#      with NO HTTP server (confirmed: no listening sockets), so the check could
#      never pass. It reported unhealthy whether working or not — which is
#      precisely why nobody noticed fault 1 for ten days.
#
# The healthcheck is now overridden in docker-compose.yml to test the dependency
# that actually failed:
#     test: ["CMD","node","-e","require('net').connect(6379,'redis')..."]
# so `unhealthy` now means "cannot reach Redis" instead of meaning nothing.
if [ "${SKIP_3:-0}" != "1" ]; then
  say "3. vaultlens-worker — ALREADY FIXED, verify only"
  docker ps --filter name=vaultlens --format '   {{.Names}}  {{.Status}}'
  echo "   expect: (healthy). If unhealthy again, Redis is genuinely unreachable."
fi

# ── 4. PIN IMAGE TAGS ─────────────────────────────────────────────────────
# Five tags float. minio and valhalla are on :latest — either can cross a MAJOR
# version on any pull, with no code change to blame it on.
#
# Digests below were read off the images RUNNING on 2026-08-09, so applying them
# changes nothing about what executes — it only stops a future pull from moving.
#
# CORRECTION to the note that used to be here ("NO restart needed"): that is
# wrong, and a dry-run proved it. Compose treats `redis:7` -> `redis:7@sha256:..`
# as a changed spec even when it resolves to the identical image, and WILL
# recreate postgres, redis, minio and valhalla. Pinning was therefore deferred
# out of the zero-impact pass and belongs HERE, in the same restart window as
# step 1/2 — pay the interruption once.
if [ "${SKIP_4:-0}" != "1" ]; then
  say "4. Pin floating image tags (RECREATES containers — window only)"
  cat <<'PINS'
   docker-compose.yml:
     image: caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
     image: postgres:16@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171
     image: redis:7@sha256:33d7c9a245edd95e6703a0addbeaa48fe40c3b3b4783627a72085155462ebfdb
     image: minio/minio:latest@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e
     image: ghcr.io/gis-ops/docker-valhalla/valhalla:latest@sha256:060da5b92e6024a67f65135c236d918b021d63e73d1808a0d55b7e7cbd17240c
   verify BEFORE applying:  docker compose up -d --dry-run
PINS
  echo "   NOTE: minio + caddy already show pending recreates from config drift"
  echo "         that predates this script — the running containers were deployed"
  echo "         from a different compose revision. Expect them in the dry-run."
fi

# ── 5. DEPLOY go-api (per-device delivery pointers) ───────────────────────
# Migration 078 created chat_device_delivery, but the RUNNING image predates
# the code that writes to it, so the table stays empty. DELETE_ON_DELIVERY must
# stay OFF until it has real coverage, or the sweep purges messages using only
# the account-level pointer — the exact data loss 078 exists to prevent.
if [ "${SKIP_5:-0}" != "1" ]; then
  say "5. Deploy go-api (writes chat_device_delivery)"
  echo "   $COMPOSE build go-api && $COMPOSE up -d go-api"
  echo "   verify: curl -s https://api.corefinite.com/health   -> 200"
  echo "   then, after a day of normal traffic:"
  echo "     docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat \\"
  echo "       -tAc 'SELECT count(*) FROM chat_device_delivery;'   -> should be > 0"
  echo "   ONLY THEN consider DELETE_ON_DELIVERY=true."
fi

say "ROLLBACK"
cat <<'ROLL'
   compose:  cp docker-compose.yml.bak-<date> docker-compose.yml && docker compose up -d
   go-api :  the previous image id was recorded in the audit; docker compose up -d go-api
   redis  :  remove --requirepass from compose + REDIS_URL, docker compose up -d redis go-api
   db     :  zcat /home/srihari/vaultchat-backups/<newest>.sql.gz | \
               docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat
ROLL

say "DONE (${APPLY:+APPLY=$APPLY})"
[ "$APPLY" = "1" ] || echo "   dry run only — nothing changed. Re-run with APPLY=1 to act."
