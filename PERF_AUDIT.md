# VaultChat — Performance & Architecture Audit

_Principal-architect review of the actual codebase (RN 0.81 / Expo 54 + Go 1.26 + Rust + Kotlin). Every finding below is anchored to real files and lines. Savings figures are engineering estimates with stated rationale, not measurements._

---

## 0. Ground truth (correcting the brief's assumptions)

Before recommendations, the real shape of the system, because three premises in the audit request are wrong on the ground:

| Assumption in brief | Reality in code | Evidence |
|---|---|---|
| Multiple live backends | **One** live backend: the Go API. Node is an un-routed legacy twin; `server/` is a stray Expo skeleton. | `caddy/Caddyfile:22` routes all → `go-api:4000`; `docker-compose.yml:105,148` Node `api` is `profiles:["legacy"]` |
| Uses Supabase | **Not used at all** — `@supabase/supabase-js` is a declared dependency with zero imports. | grep: 0 `createClient` usages |
| React-native-firebase (native) | Every `@react-native-firebase/*` import is **rewritten to the pure-JS Firebase Web SDK** and runs on the JS thread. It is also a **redundant, mostly-dead messaging path** — the live transport is Go + Socket.IO + Postgres. | `metro.config.js:8-15`; `shims/firebase-firestore.js`; live path `lib/chatService.ts:615` |
| LiveKit / SFU for calls | **Pure P2P WebRTC mesh, no SFU.** | `app/group-call-active.tsx:1-8` "REAL mesh group call (no SFU)" |

**What is genuinely well-built already** (so we don't "fix" it): New Architecture (Fabric + TurboModules) and Hermes are on (`app.json:10-11`); the root layout defers almost everything correctly (`app/_layout.tsx` — async security scan, lazy `import()`, non-blocking fonts); **VaultBeam** large-file transfer is native/Rust, streaming, chunked, resumable, 4-way parallel (`services/vaultbeam/rust/*`, `plugins/android/VaultBeamStreamModule.kt`); the sync engine is a real forward-delta, not a full re-download (`lib/syncEngine.ts:44-82`); Postgres has sensible keyset pagination + hot-path indexes (`vaultchat-backend/migrations/002_chats.sql:72`).

---

## 1. Current architecture weaknesses (ranked)

1. **Realtime backend cannot horizontally scale — hard single-node ceiling.** `internal/realtime/server.go:8` states plainly: "No Redis adapter, no Kafka … fan-out is in-process." Presence (`Hub.userSockets`), game rooms, and call rosters live in process memory (`server.go:60-67`); `hasLiveSocket`/`callRoster` assume every one of a user's sockets is on this process (`server.go:207-211`, `handlers.go:317`). **You cannot run a second Go instance** — two users on different nodes can't see each other's presence, share a call room, or receive each other's fan-out. Ceiling ≈ one process's WS capacity (tens of thousands).

2. **The whole client runs Firebase on the JS thread for a path that's mostly dead.** `metro.config.js:8-15` aliases the native Firebase SDK to the JS Web SDK. That JS SDK (v12) is compiled into the bundle, initialized at import (`shims/firebase-app.js`), and pulled by ~30 legacy files — while the actual messaging transport is Go/Socket.IO/Postgres. You pay bundle + JS-thread + a second realtime-DB billing surface for redundancy.

3. **Cryptography is 100% pure-JS on the Hermes thread by default; the Rust port is dead.** `services/crypto/index.ts:68` defaults the backend to `ts`; `EXPO_PUBLIC_CRYPTO_BACKEND=rust` is never set anywhere. The fully-implemented, vector-tested Rust crypto-core (`services/crypto/rust/src/*.rs`) is Android-only (no `crypto-core-ios`), silently skipped if `cargo-ndk` is absent (`plugins/withCryptoCore.js:45-53`), and gated off. So X25519/Ed25519/HKDF/AES-GCM, the hand-rolled Double Ratchet, scrypt, and PBKDF2 all execute in JS (`services/crypto/e2ee.ts`, `services/security/vaultKeys.ts:24`, `lib/vaultCrypto.ts:18`).

4. **Chat-media encryption loads whole files into the JS heap as base64 → OOM.** `lib/mediaAttachments.ts:24-28`: `readAsStringAsync({encoding:'base64'})` + whole-file GCM + `.toString('base64')` write — transiently ~**4× file size** in JS heap. The encrypted download branches (`:53-57`, `:104-108`) and every multipart part (`lib/resumableUpload.ts:142-143`) do the same. VaultBeam solved this natively; chat media never got the same treatment.

5. **`app/chat.tsx` is a 4,373-line component**, and the chat-list re-renders the entire visible list on every inbound socket event: `app/(tabs)/chats.tsx:176-178` → `fetchList()` replaces all chat objects with new identities (`:84-85`), defeating the `ChatRow` memo (`:603`) and re-triggering `syncAllHistory` (`:89`) each time.

6. **React Compiler is installed but disabled** — `package.json:62` has `babel-plugin-react-compiler`, but `app.json:14` sets `reactCompiler:false` and `babel.config.js` omits the plugin. The team hand-writes memo comparators (`chat.tsx:4356`, `chats.tsx:599`) that the compiler would generate automatically.

7. **Local SQLite is barely tuned and has full-scan hot queries.** op-sqlite opened with WAL only — no `synchronous`, `busy_timeout`, `mmap_size`, `cache_size` (`lib/localDb.ts:61,73`); a single connection with a hand-rolled promise lock serializes all txns (`:35,44-52`). `getLastMessagePerChat` (`:192-208`) and `getAttachmentChatMap` (`:242-254`) full-scan the unbounded `messages` table on chat-list render; search is JS `.includes()` over ≤5000 JS-decrypted rows (`:214-236`) — no FTS. The message cache has **no eviction**.

8. **Postgres `messages` is one unpartitioned heap; per-message fan-out is synchronous.** No partitioning anywhere (grep-confirmed); `FanOutToChat` runs members-query + blocks-query + `vc_bump_unread` SPROC + push-query per message (`internal/realtime/delivery.go:62,79`); presence flips run a `DISTINCT` self-join per event (`presence.go:96-103`); hot paths spawn unbounded goroutines (`presence.go:38,60`, `chats_helpers.go:427,434`).

9. **Group calls are a mobile-killing mesh.** Each participant holds N-1 `RTCPeerConnection`s and uploads N-1 encoded streams (`app/group-call-active.tsx`). Above ~5-6 participants this dies on phone CPU/uplink regardless of backend.

10. **`d2deService` "E2EE" is not end-to-end encrypted.** The key is derived deterministically from the two sorted UIDs + a static salt (`services/d2deService.ts:19-30`: `vaultchat-v1-${a}-${b}`, salt `vaultchat-aes-gcm-salt-2026`) — anyone who knows two user IDs derives the key. It advertises "Double Ratchet / X3DH" (`:82-90`). **Security defect, not just performance.**

11. **Dependency/stack duplication inflating bundle & TTI:** dual SQLite (op-sqlite live + expo-sqlite unused for messaging, `lib/localDb.ts:13` vs `db/*.ts`), dual crypto (`@noble/*` + `react-native-quick-crypto`), dead TensorFlow.js models (`@tensorflow-models/*` still in deps; `services/faceRecognitionService.ts` unused per `DEPLOY_CHECKLIST.md:192`), eager `ethers` v6 (`constants/vaultID.ts:5`), Firebase JS SDK, unused Supabase.

---

## 2. High-priority improvements (Critical/High)

- **H1 — Unblock horizontal scaling.** Enable the Socket.IO **Redis adapter** in Go (`zishang520/socket.io-go-redis`, already a compatible wire format) and move presence/call-roster/games out of process memory into Redis. The Node twin already had `@socket.io/redis-adapter` + Kafka wired (`docker-compose.yml:166` `REDIS_ADAPTER:"1"`); that was abandoned in the cutover. This is the single change that lets you run >1 Go replica. _Files: `internal/realtime/server.go`, `main.go:78-87`, `internal/redisx/`._

- **H2 — Move per-message fan-out and unread counting off the request path.** Cache chat membership in Redis; push fan-out + `vc_bump_unread` + push-send to an async worker (Kafka/BullMQ path the Node stack already had). Cap goroutines with a worker pool. _Files: `internal/realtime/delivery.go:62-159`, `presence.go:96`, `chats_helpers.go:427,434`._

- **H3 — Stream chat-media crypto natively; kill the base64 whole-file path.** The native module already exposes `readCipherChunk`/`writeCipherChunk` (used by VaultBeam). Route `uploadEncryptedAttachment`/`getDecryptedAttachmentUri`/`resumableUpload.putPart` through those instead of `readAsStringAsync({base64})`. Eliminates the ~4× heap blow-up and the OOM ceiling on encrypted media. _Files: `lib/mediaAttachments.ts:21-108`, `lib/mediaCrypto.ts`, `lib/resumableUpload.ts:142`._

- **H4 — Enable React Compiler.** Set `app.json` `experiments.reactCompiler:true` and add the babel preset option. Removes most manual-memo burden and cuts re-renders app-wide, especially `chat.tsx`/`chats.tsx`. _Files: `app.json:14`, `babel.config.js`._

- **H5 — Fix the chat-list re-render/network storm.** In `chats.tsx`, apply socket deltas to the single changed row (stable identity for untouched chats) instead of `fetchList()` replacing the whole array; decouple `syncAllHistory` from every `new_message`. _Files: `app/(tabs)/chats.tsx:84-89,176-178,603`._

- **H6 — Turn on the Rust crypto backend the right way.** Add the missing **iOS** binding (`crypto-core-ios`, mirroring `vaultbeam-core-ios`), make prebuild fail loudly if `cargo-ndk` is missing, replace the hex+JSON FFI marshaling with a compact binary boundary (`services/crypto/native/CryptoCore.ts:63,83`), then flip the default to `rust`. Biggest wins: scrypt/PBKDF2 unlock, per-message ratchet, X25519/Ed25519. _Files: `services/crypto/index.ts:68`, `plugins/withCryptoCore.js`, `services/crypto/native/CryptoCore.ts`._

- **H7 — Offload UI-blocking KDFs now (even before Rust).** `scrypt` (N=2^14) runs synchronously on unlock (`services/security/vaultKeys.ts:24-31`, twice on setup) and PBKDF2-100k on first Vault op (`lib/vaultCrypto.ts:18-25`) — both block first paint / unlock. At minimum move to a worklet/worker; ideally native.

- **H8 — Fix the `d2deService` fake-E2EE defect.** Replace deterministic-from-UIDs key derivation with the real X3DH/Double-Ratchet session already implemented in `services/crypto/e2eeSession.ts`, or remove the feature. _Security-critical._

- **H9 — Partition `messages` + bound the sweeps.** Range-partition by `created_at` (or hash by `chat_id`); add `LIMIT`+loop to the unbounded `DELETE FROM messages/stories` sweeps (`internal/jobs/jobs.go:75,194`); add PgBouncer (compose TODO never done). _Prevents the billion-row heap wall._

---

## 3. Medium-priority improvements

- **M1 — Delete redundant stacks:** remove `vaultchat-backend/` (Node twin) and `server/` (keep a rollback tag); rip out the Firebase shims + all `services/*.ts` Firestore calls + `firestore.rules/indexes.json`; drop unused `@supabase/supabase-js` and `expo-sqlite` (for messaging). Removes a whole second realtime-DB billing/attack surface and shrinks the bundle.
- **M2 — Tune op-sqlite:** add `PRAGMA synchronous=NORMAL` (safe under WAL), `busy_timeout=5000`, `mmap_size=268435456`, `cache_size`, `temp_store=MEMORY` (`lib/localDb.ts` after `:73`). Batch inserts as multi-row instead of per-message `runAsync` (`:138-165`).
- **M3 — Encrypted FTS for search:** replace the 5000-row JS `.includes()` (`localDb.ts:214-236`) with an FTS5 index over a **client-side-tokenized, blind-indexed** column (trigram/HMAC-token scheme) so at-rest encryption and search coexist. At minimum, add an eviction/cap policy to the unbounded `messages` cache.
- **M4 — Split `app/chat.tsx`** (4,373 lines) into memoized subcomponents; move the per-row IIFE (`chat.tsx:2181-2184`) and inline prop closures out of `renderItem` (`:2151-2190`).
- **M5 — Switch chat media to `expo-image`** (currently RN built-in `Image`, `chat.tsx:46`) for disk cache + downsampling; stop embedding base64 thumbnails in message meta (`lib/thumbnails.ts:45-47`).
- **M6 — Add an SFU (LiveKit/mediasoup)** for group calls >5-6 and enforce the mesh cap server-side.
- **M7 — Index the mutation-delta query** (`GREATEST(edited_at,deleted_at)` sort in `vaultchat-backend/routes/chats.js:98`) and raise/paginate the 20k-message global-cursor catch-up cap (`lib/syncEngine.ts:51`) so busy accounts don't silently miss history.
- **M8 — `db.WithUser` round-trips:** the txn-per-RLS-read pattern (`internal/db/db.go:27-44`) triples round-trips; batch reads within one txn or cache RLS context.
- **M9 — Add integrity hashing + compression for chat media** (VaultBeam hashes; chat media doesn't). Optional zstd for compressible attachments before encryption.

---

## 4. Low-priority improvements

- **L1 — Memory leaks:** clear the countdown interval on unmount (`app/emergency-sos.tsx:170`), clear typing timers on unmount (`app/(tabs)/chats.tsx:167-169`), gate the module-level `setInterval` flushers on connectivity/foreground (`lib/mediaOutbox.ts:183`, `lib/messageQueue.ts:326`).
- **L2 — Zero key material** after use in the JS crypto paths (none is wiped today — grep for `.fill(0)`/`zeroize` = 0 hits in crypto files); note the hex-string `serializeState` (`e2ee.ts:266`) makes deterministic wiping impossible, another reason to move state handling to Rust (which already pulls `zeroize`).
- **L3 — Lazy-load `ethers`, TF.js, QR** and other route-only heavy libs behind dynamic `import()`; remove dead `services/faceRecognitionService.ts` + TF model deps.
- **L4 — Serialize with Protocol Buffers / MessagePack** instead of JSON for the E2EE wire + ratchet state (`e2eeSession.ts:258`, `e2ee.ts:266-293`) to cut per-message CPU and size.
- **L5 — mediaCacheGC boot cost:** the serial `getInfoAsync` per file (`lib/mediaCacheGC.ts:26-28`) is O(files) on boot — batch or defer.
- **L6 — Tighten Firestore rules** if the path lingers (`firestore.rules:31-38` lets any authed user read any chat's messages) — but M1 (deletion) supersedes this.

---

## 5. Rust migration plan

Rust is the right home for **CPU-bound, memory-sensitive, per-message or per-byte** work that today blocks the Hermes thread. The infrastructure (Nitro JSI HybridObject, `cargo-ndk` prebuild plugin) already exists — it's proven by VaultBeam.

**Phase R1 — Activate what already exists (Android) + build the iOS binding.**
- Add `plugins/crypto-core-ios` mirroring `plugins/vaultbeam-core-ios`; wire `withCryptoCore.js` for iOS. Without this, Rust crypto can never help iPhone users.
- Replace hex+JSON FFI marshaling with a binary ABI (`CryptoCore.ts:63,83`) so tiny per-message payloads don't pay JS-side string cost.
- Flip `services/crypto/index.ts:68` default to `rust`; keep `ts` as fallback.

**Phase R2 — Move the hot per-message path.** X3DH + Double Ratchet encrypt/decrypt (`e2ee.ts:206-263`), group sender-key sign/verify (`senderKey.ts:121-176`), ratchet-state (de)serialization. The Rust port (`rust/src/e2ee.rs`, `sender_key.rs`) is already vector-proven.

**Phase R3 — Move the KDFs.** scrypt (`vaultKeys.ts`) and PBKDF2 (`vaultCrypto.ts`) into Rust (or at least a worker). These are the biggest single UI-blocking ops.

**Phase R4 — Give chat media the VaultBeam treatment.** Streaming chunked AES-GCM over file offsets via the existing native primitives, replacing `mediaCrypto.ts` whole-file base64.

**Phase R5 — Shamir** (`shamir.ts` → `rust/src/shamir.rs`) — low frequency, low priority, but free once the boundary exists.

| Rust candidate | From | Perf gain | Battery | Memory | CPU | Why Rust |
|---|---|---|---|---|---|---|
| Double Ratchet per-msg | JS `@noble` | 5-15× per op | High (multiplied on scroll — every visible bubble decrypts) | Frees hex-string churn | Large | Native curve/AEAD; no GC; deterministic zeroize |
| X25519/Ed25519 (X3DH, group sign) | JS | 10-30× | High on bootstrap bursts | — | Large | dalek is far faster than JS scalar-mult |
| scrypt / PBKDF2 unlock | JS sync | 3-8× + unblocks UI | Medium | Memory-hard done off-heap | Large | Native, off the JS thread |
| Chat-media streaming AEAD | JS whole-file base64 | Removes OOM ceiling | High on large files | ~4× → ~0 JS heap | Large | Offset streaming, zero JS bytes |
| Ratchet-state serialize | JS hex+JSON per msg | 3-10× | Medium | Removes per-msg string alloc | Medium | Binary, zeroizable |

---

## 6. Go migration plan

Go already owns the backend correctly — the plan is **scale-out**, not relocation. Go stays the home for all I/O-bound, fan-out, connection-heavy server work (WebSocket hub, presence, push gateway, media metadata, signalling, jobs) — this is exactly what Go's goroutine+channel model is best at, and rewriting it in Rust would trade throughput ergonomics for nothing.

**Phase G1 — Redis adapter + externalize state** (H1): Socket.IO Redis adapter; presence/roster/games → Redis. Unlocks N replicas.
**Phase G2 — Async fan-out** (H2): membership cache in Redis; fan-out/unread/push to a worker pool or Kafka (the disabled `EVENT_BUS`). Bound goroutines.
**Phase G3 — Data tier** (H9): partition `messages`, add PgBouncer, `LIMIT` the sweeps, add read replicas for history/search.
**Phase G4 — Edge**: HTTP/3+QUIC at Caddy (already the proxy) for lossy-mobile head-of-line-blocking wins on REST; keep WS for realtime.
**Phase G5 — Media**: MinIO/S3 is already wired (`internal/storage`, `minio-go`); add CDN + presigned direct-to-storage so media bytes never transit the API (chat media already uses presigned PUT — extend consistently).
**Phase G6 — Decommission** the Node twin and Firestore path (M1).

**Keep in Go, never move to Rust or RN:** the realtime hub, REST API, presence, push gateway, signalling relay, periodic jobs, rate limiting, storage service. **Keep out of Go:** anything needing the user's plaintext or private keys (that must stay client-side — Go only ever sees E2EE blobs, and should keep it that way).

---

## 7. React Native optimization plan (what stays in RN, and why)

**Stays in RN — never move to Rust/Go:** all UI, navigation, gesture/animation, screen state, list virtualization, and orchestration (`app/*`, `components/*`, most of `lib/*` glue). These are latency-to-touch and iteration-speed sensitive; RN + Hermes + New Arch is the right tool and moving them native buys nothing but friction.

Concrete RN work, in order:
1. **Enable React Compiler** (H4) — highest ROI, one config change.
2. **Kill the chat-list re-render storm** (H5).
3. **Decompose `app/chat.tsx`** (M4); hoist inline `renderItem` closures/IIFE.
4. **`expo-image` for chat media** (M5); stop base64 thumbnails in meta.
5. **Lazy-load heavy libs** (L3) — ethers/TF/QR behind `import()`.
6. **Fix leaks** (L1).
7. Keep the good bits: FlatList tuning in `chat.tsx:2213-2216`, native-driver `Animated` (`chat.tsx:1589-1600`), memoized `ThemeProvider` — leave them.

---

## 8. Performance roadmap (sequenced)

- **Sprint 1 (config + safety, days):** H4 React Compiler, H5 list storm, H8 d2de security fix, L1 leaks, M2 SQLite pragmas. Low risk, immediate feel.
- **Sprint 2 (scale unblock, 2-3 wks):** H1 Redis adapter, H2 async fan-out, H9 partition + PgBouncer. Backend-only, no app release.
- **Sprint 3 (memory ceiling, 2-3 wks):** H3 streaming chat-media crypto, H7 KDF offload. Removes OOM + unlock jank.
- **Sprint 4 (native crypto, 3-5 wks):** H6 Rust crypto incl. iOS binding + binary FFI (R1-R2).
- **Sprint 5 (cleanup + reach, ongoing):** M1 delete redundant stacks, M3 encrypted FTS, M6 SFU, G4 HTTP/3, L3-L5.

---

## 9-14. Estimated savings (per-change, with rationale — estimates, not measurements)

| # | Metric | Estimate | Driven by | Rationale |
|---|---|---|---|---|
| 9 | **CPU** | **-30-55%** on the messaging hot path | H6 Rust crypto, H4 compiler, H5 storm, H3 media | JS `@noble` ratchet+curves are 5-30× native; every visible bubble decrypts on scroll today; compiler cuts wasted re-renders; list storm re-runs whole-list diff per socket event |
| 10 | **RAM** | **-25-40%** typical; **OOM eliminated** on large encrypted media | H3 (4×→~0 JS heap), M1 (drop firebase-JS/TF/supabase/dual-SQLite), H4 (fewer retained render trees) | Chat-media path holds ~4× file size in JS heap; redundant stacks are resident |
| 11 | **Battery** | **-15-30%** in active-messaging/scroll and transfer sessions | H6, H3, H2 (fewer client retries via reliable fan-out), L1 (no orphan intervals) | Native crypto + no whole-file base64 churn + fewer wakeups |
| 12 | **Startup / TTI** | **-20-35%** cold start | M1 bundle removal, L3 lazy-load, H4 | firebase-JS v12 + TF models + ethers eagerly in the main Hermes bundle inflate parse/TTI; startup effect work is already well-deferred so the win is bundle-side |
| 13 | **App size** | **-8-20 MB** install | M1 (firebase-JS, supabase, one SQLite, TF models), L3 | Multiple redundant heavyweight stacks resident today |
| 14 | **Network** | **-20-40%** message/media bytes + far fewer redundant round-trips | L4 protobuf/msgpack wire, M9 compression, H2 (no double Firestore writes), G5 CDN/direct-storage | JSON+base64 E2EE wire is fat; Firestore path double-writes; media currently uncompressed |

Backend capacity is the categorical one: **H1 changes the ceiling from ~1 node (tens of thousands of concurrent sockets) to horizontal (millions)** — not a percentage, a class change.

---

## 15. Risk analysis

- **H1 Redis adapter:** medium risk — wire-format compatibility is proven (Node used the same), but cross-node call-roster/presence semantics need careful testing. Mitigate with a canary node behind the same Redis before flipping replica count.
- **H3/H6 native crypto & media:** medium-high — crypto changes are correctness-critical. Mitigate with the existing parity self-tests (`services/crypto/*.selftest.ts`, `parity.selftest.ts`) as a gate; ship behind the existing backend flag; keep TS fallback.
- **H8 d2de fix:** this is a **security** fix, not perf — but it may change ciphertext format; migrate or version the field.
- **M1 deletions:** low functional risk if the Firestore path is truly orphaned (verify no `services/*` still depends on it at runtime before deleting); keep a rollback tag.
- **H9 partitioning:** medium — online partitioning of a live `messages` table needs a backfill/dual-write window.
- **M6 SFU:** additive, low risk to existing 1:1 calls; new infra to operate.
- **Doing nothing:** the single-node realtime ceiling and the chat-media OOM are the two that will produce user-visible failures first (dropped presence/calls beyond one node; crashes on large encrypted media).

---

## 16. Implementation priority

| Priority | Items |
|---|---|
| **Critical** | H1 (scale ceiling), H8 (fake E2EE — security), H3 (media OOM) |
| **High** | H2, H4, H5, H6, H7, H9 |
| **Medium** | M1-M9 |
| **Low** | L1-L6 |

---

## Feature → Layer decision table

| Feature | Current Layer | Recommended Layer | Reason | Expected Perf Gain | Difficulty | Priority |
|---|---|---|---|---|---|---|
| Realtime hub / fan-out / presence | Go (in-process state) | **Go + Redis adapter** | In-memory state caps at 1 node (`server.go:8`); Redis externalizes it | Class change: 1→N nodes | High | Critical |
| Message fan-out + unread + push | Go (sync per-msg, `delivery.go:62`) | **Go async worker/Kafka** | Removes multi-query-per-message from request path | -30-50% DB load at scale | High | High |
| Double Ratchet encrypt/decrypt | JS `@noble` (`e2ee.ts`) | **Rust** (port exists) | Runs per visible bubble on scroll; native 5-15× | -30-55% msg-path CPU | Med (iOS binding needed) | High |
| X25519 / Ed25519 / HKDF | JS (`e2ee.ts`, `senderKey.ts`) | **Rust** (dalek) | JS scalar-mult is the classic native gap | 10-30× per op | Med | High |
| scrypt / PBKDF2 unlock | JS sync (`vaultKeys.ts`, `vaultCrypto.ts`) | **Rust / worker** | Blocks first paint / unlock | 3-8× + unblocks UI | Med | High |
| Chat-media encryption | JS whole-file base64 (`mediaAttachments.ts:24`) | **Rust/native streaming** (VaultBeam primitives) | ~4× JS heap → OOM | Removes OOM ceiling | Med | Critical |
| VaultBeam large-file transfer | Rust + Kotlin (streaming) | **Keep** | Already exemplary | — | — | Keep |
| Message serialization (wire + ratchet state) | JS JSON + hex (`e2ee.ts:266`) | **Rust + protobuf/msgpack** | Per-msg string churn, unzeroizable | -20-40% wire, less CPU | Med | Medium |
| Local DB (op-sqlite) | WAL only, single conn (`localDb.ts`) | **op-sqlite tuned** (pragmas, batch, FTS5) | No mmap/busy_timeout; full-scan queries; JS search | -50-80% on list/search | Low-Med | Medium |
| `messages` table | One unpartitioned heap | **Postgres partitioned + PgBouncer** | Billion-row heap wall, unbounded sweeps | Sustains 10M+ users | High | High |
| Search | JS `.includes()` ≤5000 rows (`localDb.ts:214`) | **SQLite FTS5 + blind index** | O(all local) JS-decrypt on UI thread; lossy | -10-100× search | Med | Medium |
| Chat list rendering | Full re-render per event (`chats.tsx:176`) | **RN — delta update + React Compiler** | Whole-list churn + refetch per socket msg | -60-90% list re-renders | Low | High |
| Chat screen (4,373-line file) | RN monolith | **RN decomposed + compiler** | Re-render + bundle hazard | -20-40% re-renders | Med | Medium |
| Image rendering | RN built-in `Image` (`chat.tsx:46`) | **RN `expo-image`** | No disk cache / downsampling | -RAM in media threads | Low | Medium |
| UI / nav / gestures / animation | RN | **Keep RN** | Latency-to-touch; New Arch is right tool | — | — | Keep |
| Group calls | P2P mesh (`group-call-active.tsx`) | **SFU (LiveKit/mediasoup)** | N-1 uplinks die on mobile >5-6 | Enables large calls | High | Medium |
| Signalling / TURN | Go relay + coturn | **Keep** (add HTTP/3 at edge) | Correct already | — | — | Keep |
| d2de "E2EE" | Deterministic JS key (`d2deService.ts:19`) | **Real X3DH session** (exists) | Key derivable from UIDs — not E2EE | Security fix | Med | Critical |
| Node backend + `server/` | Legacy twin (un-routed) | **Delete** (keep tag) | 100% duplicated | -maintenance/bundle | Low | Medium |
| Firebase / Firestore path | JS SDK via shim (`metro.config.js:8`) | **Delete** | Redundant 2nd realtime DB; JS-thread | -bundle, -billing | Med | Medium |
| Supabase / expo-sqlite (msg) | Unused deps | **Delete** | Zero imports / not the msg store | -bundle | Low | Low |
| TF.js face models / ethers | Eager, mostly dead | **Lazy or delete** | Dead weight in main bundle | -app size, -TTI | Low | Low |

---

_Scope note: figures are architect estimates grounded in the cited code paths; validate each with the existing crypto parity self-tests and a device profiler (Hermes sampling profiler + Perfetto/Systrace) before/after each change._
