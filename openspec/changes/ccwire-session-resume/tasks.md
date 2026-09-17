# Tasks — CC-Wire session resume

## 1. Baseline

- [x] 1.1 Record the gate baseline: frontend 298/298, `go vet ./...`, `go test ./...`, `npm run test:rust` (214 tests)
- [x] 1.2 Confirm no schema change is needed — `resume_token`, `resume_from`, `resumed`, `Capabilities.resumption` all already exist

## 2. Resume token

- [x] 2.1 Issue 32 bytes from `crypto/rand`; fail closed if the random source errors
- [x] 2.2 Store as a reference to parked state — never encode uid/device/session into the token
- [x] 2.3 Compare in constant time (`crypto/subtle`), reusing the existing `safeKeyEqual` pattern
- [x] 2.4 Single-use: consume on resume, issue a fresh token in `ServerHello`
- [x] 2.5 Invalidate on logout and on security-sensitive change

## 3. Parked session store

- [x] 3.1 Park on `ccwireUnregister` instead of deleting; keep identity, subscriptions, cursors — never message bodies
- [x] 3.2 Bound by count, age and bytes; evict oldest at capacity
- [x] 3.3 Sweep expired sessions on a timer, reusing the existing sweep pattern (`startViewerSweep`)
- [x] 3.4 Unit tests for expiry, capacity eviction, and that no payload bytes are retained

## 4. Handshake

- [x] 4.1 Parse `ClientHello.resume_token` and `resume_from` (≤8 entries, bounded)
- [x] 4.2 Resolve the token; on any doubt answer `resumed=false` with a fresh session
- [x] 4.3 Verify the authenticated uid AND deviceID match the parked session
- [x] 4.4 Validate `resume_from`: reject future cursors, never regress recorded position, ignore unknown streams without failing the handshake
- [x] 4.5 Emit `ServerHello.resumed` and a rotated `resume_token`
- [x] 4.6 Restore subscriptions from parked state

## 5. Connection generation

- [x] 5.1 Add a generation counter to the parked session; increment on each successful resume
- [x] 5.2 Drop frames from a superseded generation without advancing cursors, presence, receipts or delivery state
- [x] 5.3 Close the older physical connection when a newer generation supersedes it
- [x] 5.4 Test the stale-connection race: old connection still open when the new one resumes

## 6. Capability

- [x] 6.1 Advertise `Capabilities.resumption` ONLY once 2–5 are complete and tested
- [x] 6.2 Confirm a client that does not negotiate it behaves exactly as today

## 7. Acceptance (from the plan's 18 cases)

Proven at unit level:

- [x] 7.6 expired token — `TestExpiredSessionsDoNotResume`
- [x] 7.7 invalid token — `TestResumeRefusedLeavesSessionFresh`
- [x] 7.8 token from another device — store + end-to-end
- [x] 7.9 token from another user — `TestResumeTokenFromAnotherUserIsRefused`
- [x] 7.14 stale connection still alive — `TestStaleGenerationCannotAdvanceState` + supersession at register
- [x] 7.18 full-resync fallback — a refused resume is indistinguishable from a fresh session

Unblocked by `ccwire-replay-window`, now proven at unit level:

- [x] 7.2 zero missed frames — `TestIdleSessionResumesWithAnEmptyWindow`. An
      EMPTY window resumes; only a MISSING one refuses. Folding the two together
      would make the commonest reconnect a full resync.
- [x] 7.3 missed message frames — `TestReplayedFramesAreTheExactBytesSent`
- [x] 7.4 receipts — `TestReceiptFramesReplayLikeAnyOther`
- [x] 7.5 ephemeral frames — `TestEphemeralFramesAreNeverSequenced`. Never
      sequenced, never retained, never able to refuse a resume.
- [x] 7.10 replay window expired — `TestResumeRefusedAfterTheWindowAgesOut`
- [x] 7.12 cursor behind window — `TestResumeRefusedWhenTheCursorIsBehindTheWindow`
- [x] 7.13 duplicate replay frame — `TestDuplicateReplayCarriesTheSameIdentity`.
      Byte-identical to the original, so the application's
      `(chat_id, sender_id, client_id)` dedup sees one row twice, not two rows.

Needs a real socket, a second gateway, or a device — NOT claimed:

- [ ] 7.1 normal reconnect (end-to-end over a live connection)
- [ ] 7.11 server restarted · 7.15 GoAway migration · 7.16 background/foreground
- [ ] 7.17 historical catch-up (`deliv_cur`/`read_cur` < `chat_max`) against a real DB

## 7b. Evidence

- 219 tests in `internal/realtime` (143 at the start of this work).
- Security cases proven, not asserted: token from another **user** refused,
  from another **device** refused, replay refused (single-use), token burned
  even on a FAILED attempt, logout invalidation scoped to one user.
- Cursor safety: advanced only on a successful send, monotonic, unsequenced
  control frames move nothing; client claims clamped both directions.
- `parkForResume` parks what was **sent**. It parked the ACKED position until
  `ccwire-replay-window` was wired in; see that change's task 5.4 for why the
  reversal was correct. In short: the parked cursor stopped being the
  resume-from point and became the CEILING the client's claim is checked
  against, and an acked ceiling refuses honest clients that lost only an ack.
- Generation enforced at `ccwireRegister`, matched on `sessionID` so other
  devices of the same user are untouched.
- Triple-gated off: `CCWIRE_RESUME` unset → no capability → no token issued →
  `tryResume` never runs. Behaviour today is byte-for-byte unchanged.

## 8. Verification

- [x] 8.1 Re-run every gate from 1.1; no regression
- [x] 8.2 Backend contract check still passes (33 c→s, 44 s→c unchanged)
- [x] 8.3 Socket.IO guard still passes; `webtransport-go` still present
- [x] 8.4 Ponytail review — reject any simplification that weakens validation, binding, bounds or the resync fallback
- [x] 8.5 Report, separating what was verified locally from what needs a device or a second gateway

## 8b. Still open

- [ ] 7.x Cases needing a real socket, a second gateway, or a device (7.1 normal
      reconnect end-to-end, 7.11 server restart, 7.15 GoAway migration, 7.16
      background/foreground, 7.17 historical catch-up against a real DB) remain
      NOT claimed.
- [x] Replay window — landed. `ccwire-replay-window` retains the unacknowledged
      tail, replays it after a successful resume, and refuses rather than
      serving a gap it cannot cover in full.

## 9. Explicitly deferred

- [x] 9.1 Replay window → `ccwire-replay-window` (landed)
- [ ] 9.2 Cross-node resume → must not be claimed until tested
- [ ] 9.3 SACK / compression → only on measurement
