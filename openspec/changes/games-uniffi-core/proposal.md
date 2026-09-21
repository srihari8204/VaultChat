## Why

The games screens now have more responsive table math and richer glass UI, but that logic still lives only in TypeScript and is easy to regress differently per screen. The user asked to use UniFFI for all games, so the safest path is to move shared deterministic game view-model helpers behind a native Rust/UniFFI boundary while keeping React Native responsible for drawing the UI.

## What Changes

- Add a native games core for Chess, Rummy, Ludo and Tic-Tac-Toe view-model helpers that can be called from Android through UniFFI/Kotlin and from TypeScript through a thin wrapper.
- Reuse the current TypeScript board components, socket state, server-authoritative snapshots, gestures, icons, animation and glassmorphism rendering.
- Add a TypeScript fallback for every native helper so release builds remain usable if the native module is missing or disabled.
- Add parity tests proving the native helpers match the current TypeScript behavior before switching any game screen to native output.
- Keep the current external games server authoritative for rules, deck, dice, turns, scores and winners.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `mini-games`: The four shipped games gain a deterministic native view-model path for screen-fitting board/table layout helpers, with TypeScript fallback and parity checks.

## Impact

- Affected app code: `lib/games/**`, `components/games/**`, Android native module registration, and any new Rust crate used for games helpers.
- Affected build code: Gradle/Cargo build wiring for the games native core, ideally matching the existing Rust staticlib patterns in `android/crypto-core`, `android/transport-core` and `android/vaultbeam-core`.
- No backend schema, DB migration, server deployment, payment flow, or game-server rule change is required.
- Not building: a Rust UI renderer, a replacement for React Native screens, a local game referee, offline game outcomes, or any client-side authority over legal moves/results.
