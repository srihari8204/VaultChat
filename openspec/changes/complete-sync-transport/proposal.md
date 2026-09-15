## Why

The repaired sync paths still lose policy continuity across cold-sync pages and CC-Wire cannot backfill edits/deletions below a message cursor. Production also terminates TLS at host nginx without HTTP/3, while the tested Rust socket remains disconnected from the app.

## What Changes

- Add server-authored sync continuation carrying message and mutation positions; clients treat it as opaque and checkpoint it only after durable storage.
- Preserve HTTP submission and Socket.IO realtime as fallbacks while CC-Wire/Rust is opt-in and negotiated.
- Add a Caddy UDP/8443 HTTP/3 edge while retaining nginx TCP listeners, other hostnames and the existing TURN UDP/443 redirect; advertise it only after external protocol checks pass.
- Define WebTransport as an optional CC-Wire carrier using the same frames, authentication and single delivery owner. Do not enable it until mobile support and interoperability pass.
- Add focused cross-codec, pagination, fallback and transport verification.
- Extend the user-approved staged migration to all Socket.IO application events through a negotiated CC-Wire compatibility envelope, retaining typed protobuf message submission and existing authorization handlers.
- Use one active realtime carrier after event parity negotiation, with bounded queues and measured device/server performance. Keep legacy peers supported during rollout.
- Repair receipt persistence, push-registration retries and lifecycle wake races before two-device acceptance.
- Keep recoverable message history in encrypted local storage and make first paint, indexed scroll-back and cold start remain bounded as history grows from hundreds to at least 100,000 rows.

Already built and reused: protobuf CC-Wire frames, Go WebSocket endpoint, TypeScript sidecar, Rust WebSocket client, Caddy upstream proxy, nginx TLS termination, REST mutation cursor and Socket.IO fallback.

### Not building

- No new message format, encryption format, QUIC implementation or parallel delivery semantics.
- No forced migration of existing clients; server endpoints and a dedicated test APK can be staged before broader device acceptance.
- No change to nginx TCP ownership. Optional native WebTransport uses a separate Go UDP/4443 listener and the existing CC-Wire session.

## Capabilities

### New Capabilities

- `reliable-sync-transport`: Lossless paginated sync and optional CC-Wire/Rust transport with one delivery owner and tested fallback.
- `http3-edge`: HTTP/3 advertisement and QUIC reachability at the existing TLS edge without removing HTTP/2 or HTTP/1.1.

### Modified Capabilities

None.

## Impact

Affected areas include `proto/ccwire/v1`, Go realtime and chat delta handlers, TypeScript sync/CC-Wire code, Rust transport integration, local encrypted history and chat rendering, application startup, nginx deployment configuration and transport tests. No server database migration is required; production deployment remains a separate task with explicit rollback and device gates.
