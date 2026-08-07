# WebRTC Crash Recovery — Summary

## Problem

VaultChat crashes 2-3% of the time during calls with:
```
java.lang.NullPointerException
  at PeerConnectionObserver.getPeerConnection()
```

**Why:** A PeerConnection is destroyed, but a stale signaling packet arrives milliseconds later and tries to use it. No protection exists between these two events.

---

## Solution

Three layers of thread-safe protection:

1. **State Machine** — Every call has a defined state (SIGNALING, CONNECTING, CONNECTED, CLOSING, CLOSED). Operations are valid only in specific states.

2. **Operation Tracking** — Cleanup waits for pending signaling to finish before destroying resources. No operation starts after cleanup begins.

3. **Packet Validation** — Every signaling packet (offer, answer, ICE candidate) is validated before processing. Stale/invalid packets are rejected.

**Result:** Race window closes completely. Crash rate → 0%.

---

## Architecture

### New Classes

| Class | Purpose |
|-------|---------|
| `CallRegistry` | Central call storage + state machine |
| `CallState` (enum) | States: IDLE, INITIALIZING, SIGNALING, CONNECTING, CONNECTED, CLOSING, CLOSED |
| `CallLifecycleManager` | Track pending ops + enforce quiescence |
| `SignalingValidator` | Validate packets before processing |
| `SerialSignalingExecutor` | Ensure per-call serialization |
| `CallException` hierarchy | `CallExpiredException`, `InvalidStateException` |

### State Machine

```
IDLE ──create──> INITIALIZING ──iceReady──> SIGNALING ──onRemote──> CONNECTING ──iceConnected──> CONNECTED ──endCall──> CLOSING ──cleanup──> CLOSED
                                                   ↓                          ↓                            ↓
                                                FAILED <──────────────────────────────────────────────────┘
```

**Key invariant:** Once in CLOSING or CLOSED, no signaling operations are accepted.

### Operation Flow

```
On receive SDP:
  1. validator.validateOffer() → return if invalid
  2. serialExecutor.execute(() → {
  3.   lifecycle.signalStart()
  4.   try: setRemoteDescription()
  5.   catch: emit error (don't crash)
  6.   finally: lifecycle.signalEnd()
  7. })

On closeCall:
  1. registry.markState(CLOSING)
  2. lifecycle.beginClosing() → wait for pending ops
  3. Close resources (ICE, tracks, connection)
  4. registry.remove(callId)
```

---

## Timeline

| Phase | Duration | What |
|-------|----------|------|
| 1 | 2 weeks | Registry + state machine foundation |
| 2 | 2 weeks | Validator + serialization |
| 3 | 1 week | Idempotent cleanup |
| 4 | 2 weeks | Error recovery |
| 5 | 1 week | Activity lifecycle |
| 6 | 2 weeks | Testing + rollout |
| **Total** | **~10 weeks** | **Sequential** |

Each phase has a kill-switch (Firebase Remote Config) ready.

---

## Success Criteria

- ✅ Crash rate for WebRTC calls → 0% (from ~2%)
- ✅ Zero unhandled `NullPointerException`
- ✅ Cleanup idempotent (safe to call 2x)
- ✅ Call setup latency unchanged (±5%)
- ✅ Metrics enable diagnosis

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Deadlock on quiescence wait | 5-second hard timeout → proceed |
| New bugs in lifecycle tracking | Canary rollout (5%) + kill-switch |
| Performance regression | Benchmark setup latency |
| Complex state machine errors | Unit tests for all transitions |

---

## Rollout Plan

1. **Canary (5%)** — 24 hours green → proceed
2. **Staged (25% → 50% → 75% → 100%)** — 2-3 days per stage
3. **Full rollout** — Monitor for 1 week
4. **Kill-switch:** If crash rate increases, flip flag to revert

---

## Next Steps

1. **Stakeholder review** — Confirm approach
2. **Phase 1 start** — CallRegistry + CallState (1-2 weeks)
3. **Crash testing** — Validate fix with injected race
4. **Phase 2 start** — Validator + serialization
5. **Canary rollout** — Deploy with kill-switch ready

---

## Links

- **Design:** `design.md` (detailed architecture)
- **Proposal:** `proposal.md` (stakeholder summary)
- **Tasks:** `tasks.md` (implementation roadmap)
- **Crash log:** See ticket attachment

---

## Questions?

- **Why not just add null-checks?** → Masks symptom, not cause. New crashes will appear elsewhere.
- **Why not lock everything?** → Locks are slow; can cause deadlocks. Our approach is lock-free.
- **Why 10 weeks?** → Careful implementation + comprehensive testing + staged rollout (not a weekend rush).
- **What if Phase 1 has a bug?** → Kill-switch ready; revert to interim null-checks.

