# WebRTC Crash Recovery — Implementation Tasks

## Phase 1: Registry & State Machine (Weeks 1-2)

### Task 1.1: Create CallState Enum

**Objective:** Define call states and valid transitions.

**Deliverable:** `plugins/android/calls/CallState.java`

```
States:
  IDLE               → can transition to: INITIALIZING
  INITIALIZING       → can transition to: SIGNALING, FAILED
  SIGNALING          → can transition to: CONNECTING, FAILED
  CONNECTING         → can transition to: CONNECTED, FAILED
  CONNECTED          → can transition to: CLOSING, FAILED
  FAILED             → can transition to: CLOSING
  CLOSING            → can transition to: CLOSED
  CLOSED             → (terminal, no transitions)

Each transition validates the "from" state.
Invalid transitions throw InvalidStateException.
```

**Definition of states:**
- `IDLE` — no call active
- `INITIALIZING` — PeerConnection created, ICE gathering in progress
- `SIGNALING` — local/remote SDP exchanged, awaiting connection
- `CONNECTING` — ICE candidates flowing, connection establishing
- `CONNECTED` — media flowing, call active
- `FAILED` — call encountered unrecoverable error
- `CLOSING` — user ended call, cleanup in progress
- `CLOSED` — call destroyed, resources released

---

### Task 1.2: Create CallRegistry

**Objective:** Thread-safe central call storage with state validation.

**Deliverable:** `plugins/android/calls/CallRegistry.java`

```java
public class CallRegistry {
  private Map<String, CallState> calls = Collections.synchronizedMap(new HashMap<>());
  
  public void create(String callId) {
    calls.put(callId, new CallState(callId, IDLE));
  }
  
  public CallState getActive(String callId) throws CallExpiredException {
    CallState call = calls.get(callId);
    if (call == null || call.state == CLOSED) {
      throw new CallExpiredException(callId);
    }
    return call;
  }
  
  public void markState(String callId, CallState newState) throws InvalidStateException {
    CallState call = getActive(callId);
    if (!call.canTransitionTo(newState)) {
      throw new InvalidStateException(call.state, newState);
    }
    call.state = newState;
    logStateChange(callId, call.state);
  }
  
  public void remove(String callId) {
    calls.remove(callId);
  }
  
  public int activeCallCount() {
    return calls.size();
  }
}
```

**Key methods:**
- `create(callId)` — register new call
- `getActive(callId)` — retrieve call, throw if expired/closed
- `markState(callId, newState)` — validate transition, update state, log
- `remove(callId)` — deregister call
- `activeCallCount()` — metrics

**Thread safety:** `Collections.synchronizedMap`

---

### Task 1.3: Create CallLifecycleManager

**Objective:** Track pending operations, ensure cleanup waits for them.

**Deliverable:** `plugins/android/calls/CallLifecycleManager.java`

```java
public class CallLifecycleManager {
  private AtomicInteger activeOps = new AtomicInteger(0);
  private Semaphore quiescence = new Semaphore(1);
  private CallState state;
  
  public void signalStart() throws CallExpiredException {
    if (state == CLOSING || state == CLOSED) {
      throw new CallExpiredException("call already closing");
    }
    activeOps.incrementAndGet();
  }
  
  public void signalEnd() {
    activeOps.decrementAndGet();
    if (activeOps.get() == 0) {
      quiescence.release(); // signal waiting cleanup
    }
  }
  
  public void beginClosing() {
    state = CLOSING;
    waitForQuiescence(5000); // 5-second timeout
  }
  
  private void waitForQuiescence(long timeoutMs) {
    try {
      if (!quiescence.tryAcquire(timeoutMs, TimeUnit.MILLISECONDS)) {
        logWarn("Quiescence timeout; proceeding with cleanup");
      }
    } catch (InterruptedException e) {
      logWarn("Interrupted waiting for quiescence", e);
    }
  }
  
  public int getActiveOpCount() {
    return activeOps.get();
  }
}
```

**Key methods:**
- `signalStart()` — increment pending ops, throw if call closing
- `signalEnd()` — decrement, signal if idle
- `beginClosing()` — wait for quiescence (max 5s), then proceed
- `getActiveOpCount()` — for metrics/logging

**Guarantees:**
- No new ops start after `beginClosing()` called
- Cleanup waits for pending ops (up to timeout)
- No deadlock (hard 5s timeout)

---

### Task 1.4: Create Exception Hierarchy

**Objective:** Clear exception types for error handling.

**Deliverables:** 
- `plugins/android/calls/exception/CallException.java` (base)
- `plugins/android/calls/exception/CallExpiredException.java`
- `plugins/android/calls/exception/InvalidStateException.java`

```java
// Base
public abstract class CallException extends Exception {
  public CallException(String message) { super(message); }
  public CallException(String message, Throwable cause) { super(message, cause); }
}

// Specific
public class CallExpiredException extends CallException {
  public CallExpiredException(String callId) {
    super("Call " + callId + " is expired or closed");
  }
}

public class InvalidStateException extends CallException {
  public InvalidStateException(CallState from, CallState to) {
    super("Invalid transition: " + from + " → " + to);
  }
}
```

---

### Task 1.5: Integrate Registry into WebRTCModule

**Objective:** Wire registry into PeerConnection lifecycle.

**Modify:** `plugins/android/WebRTCModule.java`

```
On createPeerConnection():
  ✓ Create registry entry: registry.create(callId)
  ✓ Log: "[CALL-ID] state: IDLE → INITIALIZING"
  
On peerConnectionReady():
  ✓ Update state: registry.markState(callId, SIGNALING)
  ✓ Log: "[CALL-ID] state: INITIALIZING → SIGNALING"
  
On remoteDescriptionSet():
  ✓ Update state: registry.markState(callId, CONNECTING)
  ✓ Log: "[CALL-ID] state: SIGNALING → CONNECTING"
  
On iceConnected():
  ✓ Update state: registry.markState(callId, CONNECTED)
  ✓ Log: "[CALL-ID] state: CONNECTING → CONNECTED"
  
On endCall():
  ✓ Update state: registry.markState(callId, CLOSING)
  ✓ Call lifecycle.beginClosing()
  ✓ Proceed with cleanup
  
On cleanup complete:
  ✓ registry.remove(callId)
  ✓ Update state: CLOSED
  ✓ Log: "[CALL-ID] state: CLOSING → CLOSED"
```

**Changes:**
- All PeerConnection lookups use `registry.getActive(callId)` → throws if expired
- All state changes go through `registry.markState()` → validates transitions
- Add logging at every transition

---

### Task 1.6: Add Unit Tests for Phase 1

**Objective:** Validate registry, state machine, lifecycle manager.

**Deliverable:** `plugins/android/calls/test/CallRegistryTest.java`

```
Tests:
  ✓ create() registers new call
  ✓ getActive() returns call if active
  ✓ getActive() throws if call expired
  ✓ markState() allows valid transitions
  ✓ markState() rejects invalid transitions
  ✓ remove() deregisters call
  ✓ concurrent creates/removes → no race
  ✓ lifecycle.signalStart() increments ops
  ✓ lifecycle.signalEnd() decrements ops
  ✓ lifecycle.beginClosing() waits for ops == 0
  ✓ lifecycle.beginClosing() times out after 5s
```

**Coverage goal:** 90%+

---

### Phase 1 Acceptance

- [ ] All classes created
- [ ] All tests pass
- [ ] No regression in call setup latency (measure: create → SIGNALING)
- [ ] Logging shows all state transitions
- [ ] Code review approved

---

## Phase 2: Signaling Validation & Serialization (Weeks 2-3)

### Task 2.1: Create SignalingValidator

**Objective:** Validate packets before processing.

**Deliverable:** `plugins/android/calls/SignalingValidator.java`

```java
public class SignalingValidator {
  private CallRegistry registry;
  
  public ValidationResult validateOffer(String callId, Offer offer) {
    try {
      CallState call = registry.getActive(callId);
      
      // State check
      if (call.state != SIGNALING) {
        return ValidationResult.invalid("call_not_in_signaling_state: " + call.state);
      }
      
      // Session ID check
      if (!call.sessionId.equals(offer.sessionId)) {
        return ValidationResult.invalid("session_mismatch");
      }
      
      // Timestamp check (reject if > 60s old)
      long ageMs = System.currentTimeMillis() - offer.timestamp;
      if (ageMs > 60000) {
        return ValidationResult.invalid("stale_packet: age=" + ageMs + "ms");
      }
      
      return ValidationResult.valid();
    } catch (CallExpiredException e) {
      return ValidationResult.invalid("call_expired");
    }
  }
  
  public ValidationResult validateAnswer(String callId, Answer answer) {
    // Same checks as offer
    ...
  }
  
  public ValidationResult validateCandidate(String callId, IceCandidate candidate) {
    // Similar checks, allow in SIGNALING or CONNECTING states
    ...
  }
}
```

**Validation checks:**
- Call exists and not expired
- Call in correct state (SIGNALING for offer/answer, SIGNALING/CONNECTING for candidates)
- Session ID matches (prevents cross-call packets)
- Packet age < 60 seconds (reject stale)
- Return `ValidationResult { isValid, reason }` (no exceptions)

---

### Task 2.2: Create SerialSignalingExecutor

**Objective:** Ensure signaling events for a call are processed in order.

**Deliverable:** `plugins/android/calls/SerialSignalingExecutor.java`

```java
public class SerialSignalingExecutor extends Executor {
  private Queue<Runnable> queue = new LinkedList<>();
  private AtomicBoolean isRunning = new AtomicBoolean(false);
  private String callId;
  
  public SerialSignalingExecutor(String callId) {
    this.callId = callId;
  }
  
  @Override
  public void execute(Runnable command) {
    queue.add(command);
    runNext();
  }
  
  private void runNext() {
    if (isRunning.getAndSet(true)) {
      return; // already running
    }
    
    while (true) {
      Runnable cmd = queue.poll();
      if (cmd == null) {
        isRunning.set(false);
        return;
      }
      
      try {
        cmd.run();
      } catch (Exception e) {
        logError("[" + callId + "] signaling error", e);
        // Continue to next command (don't crash)
      }
    }
  }
}
```

**Guarantee:** All commands for a call execute serially (no concurrent execution).

---

### Task 2.3: Wrap Signaling Handlers

**Objective:** Integrate validator and serialization into socket listeners.

**Modify:** Socket/signaling handler code (location TBD after code review)

```
On receive offer:
  1. validator.validateOffer(callId, offer)
  2. if invalid → logWarn("[CALL-ID] rejected: " + reason); return
  3. if valid → enqueue handler to serialExecutor
  4. In handler: lifecycle.signalStart()
  5. Try: setRemoteDescription()
  6. Catch: emit error event (don't crash)
  7. Finally: lifecycle.signalEnd()

On receive answer:
  (same pattern)

On receive ICE candidate:
  (same pattern)
```

**Code pattern:**
```java
void onRemoteOffer(String callId, Offer offer) {
  ValidationResult result = validator.validateOffer(callId, offer);
  if (!result.isValid) {
    logWarn("[" + callId + "] rejected offer: " + result.reason);
    return;
  }
  
  SerialExecutor executor = getExecutor(callId);
  executor.execute(() -> {
    try {
      lifecycle.signalStart();
      setRemoteDescription(callId, offer);
    } catch (Exception e) {
      emitError(callId, "setRemoteDescription", e);
    } finally {
      lifecycle.signalEnd();
    }
  });
}
```

---

### Task 2.4: Add Activity Lifecycle Pausing

**Objective:** Pause signaling when activity backgrounded.

**Modify:** Activity lifecycle callbacks

```
onPause():
  ✓ signaling.pause()  // stop accepting new packets

onResume():
  ✓ signaling.resume()  // start accepting again

onDestroy():
  ✓ signaling.drain()  // process remaining queue
  ✓ call endCall()
```

---

### Task 2.5: Unit Tests for Phase 2

**Deliverable:** `plugins/android/calls/test/SignalingValidatorTest.java`

```
Tests:
  ✓ validateOffer() accepts valid offer
  ✓ validateOffer() rejects if call expired
  ✓ validateOffer() rejects if not in SIGNALING state
  ✓ validateOffer() rejects if session mismatch
  ✓ validateOffer() rejects if stale (> 60s)
  ✓ validateCandidate() accepts valid candidate
  ✓ SerialExecutor processes commands in order
  ✓ SerialExecutor doesn't crash on command exception
  ✓ concurrent execute() calls → no race
```

---

### Phase 2 Acceptance

- [ ] All signaling handlers wrapped with validator
- [ ] All tests pass
- [ ] Late packets logged (not crash)
- [ ] Serial execution verified (test: interleaved offers)
- [ ] Code review approved

---

## Phase 3: Idempotent Cleanup (Weeks 3-4)

### Task 3.1: Refactor Close Pattern

**Objective:** Make cleanup idempotent and ordered.

**Modify:** `WebRTCModule.java` closeCall() method

```
closeCall(callId):
  1. Call call = registry.get(callId)
  2. If call null or state CLOSED → return (idempotent)
  3. If state not CLOSING → markState(CLOSING)
  4. lifecycle.beginClosing()  // wait for pending ops
  5. Try:
       - closeICE()  // guarded with null-check
       - closeTracks()  // guarded
       - closeDataChannels()  // guarded
       - closePeerConnection()  // guarded
  6. Finally:
       - registry.remove(callId)
       - markState(CLOSED)
  7. Emit call_ended (once per close)
```

**Pattern for each close operation:**
```java
private void closeICE() {
  try {
    if (iceConnection != null) {
      iceConnection.close();
    }
  } catch (Exception e) {
    logWarn("Error closing ICE: " + e.getMessage());
  }
  iceConnection = null;
}
```

**Guarantees:**
- Second call to closeCall() is no-op (state already CLOSED)
- Resources cleaned up in order (ICE → tracks → channels → connection)
- No exceptions propagate

---

### Task 3.2: Test Idempotency

**Objective:** Verify cleanup can be called multiple times safely.

**Deliverable:** `plugins/android/calls/test/CleanupIdempotencyTest.java`

```
Tests:
  ✓ closeCall(callId) succeeds on first call
  ✓ closeCall(callId) is no-op on second call
  ✓ State transitions: CONNECTED → CLOSING → CLOSED
  ✓ Resources nulled out after close
  ✓ Double-close from different threads → no race
  ✓ Emit call_ended exactly once (not twice)
```

---

### Phase 3 Acceptance

- [ ] closeCall() is idempotent (call 2x safely)
- [ ] State machine prevents re-entry (CLOSED is terminal)
- [ ] All tests pass
- [ ] Code review approved

---

## Phase 4: Error Recovery (Weeks 4-5)

### Task 4.1: Comprehensive Error Handling

**Objective:** Catch all WebRTC API exceptions; gracefully handle.

**Modify:** All WebRTC operation sites (multiple files)

Pattern:
```java
try {
  peerConnection.setRemoteDescription(sdp);
  logInfo("[" + callId + "] setRemoteDescription succeeded");
} catch (Exception e) {
  logError("[" + callId + "] setRemoteDescription failed: " + e.getMessage(), e);
  emitEvent("webrtc_error", {
    callId, operation: "setRemoteDescription", reason: e.getMessage()
  });
  // Do NOT crash; continue execution
}
```

**Coverage:**
- setRemoteDescription()
- addIceCandidate()
- addTrack()
- addStream()
- Any media operation

---

### Task 4.2: Error Metrics

**Objective:** Track error rates for observability.

**Deliverable:** Error counters injected into all catch blocks

```
Metrics:
  webrtc_error[operation=setRemoteDescription, reason=ice_failure]
  webrtc_error[operation=addIceCandidate, reason=constraint_error]
  webrtc_error[operation=addTrack, reason=generic]
  
Logged as:
  {
    timestamp: ...,
    callId: "...",
    operation: "setRemoteDescription",
    reason: "INVALID_STATE: ...",
    state: CONNECTING,
    active_ops: 2
  }
```

---

### Task 4.3: Unit Tests for Phase 4

**Deliverable:** `plugins/android/calls/test/ErrorRecoveryTest.java`

```
Tests:
  ✓ setRemoteDescription() error doesn't crash
  ✓ addIceCandidate() error doesn't crash
  ✓ addTrack() error doesn't crash
  ✓ Error emitted as event (for JS logging)
  ✓ Call continues despite error
  ✓ Metrics recorded for each error
```

---

### Phase 4 Acceptance

- [ ] Zero unhandled exceptions (all WebRTC ops wrapped)
- [ ] Error events emitted for JS layer
- [ ] Metrics dashboard shows error counts
- [ ] Tests pass
- [ ] Code review approved

---

## Phase 5: Activity Lifecycle (Weeks 5-6)

### Task 5.1: Save/Restore Call State

**Objective:** Survive activity recreation (rotation).

**Modify:** Activity save/restore

```
onSaveInstanceState(Bundle outState):
  if (activeCall) {
    outState.putString("callId", callId);
    outState.putInt("callState", call.state.ordinal());
  }

onCreate(Bundle savedInstanceState):
  if (savedInstanceState != null) {
    String callId = savedInstanceState.getString("callId");
    if (callId != null) {
      try {
        CallState call = registry.getActive(callId);
        reattachToCall(callId, call);
      } catch (CallExpiredException e) {
        showMissedCallUI();
      }
    }
  }
```

---

### Task 5.2: PeerConnection Lifecycle Audit

**Objective:** Ensure PeerConnection lives at correct scope.

**Audit:** Where is PeerConnection currently held?
- In Activity? → Move to Service or ViewModel
- In Service? → Verify it survives activity destroy
- In ViewModel? → Verify lifecycle() is correct

---

### Task 5.3: Integration Test

**Objective:** Rotation mid-call doesn't drop audio.

**Test procedure:**
1. Start call
2. Reach CONNECTED state
3. Rotate device (calls onDestroy → onCreate)
4. Verify:
   - Audio continues uninterrupted
   - No crash
   - State preserved

---

### Phase 5 Acceptance

- [ ] Activity rotation tested
- [ ] PeerConnection scoped correctly
- [ ] State preserved across rotation
- [ ] Audio doesn't drop
- [ ] Code review approved

---

## Phase 6: Testing & Rollout (Weeks 6-7)

### Task 6.1: Improved Logging

**Objective:** Comprehensive diagnostic logging.

Logging added at:
```
✓ Every state transition: "[CALL-ID] SIGNALING → CONNECTING"
✓ Every operation start/end: "[CALL-ID] op=setRemoteDescription start"
✓ Every validation result: "[CALL-ID] rejected offer: session_mismatch"
✓ Every cleanup step: "[CALL-ID] cleanup: closing tracks"
✓ Every error: "[CALL-ID] error=setRemoteDescription reason=ice_failure state=CONNECTING ops=3"
```

**Log level:**
- State transitions: INFO
- Operation start/end: DEBUG
- Validation results: WARN (for rejected)
- Errors: ERROR
- Cleanup: INFO

---

### Task 6.2: Metrics Dashboard

**Objective:** Monitor health during rollout.

**Metrics:**
- `webrtc_call_created` (counter)
- `webrtc_call_closed` (counter)
- `webrtc_crash_prevented` (counter — how many times did lifecycle prevent a crash)
- `webrtc_call_duration_ms` (histogram)
- `webrtc_cleanup_time_ms` (histogram)
- `webrtc_error[operation]` (counter)
- `webrtc_validation_rejected[reason]` (counter)

**Dashboard:**
- Real-time crash rate (target: 0%)
- Active call count
- Error rate by operation
- Cleanup time p50/p95/p99

---

### Task 6.3: Crash Testing

**Objective:** Verify fix works under race condition.

**Test setup:**
1. Inject 100ms delay before setRemoteDescription()
2. While delayed, simulate cleanup + removal
3. Release delay
4. Verify:
   - No crash
   - Graceful rejection (ValidationResult.invalid)
   - Logged

**Repeat 1000 times** to catch race conditions.

---

### Task 6.4: Canary Rollout (Week 1)

**Steps:**
1. Deploy with `webrtc_v2_enabled = false` (kill-switch)
2. 5% traffic: `webrtc_v2_enabled = true`
3. Monitor 24 hours:
   - Crash rate (target: 0%)
   - Call setup latency (target: ±5%)
   - Error rate (target: same as before)
4. If all green → proceed to Phase (25%)

---

### Task 6.5: Staged Rollout (Weeks 2-3)

**Gates:**
- 5% → 24h green → 25%
- 25% → 48h green → 50%
- 50% → 48h green → 75%
- 75% → 48h green → 100%

**Kill-switch:** If crash rate increases, flip `webrtc_v2_enabled = false` immediately.

---

### Task 6.6: Post-Rollout Monitoring (Week 4+)

**Activity:**
- Monitor crash rate daily for 1 week
- Monitor metrics: call duration, cleanup time, error rate
- Respond to alerts (crash spike, error spike)
- Declare success when stable

---

### Phase 6 Acceptance

- [ ] Logging comprehensive
- [ ] Metrics dashboard shows all signals
- [ ] Crash test passes 1000 iterations
- [ ] Canary rollout complete
- [ ] Staged rollout complete
- [ ] Full rollout complete
- [ ] Monitoring green for 1 week

---

## Summary: All Tasks by Phase

| Phase | Tasks | Duration | Dependencies |
|-------|-------|----------|--------------|
| 1 | 1.1-1.6 | 2 weeks | None |
| 2 | 2.1-2.5 | 2 weeks | Phase 1 |
| 3 | 3.1-3.2 | 1 week | Phase 1 |
| 4 | 4.1-4.3 | 2 weeks | Phase 2 |
| 5 | 5.1-5.3 | 1 week | All prior |
| 6 | 6.1-6.6 | 2 weeks | All prior |
| **Total** | **~20 tasks** | **~10 weeks** | **Sequential** |

---

## Acceptance Criteria (Final)

- [ ] All 12 issues resolved
- [ ] Crash rate for WebRTC calls → 0%
- [ ] All unit tests pass (90%+ coverage)
- [ ] Integration tests pass
- [ ] Crash test passes (1000 iterations)
- [ ] Call setup latency unchanged (±5%)
- [ ] Canary → full rollout complete
- [ ] Metrics show improvement
- [ ] Post-launch monitoring green for 1 week

