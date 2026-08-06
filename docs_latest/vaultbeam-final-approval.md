# VaultBeam — Final Engineering Approval

**Baseline:** the three prior documents, treated as approved except where modified below.
**Scope of this document:** the 12 required changes, and only material that is new.

Where an existing design is already correct this document says **APPROVED – no change required**
and stops. Seven of the twelve items are exactly that.

---

## Responses to the 12 required changes

### 1 · Cap physical blocks at 4 MiB — **ACCEPTED, and it fully neutralises N1**

At 4 MiB the peak is `4 × 4 threads × 2 buffers = 32 MiB` native. The 512 MiB OOM I flagged as
N1 (P0) **is eliminated by this cap.** N1 is withdrawn as a blocker.

Two consequences you should hold explicitly:

**(a) The cost win is forgone, and the number is large.** At 4 MiB, R2 Class A writes stay at
~3,072 PUTs per 12 GB transfer: **~$414K/month at 1M transfers/day** versus ~$26K at 64 MiB. This is
a deliberate trade of money for memory stability, which is a defensible mobile-first call — but it
should be a *recorded* decision with a revisit trigger, not an implicit one.

**(b) Your own escape clause is the right one, and streaming I/O is what satisfies it.** You wrote
"unless there is benchmark evidence proving no memory regression." Note what streaming I/O does:
with seal-and-stream on upload and streamed positional writes on download, **native memory becomes
`O(chunk × workers)` — about 2 MiB — regardless of block size.** Block size stops driving memory at
all. That is not an argument to raise the cap now; it is the specific evidence your rule asks for,
and it should be the recorded revisit trigger.

**Recommendation: keep the 4 MiB cap. Revisit only after streaming I/O ships and a device benchmark
confirms flat memory across 4 → 32 MiB.** No change requested to the cap itself.

### 2 · Logical identity fixed, physical packing adaptive — **APPROVED – no change required**

This is already the implemented invariant, enforced by `deserialize()` rejecting any v2 plan whose
`chunkBytes ≠ CHUNK`. Nothing to change.

### 3 · Logical chunk size — **keep 512 KiB. Do not reduce it until base64 is gone.**

I benchmarked 128 / 256 / 512 / 1024 KiB and must report the result honestly: **the CPU benchmark
was inconclusive.** Equal-work runs put 512 KiB *slowest* and produced a negative derived per-chunk
overhead, which is physically impossible. That is allocation and GC noise in this container, not
signal. I am not publishing a CPU number I do not believe.

What is arithmetic rather than measured, and therefore reliable:

| | 128 K | 256 K | **512 K** | 1024 K |
|---|---|---|---|---|
| chunks @12 GB | 98,304 | 49,152 | **24,576** | 12,288 |
| bitmap | 12.0 K | 6.0 K | **3.0 K** | 1.5 K |
| GCM tag overhead | 0.0122 % | 0.0061 % | **0.0031 %** | 0.0015 % |
| P2P acks | 98,304 | 49,152 | **24,576** | 12,288 |
| resume waste on failure | 0.25× | 0.5× | **1×** | 2× |
| JS reassembly buffer per in-flight chunk | 128 K | 256 K | **512 K** | 1024 K |

The one measurement I *do* trust is the base64 marshalling cost, because it was an order of
magnitude above the noise: **1.39 ms per chunk**, and it scales with **chunk count**, not bytes.

| chunk | marshalling CPU for one 12 GB P2P transfer |
|---|---|
| 128 K | ~137 s |
| 256 K | ~68 s |
| **512 K** | **~34 s** |
| 1024 K | ~17 s |

**That is decisive.** Halving the chunk doubles the pure-waste CPU. So:

- **Now: 512 KiB.** Balanced on every arithmetic axis, and the smallest size that does not multiply
  the known marshalling tax.
- **After base64 is removed (M1): 256 KiB becomes viable** and would halve resume waste and halve the
  JS buffer per in-flight chunk, at a 6 KB bitmap — all acceptable. Re-evaluate then, on-device.
- **Never 128 KiB** while marshalling scales with count. **Not 1 MiB** — it doubles resume waste and
  the reassembly buffer for a saving that is already negligible.

**Chunk size is coupled to the base64 decision.** That coupling was not previously stated and is the
new finding here.

### 4 · Adaptive workers — **APPROVED in principle; two corrections**

Agreed that workers must not be hardcoded. Two things the requirement as written cannot support:

**(a) Workers must be derived from a memory budget, not from RAM directly.** The safe formula is
```
workers = clamp(1, floor(memBudget / (2 × physicalUnit)), cores − 1)
```
The `2 ×` is the upload `parts` buffer plus the download body buffer. At a 64 MiB budget and 4 MiB
blocks that yields 8, capped by cores. Deriving from "RAM" without dividing by the physical unit is
how N1 happened in the first place; this formula makes that class of error impossible.

**(b) Drop storage speed as an input, for now.** There is no storage-speed signal on either
platform without running a micro-benchmark at startup, which costs I/O and battery on every launch
to inform a decision that CPU and network already dominate. **Recommend: do not implement storage
speed as a governor input.** Add it only if telemetry shows storage-bound transfers (eMMC devices),
which the telemetry will reveal for free.

Inputs to implement: RAM budget, battery level + charging, thermal headroom, core count, network
quality. That is five inputs, all cheaply available.

### 5 · Adaptive block sizing 1 / 2 / 4 MiB — **APPROVED – no change required**

Valid against the constraint `blockBytes % chunkBytes === 0`: at 512 KiB chunks these are 2, 4 and 8
chunks per block. All three are legal, memory-safe under the cap, and the existing segment planner
already implements exactly this mechanism. Nothing to change.

### 6 · WebRTC backpressure — **NOT APPROVED. One unsafe gap.**

Writer-side backpressure exists (`bufferedAmount` ceiling) and its known defect — polling instead of
`bufferedamountlow` — is already recorded. **But there is no reader-side throttling at all, and that
is a new unbounded-memory finding.**

**Problem.** In the P2P receive path, each completed chunk is pushed into an unbounded array of
in-flight write promises. Every pending entry retains its own reassembly buffer.

**Root cause.** Backpressure was designed for the sender. The receiver assumes native writes keep up
with the network, and nothing enforces it.

**Production impact.** A fast sender against a slow disk — eMMC device, thermal throttling, storage
nearly full — grows the pending queue without bound. At 512 KiB per entry, 200 outstanding writes is
100 MiB of JS-retained buffers. This is an OOM path that no current test covers, because every fake
resolves writes instantly.

**Probability:** moderate (needs a sender faster than the receiver's disk — common on LAN, and on any
budget device). **Impact:** high (OOM, the failure class the project exists to eliminate).
**Engineering cost:** ~4 hours — bound the in-flight write set (e.g. 8 chunks), and stop reading from
the channel while it is full. **Maintenance cost:** none.
**Alternative:** rely on SCTP flow control to throttle the sender indirectly — it does not, because
the receiver drains the socket into memory regardless.
**Why worth it:** it is the only remaining unbounded allocation in the engine, and it is four hours.

**Also required, and cheap:** a **maximum pending bytes** ceiling expressed in bytes rather than
chunks, so the bound holds if chunk size changes later.

### 7 · Memory safety — **APPROVED except item 6, plus one hardening note**

Verified against the checklist: no duplicate `ArrayBuffer`s, no duplicate `Uint8Array`s beyond the
known base64 path, no queue leaks in the manager, no listener leaks (asserted by the 50-cycle audit),
no worker leaks. The one genuine gap is §6's unbounded receive queue.

**Hardening note (not a confirmed defect):** `channelFromDataChannel` replaces `dc.onmessage` and
chains any prior handler. If it were ever called twice on the same datachannel, handlers would chain
and both would retain listener arrays. I could not construct a path where that happens today —
`onopen` fires once per channel, and a renegotiated channel is a new object. Recommend an
idempotence guard (a symbol on the `dc`) as one line of insurance, not as a bug fix.

### 8 · Cancellation — **NOT APPROVED; the existing gap is real and one item is missing from it**

The plumbing gap (zero `AbortSignal` reach into native) is already recorded as N3. **New:**
cancellation must also **drain and abandon the receiver's pending write queue**, or writes continue
executing after the user has cancelled — decrypting and writing plaintext for a transfer they
stopped. This compounds with §6 (the queue is unbounded) and with the missing destination delete.
Add it to the same work item; it is the same code.

Cancel must therefore stop: native file read, native encryption, native block ops, the pending write
queue, and the destination file. Currently it stops none of them synchronously.

### 9 · Transport switching — **APPROVED – no change required**

Never restarts, never duplicates, never resets progress. This is asserted directly by the audit
suite: a fallback driver is never handed a chunk the previous transport verified, exactly the four
missing chunks of ten move, and progress is monotone by construction (`PeerHave` has no clear path).
Proven for LAN, P2P and relay via the shared contract harness. Nothing to change.

### 10 · Mobile lifecycle — **APPROVED as already planned – no change required**

Android 15 job migration, OEM matrix, Doze/standby instrumentation, thermal governor, low-storage
checks are all already recorded across the three baseline documents with owners and phases. No new
findings.

### 11 · Telemetry — **APPROVED; one addition**

The requested fields are additive to the existing spec and all are cheap. `currentLogicalChunk` and
`currentPhysicalBlock` are useful and should be sampled, not streamed.

**New requirement:** crash breadcrumbs must be a **bounded ring buffer** (last N transitions, N ≈ 20)
held in native or in a fixed-size array. An unbounded breadcrumb array on a 24,576-chunk transfer is
itself a memory leak, and shipping telemetry that causes the OOM it is meant to diagnose would be
an unusually bad outcome.

### 12 · Production operations — **APPROVED as already planned – no change required**

Remote flags, kill switch, canary, rollback, version negotiation and compatibility are recorded
(N2, N6). No new findings.

---

## The ten outputs

### 1 · Still missing
- **Reader-side backpressure / bounded in-flight writes** (§6) — the last unbounded allocation.
- **Cancellation of the pending write queue** (§8).
- **Bounded breadcrumb ring buffer** (§11).
- **A recorded revisit trigger for the 4 MiB cap** (§1) — a decision log entry, not code.
- Everything already listed in the three baseline documents.

### 2 · Unsafe
Exactly one new item: **the unbounded receive queue** (§6). Nothing else found in this pass.

### 3 · Should be removed
- `registerAvailable()` in `wiring.ts` — already flagged; re-stated because it is 15 minutes and it
  actively reintroduces a fixed bug.
- `currentManager()` in `run.ts` — unused export.
- **Storage-speed as a governor input** — remove it from the requirement before it is built (§4b).

### 4 · Should be simplified
Nothing new. The Kotlin-backend retirement remains the largest available simplification and its
sequencing (after the device matrix) is unchanged.

### 5 · Should be delayed
- Any block size above 4 MiB — until streaming I/O plus a device benchmark (§1).
- Any chunk size below 512 KiB — until base64 removal (§3).
- Storage-speed input — until telemetry shows storage-bound transfers (§4b).

### 6 · Implement immediately
1. Bounded in-flight writes + reader throttling (§6) — 4 h, closes the last OOM path.
2. Cancel drains the write queue (§8) — folded into the same change.
3. Delete `registerAvailable()` — 15 min.
4. Record the 4 MiB cap decision and its revisit trigger — 10 min.

### 7 · Should NOT be implemented
- **Storage-speed governor input** — cost without a decision it would change.
- **Blocks > 4 MiB** — per your cap; and the memory argument for it does not exist until streaming.
- **Chunks < 512 KiB** — doubles known-waste CPU per halving.
- **A separate reader-throttle component** — it is a bounded set inside the existing P2P driver, not
  a new abstraction.
- Everything previously rejected (ConnectionBroker, ChunkGrid, scheduler split, transport-scoring
  framework, buffer/memory pool as separate components) — all still rejected.

### 8 · Final implementation order
```
0  Baseline measurement (incl. Hermes strings, storage class)          2 d
1  Integrity: fsync watermark · fresh K_t · delete partial plaintext
   · direct-only fallback · bounded writes + cancel drain              4 d   ← ships to the CURRENT path
2  Remote flag channel + kill switch                                   3 d   ← gates everything after
3  Platform: Android 15 job · UI coalescing · cancel into native       4 d
4  Streaming I/O (memory) — block size stays 4 MiB                     2 d
5  Version UX · two-lane admission · SLOs · breadcrumb ring            2 d
6  Flag flip: canary 1 % → 10 % → 50 % → 100 %                         gated on the 14-row matrix
7  Legacy deletion → Kotlin backend retirement                         3 d
8  Base64 removal → then re-evaluate 256 KiB chunks                    as measured
```
Phase 4 moved ahead of the flip and is no longer paired with a block-size change: under the 4 MiB
cap it is purely a memory improvement, which makes it independently shippable and lower-risk.

### 9 · Go / No-Go
**No-Go**, with a shorter blocker list than the last review. **N1 is withdrawn** — the 4 MiB cap
eliminates it. Remaining blockers:

1. Durability (fsync before verified)
2. Fresh `K_t` per session version
3. Android 15 job type
4. Remote kill switch — without it the flip is irreversible in practice
5. **New:** bounded in-flight writes (§6)
6. The 14-row device matrix

Items 1, 2 and 5 fix the **currently shipping** path and should not wait for the flag.

### 10 · Production readiness
**6.5 / 10**, recovered from 6.0. The 4 MiB cap removed a P0 (N1) and closed the memory-plan defect;
one new P1 was found (§6). Memory scores up, cost efficiency scores down — that is the trade you
chose, made explicit.

| Dimension | Was | Now | Why |
|---|---|---|---|
| Memory | 6 | **7.5** | cap removes the OOM path; one gap remains (§6) |
| Cost efficiency | 4 | **3** | 16× saving deliberately forgone |
| Durability | 2 | 2 | unchanged — still the blocker |
| Operations | 2 | 2 | unchanged until the flag channel ships |
| Everything else | — | — | unchanged |

---

## Closing note

Three of the twelve required changes produced no work: items 2, 5, 9 are already correct, and items
10 and 12 were already planned. Item 4 removed a requirement rather than adding one. That ratio is
the right sign at this stage — the architecture has stopped generating new structural findings, and
the remaining work is a short, concrete list rather than a design question.

The one thing this review did **not** change: nothing has been validated on a device. That has been
true in four consecutive reviews. Phase 0 and Phase 1 need to start.
