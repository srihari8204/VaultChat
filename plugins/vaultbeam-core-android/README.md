# vaultbeam-core (Rust) — native binding NOTES

**Status: prebuild-verified glue.** Like the Phase 1 crypto-core binding, this
module *cannot be compiled in this repo's dev environment* (no Android NDK, no
Xcode). It is written by pattern-matching the proven crypto-core template; a
human must verify it at the first `expo prebuild` + native build. See the
"Verify at prebuild" checklist below.

## What this is

The shared Rust crate `vaultbeam-core` (`services/vaultbeam/rust`) exposed to
React Native as a **classic bridge module** named `VaultBeamStreamRust`. It is a
drop-in twin of the existing Kotlin `VaultBeamStream` module — same
`@ReactMethod` surface, same wire format, same block-HTTP semantics — so a
Kotlin peer and a Rust peer interoperate on every tier (LAN / WebRTC / R2 relay).

Runtime selection lives in `lib/vaultBeamStreamNative.ts`
(`EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND=rust`, default `kotlin`); it falls back to
Kotlin automatically if the Rust module is absent or its surface is incomplete.

## Deviation from the DESIGN's Nitro recommendation → classic bridge

The DESIGN doc recommended a Nitro HybridObject (as crypto-core uses). We
**deliberately chose a classic `NativeModules` + `NativeEventEmitter` + Promise
bridge instead**, because:

- The existing JS surface (`lib/vaultBeamStreamNative.ts`) is already classic
  `NativeModules` + Promises + `NativeEventEmitter`. A classic Rust-backed shim
  makes that file a **true drop-in** — no JS rewrite, and the Kotlin↔Rust
  fallback is a one-line module lookup.
- VaultBeam is **async + event-driven** (block HTTP, long-running LAN transfers
  with progress events). Promises + `DeviceEventEmitter` model that naturally;
  Nitro's synchronous JSI surface would need extra plumbing for the async/event
  parts and buys nothing here.
- The Rust staticlib is **still shared cross-platform** — only the thin
  marshaling shim (JNI/Swift) is per-platform. We keep the "one crypto/transport
  implementation" win without adopting Nitro for a surface that doesn't need it.

## Design A′ split (where the bytes live)

- **Shared Rust** (`services/vaultbeam/rust`): AES-256-GCM seal/open, chunk/block
  geometry, positional file I/O, the LAN TCP transport, SHA-256, lanIp.
- **Platform-native (thin)**: the block HTTP (`uploadBlock` PUT / `downloadBlock`
  GET) and the marshaling. HTTP is **byte-for-byte identical** to
  `plugins/android/VaultBeamStreamModule.kt` (PUT `Content-Type:
  application/octet-stream`, `setFixedLengthStreamingMode`, connect 30s / read
  120s, 2xx = success) so old(Kotlin)↔new(Rust) transfers work on the relay tier.

The chunk wire format and the `vaultbeam_*` protocol are **unchanged** — this
binding only routes the existing ops through Rust instead of Kotlin.

## Toolchain setup (one-time)

    # Rust + cargo-ndk
    rustup ...            # install rustup
    cargo install cargo-ndk

    # Android targets
    rustup target add aarch64-linux-android armv7-linux-androideabi \
                      i686-linux-android x86_64-linux-android

    # iOS targets (macOS + Xcode)
    rustup target add aarch64-apple-ios aarch64-apple-ios-sim
    bash services/vaultbeam/rust/build-ios-xcframework.sh   # → plugins/vaultbeam-core-ios/VaultBeamCore.xcframework

Then: `expo prebuild --clean` and (iOS) `cd ios && pod install`.

## Method → Rust op mapping

| JS / @ReactMethod            | Rust op (vb_call unless noted)      | Platform-native part |
|------------------------------|-------------------------------------|----------------------|
| `prealloc(path,total)`       | `prealloc`                          | —                    |
| `uploadBlock(opts)`          | `sealBlockFromFile` → b64 ct        | HTTP **PUT** the decoded block |
| `downloadBlock(opts)`        | `writeBlockFromBody` (bodyB64 in)   | HTTP **GET** the block first   |
| `sha256(path)`               | `sha256`                            | —                    |
| `deleteFile(path)`           | `deleteFile`                        | —                    |
| `readCipherChunk(opts)`      | `readCipherChunk` → b64 ct          | —                    |
| `writeCipherChunk(opts)`     | `writeCipherChunk` (ctB64 in)       | —                    |
| `lanIp()`                    | `lanIp`                             | —                    |
| `lanServe(opts)`             | `vb_lan_serve` (blocking)           | emits vbLanBound/vbLanProgress |
| `lanConnect(opts)`           | `vb_lan_connect` (blocking)         | emits vbLanProgress  |
| `addListener/removeListeners`| — (NativeEventEmitter no-ops)       | —                    |

## JNI symbols + event trampoline (`src/main/cpp/VaultBeamJni.cpp`)

Three `external fun` on `VaultBeamStreamRustModule` (instance methods):

- `Java_com_vaultchat_vaultbeamcore_VaultBeamStreamRustModule_nativeCall`
- `Java_com_vaultchat_vaultbeamcore_VaultBeamStreamRustModule_nativeLanServe`
- `Java_com_vaultchat_vaultbeamcore_VaultBeamStreamRustModule_nativeLanConnect`

All three return a **`String`** = the Rust `{"ok":…,"result":…}` envelope, which
Kotlin parses (the task sketched `nativeLanServe: int`, but returning the
envelope keeps error propagation uniform and lets Rust own the result — the C ABI
hands back a JSON string, not an int).

**Event trampoline:** `nativeLanServe/Connect` wrap the Kotlin `LanEventListener`
(a `fun interface { fun onEvent(name, payloadJson) }`) in a JNI **GlobalRef**,
resolve its `onEvent(String,String)V` method id, and pass a C `LanCtx*` as the
`vb_lan_*` `ctx`. The C `EventCb` trampoline: `GetEnv`; if `JNI_EDETACHED`,
`AttachCurrentThread` (marking for detach), else use the returned env;
`NewStringUTF` the name/payload; `CallVoidMethod` the listener; `ExceptionClear`;
`DeleteLocalRef`; `DetachCurrentThread` **only if we attached**. The Rust LAN ops
fire the callback synchronously on the calling (io Executor) thread, which is
already JVM-attached, so `GetEnv` normally succeeds without an attach — the
attach path is defensive for a future async Rust revision. The `LanCtx` lives on
the C++ stack for the whole blocking call, so the GlobalRef stays valid.

## Fallback contract

`VaultBeamStreamRustPackage.createNativeModules` registers the module **only when
`System.loadLibrary("vaultbeamnative")` succeeded** (`companion.loaded`). If the
`.so` fails to load, nothing is registered, JS never sees
`NativeModules.VaultBeamStreamRust`, and it uses the Kotlin `VaultBeamStream`
module — the same "JS finds no CryptoCore → TS backend" contract crypto-core uses.

## Verify at prebuild (human checklist)

1. **`app.json`** lists `./plugins/withVaultBeamRust.js` (added). Confirm it runs
   *after* `withVaultBeamStream.js` so the Kotlin fallback always exists.
2. **NDK env**: `android.ndkDirectory` resolves; `cargo ndk -t <abi> build
   --release --lib` runs in `services/vaultbeam/rust` for each ABI and produces
   `target/<triple>/release/libvaultbeam_core.a`.
3. **CMake** finds each ABI's `.a` and links `libvaultbeamnative.so`. Confirm the
   Rust staticlib is self-contained (it bundles its `crypto-core` path-dep).
4. **Kotlin plugin** is applied to the library module (crypto-core had none —
   this module ships Kotlin). Confirm `org.jetbrains.kotlin.android` is available
   to a sub-module and `jvmTarget = "17"` matches the app.
5. **MainApplication** edits landed: package registration insertion point matched
   (same markers as withVaultBeamStream) and the guarded `System.loadLibrary`.
6. **iOS**: `build-ios-xcframework.sh` produced `VaultBeamCore.xcframework`;
   `withVaultBeamRust` copied `ios/VaultBeamCore` and added the `pod` line;
   `pod install` succeeds; the Swift bridging header resolves `VaultBeamCore.h`.

## Uncertain / review-first (RN / Expo / JNI API)

- **iOS is the highest-risk deliverable** (first iOS VaultBeam, written
  pattern-only). Review the Swift C-function-pointer event callback
  (`Unmanaged.passRetained`/`.release`, the global `EventCb`), the
  `SWIFT_OBJC_BRIDGING_HEADER` pod xcconfig, and the Podfile insertion regex
  (`use_expo_modules!` anchor may differ in this project's Podfile).
- **`fun interface` + JNI `GetObjectClass`/`GetMethodID`**: confirm the Kotlin
  lambda's synthetic class exposes `onEvent(String,String)V` to `GetMethodID`.
- **`JSONObject` number typing**: `toJson` emits whole numbers as `Long` so Rust
  `as_u64` accepts them (a `Double` 512.0 → `"512.0"` would fail). Verify RN's
  `ReadableType.Number` round-trips large `totalBytes` (>2^53 is out of scope;
  files are ≤12 GB ≈ 2^34, safe as double and as Long).
- **Podfile anchor** for the `pod` line (`use_expo_modules!`) — verify it exists
  in the generated Podfile; otherwise add the pod line manually.
