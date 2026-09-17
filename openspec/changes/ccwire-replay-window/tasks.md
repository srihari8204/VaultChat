# Tasks — CC-Wire replay window

## 1. Baseline

- [x] 1.1 Record gates: frontend 299/299 (221 suites), `go vet`, `go test ./...` (13 packages), `npm run test:rust` (6 crates, clippy clean)
- [x] 1.2 Confirm `s.cursors` / `s.acked` / `parkForResume` behave as `ccwire-session-resume` left them — they did not, and wiring proved it (see 5.4)

## 2. The ring

- [x] 2.1 Per-session retained-frame ring holding the ENCODED bytes, not the message
- [x] 2.2 Bound by bytes, count and age simultaneously; enforce on insert
- [x] 2.3 Skip retention for frames over the per-frame limit and for `TRAFFIC_CLASS_BULK`
- [x] 2.4 Record a hole whenever a frame is skipped, so a later resume refuses rather than silently skipping it
- [x] 2.5 Release frames at or before an acknowledged position

## 3. Retention and replay

- [x] 3.1 Retain on the same successful-send path as `noteSent` (`send()`, after the write returns nil)
- [x] 3.2 Park the ring with the session; release it when the parked session expires or is evicted
- [x] 3.3 On a successful resume, replay frames after the client's reported position in ascending sequence per stream, before new traffic (`flushReplay`, between `ServerHello` and `ccwireRegister`)
- [x] 3.4 Refuse the resume (`resumed=false`) when the gap predates the window or crosses a hole
- [x] 3.5 **Added during wiring** — a gateway-wide byte budget for parked windows. The
      per-session bound is 256 KiB and `maxParkedSessions` is 20 000: bounded per
      session and a 5 GB process-wide outage at the same time. Over budget a
      session parks WITHOUT its window, which resumes identity and refuses replay.

## 3b. Sequence numbers — the gap under the gap

Discovered by wiring, not by reading: **no outbound frame carried a `seq`.**
`noteSent` returned early on every one of them, every cursor stayed empty and
every window stayed empty. Resume and replay were correct machinery attached to
an unsequenced stream — the exact shape RULE 0 exists to catch, and invisible to
any test that supplied its own seq.

The cause is not an oversight. The fan-out encodes ONCE and shares the bytes
with every recipient, which is why a message to fifty devices is one encode. A
per-session sequence number cannot be stamped on a shared buffer.

- [x] 3b.1 Split the frame builders so they return the `ccwire.Message` alongside
      the shared encoding (`appEventBuild`, `ccwireEventBuild`)
- [x] 3b.2 `deliver()` — shared bytes verbatim for a session with no window; a
      per-session encode with its own `seq` only for one that can use it
- [x] 3b.3 Per-session, per-stream counters under the same lock as the cursors,
      the acks and the window, so a frame's seq and its enqueue cannot separate
- [x] 3b.4 Exclude EPHEMERAL and BULK, and control-plane replies sent via `send()`
- [x] 3b.5 Client: track the highest delivered `seq` per stream, report it in
      `Ping.progress` every heartbeat and in `ClientHello.resume_from` on reconnect
- [x] 3b.6 Cross-language parity: the same literal bytes asserted in
      `lib/ccwire/resume.selftest.ts` (checks 7 and 9) and in
      `TestGoParsesTheBytesTheTSClientEncodes`

## 4. Tests

- [x] 4.1 Bounds: byte ceiling, count ceiling, age ceiling, each independently
- [x] 4.2 Acknowledged frames are released — both through `release()` and through the production `noteAcked` path
- [x] 4.3 Oversized and BULK frames are not retained, and hole the window
- [x] 4.4 Gap older than the window refuses instead of partially replaying
- [x] 4.5 Replay order is ascending per stream, decoded rather than assumed
- [x] 4.6 `depends_on` still satisfied across a replay — and refused when the dependency itself was evicted
- [x] 4.7 Duplicate delivery is byte-identical to the original, so application dedup sees one row
- [x] 4.8 With `CCWIRE_RESUME` unset, no window exists and nothing is retained
- [x] 4.9 Fan-out sequences frames for a resuming session and advances its cursor
- [x] 4.10 A session without a window gets the shared bytes byte-for-byte
- [x] 4.11 Sequence counters are per session, not shared between two devices
- [x] 4.12 Every fragment of a fragmented app event is sequenced
- [x] 4.13 EPHEMERAL is never sequenced, never retained, never moves a cursor
- [x] 4.14 `Ping.progress` from the real client bytes drains the live window

## 4b. Evidence

- 216 tests in `internal/realtime` (194 before wiring, 143 at the start of the
  resume work). 13 Go packages green, `go vet ./...` clean.
- Frontend 299/299 across 221 suites; backend contract unchanged (33 c→s,
  44 s→c); Socket.IO guard passing; `webtransport-go` untouched.
- Replay writes the **retained bytes verbatim**, proven by comparing the
  replayed frames to the captured originals byte for byte, through the real
  outer framing. A re-encode would risk a frame that is subtly not the one the
  client's peers already saw.
- Cursors are NOT advanced by replay: those frames were counted when first sent.

## 5. Verification

- [x] 5.1 All gates green, no regression
- [x] 5.2 Ponytail review — the three bounds, the hole rule, the refuse-never-partially-serve rule and the resync fallback all survived; the gateway budget was ADDED under it, not removed
- [x] 5.3 Report, separating unit-proven from infrastructure-pending
- [x] 5.4 **Two defects in `ccwire-session-resume` that only wiring could expose.**
      Both were silent-loss bugs, and both are fixed:

      1. **Replay-from was taken from the server's record, not the client's
         claim.** `acceptCursors` deliberately keeps OUR higher value when the
         client reports itself behind, because a delivery cursor must not
         regress. Replaying from that value would have skipped exactly the
         frames the client had just said it was missing — a correct rule applied
         to the wrong question. The restored cursor and the replay-from point
         are now two separate numbers.

      2. **`parkForResume` parked the ACKED position, which is the wrong
         ceiling.** That was right while the parked cursor *was* the resume-from
         point. As a ceiling it refuses honest clients: a client that received
         all 100 frames and lost only the ack would have its truthful claim of
         100 rejected as a future cursor, turning the most ordinary drop into a
         forced resync. Park now records what was SENT. `resumePosition` is
         deleted, and the test that asserted the old rule was rewritten with the
         reversal recorded in it rather than quietly changed.

## 5b. Infrastructure-pending — NOT claimed

- **The race detector could not be run.** `go test -race` needs cgo and there is
  no gcc on this machine. `deliver`, `noteSent`, `noteAcked` and the window are
  now under one mutex by construction and by review, NOT by `-race`. This must
  be run in CI before the flag is turned on anywhere.

- End-to-end replay over a real socket, on a real device, across a real
  cellular drop. Everything above is unit-level.
- Wi-Fi ↔ mobile migration, and resume across a gateway restart.
- Behaviour under a real reconnect storm against the gateway byte budget: the
  bound is tested, the storm is not.

## 6. Deferred

- [ ] 6.1 SACK decision → only after `ccwire-e2e-benchmark` measures wasted replay.
      This change is what makes that measurable for the first time.
- [ ] 6.2 Cross-node replay → not attempted, must not be claimed. A token issued
      by gateway A does not resolve on B, which answers `resumed=false`.

## 7. Re-audit — findings and fixes

A second pass over the code, not over the previous report. Five defects, all
introduced or exposed by the wiring itself, all fixed with a test that fails
without the fix.

- [x] 7.1 **Sequence numbers restarted at 1 after a successful resume.**
      `tryResume` restored `s.cursors` but never seeded the allocator. Because
      `noteSent` is monotonic, every post-resume frame would have sat below the
      restored cursor and moved nothing: the cursor frozen for the life of the
      session, the client's position unreachable, the window never released, and
      the next resume refused. Resume would have worked exactly once per client.
      `TestSequenceContinuesAfterAResume`.

- [x] 7.2 **A frame at the size ceiling was silently dropped for resuming
      sessions only.** `deliver` re-encodes with a `seq`, so a frame that fits
      for everyone else overflows here. It returned without sending — a resuming
      session missing a message every other session received, which is the exact
      failure this change exists to prevent, reintroduced by the optimisation
      meant to prevent it. Now: send the shared unsequenced bytes, hole the
      window, let the next resume refuse.
      `TestOversizedPerSessionEncodeDoesNotLoseTheFrame`.

- [x] 7.3 **That same failure abandoned the rest of a fragmented event.** The
      `return` dropped every remaining fragment, leaving the client waiting
      forever to reassemble a prefix. Now `continue`.
      `TestPartialFailureDoesNotAbandonTheRestOfAnEvent`.

- [x] 7.4 **The parked window stayed reachable from the live session.** A
      fan-out that snapshotted its targets just before the session unregistered
      could still call `deliver` afterwards and mutate a window the store
      already owned and had charged to its byte budget — a data race and a wrong
      number at once. `parkForResume` now snapshots cursors and subscriptions
      under the locks that guard them and HANDS the window over, leaving the
      session holding neither. `TestParkHandsTheWindowOverRatherThanSharingIt`,
      `TestParkSnapshotsCursorsRatherThanSharingTheMap`.

- [x] 7.5 **Client: `Fragment` frames never recorded their sequence number.**
      The fragment carries the seq; the reassembled app_event inside it has none
      of its own, and the fragment path returned before `noteDelivered`. For a
      client whose traffic is mostly fragmented that means nothing to report,
      no window ever released, and every resume refused.
      `client.selftest.ts` — "a FRAGMENT frame reports its own sequence number".

- [x] 7.6 **Client: positions survived a session that was refused.** A server
      answering `resumed=false` starts a NEW session numbering from 1. Carrying
      the old positions forward makes the next reconnect offer a `resume_from`
      far ahead of anything that session sent, which the server refuses as a
      future cursor — so one un-resumed connection poisoned every resume after
      it for the life of the process. Cleared on `resumed=false`.
      `client.selftest.ts` — "resumed=false clears the positions of the dead
      session".

## 7b. Re-audit — verified unchanged

- Every fan-out path goes through `deliver`; `enqueue` has no other caller.
- Every access to `cursors`, `acked`, `replay` and the seq counters is under
  `pos.mu`, except at handshake time before `ccwireRegister` exposes the session.
- Lock order is one-way: `pos.mu` → `closeMu`/`queueMu`, never the reverse.
- A session with no window takes the shared encoding byte-for-byte.
- `CCWIRE_RESUME` is in no compose file; `docker-compose.prod.yml` sets only
  `CCWIRE_WS` and `CCWIRE_APP_EVENTS`. All of this is off in production.
- Socket.IO absent from the lockfile and the Go server; admin SSE registered;
  `webtransport-go` present.

## 7c. Re-audit — still not wired, and not claimed

- `services/transport/rust/src/session.rs` — 514 lines, 14 tests in
  `tests/session.rs`, and **zero production callers**. `ffi.rs`, the only
  surface React Native can reach, never mentions it. It was UNWIRED before this
  work and it is UNWIRED now. The Go gateway and the TS client are the two live
  halves of resume; this third implementation is not one of them.

## 8. Second re-audit — five parallel agents

Four read-only audits (Go realtime, TS client, Rust crates, three-way protocol
conformance) plus a build-chain trace. Every finding was verified in the code
before being acted on; several were rejected on inspection.

### 8a. A correction to the previous report

- [x] 8a.1 **The previous audit's claim that the Rust transport crate is
      unreachable was WRONG**, and it was wrong because I read
      `services/transport/rust/src/ffi.rs`, saw no `extern "C"`, and stopped.
      There is a second crate, `services/transport/rust-net`, which depends on
      `transport-core` by path, carries the real `#[no_mangle] extern "C"`
      surface, and is built by the Gradle module `android/transport-core`
      through cargo-ndk into `libtransportnative.so` behind
      `NativeModules.TransportCore`. The crate ships.

      What is actually true is narrower: the shipped FFI path reaches only
      `carrier`, an opaque-byte pipe. `session` is reached only through
      `rust-net`'s `client`, whose callers are a dev binary Gradle never builds
      (it passes `--lib`) and the test suites.

      Both stale headers that caused the mistake are corrected in place —
      `transport-core/src/lib.rs` said "STATUS: NOT WIRED" and `ffi.rs` said the
      shim "is a future crate".

### 8b. Go server — fixed

- [x] 8b.1 **`since()` answered "resumed, nothing missing" on an empty window.**
      The most severe finding in the tree, and the exact outcome this change
      claims is impossible. `release()` dropped acknowledged frames and recorded
      no floor, and the "too old" check lived INSIDE the loop over retained
      frames — so for a stream with nothing left (the normal state of a healthy
      connection) it never ran. A client asking from a position below what it
      had acknowledged was told it had missed nothing, and the frames between
      were already released and gone. Added `releasedUpTo` as the window's
      floor, and `since` now checks the client's report against the session's
      SENT cursors rather than against whatever happens to be in the ring — so
      silence about a stream is no longer read as completeness.
      `TestAnEmptyWindowDoesNotClaimCompleteness`,
      `TestSilenceAboutAStreamIsNotAClaimToHaveIt`,
      `TestAFullyAcknowledgedSessionStillResumes`.

- [x] 8b.2 **`tryResume` ran on any hello carrying a token**, while the token and
      window were only issued to a client that had negotiated the capability.
      The two gates disagreed, so a client presenting a token without
      negotiating resumption got `resumed=true` and a replayed tail inside a
      ServerHello whose capabilities said resumption was not negotiated — and
      held a window it could never park for the life of the connection.

- [x] 8b.3 **Revocation could not reach a live session's token.** `forgetUID`
      walks the PARKED table only, and a live session's token is not in it until
      it parks. Log out, stay connected, drop later, and the connection parked
      under the credential the logout was meant to destroy.
      `TestLogoutTakesTheTokenFromALiveSession`,
      `TestRevocationLeavesOtherUsersAlone`.

- [x] 8b.4 **The parked table was keyed by the PLAINTEXT token**, while three
      comments claimed `tokenHash` existed so a memory dump would yield nothing
      usable. It also made the constant-time compare dead code — a `map[string]`
      hit had already proven exact equality. Keyed by the hash now, so the
      compare is the real check it is described as.
      `TestTheParkedTableHoldsNoPlaintextToken`.

- [x] 8b.5 **`sessionID` was the session's heap address** (`%p`). Go reuses
      freed addresses, and `sessionID` survives a resume, is the sole match key
      for supersession, and is the room fan-out exclude key — so a collision
      means `closeOnce()` on a healthy, unrelated connection of the same user.
      Now 16 random bytes.

- [x] 8b.6 **A fan-out aborted on context expiry**, delivering to the sessions
      early in the slice and silently skipping the rest — no error, no hole, no
      metric. `canReceiveRooms` can hit the database once per target, so a call
      room on a cold permission cache blows the budget mid-loop and the
      participants never told `call_peer_left` keep rendering a departed peer
      for the rest of the call. The per-session authorization skip stays; the
      loop no longer abandons the remaining targets.

- [x] 8b.7 **A GoAway announced a planned shutdown as `INTERNAL`.**
      errors.proto has `SERVER_DRAINING` (14) and the difference is the whole
      message — the clients that back off hardest on faults are slowest to come
      back exactly when the fleet needs them.
      `TestDrainAnnouncesItselfAsDrainingNotAsAFault`.

- [x] 8b.8 **SSE frame injection through the admin firehose.** `/internal/emit`
      takes a free-form event name and it reached the SSE writer unvalidated, so
      a name carrying newlines injects fabricated events into every attached
      admin console.

- [x] 8b.9 **`maxResumeFromEntries` bounded distinct STREAMS, not entries** — it
      counted `len(map)`, so repetitions of one stream collapsed to a single key
      and the bound never tripped. It counts entries now, and a duplicate stream
      is refused rather than last-write-wins.
      `TestRepeatedResumeFromEntriesAreBounded`,
      `TestDuplicateResumeFromStreamIsRefused`.

- [x] 8b.10 **A parser differential inside the server.** The live handshake,
      cursor and Ping path uses its own protobuf reader whose varint accepted 10
      bytes in TAG and LENGTH position, where `internal/ccwire`, the TS codec
      and the Rust parser all cap those at 5 and refuse longer as
      VARINT_OVERFLOW — a refusal `codec.json` pins as a shared vector. The
      differential all three headers say they exist to prevent, reintroduced one
      layer up. `TestOverLongTagVarintIsRefusedOnTheLivePath`.

### 8c. TS client — fixed here, in code from the previous pass

- [x] 8c.1 **Fragment positions were recorded before reassembly.** Mine, from
      the previous pass, and a data-loss bug: half an event arrives, the
      position advances past those fragments, the socket drops, `down()` clears
      the partial set — and the resume then starts AFTER the fragments that were
      thrown away, so the event can never complete and never arrives. The same
      premature position also went out in `Ping.progress`, which is precisely
      what tells the server it may release those frames. Recorded at completion
      now; seq is monotonic per stream, so the final fragment carries the
      highest and nothing is lost by waiting.

- [x] 8c.2 **`resume_from` was offered without a token.** Also mine. With no
      token the server can only open a fresh session numbering from 1, and a
      cursor from the previous session is then far ahead of anything that
      session has sent — refused as a future cursor, which is a reconnect loop
      fed by the client's own memory. Both halves now, or neither.

### 8d. Rust — session resume put on the wire

- [x] 8d.1 `transport-core`'s `Session` held a resume token and exposed
      `can_resume()`; `client.rs` called `send_client_hello(false)` with a
      hard-coded false; and `body::client_hello` had no way to encode a token or
      a cursor at all, carrying a comment that "the Go peer does not implement
      resumption" which stopped being true when `CCWIRE_RESUME` landed. The
      state machine was complete and its output was thrown away.

      Added per-stream position tracking to `Session` (a fixed array, because
      `StreamId` is a closed oneof), `body::Resume` and `body::ping` encoders
      for the `StreamCursor` that both `resume_from` and `Ping.progress` carry,
      and wired `client.rs` to offer both and to record a position as each frame
      is handed to the caller — not when it is queued, because `pending` can
      still hold frames when the socket drops.
      4 new tests in `tests/session.rs` (14 to 18).

### 8e. Parity guard corrected rather than silenced

- [x] 8e.1 `codec.json` carried `bodiesTypedByTypescriptOnly: []` and both the Go
      and Rust parity tests asserted that list was empty — certifying a claim
      that had become false, since TypeScript types `app_event` (100) and bounds
      its payload where Go and Rust keep body 100 opaque. The fixture now
      records the real exception and both guards pin the exception SET rather
      than emptiness, so a NEW divergence still fails while the known one stays
      documented. Closing it means typing `app_event` on all three sides, not
      editing a fixture.

### 8f. TS client — six more, none of them mine

- [x] 8f.1 **An orphaned heartbeat deadline could tear down a healthy session.**
      `hbWait` was overwritten without being cleared, and `decodeServerHello`
      accepts `heartbeat_interval_ms` and `heartbeat_timeout_ms` independently,
      so `interval < timeout` is reachable from the server. Beat 1 arms a
      deadline, beat 2 overwrites the handle leaving the first armed and
      untracked, the pongs arrive, the link is healthy — and the orphan fires.

      Fixed by arming the deadline only when none is outstanding, NOT by
      clear-and-rearm: clearing on every beat pushes the deadline out by one
      interval each time, so with `interval < timeout` a link that stops
      answering would never time out at all. That trade is recorded in the code
      and pinned by a second test ("a silent link still times out when the
      interval is the shorter one") so the tempting version cannot come back.

- [x] 8f.2 **A failed keepalive write disabled liveness detection forever.**
      `if (!sent) return;` returned before re-arming either timer: no more
      pings, no pong deadline, and the session sat in `open` on a possibly-dead
      socket while the transport reported `ready`. Ends the session now, the
      same way a missed Pong does.

- [x] 8f.3 **Negotiated limits had no floor.** `v > 0 && v < LIMITS[dst]`
      accepted `max_frame_bytes = 1`, which is what made 8f.2 reachable without
      touching the socket. Floors added, chosen so a ClientHello, Ping and Pong
      always fit, with a test proving a legitimate tightening is still adopted.

- [x] 8f.4 **The resume token survived on a public field.** The private copy was
      carefully cleared when the server stopped offering resumption, but the
      whole ServerHello — token included — had already been stored on a public
      field reachable through `ccwireClient()`, and nothing ever cleared it. Any
      crash reporter or state dump walking it would write out a live credential,
      defeating the "in memory only, never persisted" rule the file documents.
      Stored stripped now, in both the field and the event handed to listeners.

- [x] 8f.5 **A reassembly hiccup permanently killed realtime.** `accept()`
      throws for expiry, a duplicate index and the ninth concurrent set as well
      as for genuinely malformed input, and every throw mapped to
      `down('protocol')` → `fatal` → CC-Wire never restarts for the rest of the
      app session. Backgrounding the app for 40s with a fragmented event
      half-received was enough: throttled timers skip the expiry sweep, the late
      fragment throws, and realtime is dead until app restart.

      Classified now by re-offering the fragment to a throwaway empty
      reassembler — one a fresh reassembler would also refuse is malformed and
      still permanent; one only our buffered state refused is timing or
      capacity and is recoverable. No second copy of the validation, and the
      strictness of `appEventFragments.ts` is untouched.

- [x] 8f.6 **Every install had the same backoff jitter.** `seed` is documented
      "use something per-install", and the only production caller never passed
      one — so every device fell through to `seed: 1`, `mulberry32(1)` yielded
      one fixed value, and every handset computed the same ladder. A server
      restart dropping 50k sockets had them all retry in the same millisecond
      window: the thundering herd the code's own comment says it prevents.
      Seeded from the existing SecureStore-persisted device id; per-process
      random when that is not yet readable. A source-level test pins the call
      site, because the selftest cannot import React Native.

- [x] 8f.7 **The resume token was decoded lossily.** envelope.proto declares it
      `bytes`, and the reader used a non-fatal `TextDecoder`, so a non-UTF-8
      token would be silently mangled to U+FFFD and then fail to match, with no
      error anywhere. Latent — the token is base64url ASCII today — and fixed
      as the contract issue it is, byte-exactly in both directions.

### 8g. TS codec — encode now refuses what decode refuses

- [x] 8g.1 `encodeFrameMessage` bounded neither `request_id`, nor `body_field`
      against the closed oneof set, nor the body at `max_message_body_bytes`.
      Go and Rust refuse all three on decode, so TypeScript was producing frames
      both peers drop with no local error — a bug failing on the machine that
      only has bytes rather than the one with the stack trace, which is the
      exact inversion the "enforce on encode too" rule exists to prevent.

- [x] 8g.2 The body bound is conditional on `appEventsV1`, matching the decode
      path, which already raises its own ceiling for that mode. An unconditional
      bound made this build refuse to PRODUCE a body it will happily ACCEPT off
      the wire — the same asymmetry pointed the other way. Caught because the
      first version turned `appEventFragments.selftest.ts` red.

- [x] 8g.3 `adversarial.json` described itself as "ONE source of hostile bytes
      for every implementation" and was read by two. A TypeScript consumer now
      exists; all 18 cases agree, so nothing in the vector or the code needed
      changing.

- [x] 8g.4 One reported finding was REJECTED on the evidence rather than
      "fixed": a 5-byte varint caps a field number at exactly `u32::MAX`, so the
      claimed TS/Go/Rust divergence on oversized field numbers does not exist,
      and the Go and Rust guards against it are unreachable defensive code.
      Adding a matching TS check would have been dead code that reads like a
      guard.

### 8h. Rust — aborts and hangs in code that actually ships

These are in `vaultbeam-core` and `nav-core`, both WIRED into the app. Severity
is set by one fact: every FFI entry wraps its work in `catch_unwind`, so a panic
degrades to a JSON error — but `catch_unwind` does NOT catch allocation failure,
which aborts the process. An unbounded allocation is therefore far worse than a
panic, and these convert three aborts and one hang into refusals.

- [x] 8h.1 `run_indices` collected `0..chunk_count` from an unbounded JSON
      `chunkCount`; `2^40` attempts an 8 TiB Vec and aborts. Bounded by the real
      12 GiB transfer cap over the smallest chunk geometry the app uses, with
      the derivation recorded rather than a magic number.
- [x] 8h.2 A run loop bounded the PUSH and not the ITERATION, so
      `{start: 0, count: u64::MAX}` spun forever, hanging the blocking worker
      thread the FFI call occupies. Proven by the test never returning before
      the fix.
- [x] 8h.3 The LAN receive path used a wire-supplied chunk index for both
      decryption and `seek` with no range check, while its own sibling in
      `fileio.rs` does exactly that check for the same operation. A negative
      `i32` sign-extends and the multiply wraps silently in release, letting an
      authenticated sending peer write authenticated plaintext at an arbitrary
      offset in the destination file.
- [x] 8h.4 `plan_block` divided by a JSON-supplied `chunk_bytes` with no zero
      check and reserved capacity from it with no bound.
- [x] 8h.5 **One caught panic bricked native navigation permanently.** The
      session mutex was locked with `.unwrap()` and held across the work, so any
      panic inside poisoned it; nothing cleared the poison, so every later call
      — including a fresh route — panicked for the life of the process. Worse,
      `selfCheck` takes no lock and kept passing, so a health probe reported the
      library healthy while every real operation was dead.
- [x] 8h.6 Unvalidated telemetry produced a phantom reroute loop: an absurd
      timestamp drove the filter to NaN, which serialised as `null` inside an
      `{"ok":true}` envelope, snapped the user to route index 0 and recorded an
      off-route strike. Self-healing on the next fix, so a recurring bad value
      accumulated strikes toward a reroute. Bounds test MAGNITUDE, not sign —
      iOS reports `accuracy: -1` for an unqualified fix and both
      implementations already neutralise that, so rejecting negatives would have
      refused something a legitimate caller sends today.

## 8i. Reported, deliberately NOT fixed

- [ ] 8i.1 `plan_block` can still grow unboundedly with an absurd `totalBytes`
      and a tiny `chunkBytes`. Every candidate ceiling derivable from the code
      would silently truncate a legitimate plan if the derivation were wrong,
      and it is reachable only from our own JS, not off the wire. Reported
      rather than shipped, per the rule that a fix must not reject valid input.
- [ ] 8i.2 `lan_serve` subtracts `total_bytes - plain_offset` unguarded; a
      peer manifest with an inconsistent `chunkCount` underflows in debug and
      wraps in release. The following clamp caps the result so there is no
      allocation blow-up, but the subtraction itself is unchecked.
- [ ] 8i.3 `app_event` typing and the `appEventsV1` body ceiling are two
      TypeScript-only divergences, now recorded in the fixture and pinned by
      both peer guards as a known exception set. Closing them means typing
      `app_event` in Go and Rust, not editing a fixture.
- [ ] 8i.4 **`go test -race` still cannot run here** — it needs cgo and there is
      no gcc on this machine. One of the fixes above (8b.1's sibling, the parked
      window handover) was a data race, so this gap is load-bearing and must run
      in CI before the flag is enabled anywhere.

## 9. Third round — re-auditing the fixes themselves

Two read-only agents re-audited the round-8 fixes adversarially, each asked to
say what it VERIFIED as correct and not only what failed. Both found real
defects in the fixes, including one I had introduced.

### 9a. Go — a deadlock created by the round-8 fix

- [x] 9a.1 **Adding `pos.mu` to `send()` closed a lock cycle.**

      Two acquisition orders existed on one session:

          deliver()        pos.mu  -> closeMu   (enqueue reads s.closed)
          joinEventRoom()  closeMu -> pos.mu    (sendError writes to the socket)

      One `Subscribe` past the 256-room limit, concurrent with a fan-out to the
      same session, wedges both goroutines permanently. `closeOnce()` also needs
      `closeMu`, so the socket is never closed, `drain()` never exits, and the
      session leaks with `pos.mu` held forever. Nothing times out; the
      connection simply stops. A `Subscribe` with an over-long scope id reaches
      the same `sendError` without needing 256 rooms.

      Fixed by sending the refusal outside `closeMu` — it was only ever a
      snapshot of `s.closed` there. `TestSubscribeRefusalDoesNotDeadlockAgainstDelivery`
      hangs for 20s and fails when the fix is reverted.

- [x] 9a.2 **Frames fanned out while a session was PARKED were lost, and the
      resume still reported success.** The severest finding of the round, and
      one the window cannot see by construction: a parked session is not in
      `h.cwSessions`, so delivery never reaches it — no seq allocated, nothing
      retained, and no HOLE recorded. `since()` therefore has nothing to refuse
      on and answers "nothing missing" for a message the client never saw and
      will not resync for. The gap is exactly the tunnel the feature exists to
      cover.

      Closed with a per-uid counter of fan-outs that happen while that user has
      a session parked; a parked session records the count at park time and is
      refused if it has moved. A counter rather than a flag, so a park BETWEEN
      two fan-outs is not blamed for the earlier one. The counter is pruned with
      the last parked session for that uid, so it cannot outgrow the table it
      shadows. `TestResumeRefusedWhenTrafficArrivedWhileParked`,
      `TestTrafficBeforeParkingDoesNotRefuseTheResume`,
      `TestTheMissedTrafficCounterIsPrunedWithTheLastParkedSession`.

      Writing it surfaced a second bug in my own fix: `take()` drops the parked
      entry before validating, and dropping prunes the counter — so the
      comparison always saw zero and never refused. The counter is now read
      before the drop.

- [x] 9a.3 **A data race on `s.resumeToken`.** `park()` read it with no lock
      while `revokeLiveResume` writes it under `pos.mu`. A Go string is two
      words; a torn read yields one session's pointer with another's length,
      which at best hashes to an entry nobody can resolve and which holds its
      replay bytes until the sweep.

- [x] 9a.4 **Revocation ran in the wrong order.** `forgetUID` (parked) then
      `revokeLiveResume` (live) leaves a gap: a session that drops between the
      two parks under its pre-revocation token, and the entry survives the
      invalidation for its whole lifetime. Live first now, so anything that
      parks afterwards has no token to park with.

- [x] 9a.5 **The round-8 fan-out fix was INEFFECTIVE, and looked like it
      worked.** Removing the loop's `ctx.Err()` abort changed nothing
      observable: the next statement calls `canReceiveRooms`, which derives its
      own context from the same parent and returns false the moment it is
      expired — before checking anything. Every target after the deadline was
      still skipped, silently; the only change was a metric. Authorization now
      continues on a FRESH budget when the original is gone, so the database
      check is still performed and a blown deadline no longer decides who
      receives a message.

- [x] 9a.6 **An RNG failure produced a connection that looked healthy and could
      never receive.** `newSessionID()` returning "" is inert for MATCHING —
      every consumer guards against it — but the session still completes the
      handshake, answers pings and accepts submissions while never being
      registered for fan-out. No error, no GoAway, a ServerHello
      indistinguishable from a healthy one. Refused at the socket now.

- [x] 9a.7 **A resume that could not be re-credentialled still claimed
      success.** If `tryResume` succeeded and `newResumeToken()` then failed,
      the ServerHello said `resumed=true` while its capabilities omitted
      resumption, and the adopted window was retained for the connection's life
      and could never be parked. Unwound to a fresh session, which costs one
      resync.

- [x] 9a.8 `replayWindow.hole` lacked the nil-receiver guard its three siblings
      have — not reachable today, and one `revokeLiveResume`-shaped change away
      from panicking the fan-out goroutine.

### 9b. TS client — including the other half of a round-8 fix

- [x] 9b.1 **The position still advanced past an INCOMPLETE fragment set.**
      Round 8 stopped recording per-fragment, but nothing stopped an ordinary
      sequenced frame arriving between fragments from carrying the position over
      the pending set. Fragment 0 of 2 at seq 10, any frame at seq 12, socket
      drops: the partial set is discarded and the resume asks to replay from 13.
      The event is gone, silently and permanently.

      The reported position is now capped at (lowest pending seq − 1), and
      `down()` folds that ceiling back into the recorded positions BEFORE
      clearing the sets — otherwise the ceiling died with the set it guarded.
      Both halves are separately covered.

- [x] 9b.2 **A reconnect loop at a fixed rate.** `backoff.reset()` ran on every
      ServerHello, so a server that COMPLETES the handshake and then drops is
      redialled forever with no ramp: measured 6 hello-then-drop cycles at
      [407, 407, 407, 407, 407, 407] ms against [407, 814, 1627, 3254, 6508,
      13017] when no hello arrives. A load balancer killing the socket just
      after upgrade gets ~2.5 dials/second per handset. The reset moved to the
      Pong handler — the first point at which traffic has demonstrably gone both
      ways.

- [x] 9b.3 **`Ping.progress` was ungated where `resume_from` was gated.** A
      session that offered no token but was answered `resumed:true` inherited
      the dead session's cursors and reported them. Not reachable against
      today's server, so a latent trap for this rollout rather than a live bug.

- [x] 9b.4 **The credential was still reachable.** Round 8 stripped the token
      from the public ServerHello and from the `hello` event, but `resumeToken`
      remained a plain instance property on a client that `ccwireClient()`
      exports "for diagnostics" — verified present in `JSON.stringify(client)`
      AFTER `close('logout')`. Now a true private field, cleared on close.

- [x] 9b.5 **Auth was misclassified, so the token was never refreshed.** The
      handshake-phase branch was tested before the close code, so a 1008/4401
      arriving AFTER a successful upgrade — exactly what the Go server's
      `refuse()` sends — was reported as `handshake_incomplete`. Downstream only
      refreshes the access token when the reason says auth, so an expired token
      refused after the upgrade burned the retry budget and surfaced "CC-Wire
      unavailable" instead.

### 9c. Verified correct by the re-audit, not merely assumed

Recorded because knowing what was CHECKED matters as much as what failed:
`releasedUpTo` and the `since(from, sent)` floor; per-session seq allocation and
the encode-failure hole; `pos.next` seeding after resume; the parked-window
handover and byte-budget symmetry; hash-keyed table lookups with a single
refund; `varint32` reaching every TAG and LENGTH in all five files that use
`pbr`; `resume_from` entry counting; heartbeat behaviour in both interval/timeout
orderings; the negotiated-limit floors against a real ClientHello, Ping and
Pong; 20,000 device ids producing 20,000 distinct backoff ladders; the resume
token round-tripping byte-exactly for all 256 byte values; and the encode-side
bounds against every production caller.

## 9d. Reported, still open

- [ ] 9d.1 A resume silently ejects the user from every call room: every
      disconnect emits `call_peer_left`, and `tryResume` restores the
      subscription without emitting the matching join — so the resumed device
      receives call signalling while every peer's roster has dropped it.
      Application-level, deterministic, and not a transport fix.
- [ ] 9d.2 `untrackIdentity` can race a resumed session: the parked entry is
      resumable before the old connection's teardown runs, and teardown then
      deletes the NEW session's presence entry because resume restores the
      session id. The user shows offline while fully connected.
- [ ] 9d.3 Parked-session memory is bounded only for replay bytes.
      `replayParkedBudget` covers the window; subscriptions do not have a byte
      budget, and 256 rooms x 256 bytes x 20000 parked sessions is ~1.3 GB.
- [ ] 9d.4 The `appEventsV1` encode ceiling applies to every oneof arm rather
      than just the app-event ones, so a future caller could encode a body the
      decoders refuse. Not reachable from either production caller today.
- [ ] 9d.5 `encodeFrameMessage` can throw on a malformed `seq` string where its
      contract says it returns a typed result and never throws.
- [ ] 9d.6 A fragment id longer than 128 characters classifies as malformed and
      is therefore permanently fatal. Server ids run ~100 characters with a
      64-character hostname — about 28 characters of headroom, after which every
      fragmented app event kills CC-Wire for the life of the process.
