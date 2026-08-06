# VaultBeam v2 — Production Transformation Plan

**Companion to** `docs_latest/vaultbeam-production-audit.md` (the findings).
This document is the **decisions**: what to build, what to *refuse* to build, in what order, at what
cost, with what rollback.

Where the two disagree, **this document wins** — the audit was written without a cost constraint,
and several of its recommendations do not survive one. Those reversals are marked ⚠️ and explained.

**Constraint accepted:** evolve, do not rewrite. Every item below carries an engineering-cost
estimate and must earn it. Items that cannot are listed in §7 under *Rejected*, which is the most
important section here.

---

## 1. Executive summary

VaultBeam's core is better than its reputation in this repo suggests. The chunk/AAD/nonce contract
is frozen and triple-checked, the relay byte path already achieves **zero JS bytes per block**, and
the new engine's correctness properties are genuinely well tested. The problems are not in the
transfer logic — they are at the three edges where it meets the operating system, the disk, and the
bill.

**Two production blockers, both pre-existing, neither introduced by the v2 work:**

- **P0-1 Durability.** No `fsync` before a chunk is marked verified. The bitmap (persisted through
  SQLite, which *does* fsync) is more durable than the data it describes. Power loss ⇒ resume
  completes a corrupt file, silently.
- **P0-2 Nonce reuse.** A session re-init can reuse `K_t` over changed plaintext. GCM nonce reuse
  leaks plaintext XOR and enables forgery.

**One cost blocker:** relay blocks are 4 MiB. At 1M transfers/day that is **$414K/month** in R2
Class A writes; 64 MiB blocks make it **$26K/month**. Same architecture, one constant.

**One platform blocker:** the app targets Expo SDK 54 / RN 0.81 ⇒ **targetSdk 35 (Android 15)**, and
declares `foregroundServiceType="dataSync"`. Android 15 caps dataSync foreground services at
**6 hours per 24**. A 12 GB transfer on a slow link, or a few transfers a day, will be stopped by
platform policy.

**Verdict: No-Go on the flag flip.** Fix P0-1, P0-2, and the Android 15 job type. Everything else is
staged and reversible.

**Production readiness score: 6.5 / 10** (§20).

---

## 2. Overall architecture review — and the two-engine question, costed

I previously called the coexistence of the legacy and v2 engines "the biggest operational risk."
Measured, that was overstated:

| | lines |
|---|---|
| Legacy path (`vaultBeamTransfer`, `vaultBeamDirect`, `vaultBeamRecvBitmap`) | **812** |
| v2 engine production code | **2,322** |
| v2 engine self-checks | 1,676 (41 % of the new engine is its own tests) |
| Shared native + control plane (untouched by either) | 2,120 |

And deleting the legacy path touches **one external caller** (`vaultBeamController`); everything else
in the grep is the legacy files referencing each other.

**Revised conclusion:** the duplication is cheap to carry *and* cheap to remove. That argues for a
**short, dated flag life** rather than urgency — keep both through one release, delete legacy in the
next. Do not treat it as a blocker.

**But note the honest counter-fact:** v2 is 2,322 production lines replacing 812. That is a 2.9×
expansion. It buys bitmaps, durable sessions, driver abstraction, scheduling and crash recovery —
capabilities the old path did not have — but it is a real, permanent maintenance cost, and it is the
reason the "don't rewrite further" instruction is correct.

**Circular dependencies:** none. **Layering:** correct but enforced only by convention — one stray
`import { NativeModules }` in `session.ts` would destroy the entire test strategy. A lint boundary
rule is ~1 hour and protects the codebase's most valuable property.

---

## 3. Root cause analysis

| Symptom | Root cause | Class |
|---|---|---|
| Silent corruption after power loss | bitmap persisted via fsync-ing SQLite; chunk data only in page cache | design omission |
| Reachable nonce reuse | `K_t` persisted and reused across a *material reset*; mtime heuristic guards it | design omission |
| $414K/mo relay cost | physical block size chosen for throughput, never for op-count | unexamined constant |
| Android 15 kills long transfers | `dataSync` FGS is the wrong primitive post-Android 14 | platform drift |
| Battery/thermal burn on P2P | base64 at the native boundary, twice per chunk, +33 % bytes | boundary design |
| HOL blocking on P2P | `ordered: true` inherited from before chunks had identity | stale assumption |
| Progress event storms | store emits per verified chunk; only persistence is throttled | missing coalescer |
| Thermal adaptation absent | designed in the 4-tier doc, never implemented | unfinished work |
| 3 engine bugs found in review | fakes modelled desired behaviour, not real driver semantics | test-design flaw |

The last row is the most transferable lesson: **every fake in the suite behaved better than the real
component it stood for.** That is why the driver lifecycle, idle detection and per-transfer scoping
bugs all survived a green suite.

---

## 4. P0 — Production blockers

### P0-1 · No fsync before marking a chunk verified
**Probability:** high (any power loss, OS kill, or battery pull during a transfer — routine on
mobile). **Impact:** catastrophic (silent corruption, undetectable by the user).
**Why it exists:** `write_block_from_body` (Rust) drops the `File`; Rust's `Drop` does not fsync.
Kotlin opens `RandomAccessFile` `"rw"` and never calls `getFD().sync()`. Only `lan_connect` syncs.
**Fix:** two-level bitmap — `written` (memory) → `durable` (fsynced). Only `durable` may be persisted
or published as `PeerHave`. fsync every N MiB / T seconds and always before a bitmap flush.
**Cost:** ~1 day (native × 2 backends + session field + persistence gate). **Risk:** low, additive.

### P0-2 · Reachable GCM nonce reuse on session re-init
**Probability:** low-moderate (requires re-init with a changed source file of identical size+mtime, or
a forged mtime). **Impact:** catastrophic (plaintext XOR disclosure + forgery).
**Fix:** mint a fresh `K_t` on every session-version bump, unconditionally. Removes the class rather
than narrowing it. A re-inited transfer then restarts — correct, because the content may differ.
**Cost:** ~2 hours. **Risk:** very low.

### P0-3 · Android 15 dataSync cap will stop long transfers
**Probability:** certain on Android 15 devices (targetSdk 35 confirmed; `dataSync` declared).
**Impact:** high (transfers killed by policy; looks like a crash to users).
**Fix:** migrate the transfer FGS to a **user-initiated data transfer job**
(`JobInfo.Builder.setUserInitiated(true)`, Android 14+), which exists precisely for this and is not
subject to the cap. Keep the FGS path for < Android 14.
**Cost:** ~2–3 days (config plugin + job service + fallback). **Risk:** medium — platform-specific,
needs device testing across OEMs.

---

## 5. P1 — Must fix before release

| # | Item | Prob. | Impact | Cost | Note |
|---|---|---|---|---|---|
| P1-1 | Relay blocks 4 MiB → 32–64 MiB | certain | $$$ | **2 h** | one constant + a segment-planner bound; 16× cost reduction |
| P1-2 | UI progress coalescing (4–10 Hz, trailing) | high | jank | 3 h | store emits per verified chunk today |
| P1-3 | Destination fingerprint in the bitmap record | moderate | corruption | 4 h | resume onto a recreated file writes into the wrong bytes |
| P1-4 | Free-space check during transfer, not only at prealloc | moderate | failed transfers | 3 h | `set_len` is sparse; disk fills mid-flight |
| P1-5 | Plaintext-SDP fallback → refuse instead of degrade | low | metadata leak | 1 h | E2EE is universal now |
| P1-6 | LAN token → challenge-response over `K_t` | low | LAN eavesdrop | 4 h | token is sent in clear before any handshake |
| P1-7 | Import-boundary lint (no RN below the wiring layer) | — | protects tests | 1 h | cheapest insurance in the plan |
| P1-8 | Flag removal date + legacy deletion scheduled | certain | debt | — | policy, not code |

**Total P0+P1 ≈ 8–10 engineering days.** That is the whole gate to a defensible release.

---

## 6. P2 — Recommended (measure first)

| # | Item | Why it is P2 not P1 |
|---|---|---|
| P2-1 | Kill base64 at the native boundary (JSI `ArrayBuffer`) | measured 1.39 ms/chunk, but SCTP is 5–20× slower than the marshalling ceiling — it is battery/thermal, not throughput, **until** LAN or QUIC uses the same path |
| P2-2 | Unordered datachannel + self-describing binary frames | removes HOL blocking; but it is a **wire change** with real risk, and the benefit is unmeasured on real links. Gate on a measurement. |
| P2-3 | `bufferedamountlow` event instead of `sleep(15)` polling | small, safe, do it alongside P2-2 |
| P2-4 | Read negotiated `sctp.maxMessageSize` instead of hardcoded 16 KiB | 4–16× fewer `send()` calls; trivial |
| P2-5 | TURN reclassified as a metered transport | 3-line profile change; stops treating the most expensive path as cheap |
| P2-6 | `ResourceGovernor` (thermal + battery + charging, continuous) | designed in the original 4-tier doc, never built; battery sampled once per transfer today |
| P2-7 | Telemetry (§14 of the audit) | cannot debug field crashes without it; but it is additive and can follow the P0s |

---

## 7. ⚠️ Rejected — recommendations from my own audit that do not survive a cost constraint

This is the section that matters most under "do not rewrite."

| Prior recommendation | Verdict | Reasoning |
|---|---|---|
| **`ConnectionBroker` — make negotiation a first-class subsystem** | **REJECT (for now)** | It is a rewrite of ~460 lines of *working, field-proven* negotiation (sealed SDP, ICE restart, IPv6 priority, stall guards) whose only defect is testability. No negotiation bug is known. Revisit only if field telemetry shows negotiation failures. |
| **Split `TransferManager` into Manager + Scheduler + Governor** | **PARTIALLY REJECT** | Build the `ResourceGovernor` (new capability, P2-6). Do **not** split out a `Scheduler`: concurrency is 1, there is no fairness problem to solve, and the split would be speculative structure. |
| **`ChunkGrid` abstraction for future content-defined chunking** | **REJECT** | Speculative generality for delta-sync, which is not on the roadmap. The cost is paid now; the benefit is hypothetical. Revisit when delta sync is actually specified. |
| **`TransportProfile` scoring model** | **DOWNGRADE to P3**, except TURN reclassification (P2-5) | Full scoring is a scheduler redesign. The single real defect — TURN priced as cheap — is a 3-line fix. Take the fix, leave the framework. |
| **Move fragmentation into native (JS touches 0 P2P bytes)** | **DEFER behind P2-1** | Significant native work in two backends. Do the cheap JSI fix first, re-measure, and only then decide whether the remaining cost justifies it. |
| **Priority queue / chunk priority function** | **REJECT until streaming is specified** | Cheap to add *later* is the usual argument; here the scheduler is 60 lines, so retrofitting is also cheap. Do not pre-build. |
| **Buffer/memory pool** | **DEFER behind measurement** | Justified only if the JSI fix leaves allocation pressure. Measure RSS on a 1 GB fixture first (Phase 0). |

**Principle applied:** build what fixes a *known, observed* defect; refuse what builds structure for
a defect that has not been observed. Four of the seven rejections above are things I recommended one
turn earlier without a cost constraint — they were defensible engineering and are the wrong call for
this codebase at this stage.

---

## 8. P3 — Future

Delta sync (CDC), folder sets, streaming with in-order priority, QUIC/WebTransport drivers,
desktop transport, resume-across-reinstall, group transfers (needs a new key-envelope model *and*
revisits the `recv_mask` trust assumption).

---

## 9. Phase-by-phase roadmap

Each phase is independently deployable, independently testable, and independently revertible.

### Phase 0 · Baseline measurement *(2 days, zero production risk)*
Nothing ships. Establish: RSS/heap on a 1 GB transfer per tier; throughput per transport; chunk-rate
→ React render count; R2 op count per transfer; TURN-pair share.
**Success:** every number in §4–6 is confirmed or corrected on real devices.
**Rollback:** n/a. **Why first:** three of the P2 items are gated on measurement, and I would rather
delete a recommendation than ship one that was never justified.

### Phase 1 · Integrity *(P0-1, P0-2, P1-3, P1-4 — ~2 days)*
Durable watermark, fresh `K_t` per version, destination fingerprint, live free-space checks.
**Success:** the power-cut test passes — `kill -9` mid-transfer, reboot, every chunk the bitmap claims
is byte-correct on disk. **This test fails today.**
**Rollback:** the durable watermark is additive (an extra bitmap); reverting restores current
behaviour exactly. Fresh-`K_t` is a one-line policy revert.
**Risk:** low. Ships independent of the flag — it fixes the *shipping* path too.

### Phase 2 · Platform survival *(P0-3, P1-2 — ~3 days)*
User-initiated data transfer jobs on Android 14+; UI coalescing.
**Success:** a 3-hour transfer survives on an Android 15 device with the screen off.
**Rollback:** keep the FGS path behind a runtime check; revert = flip the check.
**Risk:** medium (OEM variance). Needs Samsung + Xiaomi + Pixel at minimum.

### Phase 3 · Cost *(P1-1, P2-5 — ~1 day)*
Relay blocks to 32–64 MiB; TURN reclassified.
**Success:** measured PUT count per 12 GB drops ≥8×; no throughput regression on a 2 MB/s link.
**Rollback:** one constant. Genuinely a one-line revert.
**Risk:** low-moderate — larger blocks mean a larger wasted unit on failure. Watch the retry rate;
if block failures exceed ~1 %, add HTTP range resume within a block before going past 32 MiB.

### Phase 4 · Flag flip *(gated on the 14-row device matrix)*
**Success:** all 14 rows pass, and `bytesReTransferred / bytesTotal < 1 %` in the field.
**Rollback:** `VB_SEAMLESS_RESUME = false`. One constant, no data migration — v1 and v2 sessions are
distinguished by plan version, so both remain readable.
**Risk:** the largest single step in the plan; it is why everything before it is independently
shippable.

### Phase 5 · Legacy deletion *(1 day, one release after Phase 4)*
Delete 812 lines and one branch. Unblocks deferred tasks 1.7, 3.4, 3.5.
**Rollback:** revert the commit (the flag is already gone by then, so this is a real revert, not a
toggle — hence the one-release delay).

### Phase 6 · Performance *(P2-1, P2-3, P2-4; P2-2 only if Phase 0 justified it)*
**Success:** JS bytes/chunk → 0 for LAN and relay; measured battery delta on a 12 GB P2P transfer.
**Rollback:** JSI path behind a flag alongside the base64 path for one release.

### Phase 7 · Adaptivity + telemetry *(P2-6, P2-7)*
**Success:** thermal throttling observable in telemetry and demonstrably reducing device temperature
on a sustained transfer.
**Rollback:** governor returns constants ⇒ current behaviour.

### Phase 8 · Load & soak
See §13.

---

## 10. Risk assessment

| Risk | P | I | Mitigation |
|---|---|---|---|
| Device matrix never run before flip | high | high | Phase 4 gate is explicit and non-negotiable |
| Larger relay blocks worsen tail behaviour on bad links | moderate | moderate | staged 4→32→64 MiB with retry-rate watch |
| Android job migration breaks on an OEM | moderate | high | keep FGS fallback; test on 4 OEMs |
| Unordered datachannel introduces reassembly memory bugs | moderate | high | that is why P2-2 is gated on measurement, not assumed |
| Governor oscillates | moderate | low | copy `networkState`'s hysteresis, which already gets this right |
| Fresh-`K_t` policy surprises a resuming sender | low | low | re-init already re-posts a manifest |
| Two engines diverge during the flag window | low | moderate | window is one release, deletion is scheduled |
| `recv_mask` is an unverifiable receiver assertion | low | low (1:1) | revisit before groups — becomes real there |
| Malicious sender burns recipient storage via 12 GB prealloc | low | moderate | needs a quota; currently unaddressed |

---

## 11. Rollback strategy

Every phase reverts by one of three mechanisms, in decreasing order of preference:
1. **A constant** (Phases 3, 4, 6, 7) — flag or block size.
2. **A runtime check** (Phase 2) — OS-version branch retained.
3. **A commit revert** (Phases 1, 5) — additive changes, no data migration.

**No phase requires a data migration to roll back.** Durable-watermark bitmaps are a superset of
today's; plan v1/v2 coexist by version; `recv_mask` and `session_version` are nullable additive
columns that old clients ignore.

---

## 12. Testing strategy

Existing and good: golden vectors (3 checkers), embedded self-checks, driver contract harness,
50-cycle leak/concurrency audit — all in CI.

**Missing, in priority order:**
1. **Power-cut durability test** — `kill -9` mid-write, remount, verify bitmap against disk. Highest
   value; it fails today.
2. **Memory regression gate** — RSS/heap ceiling on a 1 GB fixture, failing the build on regression.
3. **Per-transport throughput benchmark** — otherwise P2-1/P2-2 are unfalsifiable.
4. **Fake-fidelity rule** — after this review's three bugs, every fake must model the *failure*
   semantics of the real component (dispose really disables; a socket really drops).

---

## 13. Load & benchmark plan

**Load (server side):** the client is 1:1, so server load is control-plane only. Model 1M
transfers/day = ~35 rps init, ~200 rps state polls, ~600 rps presign. Trivial for Go; the load test
should target **R2 op ceilings and presign latency**, not CPU.

**Soak (device side):** 20 × 12 GB cycles with thermal, RSS and battery traced; assert no monotonic
growth in RSS, listener count, or timer count across cycles.

**Benchmarks to publish per release:** throughput per transport at 3 link qualities; JS heap and
native RSS peak; CPU-seconds per GB; battery mAh per GB; PUT count per GB.

---

## 14. Security review

Covered in the audit §11. Ranked here: **P0-2 nonce reuse** (blocker); **P1-5** plaintext SDP
fallback; **P1-6** LAN token in clear; **P2** `K_t` at rest in plaintext SQLite because
`VAULT_CACHE_ENCRYPTED` defaults **off** — either gate VaultBeam on it or move `K_t` to the keystore.
Metadata exposure to the server (size, progress, rate, timing) is inherent to a relay design and is
correctly documented in migration 070.

---

## 15. Mobile stability review

Android: FGS type is the blocker (P0-3); OEM killers are survivable *provided* P0-1 lands, because
resume is only trustworthy once durability is. iOS: capable via the Rust core but has no background
story — relay-tier `URLSession` handoff is the only viable path and is P3-scale work. Desktop: not
addressed anywhere in the current design; the driver model would accommodate it without redesign.

---

## 16. Scalability review

Per-device concurrency is 1, so client scaling is trivially linear. Server scaling is control-plane
only.

| Users | Transfers/day (est.) | Control-plane | R2 Class A @64 MiB | TURN |
|---|---|---|---|---|
| 10 | ~5 | noise | ~$0 | ~$0 |
| 1,000 | ~500 | noise | ~$13/mo | small |
| 100,000 | ~50,000 | 1 Go instance | ~$1.3K/mo | **the real cost** |
| 10,000,000 | ~5,000,000 | horizontal, Redis-backed (already) | ~$130K/mo | **dominant** |

**TURN egress, not R2, is the cost that scales badly.** Every point of IPv6 direct-connect hit rate
is money, which is why `relayPairShare` belongs in telemetry as a business metric, not a debug one.

---

## 17. Cost optimisation

1. Relay block size — 16× (§P1-1). Do this first; it is one constant.
2. Direct-connect hit rate — reduces TURN egress, the dominant term at scale. Already helped by
   IPv6-first priority; measure before optimising further.
3. R2 zero-egress is already the right storage choice; on S3 the download side would dominate.
4. Active prefix purge on complete/abort is already implemented and correct.

---

## 18. Transfer-engine component verdicts

Requested explicitly. **Build / Keep / Refuse**, with reasoning.

| Component | Verdict | Reasoning |
|---|---|---|
| Transfer Manager | **Keep** | exists, tested, correct after this review's fixes |
| Transport Drivers | **Keep** | exists; the abstraction is earning its cost |
| Session Manager | **Keep (as `TransferSession`)** | do not add a second layer |
| Chunk Scheduler | **Refuse as a separate component** | it is `workList()` — 20 lines inside the session. Splitting it out is structure without benefit at concurrency 1 |
| Buffer Pool | **Defer** | justified only if measurement (Phase 0) shows allocation pressure after the JSI fix |
| Memory Pool | **Refuse** | duplicate of Buffer Pool under another name |
| Worker Pool | **Keep as-is** (`mapPool`) | bounded concurrency already; a "pool" abstraction adds nothing |
| Priority Queue | **Refuse until streaming is specified** | no current workload has priorities |
| Adaptive Scheduler | **Refuse** | conflates transport selection (exists) with pacing (belongs in the governor) |
| Health Monitor | **Build, small** | folds into telemetry; do not make it a subsystem |
| Transport Scoring | **Refuse the framework, take the TURN fix** | see §7 |
| Backpressure Controller | **Keep, fix** | exists as `bufferedAmount` polling; replace with the event (P2-3). Not a new component |
| Adaptive Concurrency | **Build inside the governor** | not standalone |
| Adaptive Chunk Packing | **Already exists** (segment plan) — **use it properly** (P1-1) | the mechanism is built; the policy is wrong |
| Adaptive Retry | **Keep** | exponential backoff + cooldown exists and is persisted |

**Six of fifteen proposed components should not be built.** The engine already contains the
mechanism for most of them; what is missing is *policy*, not structure.

---

## 19. Go / No-Go

**No-Go** for the flag flip and for any production release of the v2 path, until:

- P0-1 durability (with the power-cut test passing)
- P0-2 fresh `K_t` per session version
- P0-3 Android 15 job migration
- The 14-row device matrix

**Go**, immediately and independently, for Phase 1 and Phase 3 — both fix or improve the **currently
shipping** path and do not depend on the flag.

---

## 20. Production readiness score

| Dimension | Score | Note |
|---|---|---|
| Wire/protocol correctness | 9/10 | frozen vectors, 3 checkers, cross-scheme rejection proven |
| Transfer-logic correctness | 8/10 | well tested; 3 bugs found and fixed under review |
| **Durability** | **2/10** | **P0-1 — the bitmap outlives the data** |
| **Security** | **6/10** | strong design, one reachable nonce-reuse path |
| Memory | 6/10 | relay path excellent (0 JS bytes); P2P path wasteful |
| Mobile lifecycle | 4/10 | Android 15 cap unaddressed; iOS background absent |
| Observability | 3/10 | cannot debug a field crash today |
| Cost efficiency | 4/10 | 16× overspend available in one constant |
| Scalability | 8/10 | control-plane only; already horizontal |
| Test infrastructure | 8/10 | strong, with a known fake-fidelity flaw now understood |
| **Overall** | **6.5/10** | **two blockers away from 8; the architecture is sound** |

---

## 21. Challenging this plan

- **Phase 0 could be skipped under schedule pressure**, and then P2-1/P2-2 would ship on my
  estimates rather than measurements. That is exactly the failure mode that produced four rejected
  recommendations in §7. If only one thing survives from this document, it should be that
  measurement precedes optimisation.
- **The 8–10 day P0+P1 estimate assumes no OEM surprises** in the Android job migration. That single
  item could double.
- **I have not validated the R2 pricing** against a negotiated contract — only public list pricing.
  The *ratio* (16×) holds regardless; the absolute numbers may not.
- **Nothing here defends against a malicious sender** burning recipient storage. It needs a quota,
  and it is unaddressed in both documents.
- **The biggest residual risk is unchanged from the last review:** the v2 path has never executed
  against a real datachannel, a real LAN socket, or the native module. Three bugs were found by
  deliberately looking. I would not assume the fourth does not exist.
