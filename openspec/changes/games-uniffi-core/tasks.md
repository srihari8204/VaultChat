## 1. Native Games Core Scaffold

- [ ] 1.1 Add one Rust games core module for Chess, Rummy, Ludo and Tic-Tac-Toe deterministic helpers.
- [ ] 1.2 Add UniFFI/Kotlin binding generation or the smallest compatible bridge needed to call the games core from Android.
- [ ] 1.3 Register the Android module without changing current game screen rendering.
- [ ] 1.4 Add a runtime self-check and TypeScript fallback path for missing or failed native initialization.

## 2. Rummy Layout Migration

- [ ] 2.1 Port the Rummy table metrics helper from `lib/games/rummyTable.ts` to the games core.
- [ ] 2.2 Add parity fixtures for small portrait, phone landscape, tablet landscape and short-height screens.
- [ ] 2.3 Wire Rummy through a TypeScript wrapper that uses native output only after self-check passes.
- [ ] 2.4 Verify Rummy table, player names, card sizes and action buttons stay inside the safe area on physical Android.

## 3. Remaining Game Helpers

- [ ] 3.1 Port Ludo board geometry and dice/coin hit-target helpers with parity fixtures.
- [ ] 3.2 Port Chess board square mapping and responsive board sizing with parity fixtures.
- [ ] 3.3 Port Tic-Tac-Toe grid sizing and tap-target helpers with parity fixtures.
- [ ] 3.4 Confirm all four games preserve server-authoritative state handling and never compute winners or legal moves locally.

## 4. Validation and Release

- [ ] 4.1 Run focused TypeScript selftests for all migrated helpers.
- [ ] 4.2 Run Rust unit tests for the games core.
- [ ] 4.3 Build a release APK and install it on both connected physical devices.
- [ ] 4.4 Device-verify all four games in portrait and landscape, including dark and light modes.
- [ ] 4.5 Run a Ponytail review of the affected diff and remove duplicate bridge or helper code before deploy.
