## Context

VaultChat currently renders Chess, Rummy, Ludo and Tic-Tac-Toe in React Native. The external games server owns truth: snapshots replace local state, and the client renders what the server says. The repo already has Rust integrations, but most production paths use a JNI/C ABI staticlib shape with TypeScript fallbacks; `rust/vaultcore` is the existing UniFFI spike and explicitly documents that UniFFI draws nothing.

The latest Rummy work improved the responsive table and card sizing in TypeScript. That code is the right behavior to preserve first. UniFFI is useful here only for pure deterministic helpers such as layout calculations, normalized seat positions, safe-area board dimensions, local view-model transforms, and fairness seed helpers. It is not useful for drawing glass panels, icons, cards, gestures or animations.

## Goals / Non-Goals

**Goals:**

- Add one games native core that can serve all four games without creating four separate native bridges.
- Move only pure deterministic helpers behind UniFFI, starting with the layout/view-model functions that are easiest to parity-test.
- Keep every React Native screen visually controlled by TSX so the glassmorphism UI can continue to iterate quickly.
- Preserve a TypeScript fallback and feature gate so a native failure never blanks a game screen.
- Leave every server-authoritative rule and result on the external games server.

**Non-Goals:**

- No rewrite of game UI in Rust.
- No replacement of React Native rendering, icons, fonts, animations or accessibility.
- No local computation of legal moves, shuffled decks, dice results, winners, balances or rankings.
- No forced switch to UniFFI for crypto, transport, navigation or vaultbeam paths that already have working native bridges.

## Decisions

### Decision: One games core, not one crate per game

Use a single native games core module with namespaced exports for `rummy`, `ludo`, `chess` and `tic_tac_toe` helpers. This keeps Gradle, Kotlin registration and fallback handling small.

Alternative considered: four separate crates/bridges. That adds build time and duplicate bridge code without improving the user-visible screens.

### Decision: UniFFI only for deterministic helpers

The UniFFI surface should accept plain numbers, strings, arrays and records, then return serializable records. Examples: Rummy table metrics, Ludo board geometry, Chess board square mapping, Tic-Tac-Toe grid hit targets. The native layer must not hold React state or socket state.

Alternative considered: moving full game screens to Rust. React Native still owns the visual tree, and a Rust renderer would duplicate the UI system while making glass design slower to change.

### Decision: TypeScript remains the reference until parity passes

Each migrated helper first keeps the existing TypeScript implementation as the reference. Rust outputs must match existing selftests and fixture cases. Only after parity passes should a screen read native output by default, and even then it must fall back to TypeScript on native init failure.

Alternative considered: switching screens as soon as native code compiles. That risks a broken release APK on devices where the native library is missing, incompatible or slow to initialize.

### Decision: Keep server authority explicit

The games core may compute display geometry and normalized view models. It must not validate a chess move, decide a rummy meld, roll dice, pick a winner, compute demo-coin balances, or sort leaderboards unless the server already sent that exact display data.

Alternative considered: using Rust to make the client smarter. That conflicts with the existing mini-games contract and would create client/server truth drift.

## Risks / Trade-offs

- Native build time increases → Gate rollout behind a small crate, keep one bridge, and avoid extra dependencies.
- UniFFI records are stricter than loose JS objects → Keep payload shapes small and versioned, with fixtures before wiring screens.
- Android bridge failure could break games → Keep TypeScript fallback and a runtime self-check before using native output.
- Native output could differ from the TS UI reference → Require parity selftests for each helper before flipping defaults.
- The user may expect UI improvements from UniFFI → Treat UI improvements separately in TSX/Figma; UniFFI improves deterministic helpers, not visual rendering.

## Migration Plan

1. Add the games native core scaffold and one no-op self-check callable from Android.
2. Port Rummy table layout helpers first because the current user issue is table fit and card sizing.
3. Add fixture parity tests against `lib/games/rummyTable.ts`, then wire the Rummy screen through a wrapper with fallback.
4. Port Ludo board geometry, Chess square mapping, and Tic-Tac-Toe grid helpers in separate small steps.
5. Enable native helpers per game only after parity checks pass and physical-device smoke testing confirms the screens still fit in portrait and landscape.
6. Roll back by disabling the native feature flag; TS implementations remain present.

## Open Questions

- Should iOS be scaffolded in the same change or deferred until Android device verification passes?
- Should the games native module reuse the existing JNI/staticlib pattern first and introduce UniFFI-generated Kotlin as a later refinement, or should it start with generated bindings immediately for this isolated crate?
