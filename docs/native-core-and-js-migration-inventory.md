# Native Core And JS Migration Inventory

## Boundary

React Native/TSX owns every visible screen: layout, glass UI, gestures, navigation, accessibility, icons, animation and theming. TypeScript owns the app-facing wrapper APIs. Rust/UniFFI owns only deterministic helpers over explicit serializable inputs and outputs.

Screens must not call native modules directly. A screen calls a TypeScript facade; the facade runs a native self-check, selects the Rust/native backend when allowed, and falls back to the TypeScript implementation when native is absent or fails.

## Native Modules

| Area | Current path | Binding shape | Decision | Wrapper impact |
|---|---|---|---|---|
| Money | `rust/vaultcore`, `utils/money.ts`, `utils/native/MoneyCore.ts` | UniFFI crate exported through the existing `CryptoCore` Nitro HybridObject | Stay as-is | Already behind `utils/money.ts`; no screen imports native directly. |
| Crypto | `services/crypto/rust`, `services/crypto/native/CryptoCore.ts` | Rust staticlib plus Nitro HybridObject | Stay as-is | `services/crypto/index.ts` remains the facade and TS fallback owner. |
| Navigation math | `services/nav/rust`, `lib/nav/native/NavCore.ts` | Rust staticlib linked beside `CryptoCore` | Stay as-is | `NavCore.ts` already owns self-check, route session selection and fallback. |
| Transport core | `services/transport/rust`, `plugins/transport-core-android` | Rust staticlib plus Android bridge | Stay as-is | Keep transport wrapper and fallback policy; do not convert socket ownership to Rust UI logic. |
| Transport net spike | `services/transport/rust-net` | Rust tests/library spike | Needs care | Keep out of runtime until a wrapper and parity contract exist. |
| VaultBeam | `services/vaultbeam/rust`, `plugins/vaultbeam-core-android`, `lib/vaultBeamStreamNative.ts` | Rust staticlib plus classic bridge module, Kotlin fallback | Stay as-is | `lib/vaultBeamStreamNative.ts` already selects `rust` or `kotlin` and falls back safely. |
| Games | `lib/games/*`, planned `games-uniffi-core` | Not yet wired | Needs wrapper cleanup/new core | Build one games facade first, starting with Rummy layout parity. Do not move game rules, winners or server truth client-side. |

## JavaScript To TypeScript Candidates

Safe to convert first:

| Path | Why | Import impact |
|---|---|---|
| `scripts/proto-check.js` | Codegen/check script | Rename only if Node invocation and any child process path are updated. |
| `scripts/test-all.js`, `scripts/test-migrations.js` | Repo test orchestration | Rename after package scripts and direct references are updated. |

Needs care:

| Path group | Why | Import impact |
|---|---|---|
| `plugins/with*.js` | Expo config plugins are loaded from `app.json` by path | They should stay `.js` unless Expo config loading is changed to a supported TS path. |
| `babel.config.js`, `metro.config.js`, `eslint.config.js`, `react-native.config.js` | Tooling expects CommonJS JavaScript configs | Keep JS unless the tool officially supports this repo's TS config form. |
| `scripts/reset-project.js`, `scripts/maplibre-shim.js` | Script paths are hard-coded in `package.json` or platform tooling | Convert only one at a time with command checks. |
| `docs/design/*.mjs` | Node ESM design builders | Convert only if the ESM runner stays simple. |
| `vaultchat-backend-go/internal/vault/interop_node.js` | Go interop test helper | Keep JS unless the Go test harness can run TS without extra setup. |

Should stay JS/config for now:

| Path group | Why |
|---|---|
| `vaultchat-backend/**/*.js` | Legacy Node backend exists beside the Go backend; converting it is a separate backend migration and should not be mixed with app UI/native work. |
| `vaultchat-backend/loadtest/*.js` | Load-test scripts are operational tooling, not app runtime. |
| `vaultchat-backend/contract/*.js` | Contract runner/tooling; keep until backend migration scope is active. |
| Config files listed above | Toolchain stability is more valuable than a cosmetic rename. |

Converted in this pass:

| Path | Import impact |
|---|---|
| `shims/vector-icons.ts` | `metro.config.js` now resolves `@expo/vector-icons` to the TypeScript shim; `lib/vectorIcons.selftest.ts` reads the new path. |
| `shims/react-native-webrtc.ts` | `metro.config.js` now resolves web `@livekit/react-native-webrtc` imports to the TypeScript shim. |
| `scripts/check-sdk-versions.ts` | `package.json` now runs it through `tsx` for `typecheck`, Android builds and `check:sdk`. |
| `scripts/check-native-libs.ts` | Standalone APK native-library validation script; behavior unchanged, now TypeScript. |
| `scripts/gradlew.ts` | `package.json` now runs Gradle through `tsx`, preserving the cross-platform wrapper behavior. |
| `scripts/check-migration-drift.ts` | `package.json` now runs DB migration drift checks through `tsx`. |

## Correct Work Order

1. Keep TSX UI work in React Native.
2. Convert app-runtime shims and selected build scripts to TypeScript only after checking import resolution.
3. Continue `games-uniffi-core`: create one games native facade, port Rummy layout metrics first, and keep TypeScript as the reference.
4. Leave Expo config plugins as JavaScript until the build proves a TS config-plugin path is supported.
5. Treat legacy Node backend JavaScript as a separate backend migration, after Go backend parity/deploy decisions are settled.
