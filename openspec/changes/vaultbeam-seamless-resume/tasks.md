# Implementation plan (deliverable 7) + file-by-file change list (deliverable 8)

**Status: APPROVED for implementation** (review conditions folded in: logical/physical
split, `TransferManager`, persisted transport + cooldowns, completion handshake, session
versioning, transport-switching matrix as a merge blocker).

Strangler order — every phase is independently shippable, behind `VB_SEAMLESS_RESUME`
(`constants/flags.ts`, default **off**). Phases 1–4 change no behaviour with the flag off;
phase 6 flips it. Rollback at any point is one constant.

**Staged delivery — one reviewable PR stage per phase, opened as a draft up front so the
protocol can be reviewed before later work depends on it:**

| Stage | Scope | Merge gate |
|---|---|---|
| ✅ 1 | Wire protocol & logical chunk identity (§1) — **DONE**, PR #23 | vectors + Rust + parity + `tsc` all green; existing vectors verified byte-identical |
| ✅ 2 | `TransferManager` + bitmaps + session core (§2) — **DONE** | 5/5 vaultBeam suites green under `tsx`; tsc 0 |
| ✅ 3 | Transport drivers (§5) — relay, P2P, LAN + contract harness — **DONE** | driver contract + physical-unit tests green; Rust 16+6; parity green |
| ✅ 4 | Resume engine — `recv_mask`, versioning, handshake (§4) — **backend DONE**; client wiring (§6.7) lands with stage 6 | 5 pure Go tests green, 5 DB-gated ready; Node mirrored |
| ✅ 5 | Crash recovery (§3) — **DONE** (call-site swap + legacy cleanup ride with stage 6) | 9/9 vaultBeam suites; restart/reboot matrix rows still on-device |
| 🟡 6 | Production hardening — wiring, audit, F-2, engine entry point, flag-gated controller swap **DONE**. Remaining: bubble copy (7.2/7.3), legacy cleanups (1.7/3.4/3.5), **flag flip** | full transport-switching matrix (§8.2), **on-device — BLOCKING** |

Phase 1 must not merge unless every compatibility and parity test passes.

---

## 1. Canonical chunk grid (the wire change — do this first, alone)

- [x] 1.1 `services/crypto/vaultbeam-vectors.selftest.ts` — add a canonical-relay-id vector
      set (`id = plainOffset / chunkBytes`) alongside the existing offset-scheme vectors.
      Regenerate `services/crypto/__vectors__/vaultbeam.json` with `--write`; the diff is
      the review artifact. **Existing vectors must not change.**
- [x] 1.2 `services/vaultbeam/rust/src/chunk.rs` — `plan_block`: in the offset scheme emit
      `id = plain_offset / chunk_bytes` (was `plain_offset`). Extend the unit tests
      (`block_plan_offset_scheme_uses_offset_ids` becomes the canonical-id case).
- [x] 1.3 `plugins/android/VaultBeamStreamModule.kt` — same one-line change in `uploadBlock`
      and `downloadBlock` (`val id = if (offsetScheme) plainOffset / chunkBytes else …`).
      Both must change together or every GCM open fails.
- [x] 1.4 iOS inherits via the Rust core — no Swift change; confirm through the parity run.
- [x] 1.5 `services/crypto/vaultbeam-parity.selftest.ts` — assert Rust ≡ JS oracle ≡ vectors
      for the canonical ids. Must stay green in `npm run test:e2ee`.
- [x] 1.6 `lib/vaultBeamSegments.ts` — `appendSegment` takes only `blockBytes`; `chunkBytes`
      is the module constant `CHUNK = 512 KiB`. Keep the invariant check
      (`blockBytes % CHUNK === 0`) and the self-check; add "logical chunk size is uniform
      across every segment" to it. Segments continue to carry the adaptive **physical**
      block size — only the logical chunk is fixed.
- [ ] 1.7 **DEFERRED to stage 6** (`lib/networkState.ts` — `BUCKETS` becomes
      **physical-unit-only**). Re-checked during stage 3: `lib/vaultBeamTransfer.ts` still
      constructs v1 plans whenever `VB_SEAMLESS_RESUME` is off, and that is the production
      path until the flag flips. The bucket table therefore cannot drop `chunkBytes` until
      stage 6. The new `RelayDriver` already ignores it (it reads only `nextBlockBytes()`),
      so this is a cosmetic cleanup, not a functional gap.
      (2/4/8/8 MiB); `geometry()` returns `{ blockBytes }`. Update the self-check (the
      divisibility assertion now uses the `CHUNK` constant). The same bucket state also
      feeds the LAN/P2P drivers' `unitChunks()`, so one throughput brain sizes every
      transport's physical unit.

## 2. Bitmaps + session core (pure, unit-testable, no I/O)

- [x] 2.1 `lib/vaultBeam/bitmap.ts` (new) — `ChunkBitmap`: `set/test/popcount/union/
      toBase64/fromBase64/toRLE/fromRLE/complement/firstUnset`, fixed width from
      `chunkCount`. Embedded self-check in the house style (`lib/vaultBeamSegments.ts`
      pattern): round-trip, union idempotence, RLE round-trip, out-of-range safety.
- [x] 2.2 `lib/vaultBeam/session.ts` (new) — `TransferSession`: identity, grid, `PeerHave`,
      `R2Have`, in-memory `inflight`, `workList()`, `progressBytes()`, `isComplete()`,
      `mergePeerHave()`, `markVerified()`. Pure w.r.t. transport; no imports from any
      driver. Self-check covers §2 rules R1–R5 of `design.md`.
- [x] 2.3 `lib/vaultBeam/manager.ts` (new) — `TransferManager`, the process-wide singleton:
      session map (single-flight by transferId), admission queue, driver registry
      (`registerDriver`), scheduling, retry/cooldown policy, and launch recovery. Absorbs
      `lib/vaultBeamQueue.ts` and the ad-hoc `controllers` map in `vaultBeamController.ts`
      so there is exactly one scheduler. Slices `workList()` into `ChunkRun[]` of the active
      driver's `unitChunks()` width.
- [x] 2.4 `lib/vaultBeam/blockMap.ts` (new) — block ↔ canonical-chunk-run mapping, so
      `R2Have` (chunk granularity) derives from `uploaded_mask` (block granularity) ∧ plan.
      **Corrected during implementation:** a block moves when **any** of its chunks is
      needed, not when *every* one is — an R2 object is written and read whole, so a block
      straddling the edge of a needed region must still move. Bounded to one partial block
      per edge; the common resume shape (a held prefix) has exactly one.

## 3. Persistence + crash recovery

- [x] 3.1 `lib/localDb.ts` — add the `vb_chunk_state` table (see `design.md` §6, incl.
      `session_version`, `last_transport`, `driver_state`) to the schema block at line 118; add `persistChunkState` / `loadChunkState` /
      `deleteChunkState` / prune alongside the existing `vb_transfers` helpers.
- [x] 3.2 `lib/vaultBeam/session.ts` — write-behind persistence: coalesce 1.5 s, flush
      immediately on tier switch, pause, terminal, and `AppState` background.
- [x] 3.3 `manager.recoverAll()` implemented + tested (the `lib/vaultBeamController.ts`
      call-site swap lands with stage 6, when the controller stops driving tiers).
      Original: `lib/vaultBeamController.ts` — `resumePendingSends()` becomes
      `manager.recoverAll()`: rehydrate chunk state, restore `last_transport` +
      `driver_state` cooldowns, and adopt each non-terminal session into the manager. Sender
      source validation gains the size + mtime check (`design.md` §4.5 deviation 2).
- [ ] 3.4 **DEFERRED to stage 6** — still imported by the legacy `vaultBeamTransfer`
      path, which is production while `VB_SEAMLESS_RESUME` is off.
      Delete `lib/vaultBeamRecvBitmap.ts` (superseded by `PeerHave` in op-sqlite) and
      migrate any existing `vc_vb_recv_*` AsyncStorage keys on first launch, then remove.
- [ ] 3.5 **DEFERRED to stage 6** — same reason as 3.4.
      Migrate `vc_vaultbeam_sends` (AsyncStorage) into `vb_chunk_state.src_*` so all
      sender resume state lives in one store.

## 4. Backend: `recv_mask`, session versioning, completion handshake

- [x] 4.1 `vaultchat-backend/migrations/070_vaultbeam_recv_mask.sql` (new) —
      `ALTER TABLE vb_transfer ADD COLUMN IF NOT EXISTS recv_mask BYTEA;`
      `ALTER TABLE vb_transfer ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 1;`
      Idempotent, content-free, mirrors the 060 header rationale.
- [x] 4.1a Session versioning (`design.md` §7) in **both** backends: return
      `sessionVersion` from `/relay/init` and `GET /relay/:id`; require and validate it on
      `/relay/{uploaded,grow,received,complete,abort}`; **409 `stale session`** on mismatch;
      increment only on the `ON CONFLICT … DO UPDATE` re-init path.
- [x] 4.1b Completion handshake (`design.md` §8) in **both** backends: `/relay/complete`
      gains the `sessionVersion` + `popcount == chunk_count` guards and stays idempotent;
      **`/relay/uploaded` gains the missing `complete`/`aborted` state check** (410) — today
      it has none (`vaultbeam.go:634-692`, `vaultbeam.js:160-185`), so a sender can still set
      bits on a completed transfer; `/relay/abort` refuses to abort a completed session.
      `vb_complete` carries `sessionVersion`.
- [x] 4.2 `vaultchat-backend-go/internal/routes/vaultbeam.go` — `POST /vaultbeam/relay/received`
      (recipient-only, mask width validated against `chunk_count`, union-merge server-side
      so an out-of-order post cannot clear bits); add `recvMask` to `vbRelayState`; register
      in `RegisterVaultbeam`.
- [x] 4.3 `vaultchat-backend/routes/vaultbeam.js` — the same endpoint and field, byte-for-byte
      equivalent. **Required**: Node is the documented rollback target; shipping only Go
      silently breaks rollback.
- [x] 4.4 `vaultchat-backend/contract/endpoints.json` — register the new route so the
      contract runner covers it.
- [x] 4.5 Confirm the union-merge semantics with a test that posts an older mask after a
      newer one and asserts no bit is lost.
- [x] 4.6 Go tests (`vaultchat-backend-go/internal/routes/`): stale-version 409; completion
      idempotence; completion rejected on an incomplete mask; `uploaded` 410 after complete;
      abort refused after complete. Node parity via `vaultchat-backend/contract/run.js`.

## 5. Transport drivers (wrap existing code — do not rewrite the byte paths)

- [x] 5.1 `lib/vaultBeam/drivers/types.ts` (new) — the `TransportDriver` interface from
      `design.md` §3, plus a shared contract test every driver must pass (no counters,
      `onVerified` only after durability, `dispose()` idempotent, abort honoured).
- [x] 5.2 `lib/vaultBeam/drivers/relay.ts` (new) — wraps today's `sendTransfer` /
      `receiveTransfer` from `lib/vaultBeamTransfer.ts`, converting the work-list into block
      batches via `blockMap` and reporting `onVerified` per verified chunk. Delete the
      `haveBytes` prefix logic (`vaultBeamTransfer.ts:144-147, 192-206`).
- [x] 5.3 `lib/vaultBeam/drivers/p2p.ts` (new) — wraps `p2pSend`/`p2pReceive` from
      `lib/vaultBeamDirect.ts`. Change the wire so the sender sends **requested chunk runs**
      rather than `0..chunkCount-1` (`vaultBeamDirect.ts:350`), and so the receiver's
      `{t:'p',n}` carries the chunk **id** rather than a running count.
      `unitChunks()` returns 1–8 from `bufferedAmount` pressure, so one control frame can
      cover a run instead of one frame per 512 KiB (today's fixed cost).
- [x] 5.4 `lib/vaultBeam/drivers/lan.ts` (new) — wraps `lanServe`/`lanConnect`. Native gains
      an optional `runs` argument (`[{start,count}]`) so a resumed LAN attempt streams only
      the missing set **and** amortises the framing header over a run rather than one header
      per 512 KiB: `VaultBeamStreamModule.kt` (`lanServe`/`lanConnect` loops),
      `services/vaultbeam/rust/src/lan.rs` (`ServeOpts`/`ConnectOpts`),
      `services/vaultbeam/rust/src/ffi.rs` (arg parsing), `lib/vaultBeamStreamNative.ts`
      (types). Absent ⇒ today's full-range, one-chunk-per-frame behaviour.
      `unitChunks()` returns 1–16 from measured link speed.
- [x] 5.4a Physical-unit contract test: for each driver, assert that varying `unitChunks()`
      changes **only** request/frame counts — never a chunk's nonce, AAD, ciphertext, ack id,
      or bitmap bit. This is the guard that keeps the logical/physical split honest.
- [ ] 5.5 `lib/vaultBeamDirect.ts` — keep negotiation/ICE/sealing; remove all progress
      bookkeeping and the `stallGuard`-owned tier decision (the session decides now).

## 6. Session-owned orchestration + the audits

- [x] 6.1 `lib/vaultBeamController.ts` — replace the tier ladder in `startSend`/`startReceive`
      with `manager.start(session)`. **Delete the reset at line 354.** The controller keeps
      only: manifest mint/parse, the UI store, and socket listener arming.
- [x] 6.2 `lib/vaultBeam/manager.ts` — driver selection, cooldown/demotion, re-promotion
      (relay→P2P), and the `ACTIVE` park-with-retry state from `design.md` §2 R5. Persist
      `last_transport` + `driver_state` so backoff survives a restart.
- [ ] 6.2a Delete `lib/vaultBeamQueue.ts`; auto-download admission becomes
      `manager.enqueue()`. `lib/vaultBeamIngest.ts` calls the manager instead.
- [x] 6.3 Signaling: add `vaultbeam_have` to `relayToPeer` in **both**
      `vaultchat-backend/server.js:1014-1016` and
      `vaultchat-backend-go/internal/realtime/handlers.go:257-259`; seal/open it with the
      existing `callCrypto` cipher in the P2P driver.
- [x] 6.4 **Memory audit** — fix and add a regression test that runs 50 fallback cycles and
      asserts steady-state counts:
      - `openInbox` registers 4 socket handlers per call; `close()` exists but is only
        reached on some paths (`vaultBeamDirect.ts:123-129`) → guarantee via `dispose()`.
      - `onLanEvent` unsubscribers pushed into `cleanups` (`vaultBeamDirect.ts:163-168`) —
        verify every early return runs them.
      - `stallGuard` timers (`vaultBeamDirect.ts:54-62`) — `cancel()` on every exit path.
      - `meters`, `persistT`, `subs`, `controllers`, `states` maps in
        `vaultBeamController.ts` — entries are added per transfer; confirm deletion on
        terminal state (`meters` is deleted, `states` is intentionally retained for UI —
        bound it via `pruneVbTransfers`).
      - `_keyCache` in `lib/callCrypto.ts:110` is bounded at 32 — confirm the bound holds
        when a session performs repeated ICE restarts.
      - No re-encryption of completed chunks: guaranteed structurally, since the work-list
        excludes `PeerHave`.
- [x] 6.5 **Concurrency audit** — assert one upload worker, one download worker, one driver,
      one transport controller per transfer:
      - `TransferManager` single-flight replaces the `controllers.has()` guard.
      - `mapPool` (`vaultBeamTransfer.ts:57`) stays the only concurrency primitive; width
        from `batteryParallelism()`.
      - the auto-download queue is absorbed by the manager, not duplicated beside it;
        manual transfers become admitted work too (today they bypass the queue entirely,
        which is why test-matrix row 12 is reachable in production).
      - one `AbortController` per session, held by the session, borrowed by the driver.
- [x] 6.6 Fix secondary finding F-2 via the §8 handshake: the receiver runs the completion
      report on **any** terminal success, whichever transport delivered the last chunk.
- [x] 6.7 Client side of §7/§8: session key becomes `(transferId, sessionVersion)`; a 409
      `stale session` triggers rehydrate-from-server then re-derive; the sender treats an
      unknown/expired transfer on resume as complete-or-expired and drops its persisted send
      rather than re-uploading.

## 7. Progress semantics + UI

- [x] 7.1 `lib/vaultBeamController.ts` — `setState` progress comes from
      `session.progressBytes()` (verified only). The `meterTick` reset-on-decrease branch
      (`vaultBeamController.ts:105`) becomes dead code — `PeerHave` is monotonic — and is
      removed.
- [ ] 7.2 `components/VaultBeamBubble.tsx` — headline % is delivery (verified) on both
      sides. Sender's "staged to relay" becomes a secondary line, since it is no longer the
      same number as delivery progress.
- [ ] 7.3 Confirm the FGS aggregate (`lib/transferForeground.ts`) reads the same verified
      bytes, so the notification cannot disagree with the bubble.

## 7b. Integrity blockers (final approval, Phase 1 — must land before the flag flip)

- [x] 7b.1 **Durability watermark.** `write_all` reaches the page cache, not the disk, so a
      chunk marked verified on a returned write records durability that a power cut can
      take — and the resume engine then correctly skips it, leaving a silently wrong file.
      Added `fileio::sync_file` (fdatasync; the destination is preallocated so size metadata
      is already stable) + the `syncFile` op, and mirrored it on all three native surfaces
      (Kotlin `VaultBeamStreamModule`, `VaultBeamStreamRustModule`, iOS `VaultBeamStreamRust`).
      `TransferSession` gained two memory-only holding tiers between "written" and
      "verified" (`_written`, `_syncing`); `TransferManager` owns the barrier, so no driver
      changed. A failed barrier returns its batch to the work-list — it never promotes.
      Applies to recipients only: a sender's verified bits are the peer's ack, already
      durable on the peer's disk.
- [x] 7b.2 **Fresh K_t on a session-version bump.** A bump restarts chunk ids at 0 and the
      nonce is `4B(transferId prefix) ‖ u64_be(chunkId)`, so adopting a new version under the
      old key re-seals different plaintext at already-used nonces — a total AES-GCM break.
      `adoptVersion(version, keyB64)` now requires fresh material and throws on reuse, and
      `run.ts` stops a stale session (every transport gate closes, the session ends `failed`)
      instead of resetting the bitmaps and continuing. K_t lives in the E2EE manifest, so
      only a new manifest can carry the transfer forward.
- [ ] 7b.3 Delete the partial plaintext when a recipient transfer is abandoned.
- [ ] 7b.4 Direct-only fallback path (no relay) — verify the same integrity invariants.

## 7c. Remote flag channel (final approval, Phase 2)

- [x] 7c.1 **Migration `071_app_flags.sql`.** Three levers per key: `killed` (emergency
      off, outranks everything), `rollout_pct` (the canary dial), `min_build` (version
      floor). An absent row means "no opinion" and the client keeps its compiled
      constant, so an empty table behaves exactly like today.
- [x] 7c.2 **`GET /config/flags`** in Go (`internal/routes/config.go`), registered in
      `cmd/api/main.go`, with a Node twin (`routes/config.js` + the dependency-free
      `lib/flagResolve.js`) because Node is the rollback target and a rollback must not
      take the kill switch offline. Unauthenticated by design: it is fetched at boot, and
      `lib/api.ts` bounces a user to onboarding on a failed token refresh — a flag lookup
      must never be able to log somebody out. Identity is the `X-Device-Id` header the
      client already sends on every request.
- [x] 7c.3 **Bucketing is server-side** — `sha256(key || ':' || deviceId) mod 100`. Client
      bucketing cannot be hotfixed: if it is wrong, the only devices that could correct it
      are the ones running the bad code. Cross-language parity is pinned by
      `vaultchat-backend/__vectors__/flag-buckets.json` and `TestBucketParityWithNode`;
      drift there re-shuffles every cohort on a rollback, so regenerating the fixture is a
      decision, not a fix.
- [x] 7c.4 **`lib/remoteFlags.ts`** — TTL + independent staleness cap. The TTL says "you
      may serve this without asking"; the cap says "stop believing it at all", which is
      what stops an offline device from honouring a stale `true` forever after the flag
      was killed.
- [x] 7c.5 **Per-transfer snapshot** (`lib/vaultBeamFlags.ts`). A dynamic flag can move
      between a transfer's start and its resume, and the v1/v2 segment-plan grids are not
      interchangeable. The sender freezes the decision into its `PersistedSend` record;
      the RECIPIENT does not get a vote at all — the plan the sender published decides,
      because a seamless receiver facing a v1 plan finds no addressable blocks. That
      refusal now fails loudly instead of parking without a reason.

      **Runbook.** Kill: `UPDATE app_flags SET killed = TRUE WHERE key = 'VB_SEAMLESS_RESUME';`
      — takes effect within one client TTL (≤15 min) or immediately on the next transfer
      start, and stops NEW transfers only; an in-flight transfer finishes on its own terms
      rather than abandoning a half-written file. Dial: set `min_build` FIRST (so no v2
      plan reaches a build that cannot read it), then raise `rollout_pct` 1 → 10 → 25 →
      50 → 100. Lowering it removes devices in the reverse order they were added.

## 7d. Backpressure, cancellation, memory watchdog (final approval, Phase 3)

- [x] 7d.1 **Reader-side backpressure.** SCTP is reliable and ordered, so it never asks a
      sender to slow down for the RECEIVER's benefit — only for the network's. The P2P
      receiver reassembled 512 KiB buffers into an unbounded promise array and held each
      until its write completed: ~100 MiB at 200 outstanding, with nothing stopping it at
      200. Two layers now: cooperative (`{t:'x'}` pause/resume, hysteresis at half the
      budget, bounded so a lost resume frame is not a hang) and unilateral (past the
      budget the receiver allocates nothing and discards the chunk, which is re-fetched).
      The second layer is the one that matters — a memory bound that depends on the peer
      cooperating is not a bound. The queue is a `Set` a settled write removes itself
      from, so its size is the live backlog rather than a tally of the whole run.
- [x] 7d.2 **A peer-declared length is not an allocation primitive.** `new Uint8Array(c.len)`
      from the sender's integer handed the other end an allocator. Clamped to
      `CHUNK_BYTES + 16`; anything else fails the run.
- [x] 7d.3 **Cancellation.** Native block ops and socket loops cannot be interrupted from
      JS — they own their own lifetime and resolve seconds later. What is guaranteed
      instead: a cancelled run credits NOTHING. The P2P receiver stops accepting, then
      waits for writes already touching the file rather than abandoning them behind a
      caller that believes everything stopped; LAN and relay drop late results; the
      manager refuses any report into a non-active session; and `commitDurable` refuses
      to promote a barrier that lands after a cancel.
- [x] 7d.4 **Memory watchdog** (`lib/vaultBeam/memory.ts`). Every transport used to size
      itself independently and nobody added the numbers up. Workers now derive from the
      budget, not the core count: `clamp(1, floor(budget / (2 × unit)), cores − 1)`. The
      factor of two is not padding — a worker holds the buffer it is writing and the one
      it is filling next, and sizing for one is how a "safe" limit turns out to be half of
      what gets allocated. Storage speed is deliberately NOT an input: nothing reports it,
      and inferring it from write latency measures congestion as much as the medium.
      The audit asserts ≤32 MiB across 7 core counts × 3 block sizes, so raising the
      4 MiB cap fails a test rather than a device.

## 7e. Android 15 + the transition matrix (final approval, Phase 4)

- [x] 7e.1 **User-initiated data transfer job.** Transfers rode the shared Notifee
      foreground service, type `dataSync`, which Android 15 caps at six hours per 24 h
      ACROSS THE WHOLE APP — a budget already shared with the no-GMS socket connection,
      so a 12 GB transfer on a slow link could be cut off well short of six hours.
      `VaultBeamTransferJobService` (Kotlin) + `VaultBeamJobModule` + `lib/vaultBeamJob.ts`
      schedule a user-initiated data transfer job instead, which is outside that cap.
      `setNotification()` is mandatory for such a job — the system stops one that does
      not call it — so while the job runs it OWNS the progress notification and the
      Notifee one is suppressed rather than duplicated. Below API 34, or when the system
      refuses the schedule, the dataSync path is used exactly as before; a transient
      refusal (app not visible enough) is retried, only an unsupported platform latches.
- [x] 7e.2 **Transition matrix, automated as far as it honestly can be**
      (`lib/vaultBeam/matrix.selftest.ts`, 92 checks). §8.2 called all 14 rows
      device-only because NAT traversal and LAN sockets are — but that is true of the
      RADIO, not of the state machine, and every bug found in this work so far lived in
      the state machine. Rows 4, 6, 12 and 14 now run in full; rows 1, 2, 3, 5, 8, 10, 11
      and 13 run at the state-machine level against the real session, manager and driver
      contract. Each asserts all three invariants, including byte-exactness of the
      reassembled file and a chronological ledger proving no already-DELIVERED chunk is
      ever handed to another transport.
- [ ] 7e.3 **Still device-only** (§8.2 remains the merge gate): row 7 (background →
      foreground per tier), row 9 (cold boot), and the radio/OEM half of every partial
      row — ICE restart, the 24 h relay expiry window, real peak heap over a real 12 GB
      transfer, physical-unit adaptation on a real link, and a real old ⇄ new build pair.

## 8. Flag flip + verification

- [x] 8.1 `constants/flags.ts` — add `VB_SEAMLESS_RESUME` (default off), export it in the
      default object.
- [ ] 8.2 **Transport-switching matrix — merge blocker.** Cannot be CI-tested (NAT traversal
      and LAN sockets are inherently on-device). Every row asserts the same three invariants
      unless stated otherwise: **(a)** progress never decreases, **(b)** no chunk in
      `PeerHave` is transferred again, **(c)** the final file's SHA-256 equals the source's.

      | # | Scenario | Additional assertion |
      |---|---|---|
      | 1 | Wi-Fi → Mobile mid-transfer | ICE restart keeps the datachannel, or falls to relay with the bitmap intact |
      | 2 | Mobile → Wi-Fi mid-transfer | cheaper driver is re-promoted; work-list is the remainder |
      | 3 | LAN → Relay | only the missing tail is uploaded |
      | 4 | Relay → P2P | chunks already on R2 are *not* re-sent over P2P |
      | 5 | P2P at 90 % → kill Wi-Fi | relay uploads only the tail; bar holds at 90 % |
      | 6 | P2P at 100 % → drop the final ack | **zero** bytes re-uploaded; both devices reach Delivered/Saved |
      | 7 | App background → foreground, each tier | FGS keeps it alive; no progress loss |
      | 8 | App force close mid-transfer, each tier | resumes from bitmap on relaunch |
      | 9 | Device reboot mid-transfer | same as 8, across a cold boot |
      | 10 | Receiver offline for hours, then accepts | sender's staged blocks still valid; `recv_mask` merge correct; within the 24 h expiry |
      | 11 | 12 GB file, end to end | peak JS heap < 64 MB; bitmap stays 3 KB; no OOM |
      | 12 | Multiple simultaneous transfers | manager concurrency respected; no cross-session bitmap or listener bleed |
      | 13 | Weak network + packet loss | per-chunk retry isolates failures; session does not fail; physical unit adapts down |
      | 14 | Old build ⇄ new build | clean version reject, never a corrupt decrypt |

      Note for row 12: manual transfers are **not** queued today (only auto-download is,
      at concurrency 1), so simultaneous transfers are already reachable in production and
      must be covered — the `TransferManager` is what makes their admission explicit.
- [ ] 8.2a Instrument rows 1–6 with `perf.mark('vaultbeam_switch', …)` so the switch
      count, direction, and bytes-saved are measurable in the field, not just in the lab.
- [ ] 8.3 `docs_latest/vaultbeam-transfer-architecture-analysis.md` — update the fallback
      and state-machine sections once the flag is on by default.
- [ ] 8.4 Flip `VB_SEAMLESS_RESUME` on; keep it as the rollback switch for one release.

---

## File-by-file change list (deliverable 8)

### New
| File | Purpose |
|---|---|
| `lib/vaultBeam/bitmap.ts` | `ChunkBitmap` + RLE codec |
| `lib/vaultBeam/session.ts` | `TransferSession` — the state machine owner |
| `lib/vaultBeam/manager.ts` | `TransferManager` — sessions, queue, retry, recovery, transport switching, driver registry |
| `lib/vaultBeam/blockMap.ts` | block ↔ canonical-chunk-run mapping |
| `lib/vaultBeam/drivers/types.ts` | `TransportDriver` (incl. `unitChunks()`) + contract test |
| `lib/vaultBeam/drivers/{lan,p2p,relay}.ts` | transport drivers |
| `vaultchat-backend/migrations/070_vaultbeam_recv_mask.sql` | `recv_mask BYTEA` |

### Modified
| File | Change |
|---|---|
| `lib/vaultBeamController.ts` | **delete the line-354 reset**; delegate tiering to the session; progress from verified bytes; drop `meterTick`'s decrease branch |
| `lib/vaultBeamTransfer.ts` | becomes the relay driver's byte engine; delete `haveBytes`; work-list in, `onVerified` out |
| `lib/vaultBeamDirect.ts` | keep negotiation/ICE/sealing; remove progress bookkeeping and tier decisions; chunk-list-aware wire |
| `lib/vaultBeamSegments.ts` | `chunkBytes` fixed at 512 KiB; segments vary `blockBytes` only |
| `lib/networkState.ts` | `BUCKETS` → block-size-only |
| `lib/vaultBeamStreamNative.ts` | optional `runs` on `lanServe`/`lanConnect` |
| `lib/localDb.ts` | `vb_chunk_state` table + helpers |
| `lib/vaultbeamRelay.ts` | `relayReceived()` client call; `recvMask` on `RelayState` |
| `components/VaultBeamBubble.tsx` | verified-bytes headline; staged-to-relay secondary |
| `constants/flags.ts` | `VB_SEAMLESS_RESUME` |
| `plugins/android/VaultBeamStreamModule.kt` | canonical chunk id; `runs` + batched framing in `lanServe`/`lanConnect` |
| `services/vaultbeam/rust/src/chunk.rs` | canonical chunk id in `plan_block` |
| `services/vaultbeam/rust/src/lan.rs` | `runs` in `ServeOpts`/`ConnectOpts`; batched framing |
| `services/vaultbeam/rust/src/ffi.rs` | parse `runs` |
| `services/crypto/__vectors__/vaultbeam.json` | + canonical-relay-id vectors (additive) |
| `services/crypto/vaultbeam-vectors.selftest.ts` | generate/verify the new set |
| `services/crypto/vaultbeam-parity.selftest.ts` | assert parity on canonical ids |
| `vaultchat-backend-go/internal/routes/vaultbeam.go` | `/relay/received`; `recvMask` in state |
| `vaultchat-backend/routes/vaultbeam.js` | same (rollback parity) |
| `vaultchat-backend-go/internal/realtime/handlers.go` | relay `vaultbeam_have` |
| `vaultchat-backend/server.js` | relay `vaultbeam_have` |
| `vaultchat-backend/contract/endpoints.json` | register `/relay/received` |
| `app/_layout.tsx` | adopt sessions on launch |

### Deleted
| File | Reason |
|---|---|
| `lib/vaultBeamRecvBitmap.ts` | superseded by `PeerHave` in op-sqlite (with a one-release AsyncStorage migration) |
| `lib/vaultBeamQueue.ts` | absorbed by `TransferManager` (one scheduler, not two) |
