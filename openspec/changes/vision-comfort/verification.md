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

- `npm run typecheck`: passed after the estimated-sight result and responsive answer-ring edits.
- `npm run lint`: passed with 0 errors and 266 repository warnings; focused lint of the Eye Check screen and model passed with 0 errors.
- `npm test`: 350/351 suites passed after the estimated-sight result edit. The remaining `lib/chatsDeltaProto.selftest.ts` account-switch assertions fail when run alone; this change did not edit that suite or its sync engine. Focused adaptive `eyeCheckModel`, `themeCoverage`, and `responsiveLayout` selftests passed. An earlier full run caught the white chart field and calibration track layout test; both were fixed before the final full rerun.
- Focused `eyeCheckModel`, `visionComfort`, `appTextRendering`, `responsiveLayout`, `layoutMetrics`, and `backupScheduler` selftests passed.
- `openspec validate vision-comfort --strict`: passed.
- `git diff --check`: passed.
- Ponytail review: no new dependency or broad abstraction. The content and scoring rules are in `eye-check-content.md`.

## Android release artifact

- ARM64 release APK: `android/app/build/outputs/apk/release/app-release-arm64-v8a.apk` (built 2026-09-22 08:35:24 UTC; 95,261,083 bytes; SHA-256 `56E9CCE5F79F7F381D141B02E41AA1493BB549734D9C7C88AE6A3401FF8AB8FB`). `assembleRelease` succeeded. The release source map contains all 22 runtime paths in the inventory above, including the per-eye estimated-sight card and width-aware answer ring. The APK's Hermes bundle matches the generated bundle byte for byte (SHA-256 `4FC1F2EF8685B2B4AFDB292E092FA6CCB5C84619709B9F3DA719A479EAE7D09F`).
- `adb install -r` succeeded on Honor ELI-NX9, Android 16, preserving app data. On this installed APK, the native UI flow completed the four setup steps, ten C-gap trials for each eye, six colour plates with both eyes open, two semicircle answers, four Amsler answers, and the final summary. UIAutomator confirmed the prominent right/left estimated-sight status, C-gap matches and screen levels; after scrolling, it confirmed the other responses and exact Telugu disclaimer. The old automation expected the entire summary in one viewport and failed that assertion; the scroll check confirmed the content was present. Native visual capture remains blocked by `FLAG_SECURE`; UIAutomator hierarchy and bounds were used.
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

The updated editable 320 dp Eye Check studies are [intro](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=37-450), [card calibration](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=35-2), [C-gap answer ring](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-2), [six colour plates](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-84), [semicircle lines](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-223), [Amsler grid](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-265), and [separate-eye results](https://www.figma.com/design/CjvK3XTpt9eViZbAam51ui?node-id=36-335). The results study now leads with the per-eye estimated-sight status. Figma screenshots were inspected at 320×780; labels, controls and results fit without clipping. Previous letter-chart drafts were archived. These are design studies, not native screenshots or medical charts.

| Width / platform | OS font scale | Result |
| --- | ---: | --- |
| 369 dp Android portrait | 1.0 | Final portal-flow APK completed all four Eye Check sections with separate-eye summary on Honor. Earlier Vision Comfort calibration checks exposed the English/Telugu sample and plus/drag level changes. |
| 320 dp Android simulated width | 1.5 | Final portal-flow APK setup actions and all eight C-gap direction buttons were fully reachable by scrolling. The five Chats, Status, Apps, Calls, Profile tabs each occupied a 208 px slot inside the viewport on the final APK; Mini Apps visible content had no horizontal overflow in an earlier build. Size/font overrides were restored. |
| 280 dp and 240 dp Android simulated widths on Honor | 1.5 | Current estimated-sight APK: all eight C-gap buttons and setup controls reachable; the ring resizes at 280 dp and becomes a two-column grid at 240 dp. All five bottom tab labels and touch regions fit the 910 px and 780 px viewports, respectively. Size/font overrides restored. |
| 600 dp Android simulated width | 1.5 | Current APK bottom five tab touch bounds fit. Other screen content at this size remains unverified. |
| 393 dp, physical tablet, Android landscape | 1.0 / 1.5 | Current APK unverified. Earlier Redmi 393 dp check is recorded above. |
| iOS device / simulator | Dynamic Type variants | Unverified; this Windows host has no iOS build/device. |

The installed-build identity is recorded above. Profile persistence, reset, TalkBack, all named-screen visual checks, tablet/landscape/iOS checks, and Redmi final-build interaction are pending. Preliminary device checks do not prove those cells or medical accuracy.
