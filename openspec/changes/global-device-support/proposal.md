## Why

VaultChat targets millions of users across every Android form factor, but the layout system it already owns is **frozen at launch and adopted by a minority of screens**. `constants/layout.ts` computes `TOP_INSET`, `BOTTOM_INSET`, `IS_NARROW` and `IS_SHORT` at module scope and justifies it in-file with "a foldable re-launches the activity" — which is false for this app: `AndroidManifest.xml` declares `configChanges="…|screenSize|screenLayout|smallestScreenSize"`, so the activity is **never** recreated on rotate, fold, or split-screen. Every inset and breakpoint is therefore fixed for the process lifetime, and `edgeToEdgeEnabled=true` (`android/gradle.properties:46`) applies that to **every Android version**, not just 15+.

On top of that foundation, audits across 169 screens found the correct tools exist and are simply bypassed: 113 of 192 `app/` files use neither `HEADER_TOP` nor safe-area insets, 42 screens override the single theme-aware status bar, 128 files import `Text` straight from React Native instead of the type scale, and one shipping call screen puts Mute and End-call physically off-screen on a 369 dp device.

Two devices were measured (369 dp / Android 16, 393 dp / Android 11) and they already diverge. Real-world breadth — 320 dp to 600 dp+, Android 7 through 16, OS font scale to 1.5, light and dark, future RTL — is untested and, in several places, structurally impossible to satisfy.

## What Changes

**Already built (reuse, do not rebuild):** `constants/layout.ts` (`HEADER_TOP`/`SCREEN_BOTTOM`/`TAB_BAR_SPACE`), `components/ui/KeyboardSafe.tsx` + `lib/useKeyboardInset.ts`, `components/ui/Text.tsx` (`AppText`) + `lib/typeScale.ts`, `constants/theme.ts` (`Palette`, `TYPOGRAPHY`, `AuroraDark`/`AuroraLight`), `lib/i18n/engine.ts` (RTL-aware), `SafeAreaProvider` (supplied by expo-router), and six passing source-scan guardrails (`themeCoverage`, `responsiveCoverage`, `responsiveLayout`, `a11yCoverage`, `startupColdPath`, `socketPersistentListeners`).

- **BREAKING (internal)**: `constants/layout.ts` module-scope constants become hook-based reads so insets and breakpoints track the live window. Call sites that destructure the constants must move to the hook.
- Replace 9 hardcoded 48–56 dp status-bar paddings with `HEADER_TOP`; give the 60 literal `bottom:` offsets a real bottom inset, starting with the primary actions that currently sit under the gesture bar.
- Remove `StatusBar` from the 42 screens that import it from `react-native`; the theme-aware bar in `app/_layout.tsx` becomes the only one. Drop the 14 `backgroundColor` props that are no-ops on targetSdk 35+.
- Route the account-recovery screen, the 5 `behavior='padding'`-inside-`Modal` composers, and the 25 unhandled modal `TextInput`s through the existing `KeyboardSafe`.
- Fix the "N fixed-width children in a non-wrapping row" class: `group-call-active.tsx` controls (552 dp needed vs 369 dp available — **Mute and End-call are off-screen today**), `call-recording.tsx` action row, and the `width: 240` chat media cards sitting in a 241.1 dp slot.
- Make `AppText` authoritative: caller `fontWeight` can no longer silently swap the brand face to Roboto, and font families resolve on iOS as well as Android. Begin type-scale adoption at the highest-traffic shared stylesheets rather than across all 128 files.
- **Reroute or delete every orphaned path** — the `permissions` → `biometric-setup` → `security-questions` chain, `utils/notifications.ts`, the `mini.tsx` calculator, and the `chats.tsx` long-press sheet that holds the app's **only** un-favourite action. Nothing is left unrouted.
- Extend the existing guardrails so each fixed class cannot regress: no `StatusBar` import outside `_layout.tsx`; the black/white text exemption requires an adjacent non-themed background; a fixed-width-children-in-a-row check; an `AppText` adoption ratchet.

**Not building**: no new layout library or design-system package (`react-native-edge-to-edge` is correctly absent — RN 0.81 handles this natively); no new theming abstraction; no rewrite of `typeScale`/`responsive`; no per-screen redesign; no RTL locale content; no iOS CallKit (tracked separately); no changes to CC-Wire, E2EE, money, `FLAG_SECURE`, or the road-distance rule.

## Capabilities

### New Capabilities
- `device-layout`: window-reactive insets and breakpoints, safe-area contract for self-drawn headers and bottom-pinned chrome, and the overflow rule for rows of fixed-width children.
- `app-chrome`: single-owner status bar and keyboard-avoidance contract across all screens and modals.
- `typography-system`: `AppText`/type-scale authority, brand-font resolution on both platforms, and OS font-scale behaviour up to 1.5.
- `route-integrity`: every screen and module is either reachable by a defined route or removed; no orphaned duplicates.

### Modified Capabilities
- `localization`: extends the existing capability to state the RTL layout contract and the breadth target, since `lib/i18n/engine.ts` already carries RTL but no screen honours direction-aware layout.

## Impact

- **Code**: `constants/layout.ts` (foundation, highest blast radius), `app/_layout.tsx`, `components/ui/{Text,KeyboardSafe}.tsx`, `constants/theme.ts`, ~42 screens dropping `StatusBar`, ~9 headers, ~30 keyboard sites, 4 overflow sites, 4 orphaned paths.
- **Guardrails**: `lib/{themeCoverage,responsiveCoverage,responsiveLayout,a11yCoverage}.selftest.ts` extended; all must stay green. New assert-based selftests accompany each new rule — no `require('fs')` in app code.
- **Risk**: the `constants/layout.ts` change is the one with real blast radius; every other item is additive or a deletion. Sequenced first and landed alone so a regression is attributable.
- **Not affected**: backend, migrations, CC-Wire transport, E2EE, call signalling, money paths, `FLAG_SECURE`.
- **Verification**: measured on both reference devices plus emulated 320 dp / 600 dp and font scale 1.5; each task carries a runnable check.
