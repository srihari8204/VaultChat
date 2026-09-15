# Audit 09: performance and cold start

Read-only review found no new severe unbounded-queue or duplicate-primary-carrier regression in the audited paths. This is a code review, not a throughput or battery result.

## Findings

- `lib/socket.ts` shares connection attempts, lazily imports Socket.IO only on fallback, and the CC-Wire supervisor closes its owner before WebSocket or legacy handover. An established legacy reconnect reuses its existing socket. Rust permits at most two registry entries to accommodate one retiring carrier; that is not evidence of two steady-state primary connections.
- One application heartbeat belongs to the active CC-Wire client: 10-second ping interval and 5-second timeout, with timers cleared on teardown. Current legacy Go Socket.IO also uses a 10-second interval, so this migration alone does not demonstrate fewer heartbeat wakeups. TCP/QUIC keepalives and media/push connections are separate.
- Native outbound admission is bounded by 32 entries and approximately 2 MiB including the active write. App-event fragment assembly has a separate approximately 2 MiB aggregate budget and expiry. The server has a bounded command queue and outbound budget. These bounds are per layer, not a claim that total process memory is 2 MiB. Frames, decoded JSON, encryption buffers, SQLite, UI and native stacks add memory.
- Generic event payloads remain JSON inside protobuf. The native bridge converts bytes to/from base64, creating copies and expanding the encoded bytes. Rust networking therefore does not imply zero-copy, typed protobuf for every field, or lower total handset RAM.
- Optional WebTransport tries UDP first, then WSS sequentially. A blocked UDP network can spend up to the native 8-second connection deadline before fallback; the supervisor also has a 15-second handshake deadline. This is a connection-readiness risk to measure across networks, not first-frame timing. Do not promise universally quicker connection setup or tune deadlines without packet-loss measurements.
- Boot overlaps the socket handshake and SQLite initialization, dynamically starts sync/receipts/outboxes, and defers media housekeeping after interactions. The `boot_effect_start` mark occurs after process and bundle startup. The gap to `boot_unblocked` is only one portion of startup; it cannot substitute for process launch-to-chat-ready time.
- Games, LiveKit calls and other required independent transports remain separate. One primary app-event carrier does not mean one network socket for the entire application.

## Evidence and limits

Existing local `npx tsx lib/ccwire/appEventFragments.selftest.ts` passed: escaped large payload, physical bounds, ordering, duplicates, expiry, aggregate budget and cleanup. This validates bounds, not speed. Existing `scripts/bench/sockets-bench.js` targets Socket.IO and is not a fair CC-Wire comparison; no production load was generated.

Recorded baseline code 26 Activity cold launches: Honor 1,396 ms; Redmi 1,548 ms. Honor chats PSS was 219,871 KiB (214.7 MiB). Older Redmi PSS 197,439 KiB came from a different lifecycle condition and must not be compared directly. API container memory 13.09 MiB was a single idle snapshot, not marginal bytes per connection. No improved RAM, HDD, cold-start or latency figure is established yet.

## Measurement recipe

1. On each phone separately, compare signed baseline and candidate builds with unchanged app data, chat, network and background state. Record transport diagnostics to distinguish CC-Wire WT, CC-Wire WSS and legacy fallback. Do not pool different phones' timings.
2. Measure at least five force-stop launches to the same chats screen with `am start -W`; separately record chat-ready, database-ready and transport-ready marks. Report median and range, keeping first install/schema-upgrade runs separate. Never clear user data for timing.
3. After identical 60-second idle and labelled-message workloads, record `dumpsys meminfo com.vaultchat.app`, including PSS and native/Java/graphics breakdown. Retain equal history/media data; installation size and process RAM are different measurements.
4. In an isolated backend with synthetic accounts, run equal authenticated idle connection counts and identical fanout/reconnect workloads for legacy and CC-Wire. Record success/error counts, p50/p95 delivery latency, CPU, RSS, Go heap/goroutines and transmitted bytes; sample warmed baselines before calculating marginal memory per connection. The existing Socket.IO benchmark needs a CC-Wire driver before it can support a protocol comparison.
5. Test UDP-allowed and UDP-blocked networks separately, plus foreground/background and reconnect delivery. Use actual receiving-device timestamps and delivery/read database cursors. Only compare grey/blue ticks after correctness passes.

No code was changed by audit 09; root owns physical-device measurements and deployment.
