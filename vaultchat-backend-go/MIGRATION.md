# Node→Go strangler migration — runbook (Phase 2, Steps 2–6)

Status 2026-07-27: **all 17 REST modules ported; 16 flipped to Go in the
bench Caddyfile and proven** (chats port in progress — the last route).
Realtime (Socket.IO) + the fanout/vaultlens workers still run in Node by
design (Step 5 is last). Node remains fully deployable at every point.

## Architecture

```
app (ONE SERVER_URL) ──► Caddy :80 ──► per-route match ──► go-api :4000
                                   └──► default          ──► Node api :3000
                                        (incl. /socket.io websockets)
```

- `caddy/Caddyfile` is THE switch. Each route is a two-line block; commented
  = Node, uncommented = Go.
- Both backends share the same Postgres, Redis (rate-limit buckets are
  byte-identical keys), MinIO/R2, and `UPLOAD_DIR` (compose bind-mounts
  `./uploads-shared` into BOTH — required as long as either backend can
  serve `/uploads` disk files).
- Socket emits from Go-served routes bridge to Node, which owns all sockets
  until Step 5:
  - `POST /internal/emit` — rooms / userIds / broadcast:true
  - `POST /internal/chat-event` — runs Node's exact kafka-or-fanout
    new_message/chat_event broadcasters
  Both are key-guarded (`INTERNAL_EMIT_KEY`) and Caddy refuses `/internal/*`
  from outside unconditionally.

## Per-route rollback (the whole point)

1. Comment the route's two lines in `caddy/Caddyfile`.
2. `docker compose restart caddy` (sub-second; in-flight requests finish).

No deploys, no client involvement, no data migration — both backends
read/write identical rows (proven by `internal/vault` interop tests and the
shadow-diff tool).

## Cutover checklist (what every flipped route already passed — repeat for
any future change)

1. `go build ./... && go test ./...` in vaultchat-backend-go.
2. Deep fixtures in `vaultchat-backend/contract/run.js` for the module
   (promoted from smokes; exact statuses + error strings).
3. `BASE_URL=http://127.0.0.1:13000 node contract/run.js` — green vs Node.
4. Flip the route, `BASE_URL=http://127.0.0.1:18080 node contract/run.js` —
   green via proxy with Go serving the route.
5. `go run ./tools/shadow-diff -f tools/shadow-diff/migrated.jsonl -token
   <bench JWT>` — Node vs Go byte-diff on the read-only replay set
   (currently 37/37 matched).
6. Commit the flip together with its proof.

Bench prep: `docker compose -f docker-compose.yml -f docker-compose.bench.yml
up -d`, then re-seed if JWTs are stale (24 h):
`docker compose exec -u root -e DB_HOST=postgres -e DB_PORT=5432 -e
DB_USER=vaultchat -e DB_PASS=vaultchat_dev api node loadtest/seed.js` and
`docker compose cp` the two output files back to `vaultchat-backend/loadtest/`
(the host port-proxy for 15432 can go stale on Docker Desktop — in-network
always works).

## Go service env (same names as Node wherever shared)

Required: `JWT_SECRET`, DB_*, REDIS_*, `VAULTCHAT_MASTER_KEY`,
`VAULTCHAT_LOOKUP_PEPPER`, `NODE_INTERNAL_URL`, `INTERNAL_EMIT_KEY`.
Per-feature: S3_* (+`S3_PUBLIC_ENDPOINT` for presign), `UPLOAD_DIR`,
`ADMIN_KEY`, `GIPHY_KEY`, `OLLAMA_URL`/`OLLAMA_MODEL`, `VALHALLA_URL`,
`RESEND_API_KEY`/`EMAIL_FROM`, `DEV_OTP`, `GOOGLE_WEB_CLIENT_ID`,
`FIREBASE_SERVICE_ACCOUNT` (or `_FILE`), `MODELSLAB_API_KEY`,
`TURN_SECRET`/`TURN_HOST`.

## Watch items before/at prod rollout (each documented in code)

- **Per-IP rate buckets**: Express on dual-stack sockets may report IPv4 as
  `::ffff:a.b.c.d`; Go reports bare IPv4. Check the live `rl:otp:ip:*` key
  format in prod Redis; if prefixed, normalize in httpx before flipping /auth.
- **BullMQ enqueue (vaultlens /generate)**: Go EVALs the addStandardJob Lua
  extracted from bullmq 5.81.2. Soak one Go-enqueued job end-to-end against
  the real worker before flipping /vaultlens in prod; keep bullmq pinned 5.x.
- **admin onlineNow**: Go counts `users.online` (Node-maintained presence);
  Node reports its in-process socket-map size. Equivalent steady-state.
- **Disk uploads**: any deploy that still writes disk attachments needs the
  shared `UPLOAD_DIR` mounted into both backends (compose does this).
- **iOS bundle**: FCM voip topic uses `IOS_BUNDLE_ID` (defaults to
  com.vaultchat.app) — set when iOS ships.

## Remaining steps

- **Step 3 tail**: /chats flip once the port lands + contract/realtime gates
  pass (fixtures already exist and are deep — messaging core + socket
  delivery through the bridge).
- **Step 4 — workers**: `workers/vaultlens.js` (BullMQ consumer → ModelsLab
  → R2) is independently portable. `workers/fanout.js` consumes Kafka
  `message.created` and emits via the Socket.IO Redis adapter — port it
  TOGETHER WITH Step 5 (same adapter wire dependency); until then the Node
  workers keep running unchanged.
- **Step 5 — realtime, LAST**: Go Socket.IO-v4-compatible server
  (`zishang520/socket.io` + `socket.io-go-redis`) per REALTIME_DECISION.md.
  Cutover = move the `/socket.io` route in Caddy; both servers share the
  Redis adapter channels so emits cross during the transition. Client
  untouched (websocket-only, `lib/socket.ts` unchanged).

## Decommission checklist (Node retires only when ALL true)

- [ ] Every Caddyfile route block uncommented (incl. /chats) and soaked in
      prod ≥1 week with error rates at parity.
- [ ] Realtime served by Go (Step 5) incl. calls ringing, games, VaultBeam
      signaling, live location, admin firehose; reconnect banner behavior
      verified on-device.
- [ ] Fanout + vaultlens workers replaced (or consciously kept — the Node
      fanout worker is horizontally scalable and may outlive the API).
- [ ] The internal emit bridge unused (grep go-api logs for bridge calls).
- [ ] pm2/compose Node processes stopped; contract suite green with the Node
      containers DOWN (proves nothing still routes there).
- [ ] Keep `vaultchat-backend/` in the repo — it is the behavioral reference
      the contract suite and interop tests are written against.
