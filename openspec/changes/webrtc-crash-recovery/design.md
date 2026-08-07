# WebRTC Crash Recovery — Design

## Overview

VaultChat experiences **critical crashes** (P0) when WebRTC signaling operations race with call cleanup. A crash log from production shows `NullPointerException` on `setRemoteDescription()` after a PeerConnection has been destroyed, terminating the call and routing the user back to the launcher.

**Root cause:** No protection between the moment cleanup destroys a PeerConnection and the moment a stale signaling packet tries to use it. Combined with unordered asynchronous signaling, this creates an unavoidable race window.

**Solution:** Introduce a **call lifecycle state machine** and **thread-safe operation sequencing** to ensure PeerConnections are never accessed outside a valid state, and cleanup never races with pending signaling.

This design covers all 12 identified issues (3 P0, 9 P1/P2) through 6 implementation phases spanning ~10 weeks.

---

## 12 Issues Addressed

### P0 (Critical)

1. **PeerConnection NullPointerException** — Crash on `setRemoteDescription()` after destroy
2. **Signaling race condition** — Multiple threads modify call state concurrently
3. **PeerConnection lifecycle mismatch** — Connection removed before signaling completes

### P1 (High)

4. **Signaling packet validation** — Stale SDP accepted without validation
5. **Cleanup sequencing** — Pending operations left hanging
6. **Duplicate cleanup** — Cleanup not idempotent; second call corrupts state
7. **WebRTC state machine gaps** — Operations execute in invalid states
8. **Thread safety violations** — Concurrent access to shared objects
9. **Error recovery absent** — One failed operation crashes entire app

### P2 (Medium)

10. **Activity lifecycle misalignment** — Recreation breaks call state
11. **Defensive validation missing** — Operations assume required objects exist
12. **Logging insufficient** — No diagnostic context when crashes occur

---

## Root Cause Analysis

### The Race Window

```
Timeline:

Thread A (cleanup)            Thread B (signaling)
─────────────────────────────────────────────────────
1. User taps "End"
   markState → CLOSING
   
2. Wait for pending ops = 0
   (if none: proceed immediately)
   
3. peerConnection.close()
   Remove from registry          
                                 4. Socket rx: offer SDP
                                    Observer.onRemoteOffer()
                                    
                                 5. registry.get(callId)
                                    → NULL (removed in step 3)
                                    
                                 6. setRemoteDescription()
                                    → NullPointerException ✗ CRASH

────────────────────────────────────────────────────────
Vulnerability window: between step 3 and step 5
```

### Why Current Code Can't Prevent This

1. **No state machine** — no way to reject offers after cleanup starts
2. **No operation tracking** — cleanup doesn't wait for in-flight signaling
3. **No packet validation** — doesn't check if call is still active
4. **Unordered processing** — signaling handlers execute concurrently
5. **No idempotency** — second cleanup corrupts already-cleaned state

---

## Architectural Solution: Call Lifecycle Manager

### Layer 1: State Machine

Every call transitions through defined states. **Operations are valid only in specific states.**

```
                        ┌─────────────┐
                        │    IDLE     │
                        └──────┬──────┘
                               │ create()
                        ┌──────▼──────────┐
                        │  INITIALIZING   │
                        └──────┬──────────┘
                               │ iceReady()
                        ┌──────▼──────────┐
                        │   SIGNALING     │ ← Offer/Answer valid here
                        └──────┬──────────┘
                               │ onRemoteDescription()
                        ┌──────▼──────────┐
                        │  CONNECTING     │ ← ICE candidates valid here
                        └──────┬──────────┘
                               │ iceConnected()
                        ┌──────▼──────────┐
                        │   CONNECTED     │ ← Media flowing
                        └──────┬──────────┘
                               │ endCall() or network loss
                        ┌──────▼──────────┐
                        │   CLOSING       │ ← No new ops accepted
                        └──────┬──────────┘
                               │ cleanup complete
                        ┌──────▼──────────┐
                        │    CLOSED       │ ← Terminal state
                        └─────────────────┘

Valid operations per state:
  SIGNALING:  setRemoteDescription ✓  addIceCandidate ✗
  CONNECTING: addIceCandidate ✓  setRemoteDescription ✗
  CONNECTED:  addIceCandidate ✓
  CLOSING:    any signaling ✗  cleanup ✓
  CLOSED:     nothing ✗
```

**Invariant:** Once in CLOSING or CLOSED, no signaling operations are accepted.

### Layer 2: Operation Tracking

Cleanup waits for in-flight operations to complete before destroying resources.

```java
class CallLifecycleManager {
  AtomicInteger activeOps = 0;
  
  void signalStart() {
    if (state == CLOSING || state == CLOSED) throw CallExpired();
    activeOps.incrementAndGet();
  }
  
  void signalEnd() {
    activeOps.decrementAndGet();
    if (activeOps == 0) notifyAll(); // signal quiescence
  }
  
  void beginClosing() {
    state = CLOSING;  // reject new ops
    waitForQuiescence(5000ms);  // wait for pending ops
  }
}
```

**Guarantee:** No operation starts after `beginClosing()` called.

### Layer 3: Packet Validation

Every signaling packet validated before processing.

```java
class SignalingValidator {
  ValidationResult validateOffer(String callId, Offer offer) {
    Call call = registry.get(callId);
    if (call == null) return INVALID("call_not_found");
    if (call.state != SIGNALING) return INVALID("invalid_state");
    if (call.sessionId != offer.sessionId) return INVALID("session_mismatch");
    if (isStale(offer.timestamp)) return INVALID("stale_packet");
    return VALID;
  }
}
```

**Guarantee:** Stale/invalid packets rejected before any connection access.

### Layer 4: Serialized Signaling

Each call processes signaling events in order (one offer, then answer, etc).

```java
class SerialExecutor extends Executor {
  Queue<Runnable> queue = new LinkedList<>();
  AtomicBoolean isRunning = false;
  
  @Override
  public void execute(Runnable cmd) {
    queue.add(cmd);
    runIfNotRunning();
  }
  
  private void runIfNotRunning() {
    if (!isRunning.getAndSet(true)) {
      while (!queue.isEmpty()) {
        queue.poll().run();
      }
      isRunning.set(false);
    }
  }
}
```

**Guarantee:** No concurrent modification of same call's signaling state.

### Layer 5: Idempotent Cleanup

Cleanup safe to call multiple times.

```java
void closeCall(String callId) {
  Call call = registry.get(callId);
  if (call == null || call.state == CLOSED) return; // idempotent
  
  call.state = CLOSING;
  call.lifecycle.beginClosing(); // wait for pending ops
  
  closeIceConnection(call);  // all guarded with null-checks
  closeTracks(call);
  closeDataChannels(call);
  closePeerConnection(call);
  
  registry.remove(callId); // remove last to prevent reentry
  call.state = CLOSED;
}
```

**Guarantee:** Second call is a no-op if state already CLOSED.

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-2)

**Deliverables:**
- ✅ `CallRegistry.java` — thread-safe call storage + state machine
- ✅ `CallLifecycleManager.java` — operation counting + quiescence
- ✅ `CallState` enum — IDLE, INITIALIZING, SIGNALING, CONNECTING, CONNECTED, CLOSING, CLOSED
- ✅ Exception hierarchy — `CallExpiredException`, `InvalidStateException`
- ✅ Integration with `WebRTCModule.java`

**Success:** All `getActiveCall()` checks validate state before use.

### Phase 2: Signaling Hardening (Weeks 2-3)

**Deliverables:**
- ✅ `SignalingValidator.java` — packet validation (call exists, state valid, session matches, not stale)
- ✅ Wrap offer/answer/candidate handlers with validator
- ✅ `SerialExecutor` — per-call ordering
- ✅ Logging for rejected packets

**Success:** Zero stale packets processed.

### Phase 3: Idempotent Cleanup (Weeks 3-4)

**Deliverables:**
- ✅ State check on enter (return early if CLOSING/CLOSED)
- ✅ Cleanup order: pause signaling → wait for quiescence → close resources
- ✅ Try-catch around each close operation
- ✅ Single emission of `call_ended` event

**Success:** Cleanup called 2x without state corruption.

### Phase 4: Error Recovery (Weeks 4-5)

**Deliverables:**
- ✅ Comprehensive error handling for all WebRTC API calls
- ✅ Graceful degradation (failed SDP doesn't crash app)
- ✅ Metrics: error counters by operation
- ✅ Logging: contextual error information

**Success:** Zero unhandled exceptions.

### Phase 5: Activity Lifecycle (Weeks 5-6)

**Deliverables:**
- ✅ Save/restore call state across activity recreation
- ✅ Verify PeerConnection lives at service level (not activity)
- ✅ Test rotation mid-call

**Success:** Rotation does not drop audio or crash.

### Phase 6: Testing & Rollout (Weeks 6-7)

**Deliverables:**
- ✅ Improved logging (every state transition, every operation)
- ✅ Unit tests (registry, lifecycle, validator)
- ✅ Integration tests (cleanup idempotency, late packets, lifecycle)
- ✅ Crash testing (injected delays, simulated races)
- ✅ Metrics dashboard
- ✅ Kill switch via Firebase Remote Config

**Success:** Crash rate → 0; diagnostics enable root-cause analysis.

---

## Files to Create

| File | Purpose |
|------|---------|
| `plugins/android/calls/CallRegistry.java` | Central registry + state machine |
| `plugins/android/calls/CallState.java` | State enum + transitions |
| `plugins/android/calls/CallLifecycleManager.java` | Operation tracking + quiescence |
| `plugins/android/calls/SignalingValidator.java` | Packet validation |
| `plugins/android/calls/SerialSignalingExecutor.java` | Per-call executor |
| `plugins/android/calls/exception/CallException.java` | Exception base class |
| `plugins/android/calls/exception/CallExpiredException.java` | Specific exception |
| `plugins/android/calls/exception/InvalidStateException.java` | Specific exception |

## Files to Modify

| File | Change |
|------|--------|
| `plugins/android/WebRTCModule.java` | Integrate registry on all lifecycle events |
| `plugins/android/PeerConnectionObserver.java` | Validate before connection access |
| All signaling handlers (in socket listeners) | Validate packets before processing |
| `plugins/android/CallForegroundService.kt` | Ensure cleanup is idempotent |

---

## Testing Strategy

### Unit Tests

- `CallRegistryTest` — concurrent access, state transitions, expiration
- `CallLifecycleManagerTest` — operation counting, quiescence timeout
- `SignalingValidatorTest` — packet rejection on stale/invalid/expired
- `SerialExecutorTest` — ordering guarantee, no concurrent execution

### Integration Tests

- End call from UI → cleanup waits for pending ops
- Network loss → automatic close triggered
- Receive late SDP after close → rejected
- Rotation mid-call → state preserved
- Rapid create/destroy → no memory leaks

### Crash Tests (Instrumented)

- Inject 10ms delay before `setRemoteDescription()`
- While delayed, simulate cleanup + removal
- Verify: no crash, graceful rejection

### Load Tests

- 100 concurrent calls → registry still O(1)
- 1000 calls/hour create+destroy → no leaks

---

## Rollout Strategy

### Canary (Week 1)

- 5% traffic
- Phase 1 + Phase 2 (registry + validator)
- Monitor crash rate daily
- Interim null-checks (belt-and-braces)
- **Kill-switch ready:** Firebase RC flag `webrtc_v2_enabled`

### Staged (Weeks 2-3)

- 25% → 50% → 75%
- Add Phase 3 (idempotent cleanup)
- 2-3 days per stage
- Regression → flip kill-switch

### Full (Week 4+)

- 100% traffic
- Remove interim null-checks
- Monitor for 1 week
- Declare success

---

## Success Criteria

### Primary (Must Have)

- ✅ Zero `NullPointerException` on `setRemoteDescription()`
- ✅ Crash rate for WebRTC calls → 0% (baseline ~2%)
- ✅ Cleanup idempotent (call close 2x safely)
- ✅ Late signaling packets rejected

### Secondary (Should Have)

- ✅ Signaling operations ordered per-call
- ✅ State machine validated before every operation
- ✅ Comprehensive logging for diagnosis
- ✅ Metrics enable post-incident analysis

### Tertiary (Nice to Have)

- ✅ Activity lifecycle preserved across rotation
- ✅ Memory leak testing green
- ✅ Call setup latency unchanged

---

## Effort

| Phase | Duration | Tasks |
|-------|----------|-------|
| 1 | 2 weeks | Registry + lifecycle |
| 2 | 2 weeks | Validator + executor |
| 3 | 1 week | Idempotent cleanup |
| 4 | 2 weeks | Error recovery |
| 5 | 1 week | Activity lifecycle |
| 6 | 2 weeks | Testing + rollout |
| **Total** | **~10 weeks** | **Sequential** |

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Deadlock on quiescence wait | 5-second hard timeout + warning log |
| New bugs in lifecycle tracking | Canary rollout + kill-switch ready |
| Performance regression | Benchmark call setup latency (expect ±5%) |
| Complex state machine errors | Unit test all transitions |

---

## Acceptance Criteria

- [ ] All 12 issues resolved (linked to commits)
- [ ] Crash rate → 0%
- [ ] All unit tests pass
- [ ] Integration tests pass
- [ ] Canary → full rollout complete
- [ ] Metrics dashboard shows improvement
- [ ] Post-launch monitoring green for 1 week

