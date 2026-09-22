## 1. Profile foundation — written

- [x] 1.1 Trace existing `lib/theme.tsx`, `components/ui/Text.tsx`, `components/ui/GlassView.tsx`, chat style and Settings call sites; record the exact supported-route inventory and overlaps with `global-device-support` before editing.
- [x] 1.2 Implement a bounded local Vision Profile model for comfort level, contrast, reduced transparency, optional With Glasses / Without Glasses profiles, active selection, validation and reset; do not persist raw sight input.
- [x] 1.3 Add provider hydration and AsyncStorage persistence; verify unsaved draft changes cannot overwrite the active profile and malformed stored data uses defaults.
- [x] 1.4 Add a focused assert-based `*.selftest.ts` for the non-trivial profile mapping/validation and storage boundary, with no `require('fs')` in app code.

## 2. Calibration — written

- [x] 2.1 Add the Settings entry and calibration route with sample chat, vertical drag control, plus/minus actions, current-level label, accessible actions, and Save/Reset.
- [x] 2.2 Add independent contrast and reduced-transparency choices; render preview using the same tokens as supported screens.
- [x] 2.3 Add skippable sight-category and optional spectacle-value input below the preview; derive only a coarse starting hint, discard raw input, and show the nonmedical explanation.
- [ ] 2.4 Verify in focused tests that dragging changes only draft state, confirmation saves, skipping sight works, and buttons/screen-reader actions match drag behavior.
- [x] 2.5 Add an optional Eye Check from Vision Comfort with safety, card-size screen setup, ten adaptive C-gap trials for each eye, six colour plates, separate-eye semicircle and Amsler checks, transient results, and start/end Telugu disclaimers. Do not store or infer eyesight percentage.

## 3. Shared display and chat — written

- [x] 3.1 Apply profile tokens through shared text, theme contrast, glass opacity and reusable controls while preserving OS text scaling and current light/dark appearance.
- [x] 3.2 Adapt chat list, message bubble, composer and chat header for wrapping, bubble spacing, larger controls and live width changes; add labeled eye-icon quick switch for saved profiles.
- [ ] 3.3 Verify chat at 320 dp and enlarged OS font scale; essential message content, composer, actions and the switcher remain visible and operable.

## 4. Named app surfaces — written

- [x] 4.1 Audit and adapt Calls, Status and Alerts routes plus their shared components; remove fixed-height clipping and one-line truncation of essential text where the profile applies.
- [x] 4.2 Audit and adapt Profile, Mini Apps, Settings and shared tab/navigation surfaces; controls grow or wrap and retain reachable hit areas.
- [x] 4.2a Keep Mini Apps card positions stable across Vision levels at a fixed width; let narrow header text wrap without moving its back icon.
- [ ] 4.3 Verify Telugu/English rendering and light/dark profile tokens in each named surface; document any interface outside app control as excluded.
- [x] 4.4 Run a Ponytail review of the affected diff, remove unnecessary abstractions/dependencies, and run focused selftests, `npm run typecheck`, `npm run lint`, `npm test`, and `openspec validate vision-comfort --strict`. Record actual failures, including pre-existing ones.

## 5. Client delivery — deployed

- [x] 5.1 Record the **exact changed client file paths** from the final diff in the client release/copy manifest, build the Android artifact, and confirm each listed file is included in the shipped bundle. No backend files are copied; SQL migration number is **none**.
- [x] 5.2 Distribute/install the client build and record artifact identity, build time, and destination. Mark deployed only after the installed build contains the change; source edits and Git state alone do not qualify.

## 6. Device verification — device-verified

- [ ] 6.1 On Android hardware and available emulators, record 320/369/393/600 dp and tablet-width results at font scale 1.0 and 1.5, portrait/landscape, live fold or split-window resize where available, both themes, and Telugu/English. Check every named surface for clipping, overlap, reachable controls and glass readability.
- [ ] 6.2 Verify drag, plus/minus, TalkBack, both profiles, quick switching, restart persistence, malformed-data fallback and reset on an installed Android build.
- [ ] 6.3 On an iOS build/device, repeat the supported-screen, VoiceOver, font-scale, orientation, profile and language checks. Keep this task open if no iOS build/device is available; do not infer iOS verification from Android or TypeScript checks.
- [ ] 6.4 Record matrix evidence and remaining cells in this change, then sync the delta spec to main specs and archive only after deployment and required device verification meet `openspec/config.yaml` conditions.
