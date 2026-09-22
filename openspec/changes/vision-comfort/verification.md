# Vision Comfort verification and client manifest

## Client source inventory

The following are the exact changed client/runtime paths for this change. No backend files are changed or copied. SQL migration: none.

- `app/(tabs)/_layout.tsx`
- `app/(tabs)/alerts.tsx`
- `app/(tabs)/calls.tsx`
- `app/(tabs)/chats.tsx`
- `app/(tabs)/mini.tsx`
- `app/(tabs)/profile.tsx`
- `app/(tabs)/status.tsx`
- `app/_layout.tsx`
- `app/chat.tsx`
- `app/eye-check.tsx`
- `app/settings.tsx`
- `app/vision-comfort.tsx`
- `components/chat/MessageBubble.tsx`
- `components/chat/chatStyles.ts`
- `components/ui/GlassView.tsx`
- `components/ui/Text.tsx`
- `constants/layoutMath.ts`
- `lib/cloudBackup.ts`
- `lib/eyeCheckModel.ts`
- `lib/theme.tsx`
- `lib/visionComfort.tsx`
- `lib/visionComfortModel.ts`

Changed source checks, not client runtime modules:

- `lib/appTextRendering.selftest.ts`
- `lib/eyeCheckModel.selftest.ts`
- `lib/layoutMetrics.selftest.ts`
- `lib/responsiveLayout.selftest.ts`
- `lib/visionComfort.selftest.ts`

## Source verification

- `npm run typecheck`: passed after the numeric screen-score and report-to-profile preview edits.
- `npm run lint`: passed with 0 errors and 266 repository warnings; focused lint of the Eye Check screen and model passed with 0 errors.
- `npm test`: 350/351 suites passed before the latest report-to-profile preview edit. The remaining `lib/chatsDeltaProto.selftest.ts` account-switch assertions fail when run alone; this change did not edit that suite or its sync engine. Focused `eyeCheckModel` and `visionComfort` selftests passed again after the latest edit; the full suite was not rerun for the UI-only edit. An earlier full run caught the white chart field and calibration track layout test; both were fixed before the final full rerun.
- Focused `eyeCheckModel`, `visionComfort`, `appTextRendering`, `responsiveLayout`, `layoutMetrics`, and `backupScheduler` selftests passed.
- `openspec validate vision-comfort --strict`: passed.
- `git diff --check`: passed.
- Ponytail review: no new dependency or broad abstraction. The content and scoring rules are in `eye-check-content.md`.

## Android release artifact

### Current signed screen-index build (2026-09-22 10:11:52 UTC)

- ARM64 APK at `android/app/build/outputs/apk/release/app-release-arm64-v8a.apk`: 95,265,359 bytes; SHA-256 `049054BFD55B24B11D048FDD72AD67976C9C5BF0BD3B0B2F5CF284D6CEB03F58`. `assembleRelease` succeeded with Sentry source-map upload disabled locally because the Sentry organization is not configured. The APK installed on Honor ELI-NX9.
- Honor UIAutomator completed sixteen `I can't see the gap` answers for each eye and confirmed the interim result includes `Screen clarity index: -4 points` alongside `0/16` and the screen-only caution. This is a direct remapping of C-gap answers, not an eye-power estimate. A full four-section run passed on the prior build below; the final summary on this APK was not separately traversed.
- Focused `eyeCheckModel` selftest covers 0, 8, 14 and 16 correct answers mapping to -4, 0, +3 and +4 points. TypeScript, focused ESLint, strict OpenSpec validation and `git diff --check` passed before the build. The release source map includes the signed-index labels and explicit unmeasured-power note.
- [Figma result frame](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-335) was updated with per-eye signed points and the non-diopter explanation. Its 320x780 screenshot was inspected without clipping. This is a design study, not a device screenshot.

### Prior test-derived-report build (2026-09-22 09:51:13 UTC)

- Prior ARM64 APK: 95,264,479 bytes; SHA-256 `C48879A6DBF7934F652F9A9E6A8212398856F59FB0D1DE1D8A1F13C95FB5EA42`. `assembleRelease` succeeded with Sentry source-map upload disabled locally because the Sentry organization is not configured. The APK installed on Honor ELI-NX9 and the Eye Check route launched.
- The release source map contains “Your screen vision result” and no user-entered known-SPH report field. The result remains the C-gap answer score per eye, with the explicit unmeasured-diopters statement. Full 16-trial native flow was verified on the preceding 16-trial build below; it was not rerun for this heading and field-removal edit.

### 16-trial Eye Check build (2026-09-22 09:28:27 UTC)

- Prior ARM64 APK: 95,264,399 bytes; SHA-256 `3A651534B20C3C68F91E58B8BDBA2DF639CBEDDB444CF948B18F0FE05223B6A9`. Built and installed on Honor ELI-NX9. The release source map contains the 16-trial, 12-detail-level model and the `I can't see the gap` response.
- Honor UIAutomator completed 16 no-gap responses for each eye, six colour plates, the astigmatism and Amsler questions, the separate-eye 0/16 result, and navigation to the unsaved Vision Comfort level-3 preview. Stored settings were not changed.
- A fresh 240 dp/font-scale-1.5 run stopped during navigation to setup, before layout assertions. It did not establish a new 240 dp result for the no-gap button. The device's `wm size` and font scale were restored to 1200x2664 and 1.0; earlier narrow-width checks below apply to the preceding build.
- Focused model selftest, TypeScript typecheck, focused ESLint, strict OpenSpec validation, and `git diff --check` passed after the 16-trial edits. The full repository test suite was not rerun.
- The updated Figma C-gap and result frames reflect 16 trials and the no-gap option; 320 dp frame inspection found no clipping. These are design studies, not native captures or validated medical charts.
- The displayed 0-16 score is a phone-screen response count. It cannot determine eyesight percentage, 20/20 acuity, or positive/negative spectacle power; those require a professional examination and refraction.

- ARM64 release APK: `android/app/build/outputs/apk/release/app-release-arm64-v8a.apk` (built 2026-09-22 09:14:44 UTC; 95,263,595 bytes; SHA-256 `BEA6E410CCFEA33CF0AF7AD51A73CA62E5EFC559C2A926438F939B96E9614558`). `assembleRelease` succeeded. The release source map contains all 22 runtime paths in the inventory above, including the large per-eye screen scores, explicit unmeasured spectacle-power note, report suggestion and profile preview. The APK's Hermes bundle matches the generated bundle byte for byte (SHA-256 `ABCD62CC5FF020818F8F6FB186A580DEA054A6060C2617DF2C136F82F67DEE8E`).
- `adb install -r` succeeded on Honor ELI-NX9, Android 16, preserving app data. On the 09:14 UTC APK, the native UI flow completed the four setup steps, ten C-gap trials for each eye, six colour plates with both eyes open, two semicircle answers, four Amsler answers, the large per-eye score result, and the report-to-Vision-Comfort button. UIAutomator confirmed the suggestion opened an unsaved level 3/6 preview with higher contrast and reduced transparency enabled. The test did not tap Save, so it did not alter the user's stored profile. A prior build check confirmed the exact Telugu disclaimer after scrolling. Native visual capture remains blocked by `FLAG_SECURE`; UIAutomator hierarchy and bounds were used.
- At simulated 320 dp width and 1.5 font scale on Honor, all eight C-gap direction buttons became fully visible and reachable by scrolling; the setup Next and Start controls also remained reachable. All five bottom tab labels and touch regions fit the 1040 px viewport on the final installed APK. The device was restored to 1200×2664 px and font scale 1.0 after each check.
- At simulated 280 dp width (910 px at 520 dpi) and 1.5 font scale on Honor, all eight resized C-gap direction buttons were fully reachable inside the viewport by scrolling, with the lowest button moved above the bottom safe area. All five bottom-tab labels and their touch bounds fit within 910 px. The device was restored to 1200×2664 px and font scale 1.0 after each check.
- At simulated 240 dp width (780 px at 520 dpi) and 1.5 font scale, the fallback two-column C-gap button grid kept all eight 44 dp controls reachable within the viewport; all five bottom-tab labels and touch bounds fit within 780 px. The device was restored to 1200×2664 px and font scale 1.0 after each check.
- The Vision Comfort screen was also opened at 240 dp and 1.5 font scale. Its title, both profile choices, preview sender, adjustment control and scrolled Reply button had accessibility bounds within 780 px. This is a bounds/reachability check, not a full visual review of every screen.
- At simulated 600 dp width (1950 px at 520 dpi) and 1.5 font scale on Honor, the five bottom-tab touch bounds divided the viewport into five equal 390 px slots without horizontal overflow. A landscape-sized override exposed the Eye Check intro, but its lower controls were not verified; landscape remains unverified.
- The ARM64 APK installs on the x86_64 emulator but cannot launch there because that emulator requires x86_64 `libreactnative.so`; this is an ABI mismatch in the test artifact. The separate x86_64 build was stopped after Honor became available, and emulator runtime verification remains unverified.
- An earlier ARM64 Vision Comfort APK installed successfully on Redmi Note 8 Pro, 1080×2340 px at 440 dpi (about 393 dp wide), font scale 1.0. Accessibility bounds showed all five navigation labels inside the display and Mini Apps card labels inside their cards. The Vision Comfort route opened and its profile choices, preview adjustment control, and screen-comfort instructions were exposed in the accessibility tree. MIUI denied ADB touch injection and `WRITE_SECURE_SETTINGS`, so this device could not provide an interactive final Eye Check or simulated 320 dp/font-scale 1.5 check. Its size and font scale remained at their original values. The final APK was not installed on Redmi.

## Device matrix

The Android hardware is Honor ELI-NX9, Android 16, 1200×2664 px at 520 dpi (about 369 dp wide). Its original font scale is 1.0. Device size and font-scale overrides are restored after each check. Screen capture is blocked by the app's existing `FLAG_SECURE`; accessibility hierarchy and bounds were used for on-device checks.

## Figma design studies

The existing Aurora design file was inspected for its Dark/Light color variables, Nunito Sans and Sora text styles, and five-tab icon components. Editable studies were added on a separate page: [Vision Comfort setup](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=22-2) and [320 dp level-5 five-tab layout](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=23-2). The 320 dp study shows all five labels and icons inside the bar. These are design studies, not native screenshots or device verification.

The updated editable 320 dp Eye Check studies are [intro](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=37-450), [card calibration](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=35-2), [C-gap answer ring](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-2), [six colour plates](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-84), [semicircle lines](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-223), [Amsler grid](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-265), and [separate-eye results](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-335). The results study now leads with numeric per-eye screen scores, states spectacle power was not measured, and provides the Vision Comfort preview action. Figma screenshots were inspected at 320×780; labels, controls and results fit without clipping. Previous letter-chart drafts were archived. These are design studies, not native screenshots or medical charts.

| Width / platform | OS font scale | Result |
| --- | ---: | --- |
| 369 dp Android portrait | 1.0 | Final portal-flow APK completed all four Eye Check sections with separate-eye summary on Honor. Earlier Vision Comfort calibration checks exposed the English/Telugu sample and plus/drag level changes. |
| 320 dp Android simulated width | 1.5 | Final portal-flow APK setup actions and all eight C-gap direction buttons were fully reachable by scrolling. The five Chats, Status, Apps, Calls, Profile tabs each occupied a 208 px slot inside the viewport on the final APK; Mini Apps visible content had no horizontal overflow in an earlier build. Size/font overrides were restored. |
| 280 dp and 240 dp Android simulated widths on Honor | 1.5 | Current estimated-sight APK: all eight C-gap buttons and setup controls reachable; the ring resizes at 280 dp and becomes a two-column grid at 240 dp. All five bottom tab labels and touch regions fit the 910 px and 780 px viewports, respectively. Size/font overrides restored. |
| 600 dp Android simulated width | 1.5 | Earlier APK bottom five tab touch bounds fit. Other screen content at this size remains unverified. |
| 393 dp, physical tablet, Android landscape | 1.0 / 1.5 | Latest APK unverified. Earlier Redmi 393 dp check is recorded above. |
| iOS device / simulator | Dynamic Type variants | Unverified; this Windows host has no iOS build/device. |

The installed-build identity is recorded above. Profile persistence, reset, TalkBack, all named-screen visual checks, tablet/landscape/iOS checks, and Redmi final-build interaction are pending. Preliminary device checks do not prove those cells or medical accuracy.
