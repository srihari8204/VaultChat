# CC-Wire application events implementation — 2026-09-15

Status: written and focused Go tests passed; not a deployment/device verification record.

## Activation

`CCWIRE_APP_EVENTS=1` enables the new server capability. The client must offer capability field 8 (`app_events_v1`) as well. With the flag unset, old Socket.IO and typed CC-Wire behavior remains available. In Redis cluster mode, the dedicated CC-Wire subscriber must initialize successfully before capability negotiation succeeds. Keep the flag off until candidate integration checks pass.

Protocol: Frame body 100 is `AppEvent { string event = 1; bytes payload_json = 2; }`. Names are at most 64 bytes. Input must be an object and passes the original 256 KiB decoded-object budget and 192 KiB individual-string bound. JSON escaping may expand a valid legacy object, so AppEvent permits up to six times the decoded budget and reuses standard Fragment frames. Only negotiated app-event sessions permit a 2 MiB logical message; physical frames remain 256 KiB, fragment chunks remain 192 KiB, and other typed logical messages retain their original 1 MiB limit. Capability 8 additionally requires fragmentation capability 1. Generic events retain legacy fire-and-forget semantics; no transport acknowledgement claims successful authorization, durable delivery or reading.

## Backend source manifest

New files under `vaultchat-backend-go/internal/realtime/`:

- `event_peer.go`: real Socket.IO and CC-Wire adapters share the same application handlers.
- `ccwire_app_events.go`: negotiation, bounded envelope dispatch, room fanout and entitlement checks.
- `ccwire_cluster.go`: Redis distribution to CC-Wire sessions on other nodes.
- `ccwire_app_events_test.go`: regression checks.

Updated files in that directory: `handlers.go`, `presence.go`, `server.go`, `delivery.go`, `cluster.go`, `ccwire.go`, `ccwire_messages.go`, `ccwire_presence.go`, `ccwire_cursor.go`, `ccwire_fragment.go`, `ccwire_coverage_test.go`, `chatview_authz_test.go`, `payload_bounds_test.go`.

Additional protocol files: `vaultchat-backend-go/internal/ccwire/codec.go`, `proto/ccwire/v1/app_event.proto` (new), `proto/ccwire/v1/envelope.proto`, `proto/ccwire/v1/capabilities.proto`, `lib/ccwire/__vectors__/codec.json`.

No database schema migration is required. Existing authenticated REST message/edit/delete/receipt/sync handlers continue owning persistence. No git staging or deployment was performed by this implementation task.

## Behavior and resource bounds

- Negotiated sessions receive all server event names through the compatibility envelope; old sessions keep typed message events.
- User, room and broadcast paths reach the new adapter. Existing viewer/location/call disconnect paths were bridged too.
- Room recipients recheck shared cached authorization, so retained subscriptions do not override revoked membership.
- Socket.IO and CC-Wire contribute to the same local online-user identity map. Call rosters include native sessions.
- One ordered command worker per native connection allows Ping/Pong while an application command is slow.
- Each command has a 30-second context derived from session cancellation. Shared permission, viewer/ghost and fanout operations honor it; legacy callers retain bounded per-operation defaults. Cancelled/closed commands cannot add rooms, and disconnect waits for the command worker before unregistering. Call-room cleanup has a five-second budget. Global database transaction behavior was not changed.
- Pending input: eight validated frames, at most approximately 2 MiB with current frame limits. Pending output: 256 frames **and** 2 MiB total bytes. These are ceilings, not idle allocations or RAM measurements.
- Subscriptions: 256 per native session, repeated joins remain idempotent; excess joins emit a structured error.
- Session exclusion IDs include node identity, preventing cross-node pointer collisions.

## Verification

`go test ./internal/realtime ./internal/ccwire` passed after all implementation changes (realtime 1.349 seconds; codec cached).

Regression checks cover two-sided negotiation; server-stamped sender identity; denied peer/server-only inbound event rejection; room join/leave fanout; revoked room entitlement; subscription limits; outbound byte limits; mixed-transport presence; and Ping/Pong while a handler is blocked. Additional checks round-trip a legacy-valid 260,000-byte object and its escaped JSON representation above 1 MiB without changing strings, reject decoded-budget overflow after reassembly, verify fragment cleanup, and cancel a blocking handler on disconnect before it can mutate room subscriptions. Focused suites passed after context propagation (realtime 1.071 seconds); final follow-up compilation is reported separately to the lead.

The host could not execute `go test -race`: CGO is disabled and no GCC was found. Real Redis multi-node behavior, physical-device calls/receipts and actual before/after memory are not proved by these unit tests. Existing Redis integration tests require an explicitly configured `VC_TEST_REDIS`; none was configured for this task.

## Remaining delivery and performance checks

- Verify frontend capability/fallback behavior against old and new backend candidates.
- Test user, room, broadcast, call and reconnect behavior across two backend instances with Redis.
- Test both actual phones before retiring Socket.IO or claiming the receipt bug fixed.
- Measure PSS/native/JS heap, server memory and latency under equivalent workloads; no numeric RAM saving is claimed here.
- Redis publication is currently bounded but synchronous (up to one second per publication during outage). Local delivery happens first. A large membership fanout can still accumulate publication delays; measure and address before high-scale activation.
- Real database/network cancellation and multi-node outage behavior still require integration checks; local tests simulate a handler awaiting its propagated context.
- Transport replay/in-place reauthentication remain unimplemented; reconnect with fresh authentication and existing durable delta sync remains the recovery mechanism.

The earlier `ccwire-server-parity.md` is the pre-implementation audit and should be read as historical findings, not current implementation status.
