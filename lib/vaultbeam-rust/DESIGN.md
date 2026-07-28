# VaultBeam shared-Rust transport core — Phase 3 design note

Status: **IMPLEMENTED through Step 5 (host-verified); Step 3b native glue is
prebuild-verified.** Steps 0–2, 3a, the block ops, Step 4 (backend switch), and
Step 5 (host parity) are committed and green. The native binding (Kotlin/JNI +
iOS Swift + Expo plugin) is written to be verified at `expo prebuild` (no
NDK/Xcode in CI), exactly like Phase 1's binding.

Two decisions were REFINED at implementation (rationale in §4–§6 below,
reflected here):
- **Binding: a CLASSIC RN bridge module, not Nitro** (deviates from §6's
  original recommendation). The existing JS surface is classic
  (`NativeModules` + `NativeEventEmitter` + Promises), so a classic Rust-backed
  shim makes `vaultBeamStreamNative.ts` a TRUE drop-in and handles async + LAN
  events naturally. The Rust staticlib is still shared cross-platform; only the
  thin marshaling shim is per-platform.
- **Block HTTP: Design A′ (hybrid)**, not pure A. The interop-critical
  seal/open + block layout + file IO live in shared Rust (fully unit-tested, no
  TLS dep); the trivial presigned-URL HTTPS PUT/GET stays platform-native
  (Android `HttpURLConnection`, iOS `URLSession`) — avoids a Rust TLS stack in
  the mobile lib and gains native proxy/background handling. One 4 MiB block
  buffer crosses the FFI (base64), matching Kotlin `uploadBlock`'s memory profile.

## 0. The invariants this must NOT break (the whole point)

The Kotlin `VaultBeamStream` wire contract, now frozen as Step 0 vectors, is
the cross-version interop bar. Rust must reproduce, byte-for-byte:

- **nonce** = 4B `transferId` UTF-8 prefix (zero-padded to 4) ‖ `u64_be(chunkId)` (12B)
- **AAD** = `"<transferId>|<fileId>|<chunkId>"` (UTF-8)
- **wire** = `ciphertext ‖ 16B GCM tag`, AES-256-GCM, 128-bit tag, key = 32 raw bytes
- **chunkId** = plaintext byte offset (segmented/offset scheme, `blockPlainOffset`
  present) OR `blockIndex*chunksPerBlock + i` (uniform R2) == global chunk index (P2/LAN)
- **block wire** = concatenation of each chunk's `ct‖tag`; tail chunk length =
  `min(chunkBytes, totalBytes - plainOffset)`; no per-chunk length on the wire
- **LAN frame** = `[i32_be index][i32_be ctLen][ct‖tag]` per chunk; receiver first
  sends the raw token bytes, sends a 1-byte `0x01` delivery ack after the last write
- **geometry** recomputed on both sides from `(blockIndex, chunkBytes, blockBytes,
  chunkCount, totalBytes[, blockPlainOffset])`

A transfer between an **old build (Kotlin)** peer and a **new build (Rust)** peer
MUST succeed on LAN, P2P and relay. Durable transfer state (op-sqlite,
`lib/localDb.ts`) is unchanged — resume across a backend switch works precisely
because the wire + geometry + chunkId derivation are identical, so a half-done
transfer's remaining chunks seal/open the same under either backend.

Also unchanged (hard constraints): the R2 relay **protocol/routes/negotiation**
and the `vaultbeam_*` signaling; WebRTC itself; the op-sqlite state format.

## 1. Reuse of the Phase 1 crypto-core (one crypto implementation)

crypto-core already vendors `aes_gcm` (`Aes256Gcm`) and uses it internally
(`e2ee.rs` `aead_seal`/`aead_open`, which HKDF-derive the key). VaultBeam needs
raw GCM with an **explicit** key/nonce/aad. The ONLY crypto-core change is
additive — expose two thin public wrappers over the crate it already uses:

```rust
// crypto-core (new pub, no behavior change to existing ops)
pub fn gcm_seal(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Vec<u8>;      // ct‖tag
pub fn gcm_open(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], ct_tag: &[u8]) -> Result<Vec<u8>>; // verify+open
```

`vaultbeam-core` depends on `crypto-core` as a **path crate** and calls these
directly (in-process Rust, NOT the JSON FFI — chunk crypto is the hot path at
hundreds of MB/s). "One crypto implementation" = one SOURCE crate; it may be
linked into two `.so`/xcframework artifacts. A crypto-core unit test will assert
`gcm_seal` reproduces the Step 0 `vaultbeam.json` chunk wires (proves the shared
GCM ≡ the Kotlin/JS oracle before any binding work).

Phase 1 already proved noble(JS) ↔ RustCrypto GCM byte-parity, and Kotlin uses
the same AES/GCM/NoPadding primitive, so Rust↔Kotlin↔JS chunk interop holds.

## 2. The `vaultbeam-core` crate

New crate at `services/vaultbeam/rust/` (sibling of `services/crypto/rust/`,
same layout: `Cargo.toml`, `src/lib.rs`, `src/ffi.rs`, `src/bin/vb-cli.rs` for
host tests). Modules:

| module | owns |
|---|---|
| `chunk` | `seal_chunk`/`open_chunk` (nonce+aad derivation → `crypto_core::gcm_seal/open`), geometry math (`chunk_id`, `chunks_per_block`, tail length) |
| `fileio` | `prealloc`, positional `read_cipher_chunk`/`write_cipher_chunk`, `sha256_file` (streamed), `delete_file` |
| `block` | `upload_block`/`download_block` (loop `chunk` over the block, HTTP PUT/GET) — see §5 |
| `lan` | `lan_ip`, `lan_serve`, `lan_connect` (blocking `std::net` TCP, token auth, framing, progress callback) — see §4 |
| `ffi` | one C-ABI per op + a registered event callback (see §6); host CLI over the same dispatch |

Every op maps 1:1 to a current `@ReactMethod` so `lib/vaultBeamStreamNative.ts`
becomes a drop-in (same JS signatures). Unit-tested against the Step 0 vectors.

## 3. The explicit Rust ⇄ JS boundary

| Rust (`vaultbeam-core`) | JS (unchanged) |
|---|---|
| chunk seal/open (via crypto-core GCM) | WebRTC datachannel create/send/recv (react-native-webrtc) |
| nonce/AAD/chunkId derivation + geometry | `vaultbeam_*` socket signaling + receiver-driven negotiation (`vaultBeamDirect.ts`) |
| positional file IO, sha256, prealloc, delete | segment plan (`vaultBeamSegments.ts`), tier selection/orchestration (`vaultBeamController.ts`) |
| LAN TCP serve/connect + token auth + framing + progress events | durable transfer state (op-sqlite, `lib/localDb.ts`) |
| R2 block HTTP PUT/GET (see §5) | relay init/block-url/uploaded/grow/complete/abort calls to the backend (`vaultbeamRelay.ts`) — **untouched** |

JS still shuttles ONE P2 chunk's ciphertext at a time over the datachannel
(`readCipherChunk`→send, recv→`writeCipherChunk`); Rust never touches WebRTC.

## 4. Async / IO model — **blocking on a bounded thread pool, NOT tokio** (decision for review)

The task suggests tokio. I recommend **against** it here and instead mirror the
proven Kotlin model — blocking IO offloaded to a bounded thread pool
(Kotlin uses `Executors.newFixedThreadPool(4)`):

- File IO → `std::fs`/`RandomAccessFile`-equivalent positional reads/writes (blocking).
- LAN TCP → `std::net::{TcpListener, TcpStream}` (blocking), one socket per transfer,
  soTimeouts mirrored (45s accept, 60s read, 5s connect).
- HTTP (if §5 Design A) → `ureq` (blocking, tiny, no async runtime).
- The binding layer (C++ wrapper) offloads each call onto a bounded pool and
  resolves the JS Promise — exactly Kotlin's shape.

Rationale: each VaultBeam transfer is a **single** socket/stream; there is no
massive-concurrency problem that an async reactor solves. tokio adds an async
runtime + binary size + a callback-bridging complexity for zero benefit over the
already-proven blocking model. **Alternative on the table:** tokio (+ reqwest)
if we later want many concurrent LAN/relay transfers per process; the `lan`/`block`
module internals could switch without changing the C-ABI. **← decision #1.**

## 5. `uploadBlock`/`downloadBlock` — where does the R2 block HTTP live? (decision for review)

These two ops seal/open a block's chunks AND do the presigned-URL HTTP PUT/GET.
Two designs:

- **Design A (recommended): the crate owns the block HTTP** (`ureq`), so the
  ENTIRE byte pipeline is shared. **iOS gets uploadBlock/downloadBlock for free**
  from the same crate — the whole point of "iOS VaultBeam for the first time."
  The R2 relay *protocol/routes/negotiation* stay untouched (constraint 2); only
  the client's block-transport gains a flagged Rust path with Kotlin fallback.
  This slightly expands Step 2's crate list (which named crypto+IO+LAN) to include
  `upload_block`/`download_block` — flagged here for explicit sign-off.
- **Design B (more conservative): crate owns crypto+IO+LAN only; block HTTP stays
  platform-native** (Android `HttpURLConnection` as today; iOS `URLSession` written
  new). Keeps the relay data path on the exact current HTTP stack and matches
  Step 2 literally, but reintroduces per-platform code and means iOS block upload
  is NOT shared (undercuts the iOS-enablement goal).

Recommendation: **A**, because the stated goal is iOS enablement via one shared
core, and A keeps the relay contract (URL, ContentType, block wire) identical.
**← decision #2.**

## 6. Binding — reuse the Phase 1 Nitro C++ wrapper (a NEW native module name)

Reuse the crypto-core plumbing exactly (C-ABI staticlib → thin C++ Nitro
HybridObject → CMake link → `libvaultbeam.so`; the same for the iOS xcframework).
NOT a second Kotlin module and NOT UniFFI (Phase 1 chose Nitro over UniFFI to
avoid the codegen toolchain; keep that).

- New HybridObject **`VaultBeamStreamRust`** (distinct name so it coexists with
  the Kotlin `VaultBeamStream` for fallback; JS picks between them — §7).
- Async: each C-ABI op runs on the bounded pool; the C++ wrapper returns a Nitro
  Promise resolved/rejected from the worker.
- **Events** (`vbLanBound`, `vbLanProgress`): the crate takes a registered
  `extern "C"` callback `(ctx, event_name, json_payload)`; the C++ wrapper
  forwards it to the JS event emitter, so `onLanEvent()` in
  `vaultBeamStreamNative.ts` is unchanged.
- `addListener`/`removeListeners` no-ops preserved for `NativeEventEmitter`.

FFI arg shape: mirror crypto-core — small scalars/paths/keys as a JSON args
string; bytes as base64 where they already are (`keyB64`, `ctB64`) so the JS
surface is byte-identical. Large file bytes NEVER cross the FFI (Rust does
positional IO by path), matching today.

## 7. Flag + fallback chain

`VAULTBEAM_NATIVE_BACKEND` = `'kotlin'` (default) | `'rust'`, read like
`EXPO_PUBLIC_CRYPTO_BACKEND` (env → `expo-constants`). `vaultBeamStreamNative.ts`
resolves the backend once, with a capability self-check (a tiny seal/open probe
against a known vector), and Sentry breadcrumbs on selection + every fallback:

```
rust  → (flag=rust AND VaultBeamStreamRust present AND self-check passes) use Rust
      → else fall back to Kotlin
kotlin→ (VaultBeamStream present) use Kotlin
      → else isNativeStreamAvailable() = false → relay orchestrator refuses
        >2 GB (today's behavior) — EXCEPT iOS now gets Rust, so iOS gains native.
```

The **R2 relay tier remains the ultimate always-on baseline** below all of this;
a native-init failure never crashes a transfer, it degrades. No change to
`vaultBeamDirect.ts` / `vaultBeamController.ts` negotiation logic — they call the
same `vaultBeamStreamNative.ts` surface.

## 8. Config plugin + targets

`plugins/withVaultBeamRust.js`, cloned from `withCryptoCore.js`: toolchain-gated
(skip cleanly when cargo/cargo-ndk absent → Kotlin stays), copies
`plugins/vaultbeam-core-android` → `android/vaultbeam-core` (gradle lib module:
cargo-ndk builds the staticlib per ABI, CMake links it + the C++ wrapper into
`libvaultbeam.so`), wires settings/app gradle, inserts
`System.loadLibrary("vaultbeam")` (guarded). The existing `withVaultBeamStream.js`
(Kotlin) stays as the fallback module.

- **Android ABIs:** arm64-v8a, armeabi-v7a, x86_64 (+ x86/i686 to match
  crypto-core's target set — cheap, keeps emulator coverage). ← decision #3 (drop
  x86 if binary size matters).
- **iOS:** `aarch64-apple-ios` + `aarch64-apple-ios-sim` → `VaultBeamCore.xcframework`
  from the same staticlib + C++ wrapper (the crypto-core DESIGN already planned
  this xcframework path; VaultBeam reuses it). **First iOS VaultBeam.**

## 9. Test / gate plan (Step 5 preview)

- crate unit tests vs Step 0 `vaultbeam.json` (nonce/aad/wire/block/LAN/sha256).
- `vb-cli` host REPL (like `vc-crypto-cli`) → a Node parity suite:
  Rust↔Kotlin(oracle) chunk seal/open byte-equality + sha256 parity.
- CROSS-VERSION e2e: old(Kotlin)⇄new(Rust) succeeds on LAN, P2P, relay; both
  directions (Rust-serve/Kotlin-receive and vice-versa).
- Resume a transfer across a backend switch (op-sqlite state intact).
- Throughput + memory vs Kotlin on a representative file (extend loadtest).
This suite is the done-gate; PR not done until green. `npm run typecheck`,
`lint`, `test:e2ee` (which now includes `vaultbeam-vectors`) green at every commit.

## 10. Rollout

Default `kotlin` → internal build with `rust` → staged % via remote config on the
same flag → full. Relay tier always on. Kill-switch = set
`VAULTBEAM_NATIVE_BACKEND=kotlin`. Kotlin module kept indefinitely as fallback.

## Decisions (resolved)

1. **No tokio** — blocking IO on a bounded thread pool (mirror Kotlin). ✅ approved.
2. **Block HTTP** — refined to **Design A′** (seal/open+layout+fileIO in Rust;
   HTTPS transport platform-native). See status header + §5.
3. **Android x86/i686** — included (match crypto-core; keeps emulator coverage).

## Implementation status (per step)

| step | what | state |
|---|---|---|
| 0 | golden vectors + JS drift-guard | ✅ committed, green in `test:e2ee` |
| 1 | this design note | ✅ reviewed |
| 2 | `vaultbeam-core` crate (chunk/fileio/lan) + crypto-core `gcm_seal/open` | ✅ 16 crate tests green, byte-identical vectors |
| 3a | C-ABI FFI (`vb_call`/`vb_lan_*`/`vb_free`) + `vb-cli` | ✅ green |
| 3b (core) | R2 block seal/write ops (A′) | ✅ green |
| 3b (glue) Android | Kotlin/JNI module + CMake/gradle + `withVaultBeamRust` | ✅ **COMPILE-VERIFIED**: crate cross-compiles to all 4 ABIs + exports vb_* symbols; prebuild integrates (settings/app gradle + MainApplication); `:vaultbeam-core:assembleRelease` links `libvaultbeamnative.so` per ABI + Kotlin compiles + AAR builds |
| 3b (glue) iOS | Swift module + `VaultBeamCore.xcframework` + podspec | ⚙️ prebuild-verified (no macOS/Xcode here) |
| 4 | `EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND` switch + fallback + Sentry | ✅ typecheck 0 new errors |
| 5 (host) | Rust ≡ JS ≡ frozen-vectors parity (`vaultbeam-parity.selftest.ts`) | ✅ green |
| 5 (device) | cross-version LAN/P2P/relay e2e + resume-across-switch + throughput | 🔲 on-device gate (see below) |
| 6 | rollout + kill-switch + PR | ✅ `ROLLOUT.md` + `PR.md` |

## The on-device gate (Step 5 device half) — cannot run in Node CI

Host parity proves Rust ≡ JS ≡ the frozen wire (and the vectors ARE the Kotlin
contract). What remains needs two REAL builds and a device/emulator, exactly
like Phase 1's on-device crypto soak:

1. Build an **old** build (Kotlin backend) and a **new** build
   (`EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND=rust`).
2. Transfer a representative file **old ⇄ new** on each tier — LAN, P2P
   datachannel, R2 relay — in BOTH directions (Rust-serve/Kotlin-receive and
   the reverse). Each must complete + sha256-match.
3. **Resume across a backend switch**: start a transfer on one backend, kill,
   flip the flag, resume — op-sqlite state intact (the wire + geometry +
   chunkId are identical, so the remaining chunks seal/open the same).
4. **Throughput + memory** vs Kotlin on a large file (extend `loadtest`).

Sign-off on all four is the true done-gate before staged rollout.
