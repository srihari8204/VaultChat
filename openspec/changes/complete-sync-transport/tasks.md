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
- [ ] 4.3 Enable `CCWIRE_WS` only for a staged cohort after server and app compatibility checks.

## 5. Device verification

- [ ] 5.1 Verify two authorized phones across Wi-Fi/cellular changes, background/foreground, edits/deletes, receipts and duplicate suppression.
- [x] 5.2 Verify the shipping app invokes the Rust transport before describing Rust networking as integrated. Installed 1.2.10/code26 ARM64 APK cold-launched on Honor and reported CC-Wire ready with `rust-ws`; protobuf sends and native WebTransport acceptance are recorded separately.

## 6. Mobile integration — written

- [x] 6.1 Expose verified Rust WebSocket I/O through an Android native bridge and reproducible Expo plugin, preserving one CC-Wire session owner.
- [x] 6.2 Submit representable messages through protobuf CC-Wire with stable client IDs and sequential HTTP fallback; preserve unsupported message semantics through REST.
- [x] 6.3 Show native carrier, connection state, acknowledged sends and fallback evidence in the existing diagnostics screen.
- [x] 6.4 Build an ARM64 APK with the transport cohort enabled and validate bundling, native linking and focused regressions. Corrected TLS-provider build succeeded and launched on Honor. Final reconnect-fix APK also built and passed signature verification; installation is pending because Honor disconnected.
