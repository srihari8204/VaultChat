## 1. Sync continuity — written

- [x] 1.1 Add authenticated cold-sync continuation to `vaultchat-backend-go/internal/routes/chats.go`; no database migration is required.
- [x] 1.2 Persist and echo the continuation in `lib/syncEngine.ts` only after page storage succeeds.
- [x] 1.3 Add Go and TypeScript regressions for interleaved chats, forged continuations and storage failure.
- [x] 1.4 Extend the CC-Wire protobuf and Go/TypeScript/Rust codecs with a server-issued mutation continuation, preserving old-peer behavior.

## 2. HTTP/3 and WebTransport — written

- [x] 2.1 Add a Caddy HTTP/3 edge configuration and compose override that retain TCP HTTP/1.1+HTTP/2 and publish UDP/8443, preserving the existing TURN UDP/443 redirect.
- [x] 2.2 Add offline config validation and protocol smoke instructions with rollback to `nginx/sites/vaultchat.conf`.
- [x] 2.3 Add WebTransport only after one mobile implementation can reuse the existing CC-Wire frame/session core; do not advertise the capability before interoperability passes. Real Go/Rust TLS, JWT and framed Hello/Ping interoperability passed.

## 3. Validation — written

- [x] 3.1 Run focused Go/PostgreSQL, TypeScript, protobuf parity and Rust networking checks.
- [x] 3.2 Run typecheck, lint, OpenSpec strict validation and Ponytail review of the affected diff.

## 4. Production deployment

- [x] 4.1 Deploy the tested Go source snapshot and rebuilt API image with retained rollback image, plus finalized edge files; migration: none. Source is preserved under `/home/srihari/vaultchat-releases/transport-20260915/source`.
- [x] 4.2 Validate certificates, TCP/443, UDP/8443, HTTP/3 negotiation, API health and fallback before advertising the additive UDP edge; retain nginx TCP listeners and TURN UDP/443. External PC probe passed HTTP/3.0/ALPN h3/status 200, then API-only Alt-Svc was enabled and normal HTTPS health rechecked.
- [x] 4.3 Enable `CCWIRE_WS` after server and app compatibility checks. Production now advertises CC-Wire WebSocket, WebTransport and app events with legacy fallback retained.

## 5. Device verification

- [ ] 5.1 Verify two authorized phones across Wi-Fi/cellular changes, background/foreground, edits/deletes, receipts and duplicate suppression.
- [x] 5.2 Verify the shipping app invokes the Rust transport before describing Rust networking as integrated. Installed 1.2.10/code26 ARM64 APK cold-launched on Honor and reported CC-Wire ready with `rust-ws`; protobuf sends and native WebTransport acceptance are recorded separately.

## 6. Mobile integration — written

- [x] 6.1 Expose verified Rust WebSocket I/O through an Android native bridge and reproducible Expo plugin, preserving one CC-Wire session owner.
- [x] 6.2 Submit representable messages through protobuf CC-Wire with stable client IDs and sequential HTTP fallback; preserve unsupported message semantics through REST.
- [x] 6.3 Show native carrier, connection state, acknowledged sends and fallback evidence in the existing diagnostics screen.
- [x] 6.4 Build an ARM64 APK with the transport cohort enabled and validate bundling, native linking and focused regressions. Version 1.2.13/code29 is signed, installed over Redmi without clearing data, and reports CC-Wire ready on the native `rust-wt` carrier.

## 7. Complete event migration and receipt reliability — written

- [x] 7.1 Inventory frontend Socket.IO consumers and backend event gaps in `docs/reviews/socketio-ccwire-feature-inventory.md` and `docs/reviews/ccwire-server-parity.md`.
- [x] 7.2 Preserve pre-migration source, signed APK and running API image on Hetzner; verify archive hashes, live source fingerprint, API/database/Redis readiness and HTTP/3 before continuing.
- [x] 7.3 Add negotiated AppEvent envelope and shared authorized server handlers, mixed-carrier fanout/presence and queue byte ceilings in `proto/ccwire/v1` and `vaultchat-backend-go/internal/{ccwire,realtime}`.
- [x] 7.4 Migrate `lib/socket.ts` to a stable event adapter over a single negotiated CC-Wire carrier with tested legacy fallback, reconnect/auth and bounded buffering in `lib/ccwire`.
- [x] 7.5 Fix FCM transient errors, registration zero-row false success, lifecycle sync races and receipt durability in CallService, pushRegistration, Android templates, routes/calls.go, syncEngine, syncBackground, receipts and app/chat.tsx.
- [x] 7.6 Run focused regressions, full typecheck/lint/test and strict change validation; review changes for unnecessary complexity.

## 8. Migration delivery and acceptance

- [x] 8.1 Deployed separately tested source `a87ebdea3825f347` with all six existing Compose overlays plus the events override; retained immutable rollback under `/home/srihari/vaultchat-releases/ccwire-events-20260915`. Public/direct build, health, readiness and authentication checks passed. No database migration.
- [x] 8.2 Built and signed arm64 APK 1.2.14/code 30, installed it in place on Honor and Redmi, and preserved both local chat lists. Both devices negotiated `rust-wt`; Honor submitted message 70 as protobuf with one Ack and no HTTP fallback. The full client/Go/Rust event suites passed, and Redmi selected `rust-ws` during Wi-Fi loss before returning to ready `rust-wt` after restoration.
- [x] 8.3 Verify two-device send, durable grey receipts before chat opening, blue receipts only on visible focused chat, edits/deletes, reconnect and old/new-peer compatibility against server/database evidence. Code 29 sent message 69 from Honor to Redmi over `rust-wt`; Redmi showed unread before opening, then plaintext after opening. Production cursors proved delivered 69 before read 69, and the subsequent edit/delete appeared on both devices with matching `edited_at`/`deleted_at`. Wi-Fi loss selected the Rust WebSocket fallback and restoration returned to ready `rust-wt`; earlier code/server compatibility checks retained the legacy fallback.
- [ ] 8.4 Measure equivalent Android memory, startup/chat-ready time and server per-connection overhead. Report results and limits; do not infer savings from protocol choice.

## 9. Local-history and startup performance

- [x] 9.1 Preserve recoverable encrypted message history when server bodies may be purged; add regression coverage for imported rows, pending envelopes, tombstones and large histories.
- [x] 9.2 Keep chat opening and scroll-back bounded with indexed 50-message first paint, prepared/local older pages, a single pagination owner and a bounded JavaScript window.
- [x] 9.3 Fix large-history search/jump and exact page-budget continuation without replaying cached Double Ratchet history.
- [x] 9.4 Remove measured repeated cold-start work while retaining killed-call, notification action, security, E2EE identity and CC-Wire behavior.
- [x] 9.5 Ran 100/1,000/10,000/100,000-row tests and full client/backend/Rust validation; built and verified code 30; installed it without clearing data; benchmarked both phones against WhatsApp; and verified Honor-to-Redmi delivery/read cursors, plaintext, edit and delete propagation against production database evidence.
