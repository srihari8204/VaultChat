## Context

The app is React Native + Expo with TypeScript screens. Existing native/Rust paths are mixed:

- `rust/vaultcore` is a UniFFI spike for pure logic and documents that UniFFI does not draw UI.
- `services/crypto/rust`, `services/nav/rust`, `services/transport/rust*`, and `services/vaultbeam/rust` already provide native Rust cores through Android bridge patterns.
- Current UI work, including glassmorphism game screens, belongs in TSX because React Native owns layout, accessibility, gestures, theming and animation.
- The backend remains the source of truth for auth, permissions, messages, payments, groups, game state and other server-owned data.

The target architecture is not “Rust instead of TypeScript.” It is “TypeScript for UI/orchestration, Rust/UniFFI for small deterministic cores that must be identical, fast or safer across platforms.”

## Goals / Non-Goals

**Goals:**

- Make the app architecture predictable: TSX renders; TypeScript wrappers choose TS or native implementation; Rust/UniFFI executes pure deterministic helpers.
- Reduce duplicated logic and drift across Android/iOS where the same client calculation must match.
- Keep the current app working while migrating module-by-module.
- Require parity tests and runtime fallback for every migrated module.
- Keep backend authority and security boundaries intact.

**Non-Goals:**

- No Rust renderer.
- No Rust rewrite of screens.
- No migration of React component state, navigation, sockets, hooks or animations into Rust.
- No client-side ownership of server truth.
- No untested native default path.

## Decisions

### Decision: Three-layer client boundary

Use this boundary everywhere:

1. **TSX screen layer**: visual UI, glassmorphism, icons, fonts, gestures, navigation, accessibility, safe areas and responsive composition.
2. **TypeScript wrapper layer**: stable app-facing API, input normalization, feature flag, native self-check, fallback selection, telemetry breadcrumb.
3. **Rust/UniFFI core layer**: pure functions over serializable records, no React state, no network I/O, no local DB handles, no long-lived UI objects.

Alternative considered: call generated UniFFI bindings directly from screens. That spreads native availability checks across UI code and makes fallback harder.

### Decision: JS-to-TS and UniFFI migration boundary

Treat remaining JavaScript files by runtime, not by extension alone:

- App UI and app-facing orchestration SHALL be TS/TSX. New code in `app/`, `components/`, `lib/`, `services/`, `utils/`, `constants/`, `db/`, `hooks/` and `types/` uses TypeScript unless a platform config file requires JavaScript.
- Expo/Metro/Babel/ESLint/React Native config files may stay JavaScript when the tool loads them directly by conventional filename.
- Expo config plugins under `plugins/*.js` may move to TypeScript only if their loader path and prebuild flow are updated together; otherwise they remain small JavaScript build hooks.
- Node-only operational scripts and the legacy Node backend may migrate to TypeScript in a separate backend/tooling change. They are not UniFFI candidates because they do not ship as client deterministic helpers.
- Rust/UniFFI is reserved for pure deterministic helpers with serializable inputs/outputs and parity fixtures. Hooks, React state, sockets, navigation, live database handles, network clients, render functions and build scripts do not move to UniFFI.

This keeps the owner request concrete: visible app code stays TS/TSX, pure app helpers can move to Rust behind TypeScript wrappers, and JavaScript that exists only because an external tool expects that filename is changed only when that toolchain path is updated.

### Decision: Migrate pure modules first

Priority order:

1. Games layout/view-model helpers, starting from the separate `games-uniffi-core` change.
2. Money/math helpers where exact parity matters.
3. Protobuf encode/decode helpers after the current protobuf migration settles.
4. Local DB transform helpers that are pure and fixture-testable.
5. Route/map math that does not replace Valhalla road-distance authority.
6. File-transfer chunk helpers that are deterministic and already covered by vectors.

Alternative considered: migrating whole features. Whole-feature migration would drag UI, backend contracts and native bridge work together, making rollback hard.

### Existing native-core audit

Keep as-is for now:

- `services/crypto/rust` plus `services/crypto/native/CryptoCore.ts`: already exposes the Rust crypto core through the existing Nitro HybridObject, runs `selfCheck`, and falls back through `services/crypto/index.ts`.
- `rust/vaultcore` plus `utils/native/MoneyCore.ts`: the UniFFI money proof point stays wired through the existing crypto bridge on Android; its exported UniFFI surface remains intact for iOS/Swift binding generation.
- `services/nav/rust` plus `lib/nav/native/NavCore.ts`: already has parity tests and a TS fallback. The performance win mostly lives in the TypeScript algorithm, so do not expand this bridge unless a specific route helper needs it.
- `services/transport/rust` and `services/transport/rust-net`: keep the current split between pure transport logic and the unsafe/native shim. It is already scoped away from UI, DB and crypto ownership.
- `services/vaultbeam/rust` plus `lib/vaultBeamStreamNative.ts`: keep as the existing VaultBeam native stream core with its backend flag and fallback.
- Android Kotlin modules under `android/app/src/main/java/com/vaultchat/app/**`: keep as platform capability modules where they wrap OS/media/security APIs. They are not UniFFI candidates because they are not pure deterministic helpers.

Needs wrapper cleanup before wider rollout:

- Money and crypto already have separate wrapper files, but the app-wide pattern should prefer one small app-facing facade per domain with self-check, flag and fallback in the facade, and native binding isolated under `native/`.
- Game helpers need the first new wrapper once `games-uniffi-core` lands. The wrapper should mirror `utils/money.ts`: TypeScript reference remains default until Rust parity, release APK and device verification pass.
- Future protobuf/local DB/VaultBeam helper migrations need fixture files first, then Rust tests, then TS parity selftests, then runtime flagging.

High-priority UniFFI candidates from the current TypeScript code:

1. `lib/games/rummyTable.ts`, `lib/games/handGroups.ts`, `lib/games/meldHint.ts`, `lib/games/boardFit.ts`: pure game layout/view-model helpers with existing selftests and no server authority.
2. `utils/money.ts`: already backed by `rust/vaultcore`; keep improving parity and wrapper diagnostics before making Rust the permanent default.
3. `lib/vaultBeamSegments.ts`, `lib/resumableUpload.plan.ts`, `lib/vaultBeam/blockMap.ts`, `lib/vaultBeam/bitmap.ts`: deterministic chunk/accounting helpers with vector/selftest potential.
4. `lib/nav/routeProgress.ts`, `lib/nav/routing.ts`, `lib/nav/adaptiveDistance.ts`: pure route math can use native helpers only when it does not replace Valhalla road-distance authority.
5. `lib/ccwire/transport.ts`, generated protobuf encode/decode call sites and `lib/msgEnvelope.ts`: migrate only after protobuf migration settles and golden vectors cover the current TypeScript behavior.

Not UniFFI candidates:

- TSX screens and components.
- React hooks such as `useGameSocket`, `useWallet`, `useRoadEta`, `useLiveTables`.
- Network/socket wrappers, database modules with live handles, config plugins, Metro/Babel/ESLint config, operational scripts, and backend handlers.

### Decision: Existing TypeScript remains the reference during migration

Each module starts by collecting current TypeScript fixtures. Rust must match those fixtures before the wrapper can use native output by default. The TS implementation stays as fallback until release APK build and physical-device verification pass.

Alternative considered: rewriting the algorithm in Rust first and updating TS later. That would make regressions harder to detect because both implementations could drift at once.

### Decision: Backend truth does not move

Rust/UniFFI can make client-side deterministic helpers faster and safer, but it does not replace Go/Node backend ownership. Server-scoped user data, RLS compensation in handlers, payment correctness, message sync cursors, game results and permissions stay server-side.

Alternative considered: richer client-side validation. Validation can improve UX, but the server remains the enforcement point.

## Risks / Trade-offs

- Native build time and APK size increase → Use one small core per domain, avoid pulling CLI-only dependencies into runtime, and keep feature flags.
- UniFFI bridge work adds complexity → Hide native calls behind TS wrappers and self-checks.
- UI expectations may be confused with native migration → Keep Figma/TSX UI changes separate from Rust logic changes.
- Generated binding/platform mismatch can break Android release → Keep TS fallback and verify release APK on physical devices before declaring shipped.
- Big architecture work can delay user-visible polish → Migrate only modules that have parity tests or measured benefit.

## Migration Plan

1. Keep today's UI fixes shipping through React Native/TSX.
2. Use `games-uniffi-core` as the first bounded native migration because games layout helpers are pure and already have selftests.
3. Add an app-wide native wrapper convention under TypeScript before wiring more modules.
4. Move one helper at a time, with fixtures, Rust unit tests, TypeScript parity tests, release APK build, and physical-device verification.
5. Record each shipped module in its own feature change or task set; do not mark this architecture complete based only on source edits.
6. After Android is stable, add iOS binding generation using the same wrapper contract.

## Open Questions

- Should Android start with generated UniFFI Kotlin bindings for every new module, or should some existing JNI/C ABI modules stay as-is until they need cross-platform binding generation?
- Which current native cores should be consolidated later, and which should remain separate because they have independent security/performance profiles?
