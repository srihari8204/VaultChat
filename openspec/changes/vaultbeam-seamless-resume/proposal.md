## Why

VaultBeam treats each transport as its own upload session. When a direct tier (LAN or
WebRTC P2P) fails, `lib/vaultBeamController.ts:354` explicitly resets the sender's
counters and re-uploads the **entire file** to the R2 relay:

```ts
setState(transferId, { status: 'uploading', tier: 'relay', done: 0, total: 0, bytes: 0, totalBytes: opts.size });
```

The worst case is not hypothetical. The sender's progress bar is driven by the receiver's
verified-chunk acks, so "100 %" means *the receiver has decrypted and written every
chunk*. If the single final `{t:'ack'}` is then lost — peer suspends, Wi-Fi drops in the
30 s ack window — the sender discards all of it and re-uploads 12 GB that the receiver
already has on disk. The receiver, meanwhile, has already reached `complete` and saved the
file. The two devices disagree completely, and the user watches a finished transfer
restart at 0 %.

Even in the ordinary mid-transfer case the sender re-uploads from offset 0 in ascending
order, so the receiver — which *does* resume, and only needs the tail — must wait for the
sender to grind through re-uploading the prefix it already has before the missing bytes
arrive.

Three structural gaps make a correct resume impossible today, not just unimplemented:

1. **Two incompatible chunk grids.** Direct tiers use a fixed 512 KiB chunk with
   `chunkId = global index`; the relay uses adaptive per-segment chunk sizes
   (256 KiB–8 MiB) with `chunkId = plaintext byte offset`. "Chunk 37 is done" has no
   cross-transport meaning, so no shared bitmap can exist.
2. **The receiver's verified state is device-local.** `vc_vb_recv_<id>` (AsyncStorage) is
   never published to the sender or the server. The sender has no way to learn what the
   receiver holds.
3. **`uploaded_mask` means "on R2", and is used as if it meant "delivered".** It is the
   only resume input the sender has, and a direct-tier delivery never touches it.

The receiver-side stopgap — `haveBytes`, a single scalar high-water mark — can only credit
a contiguous prefix, only on the receiver, and cannot express holes.

## What Changes

- **Separate logical chunk identity from the physical transfer unit.**
  - *Logical chunk* — 512 KiB, `chunkId = plaintextOffset / 512 KiB`. This is the unit of
    AES-256-GCM, acknowledgement, the resume bitmap, and cross-transport equivalence. It is
    identical on every transport and never varies.
  - *Physical unit* — an adaptive run of contiguous logical chunks, chosen per transport
    from measured throughput. The relay keeps its 2/4/8 MiB blocks (4/8/16 logical chunks
    per R2 object); **LAN and P2P gain the same freedom**, where the physical unit is
    currently pinned at 512 KiB and costs framing overhead on fast links. A future
    Bluetooth/Nearby transport can pick a small unit without touching identity.

  **BREAKING wire change on the relay tier only** — the direct tiers already use
  `id = index`, so their ciphertext is byte-unchanged.
- **A `TransferManager`** — one process-wide component owning session state, the transfer
  queue, retry, resume, progress, crash recovery, and transport switching. Transports
  register with it; none keeps independent state. Per-transfer state lives in the
  `TransferSession` it owns. This absorbs today's `vaultBeamQueue` and the ad-hoc
  `controllers` map so there is exactly one scheduler.
- **Two authoritative bitmaps** replace the scalar high-water mark: `PeerHave`
  (receiver-authoritative: GCM-verified + written + durable) and `R2Have`
  (server-authoritative: staged on R2). The sender's work-list becomes
  `¬PeerHave ∧ ¬R2Have` — chunks the receiver has verified are never uploaded again, on
  any transport.
- **`PeerHave` is published** two ways: live over a new sealed `vaultbeam_have` signaling
  event, and durably via a new `recv_mask BYTEA` column + `POST /vaultbeam/relay/received`,
  so it survives an offline sender, an app restart, and a device reboot.
- **Progress means verified bytes on both sides** — `popcount(PeerHave) × 512 KiB`. Because
  `PeerHave` is monotonic, a transport switch can no longer move the bar backwards.
- **A server-authoritative completion handshake.** The receiver reports a fully verified
  bitmap; the server records completion and the session becomes immutable **at that moment**,
  whether or not any notification reaches the sender. Every mutating endpoint then rejects
  the transfer, so a lost final acknowledgement can no longer cause a re-upload. This also
  closes a live gap: `/relay/uploaded` has no state check today, so a sender can set bits on
  an already-completed transfer.
- **Session versioning.** A monotonic, server-held `sessionVersion` rides every stateful
  message and mutating request; a mismatch is a `409 stale session` that makes the client
  rehydrate. A device resurrecting an old in-memory session after a crash can no longer
  poison its peer or the server.
- **Per-chunk retry with bounded backoff inside the driver.** A failed block removes itself
  from the in-flight set; it never fails the session. The session fails only on
  unrecoverable errors (auth, `410 gone`, out of disk).
- **Crash recovery from op-sqlite**, not AsyncStorage: session + both bitmaps in a new
  `vb_chunk_state` table, write-behind throttled and flushed on every tier switch.
- **Secondary fix:** a transfer completed over a direct tier never calls
  `/relay/complete`, so its `vb_transfer` row lingers until the 24 h sweep. The session
  will finalize the row on any terminal state, regardless of which transport won.

## Capabilities

### New Capabilities
- `vaultbeam-transfer-session`: the transport-independent session — canonical chunk grid,
  the `PeerHave`/`R2Have` bitmap pair and their sync protocol, work-list derivation,
  monotonic verified-bytes progress, driver interface, retry policy, and crash recovery.

### Modified Capabilities
<!-- No existing openspec/specs/* capability covers VaultBeam; today's behaviour is
     described in docs_latest/vaultbeam-transfer-architecture-analysis.md. -->

## Impact

- **Client**: new `lib/vaultBeam/session.ts` (owner) + `bitmap.ts` + `drivers/{lan,p2p,relay}.ts`;
  `vaultBeamController.ts` loses its tier orchestration and the reset at line 354;
  `vaultBeamTransfer.ts` and `vaultBeamDirect.ts` are refactored into drivers;
  `vaultBeamRecvBitmap.ts` is superseded; `vaultBeamSegments.ts` keeps segments but fixes
  `chunkBytes`; `networkState.ts` bucket table becomes block-size-only.
- **Native (all three backends must change identically)**: in the offset scheme,
  `id = plain_offset / chunk_bytes` instead of `id = plain_offset` —
  `plugins/android/VaultBeamStreamModule.kt`, `services/vaultbeam/rust/src/chunk.rs`
  (`plan_block`), inherited by the iOS Swift shim. Gated by the parity suite.
- **Backend (both Node and Go — Go is live, Node is the rollback)**: migration 070 adds
  `recv_mask BYTEA` + `session_version INT`; new `POST /vaultbeam/relay/received`;
  `GET /relay/:id` returns `recvMask` + `sessionVersion`; version + state guards on every
  mutating endpoint. Additive for old clients, which omit the version and are treated as
  version-1.
- **Wire/compat**: manifest `vbm2` → `vbm3`. `parseManifest` already hard-rejects unknown
  versions, so old↔new is a clean reject, never a corrupt decrypt. The vbm2 relay reader is
  retained for one release so a transfer started before the update still completes.
- **Golden vectors**: `services/crypto/__vectors__/vaultbeam.json` gains a canonical-relay-id
  set; existing vectors are unchanged (the frozen contract only grows).
- **Bandwidth**: a 12 GB transfer that dies at 90 % over P2P currently re-uploads 12 GB;
  after this change it uploads ~1.2 GB.
- **Not in scope**: iOS background `URLSession` handoff, group transfers, changing the
  12 GiB cap, replacing the manual-Accept flow.
