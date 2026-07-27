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

- **Step 3 — DONE**: all 17 REST modules on Go, flipped + proven (contract
  both ways + shadow-diff), including `/chats` (the messaging core).
- **Step 5 — realtime**: Go Socket.IO-v4-compatible server
  (`zishang520/socket.io/v2`) in `internal/realtime`, mounted at `/socket.io`
  on go-api. Single-node atomic cutover — NO redis adapter (this supersedes
  the adapter-interop idea in REALTIME_DECISION.md; a cross-server adapter is
  only needed for gradual multi-node cutover, which we don't do). Client
  untouched (websocket-only, `lib/socket.ts` unchanged). Cutover = flip the
  `/socket.io` route in Caddy.
- **Step 4 — workers (deliberate split, NOT a full port):**
  - `workers/fanout.js` consumes Kafka `message.created` and re-emits via the
    Socket.IO redis adapter. It only runs when `EVENT_BUS=kafka`, which the
    **prod shape leaves OFF** (single-process, in-process fan-out — see the
    Step-0 gate). With Go realtime doing in-process `FanOutToChat`, this
    matches prod exactly. Porting it now means porting a currently-unused
    horizontal-scale path that also needs the redis adapter the realtime
    layer deliberately omits — **premature; revisit only if Kafka scale-out
    is re-enabled.**
  - `workers/vaultlens.js` is a BullMQ **Worker** (ModelsLab render → R2 → DB).
    Faithfully porting the BullMQ worker protocol to Go (distributed locks,
    stalled-job detection, moveToActive/moveToFinished Lua, backoff) is a
    bug-farm with **real cost** — duplicate paid ModelsLab calls / quota
    corruption on any timing bug — for a 40-line, socket-independent process.
    **Decision: the vaultlens worker stays in Node.** It is process-isolated
    (`vaultlens-worker` compose service) and holds no sockets, so it is a
    legitimate permanent split: Go owns the client-facing surface (REST +
    WebSocket); Node runs background render jobs.
  - The ONE realtime-coupled piece: the vaultlens **QueueEvents listener**
    (job done → `vaultlens:ready` socket emit) currently lives in
    `server.js` and uses Node's `io`. Once Go owns sockets, Node's `io` has
    no clients, so this listener must push into Go instead: it POSTs to
    go-api `/internal/emit` (the reverse of the outbound bridge — go-api
    exposes the same key-guarded endpoint, backed by the realtime Hub). Env
    `GO_INTERNAL_URL=http://go-api:4000` on the Node side enables it.

## Realtime cutover — exact steps

1. `internal/realtime` builds; `go build ./... && go vet ./internal/realtime`.
2. main.go: mount `realtime.New().Handler()` at `/socket.io`; set the
   `emitx.Local*` hooks to the Hub methods; add key-guarded `/internal/emit`
   + `/internal/chat-event` handlers on go-api backed by the Hub (so leftover
   Node emitters — the vaultlens listener — can push in).
3. Node `server.js`: the vaultlens QueueEvents listener emits via the Go
   bridge when `GO_INTERNAL_URL` is set (else local `io`, unchanged).
4. Flip `/socket.io` (and the websocket upgrade) to go-api in Caddy.
5. Gate: `node contract/run.js` realtime section against the proxy (handshake
   auth reject, `ready.uid`, REST-send → `new_message` to member socket,
   `typing_start` relay). Then soak calls/games/VaultBeam/live-location
   ON-DEVICE before prod (the contract suite only covers the messaging core;
   call ringing especially needs a real two-device check).

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
