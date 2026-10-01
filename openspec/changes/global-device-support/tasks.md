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

- [ ] 2.1 Remove the `react-native` `StatusBar` import and its usage from the screens that
      override the root bar; `app/_layout.tsx` becomes the only owner. Drop the
      `backgroundColor`/`translucent` props that are no-ops on targetSdk 35+.
      **COUNT CORRECTED 2026-10-02: 21 screens, not 42** — about half have already been
      migrated by other work. Re-count before estimating.
- [ ] 2.2 Add a guardrail asserting no file outside `app/_layout.tsx` imports `StatusBar` from `react-native`, with a documented-exemption mechanism matching the existing selftest idiom.
- [x] 2.3 Fix `app/security-questions.tsx` — replace `behavior={undefined}` (inert on Android) with the shared `KeyboardSafe`. Account recovery must keep the focused field and its submit control visible.
      The gradient stays OUTSIDE the wrapper: `KeyboardSafe` avoids by padding, and an `absoluteFillObject` child resolves against the parent's PADDING box, so a background placed inside would be clipped by the keyboard inset. `keyboardOnly` because the CTA is inside a `flexGrow` ScrollView that already has `keyboardShouldPersistTaps`.
- [x] 2.4 Route the 5 `behavior='padding'`-inside-`Modal` composers through `KeyboardSafe`: `app/family.tsx` (3 sheets), `app/group-notes.tsx`, `app/group-calendar.tsx`. A React Native `Modal` is its own window and never receives the activity's `adjustResize`.
      **A 6th site of the same class was found and fixed**: the media-caption composer in `app/chat.tsx` (`behavior={'padding'}` inside a full-screen `Modal`) — the caption field and Send button were covered on Android. Same three-line swap, plus its now-unused `KeyboardAvoidingView` import.
- [x] 2.5 Route the 25 modals that hold a `TextInput` with no keyboard handling, starting with the status composer in `app/(tabs)/status.tsx` (daily-use path).
      Finished. Last five were `app/shop-book.tsx` (4: suggest-alternative, decline-return, add-item, and the shared `ReasonModal` reached from reject / cancel / not-collected) and the edit sheet in `app/family-places.tsx`. The shop-book four are vertically centred cards, so `KeyboardSafe` alone was not enough: "Add an item" needs ~430 dp at OS font scale 1.5, more than a 320 dp phone leaves once the keyboard is up. Each got `KeyboardSafe keyboardOnly` **plus** a ScrollView on a new `modalScroll` (`flexGrow: 1, justifyContent: 'center'`) — centred while it fits, scrollable the moment it does not, so the submit control is always reachable. `components/call/CallChatSheet.tsx` is not converted and does not need to be: it lifts its sheet by the measured keyboard height, which is the same fix by hand; it carries an in-place `keyboard-exempt:` note because the listener sits outside the `<Modal>` block where a source scan cannot see it.
- [x] 2.6 Add a guardrail rejecting a keyboard-avoiding wrapper whose behaviour resolves to `undefined` on Android.
      `lib/keyboardAvoidance.selftest.ts`, 5 assertions. Rule 1 is the one asked for: every `<KeyboardAvoidingView>` in `app/` and `components/` must carry a `behavior` that cannot resolve to `undefined` — a missing prop counts, since the default is `undefined` and RN's `default:` branch returns a plain View. Rule 2 is the ratchet that keeps 2.4 and 2.5 from regressing: a `<Modal>` holding a `<TextInput>` must handle the keyboard inside the block. Rules 3-4 pin the account-recovery repair and the padding-not-transform premise `KeyboardSafe` rests on. Comments are blanked before scanning (newlines preserved, so line numbers stay true) because every repaired site quotes the broken expression it replaced. Opt out in place with `keyboard-exempt:`.
      **Seen to fail**: reverted 2.3 in a scratch copy of `app/`+`components/` and ran it there — `AssertionError: KeyboardAvoidingView with a behaviour that is inert on Android — use components/ui/KeyboardSafe instead: app/security-questions.tsx:31  behavior can resolve to undefined: {Platform.OS==="ios"?"padding":undefined}`. Rule 2 was also seen to fail, on the two real sites it then found (`family-places` edit sheet, `CallChatSheet`).
      Fixed on the way: `components/games/Rummy.tsx` was the last live `behavior: undefined` site (the table-code field) and is now `KeyboardSafe`.
- [x] 2.7 Add `hitSlop` to the sub-30 dp controls with none: PiP close (22×22), transfer cancel (24×24), vaultdrop remove (24×24), and the 28-36 dp group.
      30 `hitSlop` props across 17 files. Sized per control rather than one blanket number: `hitSlop = ceil((44 - dp) / 2)`, so every one of them reaches a 44 dp target — 11 on the 22 dp PiP close and status background swatch, 10 on the 24 dp transfer cancel and vaultdrop remove, 9/8/7/6/4 on the 26/28/30/32/36 dp group. A uniform value would have overlapped neighbours in the swatch rows for no gain. Controls already at 38-42 dp were left alone; they are named nowhere in this task and a blanket sweep would have overlapped the 40 dp header-button rows.
- [ ] 2.8 **Written → verified**: typecheck, full suite, guardrails green.
- [ ] 2.9 **Device-verified**: on both devices, in light *and* dark theme — status-bar icons legible on every migrated screen; keyboard does not cover the recovery field, the family sheets, or the status composer.

## 3. Overflow — rows of fixed-width children

- [x] 3.1 `app/group-call-active.tsx` — the control row needs 552 dp on a 369 dp screen, so Mute and End call are physically off-screen today (shipping path: `CALL_ENGINE_V2 = true`). Make the row wrap. Verify every control is reachable with the maximum control count.
      **Already repaired on 2026-09-17; re-verified rather than re-done.** `controls` carries `flexWrap: 'wrap'`, and the bar's height is MEASURED via `onLayout` rather than the old literal 110, so `CallExtras` no longer lands on top of the first row of controls. Maximum count checked, not the typical one: 7 controls render (mic, camera, flip, speaker, hand, invite, end) when the call is video AND has a free seat — `SFU_MAX` is 64, so that is the normal case. At 320 dp the row is 4 + 3; at 369 dp 4 + 3; End call is on the last line either way.
- [x] 3.2 `app/call-recording.tsx` — the action row needs ~402 dp; the Delete button is clipped at 369 dp. Wrap, or shorten the label that dominates the width.
      **Already repaired on 2026-09-17; re-verified.** `actionRow` wraps. Measured demand is 324 dp, not 402: the four `actionBtn`s are `minWidth: 72` with a 12 dp gap (4×72 + 3×12). That still overflows the 320 dp floor, so the wrap is required — but the figure in this task was high. `flex: 1` is correctly rejected in the in-file note: at 320 dp it would hand each button 59 dp, under its own 72 dp floor.
- [x] 3.3 `components/chat/chatStyles.ts` — media/file/video cards are `width: 240` in a 241.1 dp slot (1.1 dp headroom; clips at 360 dp). Size relative to the container, which already caps at a percentage of row width.
      **Was half-done, and the arithmetic behind it was wrong.** The 2026-09-17 pass added `chatCardMax(width)` = `0.78*W - 28`, which omits the message list's own 12 dp gutter — but `maxWidth: '78%'` resolves against `bubbleRow` INSIDE that padded list, not against the window. So every slot was 18-19 dp too generous and a 240 dp card still overhung at the 320 dp floor. Corrected to `0.78*(W-24) - padH*2`, which reproduces the 241 dp measured on the 369 dp Honor — the number this task carries — where the old formula said 259. Second gap: `videoWrap`/`videoLoading` were still a literal `240×240`, excused by an in-file claim that media bubbles were "already sized to fit"; a media bubble's slot is 224 dp at 320 dp, so the player overhung by 16 dp and took its duration pill off-screen with it. Both now `Math.min(240, m.cardMax)`. `chatCardMax` gained an optional `padH` (3 for `mediaBubble`, 14 for a text bubble) rather than a second metric threaded through `ChatMetrics`. Pinned values in `lib/layoutMetrics.selftest.ts` moved with the formula, comment and numbers together; +3 checks there.
- [x] 3.4 `components/GifPicker.tsx` — the one tab row whose children do not flex; bring it in line with the flex pattern used by the other 14 tab rows.
      `tab` gains `flex: 1, alignItems: 'center', justifyContent: 'center'`, the identical shape used by `app/chat-code.tsx` and `app/media-gallery.tsx`. No new pattern, no new token. The three pills previously sized themselves from their labels ("Stickers" widest) with fixed `paddingHorizontal`, so they were the row that breaks first as the OS font scale grows.
- [x] 3.5 Add a guardrail for the class: a row laying out a variable number of fixed-width children must wrap, scroll, or flex.
      `lib/rowOverflow.selftest.ts`, 7 assertions, auto-discovered by `scripts/test-all.js`. Section 1 is the class: for every non-wrapping, non-scrolling row style it resolves each child's pinned width three ways — a referenced style, an inline style, and **a component defined in the same file that pins its own width** — then fails when `n×w + (n-1)×gap > 320`. The third resolution path is the point: `CtrlBtn` hides `width: 60` in its own body, which is why no width grep ever found the group-call bug. Currently 0 findings repo-wide.
      **Seen to fail, per revert, in a scratch copy** (`app/`+`components/`+`constants/`+`lib/` copied out; no shared source mutated):
      · revert 3.1 → section 1: `app/group-call-active.tsx controls: 7 x 60dp + 6 x 22dp gap = 552dp > 320dp` — reproduces this task's own 552 figure from source.
      · revert 3.2 → section 1: `app/call-recording.tsx actionRow: 4 x 72dp + 3 x 12dp gap = 324dp > 320dp`.
      · revert 3.3 (video back to 240) → section 2b: `videoWrap is capped by the bubble slot, not a literal 240`.
      · revert 3.3 (gutter back out of `chatCardMax`) → `lib/layoutMetrics.selftest.ts`, 8 checks including `a 369dp window gives a 241dp card slot`.
      · revert 3.4 → section 2a: `GifPicker tabs share the row instead of sizing to their labels`.
      Two limits are stated in the file header rather than hidden: a child component imported from another file is not resolvable without a module graph, and `.map`ped children are counted literally (inflating them to an unbounded count flagged ~50 rows of 8 dp dots and 26 dp avatars, so the check would not have stayed green, and a guard nobody can keep green is not a guard). Those two gaps are what section 2's hand-written pins cover.
- [ ] 3.6 **Device-verified at 320 dp**: emulate a 320 dp-wide window and confirm the group-call control set, including End call, is fully on-screen at the maximum control count.
      **Not done — needs hardware, and nothing below substitutes for it.** What is established without a device: the row demands 552 dp at 7 controls and wraps to 4+3 at 320 dp; `CallExtras` is offset by the measured bar height rather than a literal, so the second line cannot be overdrawn; the sibling above is a `ScrollView`, so it yields the ~82 dp the extra line needs. What a scan cannot show is whether the wrapped bar plus the tile grid still fits vertically at 320×534 with the OS font scale at 1.5, and whether End call lands where a thumb reaches. Run `adb shell wm size 320x534 && adb shell wm density 160` on the Honor, join a video group call with a free seat (all 7 controls), and check every control in light and dark.

## 4. Typography — shared component becomes authoritative

- [ ] 4.1 `components/ui/Text.tsx` — a caller `fontWeight` must no longer change which typeface resolves. Android matches asset fonts by filename, so a weight with no bundled file silently falls back to the system font; select the bundled face that carries the requested weight instead.
- [ ] 4.2 Fix the 22 sites that currently defeat the brand face, starting with `components/ui/ChatRow.tsx` (the chat list changes typeface between read and unread), the tab bar, and `components/ui/Avatar.tsx`.
- [ ] 4.3 Reference bundled faces by names that resolve on both platforms; the current names resolve on Android only and would fall back to the system font on iOS. See design.md Open Questions on whether the iOS scenario can be exercised.
- [ ] 4.4 Add a guardrail failing when the type scale references a weight with no corresponding bundled file.
- [ ] 4.5 Point `components/chat/chatStyles.ts` at the type scale — highest screens-fixed per line-touched in the repo. Do not migrate the remaining direct-`Text` files in this change; the ratchet in task 6 governs them.
- [~] 4.6 Remove the stale typography surface. **THREE OF FOUR DONE 2026-10-02.**
      - [x] The unused `@expo-google-fonts/{nunito-sans,sora}` dependencies — removed from
        `package.json`. Nothing imported them; the five `.ttf` files are committed under
        `assets/fonts/` and are the real source now.
      - [x] `components/themed-text.tsx` and its second type scale — **deleted**. The task
        says "migrating its one consumer"; by 2026-10-02 it had ZERO importers (the only
        remaining mentions are a regex and comments in `lib/a11yCoverage.selftest.ts`), so
        there was nothing to migrate.
      - [x] The comments describing a runtime font load — corrected in `constants/theme.ts`.
        They claimed the fonts are "loaded in the root layout (U2)" and that the names match
        "@expo-google-fonts exports", while `lib/startupColdPath.selftest.ts:89` actively
        ASSERTS the root layout does not import them. Fonts are embedded at build time by
        the `expo-font` config plugin, so there is no load and no fallback window.
      - [ ] The `react-native.config.js` `assets: ['./assets/fonts']` key — **NOT removed,
        deliberately, and it is not merely inert: it DUPLICATES every brand font in the
        APK.** Measured in the shipped artifact: each of the five fonts appears twice, once
        under `assets/fonts/` and once as a `res/*.ttf` resource, with byte-identical sizes
        (113,232 / 113,340 / 113,328 / 57,936 / 57,980) — about **445 KB** of duplication.
        Removing the key should reclaim it, but `expo-font` and the legacy
        react-native-asset path register fonts through different Android mechanisms, so
        getting it wrong loses the brand typeface app-wide and silently falls back to the
        system font. That makes this task 4.7's problem, not a desk change: remove the key,
        rebuild, and confirm the typeface on a device before believing it.
- [ ] 4.7 **Device-verified**: on both devices at OS font scale 1.0 and 1.5 — chat list typeface identical for read and unread rows, no clipped labels.

## 5. Route integrity — reroute or delete, nothing left unrouted

- [ ] 5.1 Act on the task 0.3 decision for `app/permissions.tsx`, `app/biometric-setup.tsx`, `app/security-questions.tsx`. If kept, wire a real entry point and cover it; if deleted, remove their now-unreferenced imports. Either way the copy "Skip — grant later in settings" must name a destination that exists, or be changed to describe what actually happens.
- [x] 5.2 Delete `utils/notifications.ts` — **already done** (verified 2026-10-02: the file does not exist). Superseded by `lib/push.ts`.
- [x] 5.3 ~~`app/(tabs)/chats.tsx` — the long-press action sheet is unreachable and holds
      `doFavourite`, the **only** un-favourite path in the app.~~ **ALREADY FIXED 2026-09-17**
      (verified 2026-10-02). `chats.tsx:495-503` carries the dated reasoning: `setFavourite(id,
      false)` was unreachable, so nothing could un-favourite a chat and the Favourites folder
      filled up; the action is now a TOGGLE — if everything selected is already a favourite it
      removes them. The symbol `doFavourite` no longer exists. The task was closed by a commit
      that never updated this file, which is the pattern `docs/BACKLOG_REBASELINE.md` documents.
- [x] 5.4 `app/(tabs)/mini.tsx` — the calculator (~150 lines, 4 `useState`) is unreachable because nothing passes `'calculator'` to the open handler. Reroute if wanted, delete if not.
- [ ] 5.5 Add a route-coverage guardrail: every route file is reachable from at least one navigation path or carries a documented exemption.
- [ ] 5.6 **Written → verified**: typecheck, full suite, guardrails green; confirm no dead imports remain from any deletion.

## 6. Guardrail ratchets and localization contract

- [ ] 6.1 Record the task 0.1 counts as ratchet budgets: direct `Text` imports, and hardcoded user-visible strings. Each fails on an increase and lowers on improvement.
- [ ] 6.2 Tighten `lib/themeCoverage.selftest.ts` so the black/white text exemption requires an adjacent non-themed `backgroundColor`. This is the rule that would have caught the mini-apps tab rendering black text on a dark themed surface.
- [ ] 6.3 Add the direction-aware layout guardrail: flag `marginLeft`/`marginRight`/`paddingLeft`/`paddingRight`/`left`/`right` in direction-sensitive contexts, with documented exemptions. `lib/i18n/engine.ts` remains the single source of direction.
- [x] 6.4 Fix `app/(tabs)/mini.tsx`'s 11 hardcoded `#000000` text colours on themed dark surfaces — the bug 6.2 pins.
- [ ] 6.5 **Written → verified**: full suite green with all new guardrails active; every new rule has a runnable assert-based selftest and none uses `require('fs')` in app code.

## 7. Ponytail review and close-out

- [ ] 7.1 Ponytail review of the whole diff: confirm no new abstraction, dependency or config was introduced where an existing one sufficed, and that every change removes a class of bug rather than one instance of it.
- [ ] 7.2 Confirm scope discipline: no unrelated optimization rode along. Cold-start work, CC-Wire, E2EE, money, call signalling and `FLAG_SECURE` are untouched.
- [ ] 7.3 Mark any deliberate shortcut with a `ponytail:` comment naming the ceiling and the upgrade path.
- [ ] 7.4 Final verification on both reference devices plus emulated 320 dp and 600 dp, at font scale 1.0 and 1.5, in light and dark: no clipped control, no covered input, no illegible status bar, no unrouted screen.
- [ ] 7.5 Sync the delta specs into `openspec/specs/` only once the behaviour is device-verified per 7.4 — not at merge.
