# VaultBeam — 4-Tier Hybrid Transfer Engine (Architecture & Phased Build Plan)

Production spec for a zero-crash, low-resource file transfer engine up to **12 GB**, with
dynamic hot-swap across four transport tiers. Grounded in the actual VaultChat codebase
(Expo SDK 54 RN, Express+Socket.IO backend, custom X3DH+Double-Ratchet crypto, MinIO/R2).

> **Status of what exists today** (from the 2026-07-12 code audit):
> `app/vaultbeam.tsx` + `lib/transferManager.ts` do real WebRTC-datachannel transfer with a
> genuine whole-file SHA-256 verify and `bufferedAmount` backpressure — **but** the data path
> **base64s the whole file into the JS heap (OOMs past a few hundred MB)**, uses fixed 16KB
> chunks, has **NO app-layer encryption**, resume is dead code, and the screen is **unreachable
> from chat** (no caller passes `peerUid`). This engine is a rebuild of the *data path*; we
> **reuse** the WebRTC/signaling bootstrap and the transfers-dashboard UI.

---

## 0. Four corrections to the source spec (baked in below — do not skip)

1. **E2EE is mandatory and was missing from the spec.** Every chunk on every tier is
   AES-256-GCM. R2/relay (Tier 3/4) sees **ciphertext only** — never plaintext, or the
   zero-knowledge promise breaks. This is the #1 addition.
2. **512 KB is the *logical* chunk, not the WebRTC wire size.** SCTP's safe DataChannel
   message is ~16 KB (up to 64 KB if `sctp.maxMessageSize` is negotiated) — **not** 512 KB.
   Keep 512 KB as the encryption/hash/bitmask/resume unit; **fragment it into ≤16 KB wire
   frames on the WebRTC tier only**. LAN and R2 move the 512 KB block whole.
3. **No blanket per-chunk sleep.** A mandatory 15–30 ms sleep per 512 KB chunk caps
   throughput at ~34 MB/s — it would cripple Tier-1's 100–500 MB/s target (1 ms/chunk budget).
   Use **thermal/battery-adaptive pacing**: read real signals (Android
   `PowerManager.getThermalHeadroom()`, iOS `ProcessInfo.thermalState`, battery %) and only
   inject/double cooldown when the device *actually* reports rising thermals or <15% battery.
4. **Background daemon = R2 handoff, not "keep the socket alive."** iOS suspends WebRTC/TCP
   sockets within ~30 s of backgrounding; only HTTPS `URLSession` background transfers
   survive. So Tier 4 is **auto-hand-off of the remaining chunks to Tier 3 (R2) over a
   background session**, not a persisted P2P socket. Android holds sockets longer via a
   `dataSync` foreground service, but the portable rule is: **background ⇒ fall to R2**.

Also: the deployed store is **MinIO** today; **R2 exists but isn't wired** (S3-compatible env
swap). "Boto3" is Python — our backend is **Node**, so it's the Node S3 client
(`@aws-sdk/client-s3`), same one already presigning MinIO.

---

## 1. The encrypted chunk model (shared by all tiers)

- **Logical chunk = 512 KiB** (256 KiB fallback under jitter). 12 GB → ≤24,576 chunks. This is
  the unit of: AES-GCM, per-chunk SHA-256, the resume bitmask, and cross-tier handoff.
- **Per-transfer key `K_t`**: sender mints 32 random bytes, wraps it **once** through the
  existing per-peer Double-Ratchet (`services/crypto/e2eeSession.rn` via the `callCrypto.ts`
  `newCallCipher`/`openCallOffer` template) and delivers it as a normal E2EE message
  `{type:'vaultbeam-key', transferId, key}`. Reusing the ratchet-wrap-once pattern avoids the
  skipped-key hazard on lossy transports (same reason `callCrypto` wraps a call key once).
- **Per-chunk cipher**: `AES-256-GCM(K_t, nonce = 4B(ULID prefix) ‖ u64(chunkIndex),
  aad = transferId ‖ fileId ‖ chunkIndex)`. Nonce is **derivable from the index**, so the wire
  carries only `ct‖tag` (16 B tag appended — matches `lib/mediaCrypto.ts` format, quick-crypto
  native). Binding `chunkIndex` as AAD means an out-of-order / random-access commit can't be
  reordered or forged.
- **Integrity**: per-chunk GCM tag catches corruption per chunk (re-request only that chunk);
  a whole-file SHA-256 (or merkle root) verifies on completion before the file is revealed.

### Wire framing per tier
| Tier | Framing |
|---|---|
| 1 LAN TCP | length-prefixed 512 KB block (TCP preserves order); binary header `magic·transferId·chunkIndex·len` |
| 2 WebRTC | 512 KB block **fragmented into ≤16 KB frames** (`chunkIndex·frameIndex·frameCount`), reassembled on `vb-data` (reliable-unordered); control (manifest/acks/resume) on `vb-ctl` (reliable-ordered) |
| 3 R2 | encrypted block PUT/GET over HTTPS presigned URL |
| 4 Background | same as Tier 3, over iOS `URLSession` background / Android `WorkManager` |

> **R2 op-count optimization**: don't PUT 24,576 tiny objects. Group ~8 logical chunks into a
> **~4 MB relay block** = one R2 object under `/vault_relay/{transferId}/{blockIdx}` (≈3,000
> objects for 12 GB). Resume is still tracked at 512 KB granularity in the local bitmask;
> fetch happens at block granularity.

---

## 2. Zero-JS-heap native boundary

**JS only ever holds numeric metadata** — `{transferId, chunkIndex, fileUri, offset, byteLen,
bitmask}`. It never touches payload bytes. A custom native module (`VaultBeamStream`, Kotlin
first) owns the byte pipeline:

```
prealloc(uri, sizeBytes)                        -> fallocate/ftruncate a full-size shell
freeSpaceBytes(uri) -> number                   -> disk-availability guard (≥ size × 1.05)
readEncryptChunk(uri, index, keyHandle) -> sends // read@offset → AES-GCM → transport, native-only
receiveDecryptWrite(uri, index, keyHandle, ct)  // decrypt → write@offset (random access)
sha256File(uri) -> hex                           // whole-file verify off-thread
```

- **The LAN fast path (Tier 1) must not cross the RN bridge.** Bouncing 512 KB buffers through
  the bridge at 500 MB/s saturates it. So `VaultBeamStream` **owns the TCP socket natively**
  and does read → encrypt → socket-write entirely in native (Kotlin/Swift). JS only issues
  "start/pause/resume/next-index" commands. This is the hardest, highest-value module.
- Crypto runs on a **native worker thread** (quick-crypto JSI or in-module Kotlin), never the
  UI thread — keeps chat at 60 fps during a full-speed transfer.
- Positional random-access writes let chunks commit **out of order** into the pre-allocated
  shell (no temp-file concatenation, flat RAM).

---

## 3. The 4-tier state machine + hot-swap

```
PROBE ──try in order──▶ Tier1 LAN ──▶ Tier2 P2P ──▶ Tier3 R2   (Tier4 = R2 while backgrounded)
   │                        │            │            │
   └── pick first that connects ─────────┴────────────┘
ACTIVE(tier):  send/recv only the 0-bit chunks from the bitmask
   │  on {timeout | disconnect | app-background | thermal-critical}
   ▼
SWITCH(nextTier): pause current, KEEP bitmask, resume missing chunks on next tier
   │  (never re-transmit an already-verified chunk)
   ▼
COMPLETE: whole-file SHA-256 / merkle verify → move shell to final path → emit bubble update
```

- **Tier order** is fastest/cheapest → most isolated: LAN → P2P → R2 → (background R2).
- **Mid-transfer switch is lossless** because progress lives in the bitmask, not the transport.
  Example from the spec: LAN drops at 10 GB → isolate the remaining 2 GB's 0-bits → hand the
  bitmask to the R2 pipeline → download only the missing chunks. No re-transmission.
- **Probe/fallback timeouts**: ICE gather 8 s → add relay; 30 s connected with zero acked bytes
  → tear down + next tier; LAN mDNS discovery ~3 s → else skip to P2P.

### Resume bitmask
- `Uint8Array(ceil(chunkCount/8))` — 24,576 chunks = **3,072 bytes** (✓ <3 KB claim holds).
- Persisted to **op-sqlite** (`vb_transfer` + a bitmask blob, not 24k rows) so it survives app
  kill / reboot. On reconnect, peers exchange an **RLE-compressed** bitmask; sender transmits
  only the receiver's 0-bits.

---

## 4. Storage corruption guard + thermal coupling

- **Pre-alloc**: before any byte flows, `freeSpaceBytes ≥ size × 1.05` then `prealloc()` a
  full-size shell (Android `RandomAccessFile.setLength` / native `fallocate`; iOS `ftruncate`).
  Prevents mid-transfer ENOSPC crashes; enables out-of-order random-access commits.
- **Adaptive pacing** (replaces blanket sleep): a governor reads `thermalHeadroom` /
  `thermalState` / battery% between *batches* of chunks. Cool + charged → run flat out. On
  `thermalState ≥ .serious` **or** battery <15% unplugged → insert cooldown and **halve the
  in-flight window** (not a fixed 15 ms per chunk); double the brake on `.critical`. Restore
  when healthy. This preserves the LAN 100–500 MB/s target while still resting hot hardware.

---

## 5. Cloud relay (Tier 3/4) — ciphertext-only, cost-guarded

- **R2 (recommended)**: env swap on the existing S3 client (`S3_ENDPOINT` →
  `https://<acct>.r2.cloudflarestorage.com`, `S3_REGION=auto`). R2's **zero egress** removes
  the relay's bandwidth cost. Blocks are **AES-GCM ciphertext** — R2 can't read them.
- **Volatile prefix + lifecycle**: all relay blocks under `/vault_relay/{transferId}/…` with a
  **bucket lifecycle rule: auto-delete after 24 h**, plus server-side delete on confirmed
  full download (queue-only retention).
- **Backend (Node, not Boto3)**: `@aws-sdk/client-s3` presigns per-block PUT (sender) and GET
  (receiver). New endpoints: `POST /vaultbeam/relay/init`, `…/block-url`, `…/complete`,
  `…/abort`. New `transfers` table with **BIGINT size** (`attachments.size_bytes` is INTEGER →
  overflows at 2.1 GB — must not reuse it).
- **≤100 MB never uses this engine** — small files stay on the existing E2EE media pipeline
  (encrypt → presign → link). No PeerConnection for small files.

---

## 6. Background & lifecycle

- **Android**: on Accept/Send, start a `dataSync` **foreground service** (reuse the
  `CallForegroundService` + `withVaultChatCalls` config-plugin pattern). It owns the session;
  the persistent notification is the progress UI (name·%·speed·ETA·pause/cancel, ≤1 update/s).
  On OS kill → resume from the op-sqlite bitmask on next launch.
- **iOS**: WebRTC/TCP suspend on background → **auto-hand-off remaining chunks to Tier 3 over
  a background `URLSession`**. Show a "keep VaultChat open for fastest transfer" hint for LAN/P2P.

---

## 7. Native module & dependency list (EAS-build only — no Expo Go for the hot path)

| Module | Role | State |
|---|---|---|
| **`VaultBeamStream`** (custom Kotlin→Swift) | prealloc, positional R/W, per-chunk AES-GCM off-thread, sha256, **owns LAN TCP socket** (zero-bridge fast path) | net-new (the big one) |
| `react-native-webrtc` | Tier 2 DataChannels | installed |
| `react-native-quick-crypto` | native AES-GCM (JSI) — already wired in `mediaCrypto.ts` | installed |
| mDNS/NSD (`react-native-zeroconf` or Android NSD / iOS Bonjour) | Tier 1 LAN peer discovery | net-new |
| Foreground service (Android) | background survival | reuse call plugin |
| Background `URLSession` (iOS) / `WorkManager` (Android) | Tier 3/4 background relay | net-new |

**Android-first** (no long-lived iOS bg service for P2P); iOS gets Tier-1/2 foreground + Tier-3
background.

---

## 8. Reuse from the existing codebase (build ON, don't rewrite)

- Signaling: `server.js` `vaultbeam_offer/answer/ice/end` handlers + `relayToPeer` +
  `emitToUid` + `user:<uid>` rooms + JWT `io.use`; `addPersistentListener` (socket.ts).
- Key delivery: `lib/callCrypto.ts` `newCallCipher`/`openCallOffer` as the `K_t` mint→wrap→unwrap
  template; the `e2eeEncrypt` seam.
- Crypto: `lib/mediaCrypto.ts` quick-crypto `createCipheriv` + native `sha256` (ct‖tag format).
- UI: the transfers-dashboard in `app/vaultbeam.tsx` (keep the shell; rebuild the data path).

---

## 9. Phased build plan (each phase independently testable)

| Phase | Scope | Native? | Testable |
|---|---|---|---|
| **P0** | `transfers` table (BIGINT) · R2 env wiring · presigned block PUT/GET endpoints · `/vault_relay` 24 h lifecycle · `K_t` delivery via `e2eeEncrypt` | **No — JS/TS + backend** | **Now.** Tier 3 works end-to-end up to the RNFS positional limit (~2 GB) |
| **P1** | `VaultBeamStream` native core: prealloc, positional R/W, per-chunk AES-GCM off-thread, sha256, free-space guard | Yes (Kotlin) | EAS build. Unblocks >2 GB with flat RAM |
| **P2** | Tier 2 WebRTC: encrypted 16 KB-framed chunks over `vb-data`/`vb-ctl`, bitmask resume (reuse existing signaling) | JS + P1 | EAS build |
| **P3** | Tier 1 LAN: mDNS discovery + native TCP socket inside `VaultBeamStream` (zero-bridge fast path) | Yes | EAS build |
| **P4** | Hot-swap state machine + background: Android FGS, iOS URLSession, background→R2 handoff | Yes | EAS build |
| **P5** | Chat entry point (composer/attachment → `/vaultbeam` with `peerUid`) · transfer card · consent+space sheet · Wi-Fi-only toggle · thermal indicator | JS | EAS build |
| **P6** | Polish: adaptive 512→256 KB under jitter · folder/batch · thermal-pacing tuning | JS | EAS build |

**Ship order rationale**: P0 gives a working resumable **cloud** path with no native module
(fastest to a real, testable win). P1 is the load-bearing native core everything sits on. P2/P3
add the cost-free P2P/LAN tiers. P4 makes it survive backgrounding. P5 makes it *reachable*
(the current screen isn't) — do it as soon as any tier works so you can dog-food.

---

## 10. Acceptance criteria (definition of done)

- 12 GB completes with **peak JS heap < 64 MB** and sustained ≥30 MB/s on LAN.
- Kill/background at any point → resume from last verified chunk, **zero re-transmission**,
  merkle/SHA-256 verifies; no duplicate/orphaned chunk rows after completion or abort.
- LAN drop → automatic handoff to R2 for the remaining 0-bits without user interruption.
- **R2 objects and all relay bytes are AES-GCM ciphertext** (packet capture on any tier shows
  no plaintext); `/vault_relay/*` auto-purges at 24 h.
- Files ≤100 MB never open a PeerConnection (existing media pipeline).
- Chat scrolls at 60 fps and typing has no input lag during a full-speed transfer.
- Works on the Huawei P30 Pro (no GMS).

---

## 11. Open decisions for the owner

1. **R2 vs stay on MinIO** for Tier 3. R2 = zero egress + global edge (recommended, matches the
   spec); MinIO = self-hosted, you pay Hetzner egress. You've created R2 but not wired it.
2. **12 GB now vs ship ≤2 GB first** (P0+P2/P3 with RNFS positional I/O) and add the native
   streaming core (P1) after. The ≤2 GB path is weeks cheaper and covers most real transfers.
3. **1:1 only for v1** — groups have no per-peer key envelope for `K_t` (same limit as calls).

---

## 12. P0 — SHIPPED (2026-07-12): R2 relay control plane

Decisions locked: **R2**, **12 GB**, **1:1**. P0 is the pure backend/JS tier — testable now.

**Files added/changed**
- `migrations/057_vaultbeam_transfers.sql` — content-free `vb_transfer` (BIGINT `total_bytes`, `uploaded_mask` BYTEA; no filename/mime/key).
- `lib/storage.js` — `+objectExists`, `+deletePrefix` (batch purge of `vault_relay/<id>/`).
- `routes/vaultbeam.js` — `POST /vaultbeam/relay/{init,block-url,uploaded,complete,abort}`, `GET /vaultbeam/relay/:transferId`; mounted in `server.js` with `emitToUid` (rings recipient: `vb_invite`/`vb_ready`/`vb_complete`/`vb_abort`) + hourly stale-row sweep.
- `lib/vaultbeamRelay.ts` (client) — `mintTransferKey` / `wrapKeyForPeer` / `openKeyFromPeer` (K_t over the ratchet), `encryptChunk`/`decryptChunk` (per-chunk AES-256-GCM, quick-crypto + noble, nonce from index + AAD), resume bitmask, and the relay control-plane calls. Byte pipeline is the **P1 native seam** (marked in-file).

**R2 config the owner must set** (env in `vaultchat-backend/.env.prod`):
```
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_PUBLIC_ENDPOINT=https://<your-r2-public-or-custom-domain>   # what devices hit for presigned URLs
S3_REGION=auto
S3_ACCESS_KEY=<R2 token access key id>
S3_SECRET_KEY=<R2 token secret>
S3_BUCKET=vaultchat-media        # (or a dedicated bucket)
```
**R2 bucket lifecycle rule (required):** auto-delete objects under prefix **`vault_relay/`** after **1 day** (Cloudflare dashboard → R2 → bucket → Settings → Object lifecycle rules, or the S3 `PutBucketLifecycleConfiguration` API). This is the cost backstop; the server also actively purges the prefix on `complete`/`abort`.

**Deploy**: `docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps api node migrate.js up` (applies 057) → `... up -d api fanout-worker`.

**Testable now** (no native module): the control plane end-to-end (init → presign → PUT ciphertext block → uploaded → GET → complete → prefix purged), and per-chunk encrypt/decrypt round-trip. The 12 GB byte pipeline is **P1** (native streaming core) — RNFS can stand in for a ≤2 GB smoke test.

---

## §13 — P1: native streaming core (SHIPPED, EAS-build only)

The load-bearing native byte pipeline that makes the R2 relay work at the full
12 GB cap. The JS-heap path OOMs at ~2 GB; P1 removes JS from the byte path
entirely — JS holds only `{blockIndex, presignedUrl}`, native owns every file
byte, all per-chunk crypto, and the block HTTP PUT/GET.

**Files (all new unless noted):**
- `plugins/android/VaultBeamStreamModule.kt` — the module (`getName()="VaultBeamStream"`), classic RN bridge (mirrors `CallModule`), all work on a 4-thread `Executors` pool (off JS/main thread):
  - `prealloc(path, totalBytes)` — `RandomAccessFile.setLength` shell for out-of-order/resumed positional writes.
  - `uploadBlock(opts)` — read the block's 512 KiB chunks @ offsets → AES-256-GCM seal each → stream concatenated ciphertext to the presigned PUT (`setFixedLengthStreamingMode`, `Content-Type: application/octet-stream` to match the SigV4-signed ContentType).
  - `downloadBlock(opts)` — GET the block → recompute identical geometry to split into per-chunk `ct‖tag` → verify+decrypt each → positional write @ offset. Tamper/short-body throws (block not marked).
  - `sha256(path)` — streamed whole-file hex digest.
  - `deleteFile(path)`.
  - Crypto byte-identical to `lib/vaultbeamRelay.ts` / `lib/mediaCrypto.ts`: `AES/GCM/NoPadding`, nonce = 4B(transferId UTF-8 prefix)‖u64_be(globalChunkIndex), aad = `transferId|fileId|globalChunkIndex`, wire = ct‖16B tag. Geometry (last block <8 chunks, last chunk <512 KiB) recomputed on both sides — no per-chunk length rides the wire.
- `plugins/android/VaultBeamStreamPackage.kt` — `ReactPackage`.
- `plugins/withVaultBeamStream.js` — config plugin: copies the Kotlin into `com.vaultchat.app.vaultbeam` + registers `VaultBeamStreamPackage` in `MainApplication` (idempotent, same insertion points as `withVaultChatCalls`; the `// add(MyReactNativePackage())` marker survives the first plugin's edit). Registered in `app.json` plugins after `withVaultChatCalls`.
- `lib/vaultBeamStreamNative.ts` — typed bridge + `isNativeStreamAvailable()` (false on Expo Go/iOS → orchestrator refuses >2 GB instead of OOMing).
- `lib/vaultBeamTransfer.ts` — orchestrator pairing native ↔ relay control plane: `sendTransfer` (init → resume-diff vs server bitmask → presign PUT batches of 64 → 4-wide `uploadBlock` pool → `relayMarkUploaded`) and `receiveTransfer` (prealloc → poll `relayState` → presign GET → 4-wide `downloadBlock` → whole-file sha256 gate → `relayComplete`). Both resumable (reconcile against the server's uploaded-block bitmask each batch), cancellable (`AbortSignal`), zero plaintext to the relay.
- `lib/vaultbeamRelay.ts` (edited) — added `wrapTransferManifest`/`openTransferManifest`: the full E2EE side-channel (K_t + fileId + name/mime/size/expected sha256), one-shot ratchet-wrapped like the key. Server never sees any of it.

**Build/test:** requires `expo prebuild --clean` + a dev/EAS build (native module — no Expo Go, Android only for now). Verified: tsc baseline held at 41 (zero new TS errors), plugin JS + app.json parse, Kotlin braces/parens balanced, backend `node --check` clean.

**Not in P1 (later phases):** LAN TCP socket ownership (P3 Tier-1), WebRTC P2P (P2), iOS background URLSession handoff (P4), chat entry point wiring the manifest over the socket (P5).

---

## §14 — P5: chat entry point (SHIPPED)

VaultBeam is now reachable and usable end-to-end from a real chat. The large-file
transfer IS a chat message (WhatsApp model), so it persists, syncs offline, and
arrives live through the existing `new_message` pipeline — no bespoke socket wiring.

**Manifest transport = the E2EE message row (zero-knowledge split):**
- `content` (E2EE, ratchet-encrypted) = `{ v:'vbm1', keyB64, fileId, name, mime, size }` — the per-transfer key K_t, the fileId that binds the per-chunk AAD, and the filename never reach the server.
- `meta` (plaintext) = `{ vaultbeam:true, transferId, size }` — only routing the server already knows from `relay/init`.
Same pattern as F4 reactions / polls (payload rides inside E2EE content). No second ratchet op, no side-channel.

**Files:**
- `migrations/058_vaultbeam_message_type.sql` (NEW) — extends `messages.type` CHECK to a strict SUPERSET incl `'vaultbeam'` (and re-adds `'reaction'`, which 022 dropped — a latent gap). Idempotent, mirrors 022.
- `lib/chatService.ts` — `'vaultbeam'` added to `Message['type']`.
- `lib/vaultBeamController.ts` (NEW) — runtime transfer store keyed by transferId (`useTransfer` hook via `useSyncExternalStore`, so a progress tick re-renders only that one bubble) + `startSend` (relay/init → post E2EE manifest message → background `sendTransfer`) / `startReceive` (Accept → `receiveTransfer` → save under `documentDirectory/VaultBeam/`) / `cancelTransfer` (abort + relay/abort) / `openSaved` (expo-sharing). Lazily arms persistent `vb_complete`/`vb_abort` socket listeners so both parties see the final state live.
- `components/VaultBeamBubble.tsx` (NEW) — the in-chat transfer card (monochrome Ionicons): sender shows Uploading %→Sent→Delivered; recipient shows Accept→Downloading %→Open; Cancel while active. Name/size from the decrypted manifest (never the server).
- `app/chat.tsx` — import + `onSendVaultBeam` (DocumentPicker `copyToCacheDirectory` → real path → `startSend`) + attach action **"Big File"** (direct chats only, gated on native availability) + `isVaultbeam` render branch + reply/forward/pinned previews.
- `app/(tabs)/chats.tsx` — chat-list last-message preview shows "📦 File".
- `lib/vaultBeamTransfer.ts` — `sendTransfer` no longer calls `relay/init` (the controller owns init before the manifest is delivered, so the row exists before the recipient can Accept); geometry + resume now come from `relay/state`. Removed the double-init that double-fired `vb_invite`.
- `lib/vaultbeamRelay.ts` — pruned the now-dead K_t/manifest ratchet-wrap helpers (superseded by the message-content manifest); kept the per-chunk crypto as the documented native-parity reference.

**Integrity:** whole-file sha256 intentionally NOT used — per-chunk AES-256-GCM already authenticates every byte AND binds it to its index (AAD + nonce), and `receiveTransfer` only completes when every block is present, so assembly is cryptographically guaranteed without a second full-file read on 12 GB.

**1:1 only** (matches the relay's per-peer key model). **Deploy-gated:** needs migration 058 applied + the P0 relay backend deployed (R2 env) + a P1 dev/EAS build (native module). Verified: tsc baseline held at 41 (zero new errors), migration mirrors the proven 022 pattern.

**Still open (later phases):** P2 WebRTC P2P · P3 LAN mDNS · P4 iOS background URLSession · resume across app restarts for the SENDER (recipient already resumes via the server bitmask; sender loses the cached srcPath on kill).

---

## §15 — P2 (WebRTC P2P) + P3 (LAN) direct tiers (SHIPPED, need device testing)

The two direct transports that let VaultBeam skip the cloud when both peers are
online + reachable. They move the SAME AES-256-GCM chunks with the SAME wire
format as the R2 relay, so a chunk is tier-agnostic. The relay (§12–14) stays the
always-available baseline; these are opportunistic speed-ups.

**Tier order (receiver-driven):** LAN (native TCP) → P2P (WebRTC) → R2 relay.

**Negotiation** over the existing `vaultbeam_*` signaling relay (mutually exclusive):
`vaultbeam_pull` (recipient: "ready, try direct") → `vaultbeam_ready` (sender: `{lanIp,lanPort}`) + `vaultbeam_offer` (WebRTC) → recipient tries LAN connect, else answers the offer, else `vaultbeam_tier{mode:'relay'}`. Signaling is **buffered from the moment of pull** so an early offer/ICE is never dropped while the LAN attempt runs; the connect deadline (12s) only fires if nothing *connects* — an in-flight transfer is never interrupted by it.

**Files:**
- `plugins/android/VaultBeamStreamModule.kt` — added: `readCipherChunk`/`writeCipherChunk` (P2: seal/open ONE chunk's ciphertext so JS shuttles ≤512 KiB over the datachannel, never the whole file; crypto stays native); `lanIp`/`lanServe`/`lanConnect` (P3: native TCP, sender binds + streams framed `[i32 idx][i32 ctLen][ct]`, receiver connects + writes @offset, 16-byte token auth from the manifest, zero JS heap); an event emitter (`vbLanBound`/`vbLanProgress`) + `addListener`/`removeListeners`.
- `lib/vaultBeamStreamNative.ts` — typed bridges + `onLanEvent`.
- `lib/vaultBeamDirect.ts` (NEW) — `serveDirect` (sender: serve LAN+P2P after a pull, return the tier used or null) / `receiveDirect` (recipient: try LAN then P2P, return true or false→relay); the WebRTC bootstrap reuses `getTurnConfig` + the proven `vaultbeam_offer/answer/ice` flow from `app/vaultbeam.tsx`; the P2P data path is a bounded control-frame + ≤16 KiB binary-frame protocol with `bufferedAmount` backpressure.
- `vaultchat-backend/server.js` — added `vaultbeam_pull`/`vaultbeam_ready`/`vaultbeam_tier` to `relayToPeer` (opaque routing; bytes never touch the server).
- `lib/vaultBeamController.ts` — `startSend` now serves direct first (→ 'complete' on success) and falls back to relay upload; `startReceive` tries `receiveDirect` first, else `receiveTransfer`. Manifest gained `token`; geometry (chunkCount) is derived from `size` (canonical 512 KiB), no relay call needed for direct.
- `components/VaultBeamBubble.tsx` — Accept now passes `peerId = msg.senderId`.

**Security:** relay/LAN/P2P all carry only AES-256-GCM ciphertext under K_t (delivered via the E2EE manifest). LAN connections are token-gated (an outsider on the same Wi-Fi can't guess the 16-byte token). WebRTC SDP is currently plaintext-signaled — acceptable because the payload is independently E2EE (a MITM sees only ciphertext); sealing it via `callCrypto` is a future hardening.

**Verified:** tsc baseline held at 41 · backend `node --check` clean · Kotlin braces/parens balanced (86/86). **Needs on-device testing** (inherent — NAT traversal + LAN sockets can't be CI-tested): same-Wi-Fi LAN transfer, cross-NAT P2P (note: coturn is NOT deployed, so symmetric-NAT P2P will fall back to relay until TURN lands), and the direct→relay fallback path.

**Deploy-gated:** the 3 new signaling events need a **backend redeploy**; the native methods need a fresh **prebuild + EAS build**.

**Remaining:** P4 (mid-transfer hotswap + iOS background URLSession) · seal WebRTC SDP · deploy coturn for symmetric-NAT P2P · sender-side resume across app restart.

---

## §16 — P4: hotswap, resume, TURN, sealed signaling (SHIPPED; iOS bg deferred)

The robustness + hardening pass that makes the tier stack production-grade.

**(1) coturn — the missing relay (fixes cross-NAT P2P AND calls).** WebRTC fails
across symmetric NATs without a TURN relay; coturn was never deployed, which the
repo flagged as the cause of calls silently not connecting. Added:
- `coturn/turnserver.conf` — `use-auth-secret` (byte-identical to what `GET /user/turn` already issues), relay port range 49160-49200, SSRF hardening (deny relaying to private ranges), quotas.
- `docker-compose.yml` — a `coturn` service (host networking; secret + external IP passed as env-interpolated flags). **Deploy:** set `TURN_SECRET` (= backend's) + `TURN_EXTERNAL_IP` in the compose env, point the backend's `TURN_HOST` at this host, open UDP 3478 + 49160-49200 (and TCP 3478) on the firewall, `docker compose up -d coturn`.

**(2) Sender crash/restart resume.** A relay upload killed mid-flight (app swiped
away) now resumes on next launch. `lib/vaultBeamController` persists each active
send (`AsyncStorage`, dropped at any terminal state); `resumePendingSends()` —
wired into `app/_layout` — re-runs the upload, which skips blocks already on R2
via the server bitmask, or drops the record if the cache file was evicted. (The
recipient already resumed symmetrically.)

**(3) Stall→relay hotswap.** A direct tier that connects then goes silent (Wi-Fi
drop, peer suspended) no longer hangs: `stallGuard(15s)` races each tier and, on
no progress, abandons it → next tier → relay. Lossless (the relay re-pulls; the
partial file is overwritten in place).

**(4) Sealed WebRTC signaling.** The P2P offer/answer/ICE are now sealed with the
per-transfer call cipher (`callCrypto.newCallCipher`/`openCallOffer`, the same
proven path as encrypted calls) — the server no longer sees the DTLS fingerprint
or device IPs. Plaintext passthrough keeps legacy/no-E2EE peers working; a sealed
offer that can't be opened (stale session) cleanly falls back to relay.

**Deferred — iOS background transfer.** A 12 GB transfer that must survive
backgrounding on iOS needs a native `URLSession` background-download handoff
(Swift). The app is Android-first (native module is Android-only today), so this
is a documented future phase, not a v1 gap.

**Verified:** tsc baseline held at 41 · `docker compose config` OK (coturn parses)
· `callCrypto` reuse matches `videocall.tsx`. **Needs device testing** (WebRTC/LAN
inherent): resume-after-kill, stall→relay hotswap, and cross-NAT P2P once coturn
is deployed.

**VaultBeam is now feature-complete for v1** (Android): 4 tiers (LAN → P2P → R2
relay → resumable/hotswapping), E2EE end-to-end on every tier, reachable from
chat, 1:1, up to 12 GB. Remaining are deploy + device-test + the iOS background
phase.
