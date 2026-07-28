# Deploy — fresh Go-first prod (Docker, greenfield)

Prod runs on Docker, there are no users, and the box can be wiped — so prod
ships **Go-first from day one**: Go serves 100% of the client surface (all 17
REST modules, /health, Socket.IO). The Node **API** process is NOT deployed.
Node survives only as the `vaultlens-worker` container (BullMQ render worker,
which now also hosts the QueueEvents listener and pushes `vaultlens:ready/
failed` into Go's internal bridge).

**PROVEN**: the full contract suite (REST + realtime + health) passes through
Caddy with the Node API container stopped — the decommission bar from
MIGRATION.md. All five server.js background jobs (disappearing-messages,
delete-on-delivery, media retention, scheduled messages, stories TTL) are
ported into go-api (`internal/jobs`), boot-verified.

## Prod service set (default — no profile)

caddy (:80 and :3000→ existing APK SERVER_URL compat) · go-api · postgres ·
redis · minio · valhalla · coturn · vaultlens-worker (Node).
Behind `--profile legacy` (NOT started in prod): Node api, kafka,
fanout-worker — kept for bench parity runs and emergency per-route rollback.

## Steps (on the Hetzner box)

```bash
# 0. code
git clone <repo> vaultchat && cd vaultchat && git checkout hetzner-deploy

# 1. secrets — vaultchat-backend/.env (compose feeds BOTH go-api and the worker):
#    JWT_SECRET=<random>            ADMIN_KEY=<random>
#    VAULTCHAT_MASTER_KEY=<32B hex> VAULTCHAT_LOOKUP_PEPPER=<random>
#    RESEND_API_KEY=… EMAIL_FROM=…  (onboarding OTP mail)
#    MODELSLAB_API_KEY=…            (vaultlens; optional → not_configured)
#    GIPHY_KEY=…                    (optional)
#    FIREBASE_SERVICE_ACCOUNT=…     (call wake-up push; vaultchatprod01 SA)
#    TURN_SECRET=<random>           (must match the app's TURN config)
#    plus shell env for compose:  export INTERNAL_EMIT_KEY=<random>
#                                 export DB_PASS=<random> MINIO_USER=… MINIO_PASS=…
#    S3_PUBLIC_ENDPOINT in docker-compose.yml → this box's public IP/domain.

# 2. fresh slate (DESTROYS all previous data — greenfield by decision)
docker compose down -v --remove-orphans

# 3. up — Go-first set
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# 4. migrations 001→060 on the fresh DB (one-shot via the legacy api image;
#    the container exits after)
docker compose --profile legacy run --rm api node migrate.js up

# 5. verify
curl -s http://127.0.0.1/health           # {"status":"ok","db":true,...} from GO
docker compose logs go-api --tail 20      # [jobs] lines + listening
docker compose logs vaultlens-worker --tail 5   # 'QueueEvents listener active (→ Go bridge)'
#    full gate (optional, needs a seeded bench dataset):
#    docker compose --profile legacy up -d api …seed… docker compose stop api
#    BASE_URL=http://127.0.0.1 node vaultchat-backend/contract/run.js

# 6. app: SERVER_URL → http://<box-ip>:3000 keeps working (caddy answers
#    there); move to a domain + :443 by adding a TLS site to caddy/Caddyfile
#    and enabling 443 in docker-compose.prod.yml.
```

## Rollback / escape hatches

- **Per-route to Node** (emergency): `docker compose --profile legacy up -d api`,
  add a matcher block above Caddy's default (`@x path /route/*` →
  `reverse_proxy @x api:3000`), `docker compose restart caddy`. The Node API
  remains fully functional — it just isn't routed.
- Nothing to migrate back: greenfield DB, both backends read/write identical
  rows (proven by the vault interop tests + shadow-diff 40/40).

## Watch items on first real traffic (from MIGRATION.md)

- vaultlens: soak ONE Go-enqueued generation end-to-end through the Node
  worker (the BullMQ Lua enqueue is the flagged soak item).
- On-device pass over calls / VaultBeam / live-location (contract covers the
  messaging core deeply; signaling relays shallowly).
- Sentry: watch the `vaultbeam`/`crypto` breadcrumbs for unexpected fallbacks.

## The APK

Self-contained release APK (default flags = launch config:
crypto=ts, vaultbeam=kotlin):
`android/app/build/outputs/apk/release/app-release.apk`
Rebuild: `$env:SENTRY_DISABLE_AUTO_UPLOAD='true'; cd android; .\gradlew assembleRelease`
Rust-enabled test build: set `EXPO_PUBLIC_CRYPTO_BACKEND=rust` /
`EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND=rust` before the gradle step.
