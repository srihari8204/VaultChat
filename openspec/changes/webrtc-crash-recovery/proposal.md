# WebRTC Crash Recovery — Proposal

## Problem Statement

VaultChat experiences **critical production crashes** during voice/video calls. A recent crash log shows:

```
java.lang.NullPointerException
  at com.vaultchat.app.calls.PeerConnectionObserver.getPeerConnection()
  at com.vaultchat.app.calls.WebRTCModule.setRemoteDescription()
  (crash on pool-26-thread-1 — NOT the main thread)
```

**What's happening:** A PeerConnection is destroyed during cleanup, but a stale signaling packet (offer or answer) arrives milliseconds later and tries to use the destroyed connection. The observer tries to retrieve the connection, gets null, and crashes the entire app.

**Impact:**
- Call terminates abruptly
- User returns to launcher
- No graceful recovery
- Affects 2-3% of call sessions in production

**Root cause:** A race condition between:
1. **Cleanup thread** destroying the PeerConnection
2. **Signaling thread** processing a WebSocket message for that call

No protection exists in between, and cleanup doesn't wait for signaling to finish.

---

## Proposed Solution

Introduce a **call lifecycle state machine** with three layers of protection:

1. **State machine** — Every call has a defined state (SIGNALING, CONNECTING, CONNECTED, CLOSING, CLOSED). Operations are valid only in specific states.
2. **Operation tracking** — Cleanup waits for pending signaling operations to complete before destroying resources.
3. **Packet validation** — Every signaling packet is validated (call exists, in correct state, not stale) before touching the connection.

**Result:** The race window closes completely. By the time cleanup reaches "destroy connection," no new packets can reach it, and any pending operations have already finished.

---

## Why This Approach

### Alternative 1: Just Add Null Checks

**Problem:** Masks the symptom, not the cause. A null-check on line X prevents *that specific crash*, but doesn't address the underlying race. New crashes will appear elsewhere.

### Alternative 2: Lock Everything with Mutex

**Problem:** Locks are slow and can cause deadlocks. WebRTC operations can take 100-500ms; blocking other threads for that long is not acceptable.

### Alternative 3: Run Signaling on Main Thread Only

**Problem:** Main thread is already busy with UI. Blocking it for 500ms on WebRTC stalls the UI and violates Android best practices.

**Our approach:** Thread-safe state machine + operation counting (lockfree atomics) + per-call serialization. Fast, deadlock-free, and solves the root cause.

---

## Implementation Phases

**Total effort:** ~10 weeks, split into 6 phases

| Phase | Duration | What | Risk |
|-------|----------|------|------|
| 1 | 2 wks | Registry + state machine | Low (new code, isolated) |
| 2 | 2 wks | Validator + serialization | Low (new code, isolated) |
| 3 | 1 wk | Idempotent cleanup | Medium (modifies existing code) |
| 4 | 2 wks | Error recovery | Medium (touches many call sites) |
| 5 | 1 wk | Activity lifecycle | Medium (activity code) |
| 6 | 2 wks | Testing + rollout | Low (validation only) |

Each phase has a **kill-switch** (Firebase Remote Config flag) ready before rollout.

---

## Success Metrics

### Primary (Blocking)

- **Crash rate for WebRTC calls → 0%** (currently ~2-3%)
- **Zero unhandled NullPointerException** on setRemoteDescription
- **Cleanup idempotency** — closing a call twice is safe

### Secondary

- Call setup latency unchanged (±5% acceptable)
- No memory leaks
- Comprehensive logging enables diagnosis

### Rollout Gates

- Canary (5%) → 24 hrs green → proceed
- 25% → 48 hrs green → proceed
- 50% → 48 hrs green → proceed
- 75% → 48 hrs green → proceed
- 100% → 7 days green → declare success

If crash rate increases at any stage: **flip kill-switch, revert to null-checks.**

---

## Stakeholder Alignment

### Mobile Team (VaultChat)

**Benefit:** Reliability. Users can have calls without crashing. Reduces support burden.

**Cost:** 10 weeks eng time; killswitch risk is low (revert to null-checks if needed).

### Backend Team (Signaling/Socket)

**Benefit:** None directly (this is client-side). Backend continues unchanged.

**Impact:** New logging will help diagnose edge cases faster.

### QA / Testing

**Benefit:** Clearer test matrix (state machine is explicit). Easier to audit edge cases.

**Cost:** Need to write new unit tests (~500 LOC), integration tests (~200 LOC).

### Ops / On-Call

**Benefit:** Kill-switch ready; can flip if needed. Better diagnostics in crash logs.

**Cost:** 1 week monitoring during rollout.

---

## Open Questions

1. **Activity lifecycle:** Should PeerConnection live in Activity or in a retained Service/ViewModel? Current code is ambiguous.
   → *Plan:* Audit in Phase 5; if needed, move to service.

2. **Signaling packet order:** Is Socket.IO guaranteed to deliver packets in order?
   → *Plan:* Assume not; Phase 2 adds per-call serialization to guarantee order.

3. **Cleanup timeout:** If quiescence wait times out (5s), should we proceed or crash?
   → *Plan:* Log warning and proceed (fail-open). Metrics will flag if this happens > 0.1%.

4. **Backwards compatibility:** Any clients on old version during transition?
   → *Plan:* No; only latest version installed in production.

---

## Next Steps

1. **Design review** — stakeholders confirm approach
2. **Spike: Phase 1** — implement registry + state machine (1-2 days)
3. **Validation:** Test with injected race condition; verify fixed
4. **Start Phase 2** — validator + serialization
5. **Canary rollout** once Phase 2 complete

---

## Appendix: Full Issue List

| # | Issue | Severity | Fixed By Phase |
|---|-------|----------|-----------------|
| 1 | PeerConnection NullPointerException | P0 | 1 |
| 2 | Signaling race condition | P0 | 2 |
| 3 | Lifecycle mismatch (destroyed too early) | P0 | 1 |
| 4 | Stale SDP packets accepted | P1 | 2 |
| 5 | Cleanup sequencing (pending ops left hanging) | P1 | 1 |
| 6 | Duplicate cleanup corrupts state | P1 | 3 |
| 7 | State machine gaps (invalid operations) | P1 | 1 |
| 8 | Thread safety violations | P1 | 1 |
| 9 | Error recovery absent (one failure crashes app) | P1 | 4 |
| 10 | Activity lifecycle misalignment | P2 | 5 |
| 11 | Defensive validation missing | P2 | 2 |
| 12 | Logging insufficient for diagnosis | P2 | 6 |

