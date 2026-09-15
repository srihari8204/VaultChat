# CC-Wire server parity audit — 2026-09-15

Read-only source audit; this report makes no deployment, database, benchmark, or device-verification claim. Backend files were not changed. Scope: Go `internal/realtime`, existing protobuf envelope and transport adapters.

## Decision

Do not disable Socket.IO yet. Existing CC-Wire supports important messaging commands and events, but does not cover complete realtime delivery. Reuse the existing Hub authorization and feature handlers; extend their transport-neutral entry/exit points rather than introducing another policy/store.

## Implemented reusable behavior

| Area | Existing implementation |
|---|---|
| Carriers | `/ccwire/v1` WebSocket and `/ccwire/wt/v1` WebTransport both call `Hub.ccwireRun`; HTTP bearer authentication precedes upgrade. WT uses one reliable bidirectional stream with draft-02 negotiation. |
| Framing | Five-byte prefix, bounded protobuf parsing, negotiated limits, fragmentation reassembly, request-correlated errors/Acks. |
| Commands | `serveBody` accepts SubmitMessage, EditMessage, DeleteMessage, Receipt, TypingState, CursorSync, ViewerState, GeoRelay. |
| Database semantics | Submit/edit/delete/receipt/cursor invoke the existing REST mux in-process with authenticated context and device ID, preserving its authorization, persistence and fanout. No new tables needed for basic transport parity. |
| Chat authorization | `chatMemberAllowed`, `peerAllowed`, `runAllowed` and permission cache invalidation already available in the same package. |
| Delivery audience | `FanOutToChat` shares membership, blocking and ghost-mode decisions; `emitToUidIn` sends to both transports locally. |
| Backfill | CursorSync calls canonical `/chats/delta`, validates cursor provenance and pages data. ServerHello honestly returns `resumed=false`. This is message catch-up, not replay of every arbitrary realtime event. |
| Heartbeat | Client Ping/server Pong; limits advertise interval 10 seconds, timeout 5 seconds; incoming traffic refreshes 60-second idle deadline. |
| Shutdown | GoAway and bounded drain support already present. |

## Exact parity gaps and risks

1. **Outgoing event coverage is restricted.** `ccwire_messages.go:507` `ccwireEventFrame` only translates `new_message`, `message_edited`, `message_deleted`, `typing_start`, `typing_stop`, `message_delivered`, `message_read`. Other events return nil. Viewer changes, presence, reactions, calls and other application events disappear on a CC-Wire-only client.
2. **Rooms and broadcast do not reach CC-Wire.** `server.go:371` `EmitToRooms` and `EmitBroadcast` use Socket.IO only. Additional direct `h.io.To`, `s.To`, `s.Emit` calls exist in handlers. `ccwireSession.subs` records successful authorized subscriptions but is not consulted by fanout. Subscribe Ack therefore does not prove receipt of room events.
3. **Geo relay has only half parity.** `ccwire_presence.go:199` accepts authorized sealed location/trip payloads but emits to a Socket.IO chat room only. ViewerState shares roster helpers and directly replies with ViewerList, but incremental viewer events are dropped by the outbound translator.
4. **Online presence excludes CC-Wire.** Registration updates `cwSessions` only. Socket.IO `trackSocket`/`untrackSocket` own presence; `OnlineCount` and `hasLiveSocket` do not include CC-Wire. Removing Socket.IO changes online indicators and call wake decisions unless lifecycle tracking is unified.
5. **Calls need shared membership and handlers.** CallSignal body 99 is in protobuf but not served. ScopeCall subscription checks a roster that counts Socket.IO participants only and does not implement join/leave side effects or notifications. Do not equate subscription with existing `join_call` behavior. Current handlers also cover rekey/media keys, screen sharing, call chat/emoji, VaultBeam and call wake pushes.
6. **Runs and channels are partial.** Scope subscriptions exist; run update/end relay and room delivery remain Socket.IO. Channel scope currently inherits the existing ungated channel policy; retain shared policy during migration and audit separately rather than silently changing one transport.
7. **Cross-node CC-Wire fanout is not established by this adapter.** `ccwireDeliver` enumerates process-local `cwSessions`; Socket.IO Redis adapter delivery does not automatically call it on another node. Need transport-neutral cluster event routing/dedup before claiming multi-node parity.
8. **Queue is count bounded, not byte bounded.** Per-session fanout capacity is 256 frames; at the 256 KiB frame limit that can retain approximately 64 MiB of distinct queued frame data in a worst-case slow session. Byte accounting and disconnect-on-overflow should supplement existing limits; actual allocations must be measured.
9. **No transport replay/in-place reauth.** ServerHello has empty resume token, false resumed; ReAuth is unserved. Authentication is handshake-only. Reconnect with fresh credentials and durable delta recovery is the smallest compatible baseline.
10. **Logical streams are not physical scheduling.** Current WT uses one reliable stream; writes are serialized. Comments suggesting sync cannot starve messaging are not an implementation guarantee. A long synchronous command also occupies the reader path until completion (REST loopback timeout 30 seconds), potentially delaying Ping handling. Measure and address scheduling before claiming latency isolation.
11. **Capability handshake needs scrutiny.** The server parses device ID from ClientHello and emits a fixed supported capability subset; it does not actually compute the advertised client/server intersection despite comments. New parity must have an explicit negotiated capability, not inference from an open connection.

## Frontend wire compatibility

- Retain existing body field numbers and traffic-class invariants. EPHEMERAL currently allows only TypingState, ViewerState and GeoRelay; putting new call/crypto events there is rejected.
- Server-provided Receipt includes chat identity; the original Socket.IO receipt payload may omit chat ID, so keep the router's chat context.
- CallSignal only offers kind, destination/source, chat ID and sealed bytes. It does not directly represent all existing call payload metadata/rosters. Schema presence alone is not feature parity.
- DeviceEvent, CryptoControl, AttachmentControl and CallSignal are schema bodies but are not served by this build. Games/other generic application events need explicit schema coverage or a reviewed bounded event envelope.
- A bounded event envelope can preserve existing event names/payload shapes during migration, but must be direction-specific and allowlisted. Never accept arbitrary event names and arbitrary caller-supplied actor IDs or destination rooms.
- Existing clients must ignore unnegotiated new bodies. Keep old-server fallback until capability negotiation succeeds; do not retire Socket.IO because transport connection alone succeeded.

## Smallest safe implementation sequence

1. Extract shared authorized feature functions from Socket.IO callbacks, passing authenticated actor/session and typed bounded payload; Socket.IO becomes one adapter. Avoid synthesizing fake Socket.IO socket instances.
2. Add reviewed, additive protocol coverage for missing events. Preserve typed message bodies. An allowlisted compatibility envelope for the remaining event shapes is smaller than prematurely creating dozens of bespoke codecs, but requires a negotiated capability and preserved payload bounds.
3. Add transport-neutral emit-to-user/rooms/broadcast leaves and shared presence/call lifecycle bookkeeping. Route all direct Socket.IO emissions through these leaves; preserve per-sender exclusion and multi-device semantics.
4. Add CC-Wire inbound dispatch only for existing authorized commands; reuse existing guards/rate limits and server-stamped identity. Test forbidden peer, removed membership, invalid payload, channel/admin distinctions.
5. Add byte-bounded queues and metrics; preserve reconnect + delta on overflow rather than silently dropping durable events. Avoid unbounded new goroutines per inbound command.
6. Validate mixed old/new client routing, then CC-Wire-only client routing, then multi-node routing. Remove client Socket.IO only after full event parity; retain server support until supported old clients have migrated.

## Required verification before retirement

- Two devices: send/edit/delete/reaction; grey receipt before opening receiver chat; read receipt only after viewing; reconnect/cold sync and lost event recovery.
- Presence with multiple devices; last-device disconnect; ghost/block settings.
- Call invite/cancel/answer/leave/disconnect, roster cap, peer authorization, call wake.
- Viewers/location/trips/runs/channels and every application event inventoried outside realtime.
- Queue saturation/byte limit, oversized frame, heartbeat during slow command, token expiry/reconnect.
- Two backend nodes with recipients on another node; no missing or duplicated events.
- Real measured app PSS/native/JS heap, backend per-connection memory, idle wakeups and message latency. No numeric RAM saving is established by this audit.

Existing focused tests live in `internal/realtime/ccwire_*_test.go`; `ccwire_coverage_test.go` explicitly records several unserved bodies. No tests were executed for this read-only report.
