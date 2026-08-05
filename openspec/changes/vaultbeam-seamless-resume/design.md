# VaultBeam Seamless Resume — Design

Covers deliverables 1–6 and 9–12. The implementation plan (7) and the file-by-file change
list (8) are in `tasks.md`.

Baseline for every "today" claim: `docs_latest/vaultbeam-transfer-architecture-analysis.md`.

---

## 1. Root cause of the current restart behaviour

Eight findings. RC-1 is the visible symptom; RC-2 through RC-4 are why a correct resume is
currently *impossible* rather than merely unimplemented.

### RC-1 — The reset is explicit and deliberate
`lib/vaultBeamController.ts:354`, on the direct→relay path:
```ts
setState(transferId, { status:'uploading', tier:'relay', done:0, total:0, bytes:0, totalBytes: opts.size });
await sendTransfer({ srcPath, totalBytes, fileId, transferId, keyB64, ... });
```
`sendTransfer` then seeds its work-list purely from the server's block mask
(`vaultBeamTransfer.ts:92`), which is empty after a direct-only attempt, so every block is
uploaded. The in-code comment at `vaultBeamController.ts:64-67` documents the reset as
intended ("the upload genuinely RESTARTS from 0"). This is the behaviour to remove, but
removing only this line would not be sufficient — see RC-2/3.

### RC-2 — Two incompatible chunk grids (the deepest blocker)
| | chunk size | chunk identity (drives nonce + AAD) |
|---|---|---|
| LAN / P2P | fixed 512 KiB | global index `g` |
| R2 relay | adaptive 256 KiB – 8 MiB per segment | plaintext byte offset |

`services/vaultbeam/rust/src/chunk.rs:74` — `let id = if offset_scheme { plain_offset } else { first_chunk + i };`
(mirrored in `VaultBeamStreamModule.kt:140/211`).

Consequences: chunk boundaries do not align between tiers, and even where they do the
identity differs, so the sealed bytes differ. There is no proposition "chunk 37 is done"
that both transports can agree on, therefore **no shared bitmap can exist**. Every
requirement in this change (chunk ownership, shared bitmap, cross-transport resume)
depends on fixing this first.

### RC-3 — The receiver's verified state is device-local and never published
`lib/vaultBeamRecvBitmap.ts` persists the receiver's verified blocks to AsyncStorage under
`vc_vb_recv_<transferId>`. It is read only by `receiveTransfer` on the same device. It is
never sent to the sender, never sent to the server. The sender therefore has no channel —
live or durable — through which it could learn what the receiver already holds.

### RC-4 — `uploaded_mask` conflates "staged on R2" with "delivered"
`vb_transfer.uploaded_mask` is set by `POST /relay/uploaded` after a server-side HEAD
confirms the object exists in R2. It is the sender's only resume input. A byte delivered
over LAN or P2P never touches R2, so it is invisible to the mask — correctly so, because
the mask's actual meaning is "is this staged in the relay". The bug is that the code treats
it as the completion oracle.

### RC-5 — Direct-tier progress is transport-local and non-durable
`serveDirect` / `receiveDirect` keep progress in closure variables (`directDone`, the
native `vbLanProgress` counter, the P2P `received` counter) and surface it only through an
`onProgress` callback into the UI store. The sender's crash-resume record
(`PersistedSend`, `vaultBeamController.ts:234`) carries `{transferId, srcPath, name, size,
fileId, keyB64, plan, linkType}` — **no progress field at all**. A direct transfer that
dies leaves nothing durable behind.

### RC-6 — Delivery confirmation is all-or-nothing
`p2pSend` sends every chunk, then `{t:'eof'}`, then awaits a single `{t:'ack'}` with a 30 s
timeout (`vaultBeamDirect.ts:364-367`). LAN is the same shape — one `0x01` byte after the
whole file (`lan.rs:105`, `VaultBeamStreamModule.kt:399`). Losing that one message discards
100 % of the work even though the receiver sent per-chunk `{t:'p',n}` acks the whole way
and has already reached `complete` locally. The sender re-uploads a file the receiver has
saved; the two devices' UIs disagree completely.

### RC-7 — `haveBytes` is a scalar prefix, not a bitmap, and only helps the receiver
`vaultBeamController.ts:412` passes `haveBytes = min(directDone × 512 KiB, size)`;
`vaultBeamTransfer.ts:192-206` credits blocks fully inside that prefix. Three limits: it
expresses only a *contiguous* prefix (no holes), it is recomputed from a live counter
rather than from durable state, and it exists **only on the receiver**. The sender has no
equivalent.

### RC-8 — Re-upload order maximises the receiver's stall
`sendTransfer` appends segments from offset 0 and pushes each segment's blocks in ascending
order, filtered only by the (empty) server mask. So after a fallback the sender re-uploads
the prefix the receiver already has *first*, and the genuinely-missing tail *last*. The
receiver credits the prefix without downloading it and then waits — for the full duration
of a redundant upload — for the bytes it actually needs. This is the "receiver waits
unnecessarily" symptom.

### Secondary finding (F-2, not a restart cause)
A transfer that completes over a direct tier never calls `/relay/complete`
(`startReceive` returns before `receiveTransfer`), so its `vb_transfer` row sits at
`pending` until the hourly `expires_at` sweep. Harmless today (a pure-direct transfer
staged nothing on R2) but it becomes a real leak once the sender may have staged blocks
before a direct tier wins.

### On the reported crashes
The repository contains no crash evidence for VaultBeam, and I could not reproduce or
confirm a crash from static reading. Two mechanisms are *plausible* and worth instrumenting
rather than asserting: unbounded growth of the `meters`/`persistT`/`subs` maps and
`openInbox` socket handlers across repeated fallback cycles (see §12 R8), and simultaneous
`startReceive` drives if the single-flight guard is bypassed by a rehydrated state. Sentry
breadcrumbs already exist in `vaultBeamStreamNative.ts`; §7 adds session-scoped ones.
**Treat "crashes" as unverified until a breadcrumb trail confirms it.**

---

## 2. Redesigned fallback state machine

The session is the state machine. Transports are attempts *within* a state, not states.

```
                    ┌─────────────────────────────────────────────┐
                    │            SESSION (durable)                 │
                    │  transferId · fileId · K_t · grid · bitmaps  │
                    └─────────────────────────────────────────────┘

  CREATED ──manifest delivered──▶ ACTIVE
                                    │
                                    │  work = ¬PeerHave ∧ ¬R2Have   (recomputed on entry
                                    │                                to every attempt)
                                    ▼
                        ┌──────  SELECT_TRANSPORT  ──────┐
                        │   ordered by cost: lan → p2p → relay
                        ▼                                 │
                     ATTEMPT(driver)                      │
                        │                                 │
       ┌────────────────┼─────────────────┐               │
       │                │                 │               │
   onVerified(g)    driver ends       driver fails        │
   → PeerHave|=g      cleanly         / stalls            │
   → progress++         │                 │               │
       │                │                 └───▶ demote driver, ───┘
       └────────────────┤                       keep bitmaps
                        ▼
                  work empty?
                   │        │
                  no       yes
                   │        │
                   └────────┴──▶ COMPLETE ──▶ finalize (relay/complete, purge, notify)
```

Rules that make the switch seamless:

- **R1 — Bitmaps are session state, never driver state.** A driver may only *append* to
  `PeerHave` via `onVerified`. It never reads or resets progress.
- **R2 — `PeerHave` is monotonic.** No code path clears a set bit. This is what makes the
  progress bar physically incapable of moving backwards on a transport change.
- **R3 — Transport change is a no-op on state.** `SELECT_TRANSPORT` re-derives the
  work-list from the bitmaps and hands it to the next driver. Nothing is reset, discarded,
  or re-created — same session object, same ids, same key.
- **R4 — Demotion, not termination.** A failed driver is marked unavailable with a
  cooldown; the session stays `ACTIVE`. A driver may be *re-promoted* when its precondition
  returns (peer comes back online, Wi-Fi returns), enabling relay→P2P without restart.
- **R5 — Terminal only on empty work-list or unrecoverable error.** Transport exhaustion is
  not terminal: the relay driver is always available while the peer is reachable at all,
  and a session with a non-empty work-list and no available driver parks in `ACTIVE` with
  a retry timer rather than failing.

### The RC-6 case under the new machine
Receiver verifies chunk 24 575 → sets `PeerHave[24575]` → publishes. Final ack lost. The
P2P driver fails. Session re-derives work = `¬PeerHave ∧ ¬R2Have` = **∅** → `COMPLETE`.
Zero bytes re-uploaded. The pathological case becomes the trivial case.

---

## 3. Transport-independent transfer architecture

```
      ┌────────────────────────────────────────────────────────────┐
      │  SessionRegistry   (Map<transferId, TransferSession>)      │
      │  single-flight: one session per transferId, process-wide   │
      └────────────────────────────────────────────────────────────┘
                                   │ owns
                                   ▼
      ┌────────────────────────────────────────────────────────────┐
      │  TransferSession                                            │
      │   identity : transferId, fileId, K_t, totalBytes, role      │
      │   grid     : CHUNK=512KiB, chunkCount                       │
      │   state    : PeerHave, R2Have (bitmaps) · inflight (memory) │
      │   derived  : workList(), progressBytes(), isComplete()      │
      │   io       : persist() → op-sqlite · publish() → peer/server│
      │   control  : AbortController, driver registry + cooldowns   │
      └────────────────────────────────────────────────────────────┘
             │ hands a work-list to exactly one driver at a time
             ▼
      ┌──────────────┬──────────────┬──────────────┐
      │  LanDriver   │  P2pDriver   │ RelayDriver  │   (+ future)
      └──────────────┴──────────────┴──────────────┘
```

```ts
interface TransportDriver {
  readonly id: 'lan' | 'p2p' | 'relay';
  readonly cost: number;                    // lower = preferred
  available(s: TransferSession): Promise<boolean>;
  run(s: TransferSession, work: ChunkSet, onVerified: (g: number) => void,
      signal: AbortSignal): Promise<DriverOutcome>;
  dispose(): void;                          // MUST release every listener/socket/timer
}
type DriverOutcome = { kind: 'drained' } | { kind: 'failed'; reason: string; retryAfterMs?: number };
```

Invariants enforced by review and by the driver contract tests:
- A driver holds **no** byte counter, no percentage, no "done" total.
- A driver calls `onVerified(g)` **only** after the chunk is GCM-verified, written, and
  durable on the receiving side (or confirmed by the peer, on the sending side).
- A driver never touches `vb_transfer` state, never posts progress to the UI store, and
  never decides the next transport.
- `dispose()` is idempotent and always called, including on abort.

**Why TURN needs no driver:** TURN is an ICE candidate type inside `P2pDriver`, not a
transport of its own. Whether the datachannel rides a host, srflx, or relay pair is
invisible above the driver — which is exactly the transport-independence the requirement
asks for.

---

## 4. Chunk bitmap architecture

### 4.1 Canonical chunk grid
```
CHUNK        = 512 KiB                    (frozen, all transports)
chunkCount   = ceil(totalBytes / CHUNK)   ≤ 24 576 at the 12 GiB cap
offset(g)    = g * CHUNK
len(g)       = min(CHUNK, totalBytes - offset(g))
chunkId      = g = offset / CHUNK         ← nonce + AAD identity, ALL tiers
```
Native change, offset scheme only: `id = plain_offset / chunk_bytes` (was `plain_offset`).
Legal because `chunk_bytes` is now globally constant, making offset and index a bijection.
The direct tiers already use `id = g`, so **their ciphertext is byte-unchanged**.

Adaptive geometry survives as block packing: a segment fixes `blockBytes` ∈ {2, 4, 8 MiB},
i.e. {4, 8, 16} canonical chunks per R2 object, chosen from measured throughput exactly as
today. What it no longer varies is `chunkBytes`.

> **Why dropping the 256 KiB / 8 MiB chunk sizes costs nothing:** resume granularity was
> already the *block*, never the chunk, so a small chunk was not bounding re-send. The only
> measurable deltas are +16 GCM tags per 8 MiB block (256 B ≈ 0.003 % overhead) and more
> AES calls, immaterial with ARMv8 crypto extensions.

### 4.2 The two bitmaps
| | authority | meaning of bit `g` | lives |
|---|---|---|---|
| `PeerHave` | **receiver** | chunk `g` is GCM-verified, written at its offset, and durable | receiver op-sqlite; published to sender + server |
| `R2Have` | **server** | chunk `g` is staged in an R2 object (derived from `uploaded_mask` ∧ plan) | `vb_transfer.uploaded_mask`; read by both |

Both are `Uint8Array(ceil(chunkCount/8))` — **3 072 B** at the 12 GiB cap. `inflight` is a
third set held **in memory only**: persisting it would be a lie after a crash.

### 4.3 Derived work-lists
```
sender.work   = ¬PeerHave ∧ ¬R2Have ∧ ¬inflight     ascending g
receiver.want = ¬PeerHave ∧ (R2Have ∨ peerOffering) ∧ ¬inflight
progressBytes = Σ over set bits of PeerHave of len(g)      // both sides, identical
isComplete    = popcount(PeerHave) === chunkCount
```
Ascending order fixes RC-8 for free: if the receiver holds the prefix, the work-list *is*
the missing tail, so the first byte uploaded is a byte the receiver needs.

### 4.4 Sync protocol
- **Live** — `vaultbeam_have`, a new sealed signaling event (same `callCrypto` cipher as
  the SDP): `{transferId, mask: <RLE+base64>, count}`. Receiver emits on every 64 newly
  verified chunks, on tier switch, and on session pause. Sender merges by OR.
- **Durable** — `POST /vaultbeam/relay/received {transferId, mask}` (recipient-only) writes
  `vb_transfer.recv_mask`; `GET /relay/:id` returns it. Covers an offline sender, an app
  restart, and a reboot. Merge is OR, so a stale mask is never harmful.
- **Merge rule** — always union, never replace. `PeerHave` is monotonic, so out-of-order
  or duplicated masks are idempotent.

### 4.5 Chunk states (mapping the requested vocabulary)
Derived, not stored per chunk — two bits + an in-memory set gives all of it:

| Requested state | Sender-side derivation | Receiver-side derivation |
|---|---|---|
| `Pending` | ¬PeerHave ∧ ¬R2Have ∧ ¬inflight | ¬PeerHave ∧ ¬inflight |
| `Uploading` | ∈ inflight | ∈ inflight (downloading) |
| `Uploaded` | R2Have ∧ ¬PeerHave (staged, not yet delivered) | n/a |
| `Downloaded` | n/a | *collapsed into `Verified`* — see below |
| `Verified` | PeerHave (peer asserted) | PeerHave (own GCM verify) |
| `Completed` | PeerHave — **immutable, never re-sent** | PeerHave — **immutable, never re-written** |

Two deliberate deviations from the requested model, both to avoid making the system weaker:

1. **`Downloaded` and `Verified` are one state.** A chunk is only ever written to disk
   *after* its GCM tag verifies (`open_chunk` → `write_all`, `fileio.rs:74-78`). A
   "downloaded but unverified" state cannot occur, and inventing a durable one would create
   a window where unauthenticated bytes look like progress.
2. **No separate per-chunk checksum.** The 16-byte GCM tag already authenticates the chunk
   *and* binds it to `(transferId, fileId, chunkIndex)` through nonce + AAD — strictly
   stronger than a checksum, since it is keyed and position-bound. A second checksum would
   add storage and CPU for no property we lack. Where a checksum *would* add something is
   detecting a locally-corrupted or swapped **source** file mid-transfer; that is covered
   instead by recording the source file's size + mtime in the session and failing on
   mismatch (cheap, catches the realistic case).

---

## 5. Resume architecture

Resume is not a special mode — it is what the session does on every attempt entry. There is
one code path for "start", "switch transport", and "resume after a week".

```
resume(session):
  1. rehydrate      ← op-sqlite: identity, grid, PeerHave, R2Have
  2. refresh R2Have ← GET /relay/:id       (uploaded_mask ∧ plan)
  3. refresh PeerHave:
       sender   ← recv_mask from the same response,  OR  live vaultbeam_have
       receiver ← own durable bitmap (authoritative; never overwritten by the server)
  4. verify source  ← sender only: srcPath exists, size + mtime match the session
  5. work = ¬PeerHave ∧ ¬R2Have           (ascending g)
  6. if work empty → COMPLETE → finalize
  7. else → SELECT_TRANSPORT → ATTEMPT
```

**P2P → Relay** (the headline case). Bitmaps are untouched by the driver swap. The relay
driver receives the same work-list the P2P driver had left, minus everything the receiver
confirmed. Chunks the receiver verified are in `PeerHave` and are therefore **never
uploaded**. The transfer id, file id, K_t, manifest, and `vb_transfer` row are the same
objects throughout — there was never a second session to create.

**Relay → P2P.** Symmetric, and now possible because nothing about the relay driver is
privileged: when the peer comes back online and pulls, `SELECT_TRANSPORT` prefers the
cheaper driver and hands it `¬PeerHave ∧ ¬R2Have`. Blocks already staged on R2 are *not*
re-sent over P2P; the receiver fetches them from R2 and takes only the remainder directly.
(Requirement says "resume from current chunk, never restart, never duplicate" — the
work-list derivation gives exactly that.)

**Cross-tier crediting replaces `haveBytes` entirely.** The scalar prefix and its
block-containment test (`vaultBeamTransfer.ts:192-206`) are deleted; a bitmap expresses
holes, which a prefix cannot.

---

## 6. Crash recovery architecture

**Durable set (op-sqlite, one row per transfer):**
```sql
-- client, lib/localDb.ts
CREATE TABLE IF NOT EXISTS vb_chunk_state (
  transfer_id TEXT PRIMARY KEY,
  role        TEXT NOT NULL,          -- 'sender' | 'recipient'
  chunk_count INTEGER NOT NULL,
  peer_have   BLOB,                   -- ≤3 KB
  r2_have     BLOB,                   -- ≤3 KB
  src_path    TEXT,                   -- sender only
  src_size    INTEGER, src_mtime INTEGER,
  updated_at  INTEGER NOT NULL
);
```
The existing `vb_transfers` table keeps UI state; identity/key material stays where it is
today (the manifest is already durable — it *is* a chat message row, which is the reason no
key needs re-deriving after a crash).

**Write policy:** write-behind, coalesced at 1.5 s, **flushed immediately** on tier switch,
pause, terminal state, and `AppState` background. Bounded cost: ≤6 KB per flush.

**Launch sequence** (extends `resumePendingSends`, `app/_layout.tsx:241`):
```
hydrateTransfers()            → UI state, as today
loadChunkState()              → bitmaps for every non-terminal transfer
for each: registry.adopt(...) → single-flight; skip if already live
          session.resume()    → §5, step 1
```
A sender whose `srcPath` was evicted from cache is marked failed and dropped (today's
behaviour, retained). A receiver never needs a source file, so it always resumes.

**Why the destination file survives:** `prealloc` opens without `O_TRUNC` and `set_len()`s
to the full size (`fileio.rs:30-31`), so previously written regions persist across a kill.
The bitmap is the only thing that was missing on the sender side, and now exists on both.

**Reboot / background:** identical path — nothing depends on process continuity. The
Android FGS (`transferForeground.ts`) keeps an active transfer alive while backgrounded;
if the OS kills it anyway, the next launch resumes from the bitmaps.

---

## 9. Performance impact

| Dimension | Today | After | Note |
|---|---|---|---|
| Re-upload after fallback at 90 % of 12 GB | 12 GB | ~1.2 GB | the point of the change |
| Bitmap memory | 1 × 3 KB (receiver only) | 2 × 3 KB per active session | negligible |
| `recv_mask` writes | — | ~1 per 64 chunks (≈32 MB) + on switch | 3 KB `UPDATE … WHERE PK`; ~380 writes for a 12 GB transfer |
| `vaultbeam_have` signaling | — | same cadence, RLE'd | typically <500 B; dense masks RLE well |
| op-sqlite writes | 1 row, throttled 750 ms | +1 row, coalesced 1.5 s | ≤6 KB per flush |
| GCM ops on a fast link | 1 × 8 MiB chunk/block | 16 × 512 KiB chunks/block | +256 B tags per block (0.003 %); AES-NI/ARMv8 |
| R2 object count / ops | unchanged | unchanged | block packing preserved |
| Presign round-trips | unchanged | unchanged | still ≤64 URLs per call |
| Work-list derivation | O(blocks) scan per poll | O(chunkCount/8) word ops | 384 words at the cap; sub-millisecond |

Net: a small, bounded, constant-factor cost on the happy path, in exchange for eliminating
an unbounded O(filesize) re-upload on the failure path.

---

## 10. Scalability analysis

- **Per transfer**: both masks are bounded by the 12 GiB cap → 3 072 B each. There is no
  input that makes them grow further, so server row size and client memory are bounded by
  construction, not by convention.
- **Server writes**: `recv_mask` is a single-row `UPDATE` by primary key. At the stated
  cadence a 12 GB transfer produces a few hundred writes over ~20 minutes — orders of
  magnitude below the existing per-message write volume.
- **Server reads**: unchanged. The recipient already polls `GET /relay/:id` at 1.5 s;
  `recvMask` rides the existing response rather than adding a call.
- **Concurrency**: `SessionRegistry` is O(active transfers). Auto-download already caps
  concurrency at 1 (`vaultBeamQueue.ts`); manual transfers are user-initiated and few.
- **Fan-out**: none — VaultBeam is 1:1, so `vaultbeam_have` is a single addressed emit
  through the existing `relayToPeer`, with no broadcast amplification.
- **Storage**: unchanged. Active purge on complete/abort plus the 24 h lifecycle rule
  still bound R2 residency; the change *reduces* stored bytes by not staging chunks the
  receiver already holds.
- **Multi-node**: `emitToUid` publishes to the `user:<uid>` room, so `vaultbeam_have`
  crosses cluster nodes through the existing Redis adapter with no new machinery.

---

## 11. Backward compatibility analysis

| Surface | Change | Compatibility strategy |
|---|---|---|
| Manifest | `vbm2` → `vbm3` | `parseManifest` already hard-rejects unknown versions (`vaultBeamController.ts:211`), so old↔new is a clean "can't open", never a corrupt decrypt. Precedent: the vbm1→vbm2 bump did exactly this for the same reason. |
| Relay chunk identity | `id = offset` → `id = offset/CHUNK` | **Breaking on the relay tier only.** Retain the vbm2 relay reader for one release so a transfer *started* before the update still completes; new transfers are vbm3-only. |
| Direct tiers | none | already `id = g`; ciphertext byte-unchanged, so the existing golden vectors stay green unmodified. |
| Golden vectors | additive | add a canonical-relay-id set; keep every existing vector. The frozen contract only grows — a shrink would be the review signal that something regressed. |
| `vb_transfer` | `+ recv_mask BYTEA` (migration 070) | additive, nullable; old clients never read or write it. |
| `POST /relay/received` | new endpoint | additive; absent on an un-upgraded backend → client degrades to live-only `vaultbeam_have`, i.e. today's behaviour. |
| `GET /relay/:id` | `+ recvMask` field | additive; old clients ignore unknown JSON fields. |
| Node ↔ Go parity | both must ship | Go is live (`caddy/Caddyfile:49`), Node is the documented rollback. Shipping only one silently breaks rollback. |
| Native backends | Kotlin + Rust + Swift must change identically | the parity suite (`vaultbeam-parity.selftest.ts`) is the gate; it drives the real crate against the JS oracle and the vectors. |
| In-flight transfers at upgrade | 24 h ephemeral | `vb_transfer.expires_at` and the R2 lifecycle rule are both 24 h, so the dual-read window only needs to exceed one day. |

**Deployment order (violating it breaks resume):** migration 070 → backend (Go **and**
Node) → native/app release. The client tolerates a missing endpoint; the backend must never
see a `recv_mask` write it cannot store.

---

## 12. Risk assessment

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | Relay wire change breaks cross-version interop | M | **H** | Version bump is a hard reject, not a silent mis-decrypt; vbm2 reader retained one release; golden vectors extended; on-device old⇄new gate before release (`lib/vaultbeam-rust/DESIGN.md` §9). |
| R2 | Receiver publishes a `PeerHave` it does not actually have | L | M | 1:1 only, and the liar is the sole victim — the sender skips chunks the receiver then lacks. Receiver can always re-request by clearing bits locally and re-publishing; sender re-uploads. No cross-user impact. |
| R3 | `recv_mask` leaks download progress to the server | M | L | Content-free (sizes/positions only). The server already knows `total_bytes` and upload progress via `uploaded_mask`, so the marginal disclosure is the receiver's *rate*. Documented; live `vaultbeam_have` is sealed and preferred when the peer is online. |
| R4 | Fixed 512 KiB chunk regresses very slow links | L | L | Resume granularity was always the block, which still adapts (2/4/8 MiB). Validate against the `<1 Mbps` bucket before release. |
| R5 | Bitmap divergence — sender believes delivered, receiver disagrees | L | M | Receiver is authoritative and merge is union-only; a receiver missing a chunk simply leaves the bit clear and the sender's next work-list includes it. Convergence is monotone. |
| R6 | Two drivers running one session concurrently (duplicate uploads) | M | M | `SessionRegistry` single-flight by transferId; exactly one driver holds the session's `AbortController` at a time; `dispose()` is mandatory and idempotent. Contract-tested. |
| R7 | The three native backends drift | M | **H** | Parity suite is CI-gated; the identity change is one line in each; vectors cover both schemes. |
| R8 | Listener/timer/map leaks across repeated fallback cycles | M | M | Audit list in `tasks.md` §6 — `openInbox` handlers, `onLanEvent` unsubscribes, `stallGuard` timers, `meters`/`persistT`/`subs`/`controllers` map entries. `dispose()` + a leak test that runs 50 fallback cycles and asserts listener counts. |
| R9 | op-sqlite write amplification on low-end devices | L | L | Coalesced 1.5 s, ≤6 KB, flushed only on transitions. |
| R10 | Scope creep into the iOS background handoff | M | M | Explicitly out of scope; the session design does not depend on it and does not block it later. |
| R11 | Refactor regresses the working relay path | M | **H** | Land as strangler: session + bitmaps first behind `VB_SEAMLESS_RESUME`, drivers wrapping today's `sendTransfer`/`receiveTransfer` unchanged; flip the flag last. Rollback is one constant. |

**Highest-leverage risks are R1 and R7** — both are the wire change, and both are gated by
the same artifact (the golden vectors + parity suite). If that gate is honoured, the rest of
the change is additive and flag-reversible.
