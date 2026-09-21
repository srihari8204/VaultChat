## Why

VaultChat is already a React Native app with several Rust native cores, but the boundary is inconsistent: some pure logic lives in TypeScript, some native paths use JNI/C ABI, and the existing UniFFI spike is not wired into the app. We want a clear app-wide architecture: TSX owns product UI, Rust/UniFFI owns shared deterministic client logic, and the backend remains authoritative for server truth.

## What Changes

- Establish a client architecture where every visible screen remains React Native/TSX and every native migration goes through a small TypeScript wrapper with fallback.
- Introduce a `native-app-core` capability that defines what can move to Rust/UniFFI and what must stay in TSX or backend services.
- Reuse existing Rust work first:
  - `rust/vaultcore` as the UniFFI proof point.
  - `services/crypto/rust`, `services/nav/rust`, `services/transport/rust*`, and `services/vaultbeam/rust` as existing native-core patterns.
  - Current TypeScript modules as parity references until native output is proven.
- Migrate module-by-module: games layout/helpers first, then money/math, crypto-facing pure helpers, protobuf codecs, local DB transforms, route/map math, upload/download chunk helpers, and performance-sensitive validators where they are pure and testable.
- Add parity/selftest gates before any runtime switch.
- Keep release safety by requiring feature flags or runtime self-checks with TypeScript fallback for each migrated module.

## Not building

- No rewrite of the app UI in Rust.
- No replacement of React Native, Expo, TSX screens, icons, animations, glassmorphism, accessibility, navigation, theming or gesture code.
- No client-side replacement for backend authority. Auth, permissions, payments, game outcomes, message sync truth, group membership, balances and server-side scoping remain backend-owned.
- No big-bang rewrite. Existing screens continue working while each pure helper migrates independently.
- No removal of TypeScript fallback until native parity, release build, and physical-device verification pass.

## Capabilities

### New Capabilities

- `native-app-core`: Defines the React Native/TSX + UniFFI Rust boundary, fallback behavior, parity requirements, and phased module migration rules.

### Modified Capabilities

- None. Individual features will add their own delta specs only when their user-visible behavior changes.

## Impact

- Affected client architecture: TypeScript wrappers around native modules, Rust/UniFFI crates, Android Gradle/Cargo integration, and later iOS bindings.
- Affected modules over time: games helpers, money/math helpers, protobuf serialization helpers, local persistence transforms, route/map calculations, crypto-adjacent pure helpers, and VaultBeam chunk/view-model helpers.
- No immediate DB migration, backend deployment, or server API change is required for the architecture itself.
- Device verification remains required before declaring any migrated module shipped.
