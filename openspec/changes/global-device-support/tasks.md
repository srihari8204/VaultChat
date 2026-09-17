## 0. Scope and baseline

- [x] 0.1 Record the pre-change baseline: run `npx tsc --noEmit` and `npm test`, and note the current counts for the two ratchets (files importing `Text` directly from `react-native`; hardcoded user-visible strings). These numbers become the ratchet budgets in task 6.
      **Baseline 2026-09-17**: `tsc` exit 0; `npm test` ALL SUITES PASSED (300/300, 222 suites, 78 embedded). Ratchets: **101** files importing `Text` directly from `react-native`; **6** files importing `AppText`. Related counts: **42** files importing `StatusBar` from `react-native` outside `_layout` (51 JSX usages, 42 hardcoded `barStyle="light-content"`); **64** files consuming the layout constants.
- [x] 0.2 Confirm all six existing guardrails pass before any edit: `themeCoverage`, `responsiveCoverage`, `responsiveLayout`, `a11yCoverage`, `startupColdPath`, `socketPersistentListeners`. — all six green at baseline.
- [ ] 0.3 Owner decision required before task 5.1: keep-and-reroute or delete the `permissions` → `biometric-setup` → `security-questions` chain (design.md, Open Questions). Do not start task 5.1 without it.
- [ ] 0.4 No backend change and no SQL migration in this change. Prod migration number is unchanged at 122. Nothing under `vaultchat-backend*/` is touched; no file copy to prod is required for tasks 1-6.

## 1. Foundation — window-reactive insets and breakpoints

- [x] 1.1 Convert `constants/layout.ts` so `TOP_INSET`, `BOTTOM_INSET`, `IS_NARROW`, `IS_SHORT`, `HEADER_TOP`, `SCREEN_BOTTOM` and `TAB_BAR_SPACE` are read from the live window instead of module scope. Keep the existing names. Correct the in-file comment that claims a foldable re-launches the activity — `AndroidManifest.xml` `configChanges` includes `screenSize|screenLayout|smallestScreenSize`, so it does not.
      **Done differently from the plan, and the plan was wrong.** A hook is impossible here: 62 of 64 consumers read these from inside `StyleSheet.create`/`makeStyles`, where no hook can be called — the original author documented exactly this and was right. Instead the values became live `let` bindings (ES live bindings, so importers see current values) plus `syncLayoutMetrics()`, which recomputes them and returns a generation number only when something actually moved.
- [x] 1.2 ~~Migrate every consumer to the hook form~~ — **not done, and not needed.** 53 of 64 consumers build styles via `useMemo(() => makeStyles(colors), [colors])`, so giving `colors` a fresh identity re-runs the factory and re-reads the refreshed bindings. `lib/theme.tsx` now drives that from `useSafeAreaInsets()` + `useWindowDimensions()` in a `useMemo` (not an effect — an effect runs after paint, so the first frame after a rotation would be stale). **Two files changed instead of 62; zero screens touched.**
      **Ponytail ceiling**: the other 11 consumers use a module-scope `StyleSheet.create` and still snapshot once. Listed in `lib/layoutMetrics.selftest.ts`; 10 are single-purpose onboarding/auth screens and 3 of those are the orphaned chain in task 5.1. Convert one to the factory pattern if it ever needs to be correct in landscape.
- [x] 1.3 Extend `lib/responsiveCoverage.selftest.ts` to walk `constants/` as well as `app/` and `components/`, so the foundation itself is covered by the module-scope `Dimensions` rule. — also broadened its regex from `^const` to `^(const|let|var)`: the `let` change would otherwise have slipped past the guard by accident, and a mutable binding nothing refreshes is still frozen. `constants/layout.ts` carries a documented exemption explaining it is the bootstrap value, not a violation.
- [x] 1.4 Add an assert-based selftest asserting insets and breakpoints are derived per-render, not captured once. — `lib/layoutMetrics.selftest.ts`, 16 assertions: the five bindings are `let`, the sync is idempotent, exactly one driver, it runs in `useMemo` not `useEffect`, `colors` identity is keyed to the generation, and `configChanges` still contains the attributes that make the premise true.
- [ ] 1.5 **Written → verified**: `npx tsc --noEmit` clean, full `npm test` at or above the task 0.1 baseline, and all six guardrails still passing.
- [ ] 1.6 **Device-verified**: on both reference devices — rotate portrait↔landscape on a self-drawn-header screen and a bottom-pinned-action screen, and confirm chrome repositions with no restart. This task is not done until this is observed on hardware.
- [ ] 1.7 Land task 1 alone. Do not begin task 2 until 1.6 passes, so any regression is attributable to this single file.

## 2. Chrome ownership — status bar and keyboard

- [ ] 2.1 Remove the `react-native` `StatusBar` import and its usage from the 42 screens that override the root bar; `app/_layout.tsx` becomes the only owner. Drop the 14 `backgroundColor`/`translucent` props that are no-ops on targetSdk 35+.
- [ ] 2.2 Add a guardrail asserting no file outside `app/_layout.tsx` imports `StatusBar` from `react-native`, with a documented-exemption mechanism matching the existing selftest idiom.
- [ ] 2.3 Fix `app/security-questions.tsx` — replace `behavior={undefined}` (inert on Android) with the shared `KeyboardSafe`. Account recovery must keep the focused field and its submit control visible.
- [ ] 2.4 Route the 5 `behavior='padding'`-inside-`Modal` composers through `KeyboardSafe`: `app/family.tsx` (3 sheets), `app/group-notes.tsx`, `app/group-calendar.tsx`. A React Native `Modal` is its own window and never receives the activity's `adjustResize`.
- [ ] 2.5 Route the 25 modals that hold a `TextInput` with no keyboard handling, starting with the status composer in `app/(tabs)/status.tsx` (daily-use path).
- [ ] 2.6 Add a guardrail rejecting a keyboard-avoiding wrapper whose behaviour resolves to `undefined` on Android.
- [ ] 2.7 Add `hitSlop` to the sub-30 dp controls with none: PiP close (22×22), transfer cancel (24×24), vaultdrop remove (24×24), and the 28-36 dp group.
- [ ] 2.8 **Written → verified**: typecheck, full suite, guardrails green.
- [ ] 2.9 **Device-verified**: on both devices, in light *and* dark theme — status-bar icons legible on every migrated screen; keyboard does not cover the recovery field, the family sheets, or the status composer.

## 3. Overflow — rows of fixed-width children

- [ ] 3.1 `app/group-call-active.tsx` — the control row needs 552 dp on a 369 dp screen, so Mute and End call are physically off-screen today (shipping path: `CALL_ENGINE_V2 = true`). Make the row wrap. Verify every control is reachable with the maximum control count.
- [ ] 3.2 `app/call-recording.tsx` — the action row needs ~402 dp; the Delete button is clipped at 369 dp. Wrap, or shorten the label that dominates the width.
- [ ] 3.3 `components/chat/chatStyles.ts` — media/file/video cards are `width: 240` in a 241.1 dp slot (1.1 dp headroom; clips at 360 dp). Size relative to the container, which already caps at a percentage of row width.
- [ ] 3.4 `components/GifPicker.tsx` — the one tab row whose children do not flex; bring it in line with the flex pattern used by the other 14 tab rows.
- [ ] 3.5 Add a guardrail for the class: a row laying out a variable number of fixed-width children must wrap, scroll, or flex.
- [ ] 3.6 **Device-verified at 320 dp**: emulate a 320 dp-wide window and confirm the group-call control set, including End call, is fully on-screen at the maximum control count.

## 4. Typography — shared component becomes authoritative

- [ ] 4.1 `components/ui/Text.tsx` — a caller `fontWeight` must no longer change which typeface resolves. Android matches asset fonts by filename, so a weight with no bundled file silently falls back to the system font; select the bundled face that carries the requested weight instead.
- [ ] 4.2 Fix the 22 sites that currently defeat the brand face, starting with `components/ui/ChatRow.tsx` (the chat list changes typeface between read and unread), the tab bar, and `components/ui/Avatar.tsx`.
- [ ] 4.3 Reference bundled faces by names that resolve on both platforms; the current names resolve on Android only and would fall back to the system font on iOS. See design.md Open Questions on whether the iOS scenario can be exercised.
- [ ] 4.4 Add a guardrail failing when the type scale references a weight with no corresponding bundled file.
- [ ] 4.5 Point `components/chat/chatStyles.ts` at the type scale — highest screens-fixed per line-touched in the repo. Do not migrate the remaining direct-`Text` files in this change; the ratchet in task 6 governs them.
- [ ] 4.6 Remove the stale typography surface: the unused `@expo-google-fonts` dependencies, the inert `react-native.config.js` assets key, the second type scale in `components/themed-text.tsx` (migrating its one consumer), and the comments describing a runtime font load that no longer happens.
- [ ] 4.7 **Device-verified**: on both devices at OS font scale 1.0 and 1.5 — chat list typeface identical for read and unread rows, no clipped labels.

## 5. Route integrity — reroute or delete, nothing left unrouted

- [ ] 5.1 Act on the task 0.3 decision for `app/permissions.tsx`, `app/biometric-setup.tsx`, `app/security-questions.tsx`. If kept, wire a real entry point and cover it; if deleted, remove their now-unreferenced imports. Either way the copy "Skip — grant later in settings" must name a destination that exists, or be changed to describe what actually happens.
- [ ] 5.2 Delete `utils/notifications.ts` — a duplicate notification-permission implementation with zero importers, superseded by `lib/push.ts`.
- [ ] 5.3 `app/(tabs)/chats.tsx` — the long-press action sheet is unreachable and holds `doFavourite`, the **only** un-favourite path in the app. Rewire it to a reachable control; the capability is otherwise absent from the product.
- [ ] 5.4 `app/(tabs)/mini.tsx` — the calculator (~150 lines, 4 `useState`) is unreachable because nothing passes `'calculator'` to the open handler. Reroute if wanted, delete if not.
- [ ] 5.5 Add a route-coverage guardrail: every route file is reachable from at least one navigation path or carries a documented exemption.
- [ ] 5.6 **Written → verified**: typecheck, full suite, guardrails green; confirm no dead imports remain from any deletion.

## 6. Guardrail ratchets and localization contract

- [ ] 6.1 Record the task 0.1 counts as ratchet budgets: direct `Text` imports, and hardcoded user-visible strings. Each fails on an increase and lowers on improvement.
- [ ] 6.2 Tighten `lib/themeCoverage.selftest.ts` so the black/white text exemption requires an adjacent non-themed `backgroundColor`. This is the rule that would have caught the mini-apps tab rendering black text on a dark themed surface.
- [ ] 6.3 Add the direction-aware layout guardrail: flag `marginLeft`/`marginRight`/`paddingLeft`/`paddingRight`/`left`/`right` in direction-sensitive contexts, with documented exemptions. `lib/i18n/engine.ts` remains the single source of direction.
- [ ] 6.4 Fix `app/(tabs)/mini.tsx`'s 11 hardcoded `#000000` text colours on themed dark surfaces — the bug 6.2 pins.
- [ ] 6.5 **Written → verified**: full suite green with all new guardrails active; every new rule has a runnable assert-based selftest and none uses `require('fs')` in app code.

## 7. Ponytail review and close-out

- [ ] 7.1 Ponytail review of the whole diff: confirm no new abstraction, dependency or config was introduced where an existing one sufficed, and that every change removes a class of bug rather than one instance of it.
- [ ] 7.2 Confirm scope discipline: no unrelated optimization rode along. Cold-start work, CC-Wire, E2EE, money, call signalling and `FLAG_SECURE` are untouched.
- [ ] 7.3 Mark any deliberate shortcut with a `ponytail:` comment naming the ceiling and the upgrade path.
- [ ] 7.4 Final verification on both reference devices plus emulated 320 dp and 600 dp, at font scale 1.0 and 1.5, in light and dark: no clipped control, no covered input, no illegible status bar, no unrouted screen.
- [ ] 7.5 Sync the delta specs into `openspec/specs/` only once the behaviour is device-verified per 7.4 — not at merge.
