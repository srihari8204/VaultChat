## Context

Before this change, the app used REST for message submission and catch-up, Socket.IO for live events, and an opt-in TypeScript CC-Wire WebSocket sidecar. The tested Rust WebSocket crate lacked an Expo/native bridge. Production TLS terminated in host nginx 1.24 without HTTP/3 support, then proxied through Caddy to Go.

## Goals / Non-Goals

**Goals:**

- Preserve cold-sync restrictions across paginated REST requests.
- Keep mutation and message cursors durable and lossless.
- Retain one active owner for each send/delivery operation and immediate fallback.
- Provide a reproducible HTTP/3 edge configuration and verification gate.

**Non-Goals:**

- Replacing E2EE, message protobuf frames, Socket.IO, or REST in one rollout.
- Implementing QUIC or WebTransport from scratch.
- Claiming production/device completion from local tests.

## Decisions

1. The Go server issues an opaque HMAC-authenticated cold-sync continuation. It binds the authenticated user and cold floor. The app stores it beside the global cursor after a page is durably applied and echoes it until the server reports completion. This avoids a schema migration and does not treat the self-declared device ID as authorization.
2. CC-Wire continues to reuse `/chats/delta` for policy and storage semantics. A future mutation continuation extends the existing cursor protobuf rather than interpreting client wall-clock metadata.
3. HTTP/3 terminates at an additive Caddy UDP/8443 listener. Existing nginx TCP/80 and TCP/443 remain because they serve other hostnames. Existing UDP/443 redirects to the TURN call relay and must remain intact. Only the API hostname advertises the new port through Alt-Svc after config, firewall and protocol checks pass. Removing the advertisement and new UDP listener rolls back the change.
4. Optional WebTransport carries the same length-delimited CC-Wire frames over one reliable bidirectional stream. A dedicated Go UDP/4443 listener reuses the CC-Wire session handlers; Caddy does not proxy the CONNECT session. The existing TypeScript client remains the protocol owner. An explicit same-host HTTPS endpoint and a native build capability enable one WebTransport attempt, followed by WebSocket fallback. Deployment uses an atomic certificate bundle readable by the nonroot API process.
5. The Android bridge uses the existing Rust TLS/WebSocket dependencies as a binary carrier. The TypeScript CC-Wire client retains framing, authentication handshake and reconnect ownership. Representable text submissions use the existing protobuf contract and idempotency key; unsupported metadata and message types retain REST. Socket.IO continues to own application live events until a complete event handover is validated.

## Risks / Trade-offs

- A lost continuation can widen a subsequent request to normal warm-sync behavior → persist it before the numeric cursor and refetch safely after failure.
- Rotating `JWT_SECRET` invalidates continuations → return 400; the client clears invalid state and restarts from its durable cursor.
- Serving API requests through a second TLS edge can expose routing differences → validate on alternate ports first and retain nginx. Current attachments use R2 directly and bypass both edges.
- React Native lacks a standard WebTransport API → use the optional Android Rust bridge, retain platform WebSocket fallback and distinguish native interoperability from phone acceptance.
- A native panic can terminate the app before JavaScript fallback → configure a TLS provider in default builds and contain unwinding at the native boundary, with actual TLS regression coverage.

## Migration Plan

1. Deploy the backward-compatible Go continuation response.
2. Release the app that echoes and checkpoints it; old servers ignore the extra query and old clients ignore the response.
3. Verify REST/Socket.IO/CC-Wire interoperability on two devices before enabling CC-Wire.
4. Test the Caddy HTTP/3 edge on alternate TCP/UDP ports, then expose UDP/8443 and advertise it only on the API nginx vhost while keeping nginx TCP listeners and the TURN UDP/443 redirect.
5. Add WebTransport only after mobile support exists; negotiate it and fall back to WebSocket on any failure.

## Remaining Acceptance

The September 15 follow-up authorizes staged replacement of every app Socket.IO consumer. The stable event interface remains; negotiated `app_events_v1` carries allowlisted event names and bounded JSON payload bytes inside a protobuf AppEvent envelope. This compatibility payload is not fully typed protobuf. Server adapters invoke the same authenticated handlers for either carrier; room membership and user/broadcast fanout include both during mixed-client rollout. The capability stays gated until parity tests pass.

The app chooses one steady-state realtime carrier, WebTransport or WSS. Unsupported negotiation closes before legacy fallback. LiveKit media, push and file transfers retain required independent connections. Games currently use separate raw WebSockets, not Socket.IO. Queues have count and byte ceilings; durable messages remain in existing persistent sync/outbox storage. App heartbeats share the selected session, with required carrier-level timers. Lower RAM and faster startup claims require equivalent before/after measurements.

Large history remains encrypted on the device because delivered server message bodies may be purged and cannot be treated as a recoverable cache. Chat opening reads a small indexed newest-first window, mounts only visible rows, prepares the next local page after first paint and uses keyset pagination while keeping a bounded JavaScript window. Media work follows viewability and bounded concurrency. Startup changes remove repeated whole-history/schema work and defer nonvisual initialization only where killed-call, notification, security and realtime guarantees remain intact. Performance claims require 100, 1,000, 10,000 and 100,000-row fixtures on both authorized Android devices.

Before migration rollout, source and the current signed APK were saved privately at `/home/srihari/vaultchat-checkpoints/pre-migration-20260915`. The live backend fingerprint `859b143426237b6b` matched the snapshot, requiring no identical-image restart. Image `vaultchat-go-api:pre-migration-20260915` preserves rollback. Fresh health/readiness and HTTP/3 checks passed.

- Verify the corrected Android APK and actual carrier acknowledgements on the authorized phone.
- Complete two-device delivery, receipts and network/background acceptance before broad rollout.
- Verify external UDP/8443 reachability before advertising HTTP/3; nginx retains other hostnames and TURN retains UDP/443.
