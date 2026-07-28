# Deploy steps — what ships where (as of branch hetzner-deploy, 2026-07-28)

Two independent things can ship: the **APK** (client) and the **server**.
The server itself has two layers: a safe Node-only redeploy (do this first)
and the optional Phase-2 Go/Caddy strangler cutover (bigger, when ready).

## 0. What is APK-only (NO server change needed)

- Phase 1 Rust crypto core — ships in the APK, flag `EXPO_PUBLIC_CRYPTO_BACKEND`
  defaults to `ts` (dormant until flipped per build).
- Phase 3 VaultBeam Rust transport — ships in the APK, flag
  `EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND` defaults to `kotlin` (dormant).
- Games removal from mini apps; family circle; nav; local-first cache; all
  other client-side campaigns on this branch.

## 1. Server layer A — Node redeploy (SAFE, no architecture change)

Prod (pm2 `vaultchat-api` on the Hetzner box) last deployed at migration 023.
This branch's backend adds routes (`/chats/delta`, `/uploads/multipart/*`,
communities, channels, vaultlens, nav, vaultbeam relay, onboarding /auth, …)
and migrations **024 → 060**. The Phase-2 additions to `server.js`
(`/internal/emit`, `/internal/chat-event`, the vaultlens `GO_INTERNAL_URL`
bridge) are **env-gated and inert** — without `INTERNAL_EMIT_KEY` /
`GO_INTERNAL_URL` set, behavior is identical to before, so this layer carries
no Phase-2 risk.

On the Hetzner box:

```bash
# 1. ship the code (your usual flow: build → scp, or git pull on the box)
cd /path/to/vaultchat-backend

# 2. deps (bcrypt/argon native builds happen here, not at runtime)
npm ci --omit=dev

# 3. migrations 024..060 — idempotent runner; `up` applies pending
node migrate.js up

# 4. env additions required by NEW features (append to the existing .env):
#    VAULTCHAT_MASTER_KEY=<32B hex>        # onboarding vault (042)
#    VAULTCHAT_LOOKUP_PEPPER=<secret>      # onboarding vault (042)
#    RESEND_API_KEY=… EMAIL_FROM=…         # onboarding OTP mail
#    MODELSLAB_API_KEY=…                   # vaultlens (optional — else not_configured)
#    VALHALLA_URL=http://127.0.0.1:8002    # nav (needs the valhalla container)
#    GIPHY_KEY=…                           # gif picker (optional)
#    (do NOT set INTERNAL_EMIT_KEY / GO_INTERNAL_URL yet — Phase-2 only)

# 5. reload
pm2 reload vaultchat-api

# 6. smoke: the contract suite against prod-shape
BASE_URL=http://127.0.0.1:3000 node contract/run.js   # needs a seeded bench DB
#   — or minimally: curl /health, login on a device, send a message.
```

Post-deploy client flags to remember (per the E2E campaign): the default-OFF
E2EE flags (W5/W6/W7/#32) still need per-flag multi-device testing before
enabling — migrations 039/040 are applied by step 3 above.

## 2. Server layer B — Phase 2 Go/Caddy strangler (OPTIONAL, when ready)

Everything is committed and bench-proven (all 17 REST modules + Socket.IO on
Go; contract green both ways; shadow-diff 40/40). Full runbook + rollback +
decommission checklist: `vaultchat-backend-go/MIGRATION.md`. Summary for the
Hetzner box:

```bash
# 1. bring up the Go backend + Caddy next to the running Node
docker compose up -d --build go-api caddy     # caddy binds :18080 (staging port)

# 2. give BOTH sides the bridge env and reload Node:
#    Node .env:  INTERNAL_EMIT_KEY=<random>  GO_INTERNAL_URL=http://127.0.0.1:14000
#    go-api env: same INTERNAL_EMIT_KEY (compose passes it), NODE_INTERNAL_URL→Node
pm2 reload vaultchat-api

# 3. verify through the proxy before any client sees it:
BASE_URL=http://127.0.0.1:18080 node contract/run.js

# 4. cutover = make Caddy own the address the app's SERVER_URL points at
#    (move pm2 Node to PORT=3001, bind Caddy to the public :3000/:443).
#    Per-route rollback forever: comment a Caddyfile block + restart caddy.

# 5. watch items before real traffic (MIGRATION.md): rl:otp:ip:* bucket
#    format for /auth; one Go-enqueued vaultlens job through the real worker;
#    on-device soak of calls/games-less realtime/VaultBeam/live-location.
```

Layer B is independent of Layer A shipping — Node stays fully deployable and
is the instant rollback at every point.

## 3. The APK

Self-contained release-variant APK (a debug-variant APK requires a Metro dev
server and does not run standalone):

```powershell
$env:SENTRY_DISABLE_AUTO_UPLOAD='true'
cd android; .\gradlew assembleRelease     # → android/app/build/outputs/apk/release/app-release.apk
```

Built with default flags (crypto=ts, vaultbeam=kotlin) = the launch
configuration. To produce a Rust-enabled test APK instead, set
`EXPO_PUBLIC_CRYPTO_BACKEND=rust` and/or
`EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND=rust` in the environment before the
gradle step (flags are inlined at bundle time).
