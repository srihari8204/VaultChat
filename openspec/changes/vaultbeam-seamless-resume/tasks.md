# Implementation plan (deliverable 7) + file-by-file change list (deliverable 8)

**Status: awaiting approval. No code written.**

Strangler order — every phase is independently shippable, behind `VB_SEAMLESS_RESUME`
(`constants/flags.ts`, default **off**). Phases 1–4 change no behaviour with the flag off;
phase 6 flips it. Rollback at any point is one constant.

---

## 1. Canonical chunk grid (the wire change — do this first, alone)

- [ ] 1.1 `services/crypto/vaultbeam-vectors.selftest.ts` — add a canonical-relay-id vector
      set (`id = plainOffset / chunkBytes`) alongside the existing offset-scheme vectors.
      Regenerate `services/crypto/__vectors__/vaultbeam.json` with `--write`; the diff is
      the review artifact. **Existing vectors must not change.**
- [ ] 1.2 `services/vaultbeam/rust/src/chunk.rs` — `plan_block`: in the offset scheme emit
      `id = plain_offset / chunk_bytes` (was `plain_offset`). Extend the unit tests
      (`block_plan_offset_scheme_uses_offset_ids` becomes the canonical-id case).
- [ ] 1.3 `plugins/android/VaultBeamStreamModule.kt` — same one-line change in `uploadBlock`
      and `downloadBlock` (`val id = if (offsetScheme) plainOffset / chunkBytes else …`).
      Both must change together or every GCM open fails.
- [ ] 1.4 iOS inherits via the Rust core — no Swift change; confirm through the parity run.
- [ ] 1.5 `services/crypto/vaultbeam-parity.selftest.ts` — assert Rust ≡ JS oracle ≡ vectors
      for the canonical ids. Must stay green in `npm run test:e2ee`.
- [ ] 1.6 `lib/vaultBeamSegments.ts` — `appendSegment` takes only `blockBytes`; `chunkBytes`
      is the module constant `CHUNK = 512 KiB`. Keep the invariant check
      (`blockBytes % chunkBytes === 0`) and the self-check; add "chunk size is uniform
      across every segment" to it.
- [ ] 1.7 `lib/networkState.ts` — `BUCKETS` becomes block-size-only
      (2/4/8/8 MiB); `geometry()` returns `{ blockBytes }`. Update the self-check
      (the `blockBytes % chunkBytes` assertion now uses the constant).

## 2. Bitmaps + session core (pure, unit-testable, no I/O)

- [ ] 2.1 `lib/vaultBeam/bitmap.ts` (new) — `ChunkBitmap`: `set/test/popcount/union/
      toBase64/fromBase64/toRLE/fromRLE/complement/firstUnset`, fixed width from
      `chunkCount`. Embedded self-check in the house style (`lib/vaultBeamSegments.ts`
      pattern): round-trip, union idempotence, RLE round-trip, out-of-range safety.
- [ ] 2.2 `lib/vaultBeam/session.ts` (new) — `TransferSession`: identity, grid, `PeerHave`,
      `R2Have`, in-memory `inflight`, `workList()`, `progressBytes()`, `isComplete()`,
      `mergePeerHave()`, `markVerified()`. Pure w.r.t. transport; no imports from any
      driver. Self-check covers §2 rules R1–R5 of `design.md`.
- [ ] 2.3 `lib/vaultBeam/registry.ts` (new) — `SessionRegistry`, single-flight by
      transferId, `adopt()` / `get()` / `dispose()`. Replaces the ad-hoc `controllers` map
      in `vaultBeamController.ts`.
- [ ] 2.4 `lib/vaultBeam/blockMap.ts` (new) — block ↔ canonical-chunk-run mapping, so
      `R2Have` (chunk granularity) derives from `uploaded_mask` (block granularity) ∧ plan,
      and a block is uploadable iff every chunk in its run is in the work-list.

## 3. Persistence + crash recovery

- [ ] 3.1 `lib/localDb.ts` — add the `vb_chunk_state` table (see `design.md` §6) to the
      schema block at line 118; add `persistChunkState` / `loadChunkState` /
      `deleteChunkState` / prune alongside the existing `vb_transfers` helpers.
- [ ] 3.2 `lib/vaultBeam/session.ts` — write-behind persistence: coalesce 1.5 s, flush
      immediately on tier switch, pause, terminal, and `AppState` background.
- [ ] 3.3 `lib/vaultBeamController.ts` — `resumePendingSends()` also rehydrates chunk state
      and adopts sessions into the registry; sender source validation gains the
      size + mtime check (`design.md` §4.5 deviation 2).
- [ ] 3.4 Delete `lib/vaultBeamRecvBitmap.ts` (superseded by `PeerHave` in op-sqlite) and
      migrate any existing `vc_vb_recv_*` AsyncStorage keys on first launch, then remove.
- [ ] 3.5 Migrate `vc_vaultbeam_sends` (AsyncStorage) into `vb_chunk_state.src_*` so all
      sender resume state lives in one store.

## 4. Backend: `recv_mask`

- [ ] 4.1 `vaultchat-backend/migrations/070_vaultbeam_recv_mask.sql` (new) —
      `ALTER TABLE vb_transfer ADD COLUMN IF NOT EXISTS recv_mask BYTEA;` Idempotent,
      content-free, mirrors the 060 header rationale.
- [ ] 4.2 `vaultchat-backend-go/internal/routes/vaultbeam.go` — `POST /vaultbeam/relay/received`
      (recipient-only, mask width validated against `chunk_count`, union-merge server-side
      so an out-of-order post cannot clear bits); add `recvMask` to `vbRelayState`; register
      in `RegisterVaultbeam`.
- [ ] 4.3 `vaultchat-backend/routes/vaultbeam.js` — the same endpoint and field, byte-for-byte
      equivalent. **Required**: Node is the documented rollback target; shipping only Go
      silently breaks rollback.
- [ ] 4.4 `vaultchat-backend/contract/endpoints.json` — register the new route so the
      contract runner covers it.
- [ ] 4.5 Confirm the union-merge semantics with a test that posts an older mask after a
      newer one and asserts no bit is lost.

## 5. Transport drivers (wrap existing code — do not rewrite the byte paths)

- [ ] 5.1 `lib/vaultBeam/drivers/types.ts` (new) — the `TransportDriver` interface from
      `design.md` §3, plus a shared contract test every driver must pass (no counters,
      `onVerified` only after durability, `dispose()` idempotent, abort honoured).
- [ ] 5.2 `lib/vaultBeam/drivers/relay.ts` (new) — wraps today's `sendTransfer` /
      `receiveTransfer` from `lib/vaultBeamTransfer.ts`, converting the work-list into block
      batches via `blockMap` and reporting `onVerified` per verified chunk. Delete the
      `haveBytes` prefix logic (`vaultBeamTransfer.ts:144-147, 192-206`).
- [ ] 5.3 `lib/vaultBeam/drivers/p2p.ts` (new) — wraps `p2pSend`/`p2pReceive` from
      `lib/vaultBeamDirect.ts`. Change the wire so the sender sends a **requested chunk
      list** rather than `0..chunkCount-1` (`vaultBeamDirect.ts:350`), and so the receiver's
      `{t:'p',n}` carries the chunk **id** rather than a running count.
- [ ] 5.4 `lib/vaultBeam/drivers/lan.ts` (new) — wraps `lanServe`/`lanConnect`. Native gains
      an optional `chunkIds` array so a resumed LAN attempt streams only the missing set:
      `VaultBeamStreamModule.kt` (`lanServe` loop), `services/vaultbeam/rust/src/lan.rs`
      (`ServeOpts`/`ConnectOpts`), `services/vaultbeam/rust/src/ffi.rs` (arg parsing),
      `lib/vaultBeamStreamNative.ts` (types). Absent ⇒ today's full-range behaviour.
- [ ] 5.5 `lib/vaultBeamDirect.ts` — keep negotiation/ICE/sealing; remove all progress
      bookkeeping and the `stallGuard`-owned tier decision (the session decides now).

## 6. Session-owned orchestration + the audits

- [ ] 6.1 `lib/vaultBeamController.ts` — replace the tier ladder in `startSend`/`startReceive`
      with `session.run()`. **Delete the reset at line 354.** The controller keeps only:
      manifest mint/parse, the UI store, and socket listener arming.
- [ ] 6.2 `lib/vaultBeam/session.ts` — driver selection, cooldown/demotion, re-promotion
      (relay→P2P), and the `ACTIVE` park-with-retry state from `design.md` §2 R5.
- [ ] 6.3 Signaling: add `vaultbeam_have` to `relayToPeer` in **both**
      `vaultchat-backend/server.js:1014-1016` and
      `vaultchat-backend-go/internal/realtime/handlers.go:257-259`; seal/open it with the
      existing `callCrypto` cipher in the P2P driver.
- [ ] 6.4 **Memory audit** — fix and add a regression test that runs 50 fallback cycles and
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
- [ ] 6.5 **Concurrency audit** — assert one upload worker, one download worker, one driver,
      one transport controller per transfer:
      - `SessionRegistry` single-flight replaces the `controllers.has()` guard.
      - `mapPool` (`vaultBeamTransfer.ts:57`) stays the only concurrency primitive; width
        from `batteryParallelism()`.
      - the auto-download queue (`vaultBeamQueue.ts`, concurrency 1) composes with the
        registry rather than duplicating it.
      - one `AbortController` per session, held by the session, borrowed by the driver.
- [ ] 6.6 Fix secondary finding F-2: finalize the `vb_transfer` row (`/relay/complete` or
      `/relay/abort`) on **any** terminal state, whichever transport won.

## 7. Progress semantics + UI

- [ ] 7.1 `lib/vaultBeamController.ts` — `setState` progress comes from
      `session.progressBytes()` (verified only). The `meterTick` reset-on-decrease branch
      (`vaultBeamController.ts:105`) becomes dead code — `PeerHave` is monotonic — and is
      removed.
- [ ] 7.2 `components/VaultBeamBubble.tsx` — headline % is delivery (verified) on both
      sides. Sender's "staged to relay" becomes a secondary line, since it is no longer the
      same number as delivery progress.
- [ ] 7.3 Confirm the FGS aggregate (`lib/transferForeground.ts`) reads the same verified
      bytes, so the notification cannot disagree with the bubble.

## 8. Flag flip + verification

- [ ] 8.1 `constants/flags.ts` — add `VB_SEAMLESS_RESUME` (default off), export it in the
      default object.
- [ ] 8.2 Device matrix (cannot be CI-tested — NAT traversal and LAN sockets are inherently
      on-device):
      - P2P at 90 % → kill Wi-Fi → assert relay uploads only the missing tail, bar never
        drops.
      - P2P at 100 % → drop the final ack → assert **zero** bytes re-uploaded and both
        devices reach Delivered/Saved.
      - relay at 50 % → peer comes online → assert P2P takes only `¬PeerHave ∧ ¬R2Have`.
      - kill the app mid-transfer on each tier → relaunch → assert resume from the bitmap.
      - old build ⇄ new build: assert a clean version reject, never a corrupt decrypt.
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
| `lib/vaultBeam/registry.ts` | single-flight `SessionRegistry` |
| `lib/vaultBeam/blockMap.ts` | block ↔ canonical-chunk-run mapping |
| `lib/vaultBeam/drivers/types.ts` | `TransportDriver` + contract test |
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
| `lib/vaultBeamStreamNative.ts` | optional `chunkIds` on `lanServe`/`lanConnect` |
| `lib/localDb.ts` | `vb_chunk_state` table + helpers |
| `lib/vaultbeamRelay.ts` | `relayReceived()` client call; `recvMask` on `RelayState` |
| `components/VaultBeamBubble.tsx` | verified-bytes headline; staged-to-relay secondary |
| `constants/flags.ts` | `VB_SEAMLESS_RESUME` |
| `plugins/android/VaultBeamStreamModule.kt` | canonical chunk id; `chunkIds` in `lanServe`/`lanConnect` |
| `services/vaultbeam/rust/src/chunk.rs` | canonical chunk id in `plan_block` |
| `services/vaultbeam/rust/src/lan.rs` | `chunkIds` in `ServeOpts`/`ConnectOpts` |
| `services/vaultbeam/rust/src/ffi.rs` | parse `chunkIds` |
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
