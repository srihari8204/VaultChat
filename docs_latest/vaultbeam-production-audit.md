# VaultBeam — Production Engineering Audit & Target Architecture

**Scope:** the whole transfer engine — legacy path, the seamless-resume engine on
`claude/vaultchat-transfer-architecture-kij2tj`, native cores, backend control plane.
**Output:** architecture only. No code.
**Method:** every quantitative claim below was measured or read out of this repository. Where I
could not measure, I say so rather than estimating.

Benchmarks run on Node 22 / x86 in this container. Hermes on a mid-range ARM device is
materially slower for the same work (typically 2–5× on base64/`TypedArray` paths); numbers are
labelled where that matters.

---

# PART I — AUDIT

## 1. Overall architecture

### What is genuinely good and should survive

- **One canonical logical chunk identity** (`id = plaintextOffset / 512 KiB`, AAD
  `transferId|fileId|id`) across every transport. This is the property that makes a single
  resume bitmap meaningful, and it is correct.
- **Native owns the byte path on the relay tier.** JS holds `{blockIndex, url}`. Measured JS
  bytes touched per relay block: **zero**. This is why 12 GB works at all.
- **The frozen golden-vector contract** with three independent checkers (Rust unit, JS oracle,
  FFI parity). Very few mobile codebases have this. It is the single highest-value asset here.
- **Two authoritative bitmaps with union-only merge.** Monotone convergence, order-independent.

### Structural problems

**A1 — Two engines coexist, indefinitely.** `vaultBeamTransfer`/`vaultBeamDirect` (legacy) and
`lib/vaultBeam/*` (new) both exist, selected by `VB_SEAMLESS_RESUME`. Every future change must be
made twice or reasoned about twice. A flag with no expiry date is permanent duplication.
→ **The flag needs a removal deadline in the same PR that introduces it**, and the legacy path
should be deleted the release after the flag defaults on. Three deferred tasks (1.7, 3.4, 3.5)
are already blocked behind this.

**A2 — Negotiation and data path are split across a seam that only one side understands.**
`vaultBeamDirect` owns SDP/ICE/sealing and calls back into the engine via hooks. The engine
cannot test negotiation, and `vaultBeamDirect` cannot be reasoned about without knowing the
engine's expectations. This is the least defensible boundary in the current design.
→ Negotiation should become a **first-class subsystem with its own interface** (`ConnectionBroker`),
returning a `Connection` handle, rather than a callback seam.

**A3 — `concurrency: 1` is a product decision hidden in a constructor default.** One transfer at
a time per device, globally. Nobody chose that explicitly.

**A4 — No dependency-direction enforcement.** The layering (pure core → drivers → wiring → RN) is
currently correct but only by convention. One `import { NativeModules }` in `session.ts` silently
destroys the entire testing strategy.
→ Add a lint rule / import boundary check. This is cheap and protects the most valuable property
the codebase has.

**Circular dependencies:** none found today. `run.ts → wiring → manager → drivers/types → session`
is acyclic; `drivers/relay → blockMap → vaultBeamSegments` is acyclic. Worth an automated check.

---

## 2. Memory architecture — measured

### The P2P chunk path is the worst thing in the codebase

Per 512 KiB chunk, the current path is:

```
native seal → base64 STRING → JS Uint8Array → 33 × 16 KiB frames → SCTP
                                                                    ↓
native open ← base64 STRING ← reassembly buffer ← 33 frames ← SCTP
```

Measured steady-state, Node 22 / x86:

| step | cost |
|---|---|
| base64 encode (native→JS) | 0.539 ms |
| base64 decode + `Uint8Array` | 0.214 ms |
| reassembly copy | 0.098 ms |
| base64 encode (JS→native) | 0.539 ms |
| **round trip** | **≈1.39 ms/chunk** |

Consequences:

- **+33.3 % bytes across the bridge, twice per chunk.** A 512 KiB chunk crosses as a 699 KB
  string, in each direction.
- **Transient allocation ≈2.3 MiB per chunk** (two strings + two byte arrays), all garbage.
- **Ceiling from marshalling alone: ~360 MiB/s on x86.** On Hermes/ARM, realistically 70–120 MiB/s.
- **12 GB = 24,576 chunks ≈ 34 s of pure CPU** on x86; 2–3 minutes on a phone. Burned on
  format conversion, producing nothing.

**Honest framing:** this is *not* currently a throughput bottleneck, because SCTP datachannel
throughput is realistically 6–19 MiB/s — well under the marshalling ceiling. It is a **battery,
thermal and UI-jank problem**, and it becomes a hard bottleneck the moment a fast transport
(LAN, QUIC, WebTransport) uses the same JS path. At LAN speed (~100 MiB/s) marshalling would
consume roughly 28 % of the single JS thread — guaranteed visible jank in chat.

→ **Recommendation M1: eliminate base64 at the native boundary.** Use JSI/TurboModule
`ArrayBuffer` transfer (Nitro modules already in the plugin set, or a TurboModule with
`ArrayBuffer` args). Removes both string allocations and the 33 % inflation. Expected: ~1.39 ms →
~0.1 ms/chunk.

→ **Recommendation M2 (better): move fragmentation into native.** JS should never see chunk
bytes at all. The datachannel object lives in JS, but `react-native-webrtc` exposes a native
`RTCDataChannel`; a native module can hold a reference and write to it directly. Target: **JS
bytes touched per chunk = 0**, matching the relay tier.

### Native-side memory

- `uploadBlock` (Kotlin) accumulates every sealed chunk of a block into an `ArrayList<ByteArray>`
  before streaming. At 8 MiB blocks × 4 concurrent workers that is **~32 MiB transient native
  heap**, plus the same again for `downloadBlock`'s `readBytes()` of the whole body → **~64 MiB
  peak**. Survivable, but it scales with block size, and block size is about to grow (see §15).
  → Seal-and-stream per chunk; stream the download into positional writes instead of buffering
  the body.
- The Rust relay backend returns block ciphertext as **base64 across the FFI** (`sealBlockFromFile`
  → base64 → platform HTTP). Same 33 % inflation as the P2P path, at block granularity. Documented
  as "Design A′" and defensible (avoids a Rust TLS stack) but it should be a length-prefixed
  buffer, not base64.

### Memory targets to adopt

| Budget | Target |
|---|---|
| JS heap attributable to a transfer | **< 8 MiB** (currently ~2.3 MiB transient/chunk churn) |
| JS bytes touched per chunk | **0** (currently 1.2 MB round trip) |
| Native transient per transfer | **≤ 2 × physical unit × workers** |
| Peak RSS delta, 12 GB transfer | **< 150 MiB** |

→ **Recommendation M3: a native slab pool** sized `workers × physicalUnit`, reused across
chunks, so steady-state allocation is zero and GC/`malloc` pressure is flat regardless of file
size.

---

## 3. WebRTC audit

**W1 — `ordered: true` causes head-of-line blocking, and the new design makes it unnecessary.**
The channel is created ordered+reliable. One delayed SCTP fragment stalls every chunk behind it.
Because every chunk now carries its own identity and is acked by id, **ordering is no longer
required for correctness** — only the current framing depends on it (a `{t:'c'}` control frame
followed by unlabelled binary frames).
→ **Move the chunk id and frame index into a binary frame header** (12 bytes: `u64 chunkId`,
`u16 frameIdx`, `u16 frameCount`), then switch to `ordered: false, maxRetransmits: undefined`
(unordered reliable). This removes HOL blocking entirely and is a strictly better fit for a
bitmap-driven protocol. This is the single biggest available throughput win on the P2P tier.

**W2 — `maxMessageSize` is hardcoded at 16 KiB.** The negotiated SCTP `maxMessageSize` is
available on the peer connection and is commonly 64 KiB or 256 KiB. Hardcoding 16 KiB means 4–16×
more `send()` calls than necessary.
→ Read `pc.sctp.maxMessageSize` and use `min(negotiated, 256 KiB)`.

**W3 — backpressure is a polling sleep.** `while (bufferedAmount > 4 MiB) await sleep(15)` burns
timer wakeups and adds up to 15 ms of latency per stall.
→ Use `bufferedAmountLowThreshold` + the `bufferedamountlow` event. Event-driven, zero polling.

**W4 — no congestion or loss signal is consumed.** `getStats()` is called once for telemetry
(`logIceWin`) and never used to adapt. RTT, `packetsLost`, and `retransmissionsSent` are available
and should feed the adaptive tuner (§9).

**W5 — ICE restart cap of 3 with a fixed 3 s grace** is reasonable but unadapted. A commuter train
flips networks more than 3 times in a 12 GB transfer.
→ Make restarts budget-based (e.g. 3 per 5 minutes, refilling) rather than absolute.

**W6 — TURN is a cost centre with no accounting.** Every relayed byte is paid egress on
self-hosted coturn. There is no telemetry distinguishing host/srflx/relay pairs beyond one mark.
→ Track relay-pair share as a first-class business metric (§10, §15).

**Recommended transport settings**

| Setting | Value | Why |
|---|---|---|
| `ordered` | **false** | no HOL; identity is in the frame |
| reliability | fully reliable (no `maxRetransmits`) | file data |
| frame size | `min(sctp.maxMessageSize, 256 KiB)` | fewer syscalls |
| backpressure | `bufferedAmountLowThreshold = 1 MiB`, event-driven | no polling |
| `iceCandidatePoolSize` | 4 (unchanged) | pre-gather |
| `bundlePolicy` | `max-bundle` (unchanged) | fewer ports |

---

## 4. Transport layer

The driver interface is close to right. Gaps:

**T1 — `available()` is a boolean where it needs to be a *quality estimate*.** The manager picks
by static `cost`. A saturated LAN can be slower than the relay; a TURN-relayed P2P pair is often
slower and always more expensive than R2.
→ Replace static cost with a **`TransportProfile { costClass, estBytesPerSec, estRttMs,
monetaryCostPerGB, batteryCostClass }`**, refreshed from live stats. Selection becomes a scoring
function, not an ordering.

**T2 — TURN-relayed P2P is misclassified.** It is registered as `p2p` (cost 20) but behaves like a
relay: metered, slower, and paid-for. It should be its own profile, ranked *below* R2 on cost when
R2 egress is free.

**T3 — no transport can express partial capability.** A transport that can only *send* (Bluetooth
in one direction) or only handle small units has no way to say so.
→ Add `capabilities: { directions, maxUnitBytes, supportsResume, meteredness }`.

**T4 — future transports (QUIC/WebTransport) need a byte-stream driver shape**, not the
chunk-at-a-time shape. The interface should accept a driver that consumes a *run stream* rather
than being called per run.

---

## 5. Transfer Manager

**Race conditions found by inspection:**

- **R1 (fixed during this audit):** disposal after every run made drivers permanently unavailable —
  multi-round transfers stalled. Fixed; now disposed at session end.
- **R2 (fixed):** the progress-revision snapshot was taken *after* callbacks had already advanced
  it, so productive rounds counted as idle.
- **R3 (fixed):** driver registry was process-wide while drivers hold per-transfer state — the
  second transfer would have been served the **first transfer's source file**.
- **R4 (open, low severity):** `admitAndRun` busy-waits on `sleep(idlePollMs)` while over
  concurrency. With many queued transfers this is O(n) wakeups per tick.
  → Replace with a proper semaphore/waiter queue.
- **R5 (open):** `poke()` returns `this.start(session)`, which returns the *existing* promise if
  one is running. A poke during an active run is silently a no-op rather than a nudge. Correct
  today because the loop re-derives each round, but fragile.
  → Make `poke` an explicit wake signal, not a start.

**Deadlocks:** none found. The single `AbortController` per session and the absence of nested
awaits on shared locks make deadlock unlikely by construction.

**Missing for production:**
- **priority** — a user-initiated foreground transfer must preempt a background auto-download.
- **fairness** — with concurrency > 1, no round-robin; a large transfer can starve a small one.
- **global rate limiting** — no cross-transfer bandwidth ceiling, so N transfers will fight.
- **adaptive concurrency** — fixed 4 block workers; should respond to RTT/loss/thermal.

---

## 6. Chunk architecture

**Is 512 KiB right?** Analysed rather than assumed:

| logical chunk | chunks @12 GB | bitmap | GCM tag overhead | resume waste on failure |
|---|---|---|---|---|
| 256 KiB | 49,152 | 6.0 KB | 0.006 % | ≤256 KiB |
| **512 KiB** | **24,576** | **3.0 KB** | **0.003 %** | **≤512 KiB** |
| 1 MiB | 12,288 | 1.5 KB | 0.0015 % | ≤1 MiB |
| 4 MiB | 3,072 | 384 B | 0.0004 % | ≤4 MiB |

The tag overhead is negligible at every size, so it is not the deciding factor. The deciding
factors are (a) bitmap size on the wire, (b) per-chunk fixed costs (seek, marshalling, ack), and
(c) resume waste.

**Conclusion: 512 KiB is a defensible choice and should stay** — 3 KB bitmaps RLE to under 20
bytes for the common contiguous case, and 24,576 is a comfortable set size. The per-chunk cost
problem is **marshalling, not size** (§2), and should be fixed there rather than by inflating the
chunk.

**Physical unit is where the real tuning lives**, and it is currently under-exploited:

- P2P: fixed 1 chunk/frame group → should be `min(sctp.maxMessageSize)`-driven.
- LAN: 1 chunk per frame → negligible header cost, correct as-is.
- **R2: 2/4/8 MiB — far too small for cost reasons.** See §15; this is a $400K/month decision.

---

## 7. Crash resistance

### **C1 — THE MOST SERIOUS FINDING IN THIS AUDIT: no fsync before marking a chunk verified.**

`write_block_from_body` (Rust) and `downloadBlock` (Kotlin) write to the destination and drop the
handle. Rust's `File` drop does **not** fsync; Kotlin's `RandomAccessFile` is opened `"rw"`, not
`"rwd"`/`"rws"`, and `getFD().sync()` is never called. Only `lan_connect` calls `sync_all()`.

The chunk is then marked **verified** in `PeerHave`, and the bitmap is persisted to op-sqlite —
which *does* fsync, because SQLite does.

So the failure mode is:

```
write chunk → page cache          (not durable)
mark verified in bitmap
persist bitmap                    (durable — SQLite fsyncs)
POWER LOSS / OS KILL
reboot → bitmap says "have it" → chunk is never re-fetched → FILE IS SILENTLY CORRUPT
```

The bitmap is *more durable than the data it describes*. This is a data-corruption bug, not a
performance issue, and per-chunk GCM cannot catch it because nothing re-reads the chunk.

→ **Recommendation C1: a two-level durability model.**
- `written` — in page cache, tracked in memory only.
- `durable` — fsynced. **Only `durable` may be persisted or published as PeerHave.**
- fsync on a cadence (every N MiB or T seconds, and always before a bitmap flush), then advance
  the durable watermark. Cost: one fsync per ~8–32 MiB, negligible against transfer cost.

**C2 — no torn-write protection at the block level.** A partial `write_all` (ENOSPC, process kill
mid-write) leaves a chunk half-written with no record. The GCM tag verified *before* the write, so
nothing detects it.
→ Under C1 this becomes safe automatically: a chunk not fsynced is not durable, so it is re-fetched.

**C3 — disk-space exhaustion is checked once, at prealloc.** A 12 GB `set_len` succeeds sparsely on
ext4/APFS; the disk can fill *during* the transfer.
→ Check free space against remaining bytes periodically; fail early and cleanly.

**C4 — `prealloc` creates a full-size sparse file immediately.** On a device near capacity this
looks like the space is gone while the transfer is queued. Acceptable, but the UI should say so.

**C5 — app update / OS upgrade.** Session state survives (op-sqlite), but the *manifest* lives in
the message row and the source file in the app cache — which an OS upgrade may clear. Sender
resume already validates size+mtime; the failure is handled but the UX is "failed", not "please
re-pick the file".

---

## 8. Performance engineering — theoretical ceilings

Per-device, single transfer, ordered by which binds first:

| Stage | Ceiling (mid-range ARM) | Notes |
|---|---|---|
| AES-256-GCM | 1–3 GB/s | ARMv8 crypto extensions; never the bottleneck |
| SHA-256 (if enabled) | 0.5–2 GB/s | currently not run — see §11 |
| Sequential disk write | 200–800 MB/s (UFS), 40–100 MB/s (eMMC) | eMMC devices are storage-bound |
| **JS marshalling (P2P today)** | **70–120 MiB/s** | measured 360 MiB/s on x86, ARM adjusted |
| LAN TCP | 40–110 MiB/s (Wi-Fi 5/6) | realistic |
| **SCTP datachannel** | **6–19 MiB/s** | the actual P2P ceiling |
| R2 over HTTPS | 5–50 MiB/s | link-bound |
| TURN-relayed | ≤ TURN egress budget | metered |

**Reading:** on the P2P tier the transport is 5–20× slower than everything else, so marshalling
does not bind *today*. On LAN, marshalling and storage are within 2× of each other — this is where
the base64 path first hurts. Crypto never binds.

**Battery/thermal:** the dominant avoidable cost is the ~34 s (x86) / 2–3 min (ARM) of pure CPU
spent on base64 for a 12 GB P2P transfer, plus 24,576 × 2 string allocations of GC pressure.

---

## 9. Battery & thermal

Present: `batteryParallelism()` halves block workers below 20 % / in low-power mode. Sampled
**once per transfer**, so a 40-minute transfer never re-evaluates.

Missing, and all cheap to add:
- **thermal signal** — `PowerManager.getThermalHeadroom()` (Android 10+), `ProcessInfo.thermalState`
  (iOS). The 4-tier design document called for this; it was never implemented.
- **continuous re-evaluation** on a cadence, not once.
- **charging awareness** — plugged in should raise concurrency and unit size.
- **an explicit governor** with hysteresis, so it does not oscillate.

→ **Recommendation:** one `ResourceGovernor` producing a single `{ workers, unitBytes, pacingMs }`
recommendation, consumed by the manager. Every adaptive decision in one place, testable as a pure
function of `{ thermal, battery, charging, netType, rtt, loss }` — the same shape as the existing
`networkState` module, which is the right pattern.

---

## 10. Observability

Today: `perf.mark('vaultbeam_summary' | 'vaultbeam_ice_win')` and Sentry breadcrumbs on backend
selection. Not enough to debug a field crash.

**Required per-transfer event stream** (sampled, content-free):

| Group | Fields |
|---|---|
| Identity | transferId, sessionVersion, role, sizeBucket, appVersion, osVersion, deviceClass |
| Transport | active id, switch count, ICE pair type (host/srflx/relay), TURN bytes, negotiation ms |
| Progress | verified/staged/total chunks, throughput p50/p95, stall count, resume count |
| WebRTC | bufferedAmount p95, RTT, packetsLost, retransmits, sctp.maxMessageSize |
| Memory | JS heap, native RSS delta, slab pool hits/misses, GC count/pause |
| Concurrency | worker count, queue depth, listener count, driver disposal count |
| Device | thermal headroom, battery %, charging, storage free, storage class |
| Outcome | terminal state, error taxonomy code, bytes re-transferred (**must be ~0**) |

**Two metrics matter most and neither exists today:**
1. **`bytesReTransferred / bytesTotal`** — the direct measure of whether seamless resume works.
   Target < 1 %. This is the KPI for this entire redesign.
2. **`relayPairShare`** — fraction of P2P transfers that fell to TURN. This is the TURN bill.

**Crash breadcrumbs** must include the last 20 state transitions per session, so a crash report
shows the transport ladder that led to it.

---

## 11. Security audit

**S1 — nonce reuse is reachable on session re-init.** Nonce = `4B(transferId) ‖ u64(chunkId)`;
key = per-transfer `K_t`. Uniqueness holds *within* a key, which is correct — **unless the same
`K_t` is reused over different plaintext**. That happens if a transfer is re-inited (session
version bump) with the persisted `K_t` while the source file has changed. The size+mtime check
added in Stage 5 is a heuristic, not a cryptographic guarantee (mtime is forgeable, and a
same-size edit within one second is plausible).

Consequence of GCM nonce reuse with different plaintext: **XOR of plaintexts leaks, and the
authentication key is recoverable** — i.e. forgery. This is the most severe security issue in the
design.

→ **Recommendation S1: mint a fresh `K_t` on every session-version bump**, unconditionally. The
key is delivered in the manifest message; a re-init already posts a new manifest. This removes the
class of bug rather than mitigating it. Cost: a re-inited transfer restarts — correct, because
re-init means the content may differ.

**S2 — `K_t` is at rest in plaintext.** It lives in `messages.content`; `VAULT_CACHE_ENCRYPTED`
defaults **off**, so on a seized/rooted device the SQLite cache yields every transfer key.
→ Either gate VaultBeam on cache encryption, or store `K_t` in the platform keystore.

**S3 — metadata to the server.** Server learns: size, chunk count, upload progress + rate, and now
(via `recv_mask`) **download progress + rate**, plus timing. It cannot learn content, filename or
key. The `recv_mask` addition is a genuine, if small, increase in exposure — documented in
migration 070, correctly.
→ Prefer the sealed `vaultbeam_have` path when the peer is online; keep `recv_mask` as fallback.

**S4 — LAN token is 16 bytes, transferred in the clear over TCP before any handshake.** An attacker
on the same L2 who observes the token can connect and receive the file. There is no channel
binding.
→ Replace the bare token with a challenge-response over the shared `K_t` (HMAC of a server nonce),
so observation of one session does not enable another, and so a passive observer gains nothing.

**S5 — no replay protection across sessions** is *not* needed (AAD binds transferId), and
**forward secrecy** is provided by the ratchet at key delivery. Both correct.

**S6 — timing side channels** are not a meaningful concern here (no secret-dependent branching in
the chunk path; GCM is constant-time in both backends).

**S7 — WebRTC SDP is sealed** with the per-transfer call cipher. Good. But a peer with no E2EE
session falls back to **plaintext SDP passthrough**, leaking DTLS fingerprint and device IPs.
→ Make plaintext signalling refuse rather than degrade, now that E2EE is universal.

---

## 12. Resume engine

The bitmap model is correct and the tests prove the important properties. Remaining gaps:

- **Durability (§7 C1) undermines resume correctness** — this is the blocking issue.
- **No resume across reinstall.** `K_t` is in the message row, which survives reinstall only if
  chat history is restored. Acceptable; should be explicit.
- **The receiver's destination file has no identity check.** On resume, nothing verifies that
  `dstPath` is the *same file* the bitmap describes. A user who deletes and recreates a file with
  the same name gets a bitmap describing bytes that no longer exist.
  → Store a destination fingerprint (inode/size/creation time) alongside the bitmap.

---

## 13. Mobile lifecycle

**L1 — Android 15 caps `dataSync` foreground services at 6 hours per 24.** A 12 GB transfer on a
2 MB/s link takes ~100 minutes; several such transfers, or one slow one, exhaust the budget and the
service is stopped by the platform.
→ Migrate to **`setUserInitiated(true)` JobScheduler jobs (Android 14+)**, which are designed
exactly for user-initiated file transfer and are not subject to the dataSync cap.

**L2 — iOS has no background story at all.** WebRTC and TCP suspend within ~30 s of backgrounding.
The Rust core made iOS *capable*, but backgrounding still kills transfers.
→ Background `URLSession` handoff for the relay tier is the only viable path, and it constrains
the design: `URLSession` background tasks upload/download **whole files or whole requests**, so the
physical block must be a self-contained HTTP request. It already is. This is a strong second
argument for larger relay blocks (§15).

**L3 — OEM battery managers** (Huawei, Xiaomi, OnePlus, Samsung) kill background work aggressively.
The existing battery-optimization prompt helps; the engine's correct response is to make **kill
survivable**, which the bitmap does, provided C1 is fixed.

---

## 14. UI performance

**U1 — no progress coalescing on the store emit.** `setState` → `emit(id)` → subscriber re-render,
called on every verified chunk. On the P2P tier that is one React notification per per-chunk ack —
potentially 40–200/s. Persistence is throttled; the UI notification is not.
→ Coalesce to **4–10 Hz** with a trailing edge, and always emit terminal states immediately.

**U2 — the store is correctly scoped** (`useSyncExternalStore` per transferId), so a tick re-renders
one bubble, not the list. This is right and should be preserved.

**U3 — the FGS notification is throttled to 1.2 s**, which is correct.

---

## 15. Scalability & cost

**The dominant finding: relay block size is a cost lever worth ~16×.**

Cloudflare R2 Class A (writes) ≈ $4.50/million. Per 12 GB transfer:

| block | PUTs/transfer | @10K transfers/day | @1M transfers/day |
|---|---|---|---|
| 4 MiB | 3,072 | $4,147/mo | **$414,720/mo** |
| 8 MiB | 1,536 | $2,074/mo | $207,360/mo |
| 32 MiB | 384 | $518/mo | $51,840/mo |
| **64 MiB** | **192** | **$259/mo** | **$25,920/mo** |

Plus one HEAD per block (Class B, ~$0.36/M) for upload verification — same shape, 12× cheaper.

R2's **zero egress** is the reason this is affordable at all; on S3 the download side would dominate
everything.

→ **Recommendation X1: relay physical blocks of 32–64 MiB**, not 2–8 MiB. This also fits iOS
background `URLSession` (§13) and reduces presign round-trips 8–16×. The logical chunk stays
512 KiB, so resume granularity is unaffected — this is exactly what the logical/physical split was
built for, and it is currently unused in the direction that matters most.

Counter-consideration: a failed 64 MiB block re-sends 64 MiB. At a 1 % block failure rate that is
0.64 % overhead — acceptable, and mitigable with HTTP range resume within a block.

**Other scale factors:**
- `vb_transfer` rows are 24 h ephemeral and tiny; Postgres is not a bottleneck.
- `recv_mask` writes: a few hundred single-row updates per transfer. Fine.
- **TURN is the real infrastructure cost.** Self-hosted coturn egress at scale dwarfs R2. Every
  point of IPv6 direct-connect hit rate is money. This justifies real investment in connectivity
  telemetry (§10).
- Signalling is 1:1 addressed emits through existing rooms; no fan-out amplification.

---

## 16. Future-proofing

The canonical-chunk + bitmap model generalises well:

- **Delta sync / versioning** — requires content-defined chunking (rolling hash) rather than fixed
  offsets. The bitmap survives; the *grid* becomes variable. Plan for a `ChunkGrid` abstraction
  now (fixed today, CDC later) so it is not a rewrite.
- **Folder sync** — needs a manifest of manifests. The session model is per-file; a `TransferSet`
  layer above it is additive.
- **Streaming / media** — needs *in-order priority*, not any-order completion. The scheduler must
  accept a priority function over chunks. Cheap to add now, expensive to retrofit.
- **QUIC / WebTransport** — needs the byte-stream driver shape (§4 T4).

→ Two cheap decisions today that prevent a rewrite later: **(a) a `ChunkGrid` interface**, and
**(b) a chunk priority function in the scheduler.**

---

# PART II — TARGET ARCHITECTURE

## 17. Layer model

```
┌───────────────────────────────────────────────────────────┐
│ UI            bubble · notification · settings            │  coalesced 4–10 Hz
├───────────────────────────────────────────────────────────┤
│ Orchestration TransferManager · Scheduler · ResourceGov   │  pure, testable
│               TransferSession (bitmaps, work-lists)       │
├───────────────────────────────────────────────────────────┤
│ Transport     ConnectionBroker → TransportDriver[]        │  no state, no counters
│               lan · p2p · turn · r2 · (quic, bt, cdn)     │
├───────────────────────────────────────────────────────────┤
│ Byte engine   NATIVE ONLY: slab pool · crypto · file IO   │  JS touches 0 bytes
│               framing · socket/datachannel writes         │
├───────────────────────────────────────────────────────────┤
│ Durability    two-level bitmap (written → durable)        │  fsync-gated
└───────────────────────────────────────────────────────────┘
```

**Invariant to enforce mechanically:** nothing above the byte engine may hold a payload buffer.

## 18. Production state machine

```
CREATED ─manifest─▶ ACTIVE ⇄ PARKED ─────▶ COMPLETE
                      │  ▲                   (server-recorded, immutable)
                      │  └── poke (peer online / staged / network up)
                      ├─▶ DEGRADED (transport exhausted, retrying with backoff)
                      ├─▶ BLOCKED  (no space / source gone / auth) — user action needed
                      ├─▶ CANCELLED
                      └─▶ FAILED   (unrecoverable)
```

`DEGRADED` and `BLOCKED` are new and matter: today both collapse into "parked" or "failed", so the
UI cannot distinguish "waiting, will recover" from "needs you".

## 19. Transfer Manager

Split the current single class into three, because it currently does three jobs:

- **`TransferManager`** — lifecycle, admission, ownership. Single-flight per transferId.
- **`Scheduler`** — which session runs, which transport, which chunks, in what order. Takes a
  priority function (enables streaming later). Fair-shares across sessions.
- **`ResourceGovernor`** — one adaptive recommendation `{workers, unitBytes, pacingMs}` from
  `{thermal, battery, charging, net, rtt, loss}`. Pure function; unit-testable.

## 20. Transport drivers

```
TransportProfile { id, costClass, estBytesPerSec, estRttMs, $/GB, batteryClass,
                   capabilities { directions, maxUnitBytes, metered } }
TransportDriver  { profile(), available(), run(session, runs, report, signal), dispose() }
ConnectionBroker { negotiate(peer, transferId) → Connection | null }   ← NEW, first-class
```

Negotiation stops being a callback seam and becomes a subsystem with its own tests.

## 21. Memory architecture

- Native **slab pool**, `workers × unitBytes`, zero steady-state allocation.
- **No base64 anywhere** on the byte path — length-prefixed buffers over JSI/JNI.
- JS holds only `{chunkId, offset, len, url}`.
- Hard budgets enforced in telemetry (§2).

## 22. Worker & scheduler

- One **byte-worker pool per device** (not per transfer), sized by the governor.
- Explicit **backpressure**: workers pull work; the scheduler never pushes.
- One driver active per session; N block workers within it.

## 23–24. Resume & crash recovery

- **Two-level bitmap: `written` → `durable`.** Only `durable` is persisted or published.
- fsync cadence every N MiB / T seconds and before every bitmap flush.
- Destination fingerprint stored with the bitmap.
- Recovery is not a mode: rehydrate, re-derive, continue.

## 25. Telemetry

As §10, sampled, content-free, with `bytesReTransferred` and `relayPairShare` as headline KPIs.

---

# PART III — EXECUTION

## 26. Testing & benchmarking strategy

| Layer | Method | Runs where |
|---|---|---|
| Wire format | golden vectors, 3 checkers | CI ✅ exists |
| Pure logic | embedded self-checks | CI ✅ exists |
| Driver contract | shared harness | CI ✅ exists |
| Concurrency/leaks | 50-cycle audit | CI ✅ exists |
| **Durability** | **power-cut simulation (kill -9 mid-write, verify bitmap vs disk)** | **missing** |
| **Memory** | **RSS/heap regression gate on a 1 GB fixture** | **missing** |
| **Throughput** | **benchmark harness per transport** | **missing** |
| Device matrix | 14 rows, two devices | manual |
| Soak | 12 GB × 20 cycles, thermal + memory traced | missing |

The durability test is the highest-value missing test: `kill -9` mid-transfer, reboot, assert
every chunk the bitmap claims is byte-correct on disk. That test fails today.

## 27. Migration & backward compatibility

1. Ship durability (C1) and the nonce fix (S1) **before** the flag flip — both are correctness
   issues in the *current* design, not just the new one.
2. Flag flip with the 14-row matrix as gate.
3. Delete the legacy path one release later; a flag without a deletion date is permanent debt.
4. Wire changes stay additive to the golden vectors; version bumps remain hard rejects.

## 28. Priority roadmap

| # | Item | Why now | Risk if skipped |
|---|---|---|---|
| **P0** | **fsync/durable watermark (C1)** | silent corruption | data loss |
| **P0** | **fresh `K_t` on re-init (S1)** | GCM nonce reuse | key/forgery compromise |
| **P1** | relay blocks 32–64 MiB (X1) | $400K/mo → $26K/mo | cost |
| **P1** | UI coalescing (U1) | jank at high chunk rates | UX |
| **P1** | Android 15 UserInitiated jobs (L1) | 6 h FGS cap | transfers die |
| **P2** | kill base64 at the boundary (M1/M2) | battery, thermal, LAN ceiling | perf |
| **P2** | unordered datachannel + binary framing (W1) | removes HOL | perf |
| **P2** | `TransportProfile` scoring (T1/T2) | TURN misclassified as cheap | cost |
| **P3** | ResourceGovernor (§9) | thermal never implemented | thermal/battery |
| **P3** | telemetry (§10) | cannot debug field crashes | operability |
| **P4** | iOS background URLSession (L2) | iOS parity | feature |
| **P4** | ChunkGrid + priority (§16) | prevents a later rewrite | future cost |

## 29. Go / No-Go

**No-Go for the flag flip today.** Two blockers, both P0, both pre-existing rather than introduced
by the redesign:

1. **C1 durability** — the bitmap is more durable than the data it describes. Resume can silently
   complete a corrupt file. This must be fixed before seamless resume is *trusted*, because the
   redesign makes resume happen far more often.
2. **S1 nonce reuse on re-init** — reachable, and catastrophic when reached.

Everything else is a Go with staged rollout. The engine's correctness properties are well tested;
the gaps are at the edges where it meets the OS and the disk.

## 30. Challenging my own design

Where this architecture could still fail, in descending order of likelihood:

1. **The device matrix has never run.** Every claim about transport switching in production is
   inference. Three bugs were found in the engine's first written form by *deliberately* testing
   it; the untested surface is still large.
2. **Larger relay blocks worsen tail latency and failure cost.** 64 MiB on a flaky 2 MB/s link is a
   32-second unit that either lands or is wasted. Needs HTTP range resume within a block, or an
   adaptive block size that shrinks on failure — the mechanism exists; the policy does not.
3. **Unordered datachannel changes reassembly semantics.** Frames from different chunks interleave;
   the receiver needs per-chunk partial buffers, bounded, with eviction. That is a new class of
   memory bug if done carelessly.
4. **The governor can oscillate.** Any adaptive controller without hysteresis and damping will
   thrash between states. `networkState` already gets this right; the governor must copy it.
5. **`recv_mask` is a receiver assertion the server cannot verify.** Harmless in 1:1. If VaultBeam
   ever becomes group, a malicious member could suppress delivery to others. Revisit before groups.
6. **Two engines is the biggest operational risk right now** — not any single technical defect.
7. **Nothing here addresses malicious *senders*.** A sender can burn a recipient's storage by
   declaring 12 GB and never completing. Prealloc makes that immediate. Needs a quota.

**What I could not assess:** real device throughput, thermal behaviour, OEM kill behaviour,
Hermes-specific memory characteristics, and actual R2/TURN pricing under a negotiated contract.

---

## On the phased approach

The staged plan proposed is the right shape, and is what has been followed: Stages 1–6 map onto
phases 1–6 almost exactly. The correction this audit makes is to **insert durability and the nonce
fix ahead of everything else**, and to treat **load testing (phase 7) as gating the flag flip**
rather than following it.
