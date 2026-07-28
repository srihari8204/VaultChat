# Realtime migration strategy — DECISION (Phase 2, Step 1)

## The two options

**(A) Keep `socket.io-client` on the app; run a Socket.IO-v4-compatible server
in Go** (`zishang520/socket.io` — an actively maintained Go port of the
Socket.IO v4 server, with a Redis-adapter package that speaks the same wire
format as `@socket.io/redis-adapter`).

**(B) Migrate `lib/socket.ts` to raw WebSocket + a Go-native WS server**,
behind a `USE_WS_V2` client flag, Socket.IO path kept live during rollout.

## Facts that drive the choice

- `lib/socket.ts` is the ONLY client seam (verified) — but everything rides on
  it: 38 client→server + 37 server→client events (frozen in
  `vaultchat-backend/contract/socket-events.json`) covering messaging, calls
  (WebRTC signaling), games, VaultBeam signaling, live location, viewers,
  typing, presence.
- The client is **websocket-only** (`transports: ['websocket']`, no polling
  fallback — deliberate launch decision). A compatible server therefore needs
  only the WS side of Engine.IO v4 + the Socket.IO packet layer — the
  long-polling/upgrade machinery (the riskiest protocol surface) is never
  exercised.
- Reconnect/backoff/banner logic ("can't connect" after 5 failures, 3-state
  conn status, persistent listeners for incoming calls) is built on
  socket.io-client behavior. Option B reimplements ALL of it.
- Cross-over interop: during any gradual cutover, Node and Go must fan out to
  each other's connected sockets. The Redis-adapter wire format is the bridge —
  `zishang520/socket.io-go-redis` implements the same pub/sub protocol as
  `@socket.io/redis-adapter`, so a room emit from either side reaches both.
- Constraint 3 of this phase: no client contract change without an explicit
  flagged client change. Option A needs NO client change at all.

## Decision: **Option A**

Rationale, in order of weight:

1. **Client blast radius: zero.** No app release is required to migrate, soak,
   or roll back realtime. Rollback is a proxy flip, same as every REST route.
   Option B couples the server migration to APK rollout cycles and puts every
   realtime feature (including call ringing, which has already bitten us once)
   behind a new hand-rolled reconnect stack.
2. **Protocol risk is bounded and testable.** websocket-only trims the
   Socket.IO surface to: WS handshake (+JWT in `auth`), ping/pong, EVENT/ACK
   framing, rooms, disconnect semantics. The contract suite's realtime checks
   + the fan-out load harness run identically against the Go server
   (BASE_URL swap) and gate the cutover.
3. **Adapter interop enables shadow-running.** Both servers join the same
   Redis adapter channels; we can move 5% of sockets to Go (proxy rule on the
   WS path) while ALL emits still reach everyone — a true strangler cutover.
4. Option B remains the right *eventual* end-state if we ever want to shed the
   Socket.IO dependency — but it is a client-side project, sequenced AFTER the
   server migration, when Go already owns realtime and the WS v2 path can soak
   next to a proven Go Socket.IO path. Migrating protocol AND server AND
   client simultaneously is the maximum-risk ordering; A avoids it.

## Consequences

- `vaultchat-backend-go` takes a dependency on `zishang520/socket.io` +
  `zishang520/socket.io-go-redis`. Pin exact versions; wrap in our own
  `realtime` package so a future swap (option B server-side) is one seam.
- JWT-at-handshake auth, every event name, room naming (`user:{uid}`,
  `chat:{id}`, `channel:{id}`, `call:{chatId}`, `game:*`, `admin`), and the
  ghost-mode / block-list fan-out filters are ported 1:1 from `server.js`
  (they are backend logic, independent of the protocol library).
- Client `lib/socket.ts` is untouched in Phase 2. `USE_WS_V2` is NOT
  introduced.
- Realtime migrates LAST (Step 5), after all REST routes + workers, exactly
  per the phase plan.
