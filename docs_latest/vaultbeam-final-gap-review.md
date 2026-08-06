# VaultBeam — Final Gap Review

**Baseline:** `vaultbeam-production-audit.md` (findings) + `vaultbeam-v2-transformation-plan.md`
(decisions). Both are assumed read. **Nothing already in them is repeated here.**

This document contains only what those two missed, at tens-of-millions-of-users scale.

**The headline: two of the new findings are defects in the transformation plan itself.** My P1-1
(raise relay blocks to 64 MiB) would, as specified, cause the exact OOM class the project exists to
eliminate. That is the most important item below.

---

## Part A — New findings

### 🔴 N1 · P0 — The block-size recommendation causes a 512 MiB native peak and would OOM

**Problem.** `uploadBlock` accumulates every sealed chunk of a block into an `ArrayList<ByteArray>`
before streaming; `downloadBlock` calls `readBytes()` on the whole response. Both native backends
run a **fixed 4-thread pool**. So peak native memory is `blockBytes × 4 × 2`:

| block size | peak native |
|---|---|
| 4 MiB (today) | 32 MiB |
| 8 MiB | 64 MiB |
| 32 MiB | 256 MiB |
| **64 MiB (my P1-1)** | **512 MiB** |

**Root cause.** The plan treated block size as a *cost* variable and buffering as a *memory* variable,
and never multiplied them. Two recommendations in the same document, individually sound, are jointly
fatal.

**Production impact.** On a 2–3 GB RAM Android device, a 512 MiB native allocation invites the
low-memory killer during an ordinary transfer. This is the OOM the whole engine was built to avoid,
reintroduced by a cost optimisation.

**Probability:** certain if P1-1 ships as written. **Engineering cost of the fix:** ~1.5 days
(seal-and-stream on upload; stream the GET into positional writes instead of `readBytes()`).
**Maintenance cost:** none — it removes buffering rather than adding a mechanism.

**Alternatives considered.** (a) Cap `blockSize × poolWidth` by a memory budget — keeps the
buffering, caps the benefit; the cost win is throttled by device RAM. (b) Shrink the pool to 1 for
large blocks — serialises the upload and loses throughput. (c) Stream — no ceiling, no trade.

**Why worth it:** it converts P1-1 from unsafe to safe, and it is a prerequisite, not an enhancement.
**Sequencing change: streaming I/O is now a hard prerequisite of the block-size increase, not a
separate P2 memory item.** They ship together or not at all.

---

### 🔴 N2 · P0 — No remote kill switch, and therefore no canary for the flag flip

**Problem.** Every flag is a compile-time constant in `constants/flags.ts`. `lib/serverConfig.ts` is
a URL re-export, not a config channel. There is no server-driven flag, no percentage rollout, no
remote disable.

**Root cause.** Feature flags were treated as build configuration, which is adequate at small scale
and stops being adequate the moment a rollout takes days to reach users.

**Production impact.** Two distinct failures:
1. A defect found after release has **no mitigation but an app-store rollout** — days on iOS,
   fragmented on Android, and users on old builds are never mitigated at all.
2. **It invalidates the rollout strategy in my own plan.** Phase 4 "flag flip" is described as
   low-risk because rollback is "one constant" — but that constant is compiled in. The real rollback
   is a new release. There is no canary, no 1 %, no A/B, and no way to disable VaultBeam for the
   subset of devices where it misbehaves.

**Probability:** certain to matter at 10M users. **Engineering cost:** ~2–3 days for a minimal
server-driven flag channel (an authenticated `GET /config` with cached, signed values and a
conservative default). **Maintenance cost:** low, and it is reusable by every other feature.

**Alternatives.** (a) Ship the flag off and enable per release — the current plan; slow and
all-or-nothing. (b) Use an existing third-party flag SDK — adds a dependency and a data-sharing
question for a privacy-first app. (c) Minimal in-house channel — recommended; the backend already
has authenticated config endpoints and Redis.

**Why worth it:** it is the difference between "we can turn it off" and "we can ask people to
update". At this scale that gap is the whole risk posture.

---

### 🟠 N3 · P1 — Cancellation does not reach native; the window grows with block size

**Problem.** `AbortSignal` appears zero times in `vaultBeamStreamNative.ts`. `mapPool` checks the
signal *between* items; an in-flight `uploadBlock`/`downloadBlock` runs to completion regardless.

**Impact.** Cancel is advisory for up to one block. At 4 MiB on a slow link that is ~2 s; at the
recommended 64 MiB on 2 MB/s it is **~32 s of un-cancellable radio and CPU** after the user taps
Cancel — visible as a stuck UI, continued battery drain, and continued metered data use after an
explicit stop.

**Probability:** high (cancel is a common action). **Cost:** ~1 day (a cancellation token in the
native op, checked between chunks inside the block loop). **Maintenance:** low.
**Alternative:** leave it and cap block size — but that forfeits N1's cost benefit.
**Why worth it:** "stop means stop" is a correctness property for a user-facing data/battery action,
and it becomes an 8× worse violation under the plan's own block-size change.

---

### 🟠 N4 · P1 — Partial plaintext is never deleted on cancel or failure

**Problem.** `prealloc` creates a full-size destination immediately. `cancelTransfer` aborts the
session and purges the *relay*, but nothing deletes `dstPath`. A cancelled or failed receive leaves
a full-size file under `documentDirectory/VaultBeam/` containing **partial plaintext**, indefinitely.

**Impact.** Two problems, one security and one product. Security: decrypted fragments of a file the
user explicitly cancelled persist on disk, outside any of the app's at-rest protections (the VaultBeam
directory is not covered by `VAULT_CACHE_ENCRYPTED`, which is off by default anyway). Product: a
cancelled 12 GB transfer silently consumes 12 GB until the user finds it.

**Probability:** certain (every cancel). **Cost:** ~3 hours (delete on terminal non-success; keep on
`parked` so resume still works — the distinction already exists in the state machine).
**Alternative:** a GC sweep on launch — weaker (leaves data between runs) but a useful backstop.
**Why worth it:** it is a few hours to close a data-remanence hole and a storage leak with a shared
root cause.

---

### 🟠 N5 · P1 — An R2 outage disables LAN and P2P transfers, which do not need R2

**Problem.** `startSend` calls `relayInit` **before** any transport is chosen, and the backend
returns `503 relay storage unavailable` when `store.enabled()` is false. The call is outside the
try-block, so it rejects the whole send.

**Impact.** If R2 credentials rotate badly, the bucket is unreachable, or the backend loses its S3
config, **same-room LAN transfers stop working** — a path that touches neither R2 nor the internet
beyond signalling. A single cloud dependency takes down the offline-capable feature.

**Probability:** low per-incident, but certain over years, and it hits everyone at once.
**Cost:** ~4 hours (allow a direct-only session when init fails; the session model already supports
a transfer with no relay driver — that is exactly what `gateUntilReady` expresses).
**Alternative:** retry init in the background and start direct immediately — better UX, slightly more
state.
**Why worth it:** it converts a total outage into a degraded mode, for half a day's work, and it
exercises the transport-independence the architecture already claims.

---

### 🟠 N6 · P1 — Version mismatch is a silent dead end

**Problem.** `parseManifest` hard-rejects an unknown version and returns `null`; the bubble then
renders an Accept button that is simply disabled. There is no message, no "update the app" prompt,
and no telemetry.

**Impact.** At tens of millions of users, app versions are staggered for weeks. Every vbm2↔vbm3 pair
during that window produces a transfer that cannot be accepted, with no explanation to either party.
The sender sees "Sent"; the receiver sees a dead card. This is a support-volume problem, not a
correctness one — the hard reject itself is right.

**Probability:** certain during any wire-version rollout. **Cost:** ~3 hours (carry a plaintext
`v` in `meta` so the receiver can distinguish "cannot decrypt yet" from "version too new", and show
the right message). **Maintenance:** trivial.
**Why worth it:** the protocol change is already planned; shipping it without a mismatch UX
guarantees the support load.

---

### 🟠 N7 · P1 — Transfer-level head-of-line blocking; concurrency 1 *is* the fairness problem

**Problem.** The manager admits one transfer at a time. A 12 GB transfer therefore blocks every
other transfer for its entire duration — potentially hours. There is no priority, no preemption, and
manual transfers have no queue visibility (only auto-download sets `queued`).

**Root cause — and a correction to my own plan.** I dismissed a scheduler as "speculative structure;
there is no fairness problem at concurrency 1." That is backwards: **concurrency 1 with multi-hour
work items is precisely a fairness problem.** A user who sends a 12 GB video and then a 2 MB
document waits hours for the document.

**Impact.** Perceived as a hang. Combined with N3 (cancel does not reach native) the user's escape
hatch is also slow.

**Probability:** moderate-high in real use. **Cost:** ~1 day for the minimum viable fix — *not* a
scheduler: (a) admit small transfers (< 100 MB) alongside one large one, and (b) show queue position
for manual transfers. **Alternative:** full priority queue — rejected again; the two-lane rule
captures nearly all the benefit at a fraction of the cost.
**Why worth it:** it removes the worst UX failure mode without building the component I rejected.

---

### 🟡 N8 · P2 — Two native thread pools are created unconditionally and never shut down

Both `VaultBeamStreamModule` and `VaultBeamStreamRustModule` construct
`Executors.newFixedThreadPool(4)` at module init — **8 threads for every user, whether or not they
ever send a file**, never shut down. Cost: ~8 MB of thread stacks and scheduler pressure on low-end
devices. Fix: lazy pool creation on first use, idle timeout. ~3 hours.

### 🟡 N9 · P2 — The segment plan is server-supplied and unauthenticated (analysis: DoS-only)

The receiver reads geometry from `GET /relay/:id`, which the server controls. I analysed whether a
malicious server could cause **corruption**: it cannot. Chunk identity is `blockPlainOffset / CHUNK`,
which both sides derive from the *same* plan, and `deserialize` validates that segments are
contiguous and cover `[0, totalBytes)`. A tampered plan therefore produces GCM failures, not
mis-assembled files.

**But that validation is load-bearing security, and is documented as a geometry sanity check.** It
should be labelled as the control it is, with a test that asserts a non-contiguous or overlapping
plan is rejected. Residual risk is server-induced DoS, which a malicious server has anyway. ~2 hours.

### 🟡 N10 · P2 — Doze and App Standby buckets are unaddressed

Neither document considers App Standby. An app in the `rare` bucket gets restricted network and
deferred jobs even with a correctly declared user-initiated job. A user who transfers infrequently is
exactly the user most likely to be bucketed down. Needs measurement before a fix. ~1 day to
instrument.

### 🟡 N11 · P2 — Destination is always internal storage

`dstPath` is `documentDirectory/VaultBeam/`. On a budget device with 16 GB internal and a 128 GB SD
card, a 12 GB transfer fails despite abundant space, and there is no way to target external storage
(SAF). Cost: ~2 days (SAF adds a permission and URI-based IO across both native backends).

### 🟡 N12 · P2 — Telemetry has no thresholds

Both documents specify *what* to emit and neither specifies *when to page*. Without SLOs the
telemetry is a data lake. Minimum: alert on `bytesReTransferred/bytesTotal > 5 %` (resume is broken),
`relayPairShare > 40 %` (TURN cost), transfer failure rate > 2 %, and any nonzero durability-check
failure. ~1 day.

### 🟡 N13 · P2 — Verify Hermes string representation before trusting the memory numbers

My base64 measurements are Node/V8. Hermes has an ASCII string optimisation; if it does *not* apply
to these strings, a 699 KB base64 string costs ~1.4 MB of JS heap (UTF-16), doubling the P2P memory
finding. **This must be measured on-device before P2-1 is sized.** ~2 hours.

### ⚪ N14 · P3 — `K_t` has unbounded lifetime

The per-transfer key lives in the chat message forever, while the ciphertext it protects is purged at
24 h. Harmless today; becomes a real question if chat backups are exfiltrated and R2 history exists.
Consider scrubbing `keyB64` from the message body after completion + expiry.

### ⚪ N15 · P3 — No disaster-recovery runbook

No documented response to R2 bucket loss, coturn outage, or TURN secret rotation. Each has a
different blast radius; none is written down.

---

## Part B — The six lists

### 1 · Everything still missing
N1–N15 above. Ranked: **N1 and N2 are release blockers**; N3–N7 must precede a production release;
N8–N13 should follow within a release; N14–N15 are backlog.

### 2 · Everything that should be removed
- **`registerAvailable()` in `wiring.ts`** — superseded by `setDriversFor`. It is now a live footgun:
  calling it reintroduces the cross-transfer driver bug fixed under review. Delete it.
- **`currentManager()` in `run.ts`** — unused export; remove before it acquires a caller.
- **The legacy engine** — already scheduled (812 LOC, one caller).
- **Nothing else.** Resist further deletion; the remaining surface is earning its cost.

### 3 · Everything that should be simplified
- **Collapse two native backends into one.** Kotlin and Rust implement the same frozen contract; Rust
  is the only iOS-capable path and already passes the golden vectors. Retiring the Kotlin backend
  halves the surface that must stay byte-identical forever, removes one of the two 4-thread pools
  (N8), and means N1's streaming fix is written once rather than twice. **This is the single largest
  simplification available and it reduces work on three other findings.** Sequence it after the
  device matrix, not before.
- **Fold `gate.ts` into driver `available()`** once the transports stabilise — two wrappers exist
  only because negotiation is asynchronous. Low priority.

### 4 · Everything that should be delayed
Unordered datachannel (already gated on measurement), full transport scoring, SAF/external storage,
iOS background `URLSession`, everything previously marked P3. Add: **N11 and N14**.

### 5 · Everything to implement immediately
1. **Re-sequence P1-1** so streaming I/O lands with (not after) the block-size increase — this is a
   plan edit, not code, and costs nothing today.
2. **N4** partial-plaintext deletion (3 h) — security and storage, trivially cheap.
3. **N5** direct-only fallback when relay init fails (4 h).
4. Phase 1 integrity from the transformation plan, unchanged.

### 6 · Final implementation order
```
0  Baseline measurement (incl. N13 Hermes strings)         — 2 d, no risk
1  Integrity: fsync watermark, fresh K_t, N4, N5           — 3 d   ← ships to the CURRENT path
2  N2 remote flag channel + kill switch                    — 3 d   ← gates everything after it
3  Platform: Android 15 job, UI coalescing, N3 cancel      — 4 d
4  Cost + memory TOGETHER: streaming IO then 32→64 MiB     — 3 d   ← N1: never separately
5  N6 version UX, N7 two-lane admission, N12 SLOs          — 2 d
6  Flag flip — canary 1 % → 10 % → 50 % → 100 %            — gated on the 14-row matrix
7  Legacy deletion, then Kotlin-backend retirement         — 3 d
8  Performance (P2-1/2-2), telemetry depth, governor       — as measured
```
Phase 2 moves ahead of the platform work specifically so that Phase 6 can be a **canary rather than a
release**.

### 7 · Go / No-Go
**No-Go**, unchanged in verdict but with a changed blocker list. Previous blockers stand
(durability, nonce reuse, Android 15). **Added: N1 and N2.** N1 because the plan as written would
ship an OOM; N2 because without it the flip is irreversible in practice.

### 8 · Production readiness score
**6.0 / 10** — down from 6.5. Nothing regressed; the estimate was too generous. The reductions:
operations 2/10 (no kill switch, no canary, no SLOs) and a memory score that was based on a plan
containing an OOM. Everything else holds.

---

## Part C — Top 20 remaining risks

| # | Risk | P | I |
|---|---|---|---|
| 1 | Block-size increase ships without streaming IO → OOM (N1) | certain if unsequenced | critical |
| 2 | No kill switch when a field defect appears (N2) | certain at scale | critical |
| 3 | Durability gap ships (existing P0-1) | high | critical |
| 4 | Nonce reuse reached in the field (existing P0-2) | low | critical |
| 5 | Android 15 stops long transfers (existing P0-3) | certain | high |
| 6 | v2 path has never run against real transports | certain today | high |
| 7 | Cancel does not stop work for ~30 s (N3) | high | moderate |
| 8 | Partial plaintext persists after cancel (N4) | certain | moderate |
| 9 | R2 outage takes down LAN/P2P (N5) | low | high |
| 10 | Version-mismatch dead end during rollout (N6) | certain | moderate |
| 11 | One 12 GB transfer blocks all others (N7) | moderate | moderate |
| 12 | Larger blocks worsen tail latency on bad links | moderate | moderate |
| 13 | OEM job/FGS behaviour differs from Pixel | moderate | high |
| 14 | Hermes memory worse than measured on V8 (N13) | moderate | moderate |
| 15 | Doze/standby throttles infrequent users (N10) | moderate | moderate |
| 16 | TURN egress dominates cost at scale | high | moderate (cost) |
| 17 | Two native backends drift | moderate | high |
| 18 | Malicious sender exhausts recipient storage | low | moderate |
| 19 | `recv_mask` trust model breaks under groups | low today | high later |
| 20 | Telemetry without SLOs → data lake, no signal (N12) | high | moderate |

## Part D — Top 20 engineering wins still available

Ordered by benefit ÷ cost.

| # | Win | Cost | Benefit |
|---|---|---|---|
| 1 | Re-sequence block size behind streaming IO | 0 (a decision) | avoids shipping an OOM |
| 2 | Delete `registerAvailable` | 15 min | removes a re-introduction footgun |
| 3 | Delete partial plaintext on cancel (N4) | 3 h | closes remanence + storage leak |
| 4 | Direct-only fallback on relay-init failure (N5) | 4 h | outage → degraded mode |
| 5 | Fresh `K_t` per session version | 2 h | removes a nonce-reuse class |
| 6 | Version-mismatch message (N6) | 3 h | removes a support wave |
| 7 | Import-boundary lint | 1 h | protects the whole test strategy |
| 8 | Relay blocks 4→32 MiB (with N1 fix) | 2 h | 8× write-cost reduction |
| 9 | UI progress coalescing | 3 h | removes jank at high chunk rates |
| 10 | `sctp.maxMessageSize` instead of 16 KiB | 2 h | 4–16× fewer sends |
| 11 | `bufferedamountlow` instead of polling | 3 h | removes timer churn |
| 12 | fsync durable watermark | 1 d | ends silent corruption |
| 13 | Cancellation into native (N3) | 1 d | "stop means stop" |
| 14 | Two-lane admission (N7) | 1 d | small transfers stop starving |
| 15 | Lazy native thread pools (N8) | 3 h | 8 fewer threads for every user |
| 16 | SLOs on the telemetry (N12) | 1 d | turns data into signal |
| 17 | Remote flag channel (N2) | 3 d | canary + kill switch |
| 18 | Android user-initiated jobs | 3 d | transfers survive Android 15 |
| 19 | Kill base64 at the boundary | 3 d | battery/thermal, unblocks fast transports |
| 20 | Retire the Kotlin backend | 3 d | halves the frozen-contract surface |

Items 1–7 total **under two engineering days** and remove three security/correctness defects, one
outage mode and one support wave. They should not wait for a phase.

---

## Part E — Challenging this review

- **N1 was found by multiplying two numbers from my own documents.** That it survived two audits
  suggests the reviews are not systematically checking *interactions between* recommendations. Any
  further plan changes should be re-checked pairwise against the memory budget.
- **N7 is a reversal.** I rejected a scheduler on cost grounds and was right about the component but
  wrong about the problem. The two-lane rule is the cheap correction; if it proves insufficient, the
  rejection should be revisited rather than defended.
- **N9's conclusion (DoS-only) rests on `deserialize`'s contiguity validation.** If that validation is
  ever relaxed for a new geometry feature, the finding flips from DoS to corruption. It needs a test
  that fails loudly, not a comment.
- **N13 is unresolved, not answered.** I am carrying V8 numbers into a Hermes decision. Phase 0 must
  close it before P2-1 is sized.
- **Nothing here has been validated on a device.** That statement has been true in every review so
  far, and it remains the dominant risk. The correct next action is not another document.
