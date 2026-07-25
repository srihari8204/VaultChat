# Rust crypto core — Phase 1 design note

Status: **implemented (Steps 0–5)** — crate + bindings + facade + parity all
landed on this branch. TS crypto in `services/crypto/*` stays the default and
the permanent fallback. The Rust core ships DISABLED
(`EXPO_PUBLIC_CRYPTO_BACKEND` defaults to `'ts'`); parity is green (17/17
cross-backend checks + 13 Rust tests incl. byte-exact golden vectors).

## 1. Binding strategy — Decision: Option A (Nitro HybridObject over a C-ABI Rust staticlib)

Rust crate `crypto-core` → `staticlib` exposing a plain C ABI → thin C++
HybridObject registered via `react-native-nitro-modules` (already a dependency,
`^0.35.0`; New Architecture is enabled in `app.json`).

Why A over B (UniFFI → Kotlin):

- **Zero new dependency.** Nitro is installed and JSI-native; UniFFI adds a
  codegen toolchain + generated Kotlin that still crosses JNI, and would need a
  separate Swift codegen pass for iOS later. The C ABI + one C++ wrapper serve
  both platforms.
- **Synchronous calls.** Ratchet encrypt/decrypt sits on the message hot path
  (`chat.tsx` decrypts every visible bubble). JSI sync calls avoid
  promise/bridge overhead; UniFFI-Kotlin would push us to async TurboModule
  shapes.
- **Smallest surface.** The C++ layer only marshals bytes/strings — all crypto
  logic stays in Rust where it is unit-tested against the golden vectors.

## 2. Crates

| crate | use | notes |
|---|---|---|
| `x25519-dalek` | DH (IK/SPK/OPK/ratchet keys) | `StaticSecret` clamps on construction; noble clamps on use — DH outputs identical. **Do NOT add a contributory/zero-output check the TS lacks** — semantics must match. |
| `ed25519-dalek` | signing (SPK sig, sender keys) | 32-byte seed keys, RFC 8032 deterministic → signatures byte-identical to noble. |
| `hkdf` + `sha2` | RootKDF / X3DH SK / msg-key material | HKDF-SHA256, same info strings (`VaultChat-RootKDF-v1`, `VaultChat-X3DH-v1`, `VaultChat-MsgKey-v1`, `VaultChat-SenderKey-Msg-v1`), salt = RK or 32 zero bytes. |
| `hmac` | chain KDF | mk = HMAC(CK, 0x01), CK' = HMAC(CK, 0x02) — both ratchets. |
| `aes-gcm` | AEAD | AES-256-GCM, 12-byte nonce from HKDF, tag appended after ct (same layout as `@noble/ciphers` gcm). Constant-time (RustCrypto). |
| `zeroize` | wipe secret buffers (mk, ck, rk, privs, shamir coeffs) on drop | |
| `subtle` | constant-time comparisons | mirrors `ctEqual`. |
| `serde` + `serde_json` | state/envelope JSON | struct field order = TS `JSON.stringify` key order (see §5). |
| `base64`, `hex` | wire encodings | hex lowercase; b64 standard w/ padding (Node `Buffer` compatible). |
| `getrandom` | OS RNG | vectors avoid RNG entirely (fixed inputs, deterministic transforms), so no seeded-RNG test seam is needed. |

No `ring`: RustCrypto crates cover everything, pure-Rust, easier cross-compile.

## 3. Targets & build hook

Android ABIs (matching Expo's default `reactNativeArchitectures`, which
includes x86):

- `aarch64-linux-android` → arm64-v8a
- `armv7-linux-androideabi` → armeabi-v7a
- `i686-linux-android` → x86
- `x86_64-linux-android` → x86_64

Build chain: `cargo ndk` (cargo-ndk) builds `libcrypto_core.a` per ABI; the
Nitro C++ wrapper + CMakeLists link it into the app's native lib. Hook: a new
Expo config plugin `plugins/withCryptoCore.js` following the
`withVaultBeamStream.js` pattern — `withDangerousMod('android')` copies the C++
wrapper + CMake glue into the android project and `withAppBuildGradle` injects a
`cargoBuildCryptoCore` Exec task (runs `cargo ndk -t <abis> build --release`)
wired as a `preBuild` dependency.

**Toolchain-missing behavior:** if `cargo`/`cargo-ndk` is not installed, the
plugin prints a warning and skips the native build. The app still builds; the
JS facade detects the missing HybridObject at runtime and stays on TS (this is
the same path as the mandated runtime fallback — never a build break, never a
crash).

iOS (later phase, designed now): `aarch64-apple-ios` + `aarch64-apple-ios-sim`
→ `CryptoCore.xcframework` from the same staticlib + the same C++ wrapper.
There is no iOS native code in the repo today; nothing in this design is
Android-only except the Gradle hook.

## 4. FFI surface

One principle: **state crossing the FFI boundary uses the exact serialized
formats the app already persists** (`serializeState` JSON, sender-key JSON
records, envelope JSON, VCSS1 strings). The boundary format IS the interop
format, so "TS serializes → Rust continues" is exercised on every single call,
not just in tests.

- **Single C entrypoint** (as built): `vc_crypto_call(op, args_json) -> json`
  + `vc_crypto_free`. Every op is JSON-in/JSON-out; bytes travel as hex,
  ratchet state as the canonical `serializeState` JSON, sender-key records as
  their TS-shaped JSON. One extern fn, one C++ method
  (`HybridCryptoCore::call`), one JS dispatcher — the typed surface lives in
  `services/crypto/native/CryptoCore.ts`.
- Response envelope `{"ok":true,"result":…} | {"ok":false,"error":…}`; the JS
  wrapper throws `Error(error)`. Rust core error strings mirror the TS ones
  (consumer string-matching like `'no session and no X3DH'` happens a layer
  above, in `e2eeSession.ts`, which is shared by both backends).
- `std::panic::catch_unwind` at the boundary — a Rust panic becomes a JS
  error, never an abort.
- Host-side testability: `src/bin/vc-crypto-cli.rs` is a line-delimited JSON
  REPL over the same dispatcher, so the Node parity suite drives the real
  Rust core without native bindings.
- Known, intentional divergence: on a FAILED decrypt TS leaves partial
  in-memory state mutations; the native wrapper applies state only on success
  (atomic). Invisible to consumers — they never persist state after a failed
  decrypt.

<!-- ponytail: JSON-parse per ratchet op (~1KB states). If profiling ever shows
     it, upgrade path is opaque state handles kept Rust-side. -->

## 5. Data model — exact TS shapes to mirror

From `e2ee.ts`:

- `KeyPair { priv: 32B, pub: 32B }` (X25519 or Ed25519-seed).
- `PreKeyBundle { identityKey, signingKey, signedPreKey, signedPreKeySig, oneTimePreKey?, oneTimePreKeyId? }`.
- `InitialHeader { identityKey, ephemeralKey, oneTimePreKeyId }`.
- `RatchetState { DHs, DHr|null, RK, CKs|null, CKr|null, Ns, Nr, PN, MKSKIPPED: Map<"hexDh:n", mk> }`, `MAX_SKIP = 1000`.
- `serializeState` JSON — **exact key order** `DHs{priv,pub}, DHr, RK, CKs, CKr, Ns, Nr, PN, skipped`; lowercase hex; `null` for absent. `skipped` is emitted in Map **insertion order** → Rust uses an order-preserving map (`Vec<(String,String)>` or IndexMap), never BTreeMap/HashMap.
- `encodeEnvelope` JSON — key order `dh, pn, n, ct`; `dh`/`ct` base64.
- AEAD associated data: `utf8("{hexDh}|{pn}|{n}")` (lowercase hex).
- Chain/root KDFs and msg-key material as in §2; `msgKeyMaterial` = HKDF(mk, salt=32×0, info=MsgKey-v1, 44) → key 0..32, nonce 32..44.
- X3DH DH ordering DH1..DH4 concatenated, HKDF(salt=32×0, info=X3DH-v1, 32).
- Skipped-key cache: lookup by `hex(header.dh):n`, delete on use, `MAX_SKIP` gap guard, skip-before-DH-ratchet on `pn`, skip-before-decrypt on `n` — byte-for-byte the algorithm in `ratchetDecrypt`.

From `senderKey.ts` (all state already JSON-with-hex-strings):

- `OwnSenderKey { chainKeyHex, iteration, signPrivHex, signPubHex }`.
- `PeerSenderKey { chainKeyHex, iteration, signPubHex, skipped: Record<iterStr, mkHex> }`, `MAX_SKIP = 2000`, cache trimmed oldest-first past the cap.
- `SenderKeyDistribution { chainKeyHex, iteration, signPubHex }`.
- `GroupCipher { iteration, ciphertext: b64, signature: b64 }`; signature over `u32be(iteration) || ct`; AD = `u32be(iteration)`; verify BEFORE key work; immutable-style: ops return `{ result, next }`.

From `shamir.ts`:

- GF(2^8), reduction poly `0x11b`, generator `0x03`, log/exp tables; Horner eval; Lagrange at x=0 with `xj` / `xi^xj` terms.
- Wire: `VCSS1-<k>-<group4hex>-<idx2hex>-<payloadHex>` uppercased; parse tolerant of case/trim; same validation errors (group mismatch, dup x, length mismatch, `< k`).
- x-coords `1..n`, coeff[0] = secret byte, coeffs 1..k-1 random per byte.

## 6. JS integration (Steps 3–4 preview)

- `services/crypto/native/CryptoCore.ts` — typed surface, same signatures as
  `e2ee.ts` / `senderKey.ts` / `shamir.ts`.
- `services/crypto/index.ts` — facade re-exporting the whole API. Backend from
  `EXPO_PUBLIC_CRYPTO_BACKEND` (`'ts' | 'rust'`, default `'ts'`); try/catch
  init + a self-check call; any failure → Sentry breadcrumb + TS fallback.
  Never throws out of module init.
- **Actual import seam found in the repo:** app consumers (`app/_layout.tsx`,
  `app/chat.tsx`, `lib/chatService.ts`, `lib/callCrypto.ts`,
  `lib/cloudBackup.ts`, `lib/storyKeys.ts`) import the session wrappers
  `e2eeSession.rn.ts` / `groupSession.rn.ts`, not the primitives. The
  primitive imports to repoint at the facade are `e2eeSession.ts` (→ `./e2ee`)
  and `groupSession.rn.ts` (→ `./senderKey`); `shamir.ts` has no app consumer
  yet outside its selftest. Import-line changes only.

## 7. Test gates (Steps 1, 5 preview)

- Golden vectors in `services/crypto/__vectors__/*.json`: deterministic
  transforms assert exact bytes/strings; randomized ops assert TS↔Rust interop
  + round-trip + structural invariants. `npm run test:crypto:vectors` guards TS
  against format drift; the Rust crate's unit tests consume the same JSON.
- `services/crypto/parity.selftest.ts`: cross-backend encrypt↔decrypt,
  serializeState continue-in-other-backend, group send/receive across
  backends, Shamir split-in-one/recover-in-other. It drives the REAL Rust
  dispatcher through `vc-crypto-cli` (line-JSON REPL), builds it via `cargo
  build` when missing, and SKIPS (warning, exit 0) only when cargo is absent.
  Wired into `npm run test:e2ee`. PR is not done until parity is green.
- **CI gate** (requires rustup):
  `cargo test --manifest-path services/crypto/rust/Cargo.toml && npm run test:e2ee`
  — Rust unit/vector tests + TS selftests + vector guard + live parity.

## 8. Rollout & kill switch

1. Default off (`'ts'`) — this PR.
2. Internal dev build with `EXPO_PUBLIC_CRYPTO_BACKEND=rust`; run parity suite
   on-device + soak real chats.
3. Staged % via the existing remote config mechanism feeding the same flag.
4. Full, TS path kept indefinitely as fallback.

**Kill switch:** set `EXPO_PUBLIC_CRYPTO_BACKEND=ts` (or unset). No data
migration in either direction — both backends read/write the identical
persisted formats, so flipping is instant and safe mid-conversation. Runtime
auto-fallback additionally disarms the Rust path on any init/self-check
failure without a release.
