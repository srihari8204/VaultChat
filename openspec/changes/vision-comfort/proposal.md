## Why

The current app has a shared theme and text foundation, but no way for someone to calibrate readability to their own visual comfort. Fixed sizes and translucent surfaces across screens can make text and controls hard to use, especially when system font scaling or the window size changes.

## What Changes

**Already built and reused:** `lib/theme.tsx` persists appearance with AsyncStorage, `components/ui/Text.tsx` applies the shared type scale, `components/ui/GlassView.tsx` has an opaque fallback, and the ongoing `global-device-support` change handles live window metrics and basic font scaling. Vision Comfort builds on these rather than adding a second theme or layout system.

- Add a Settings entry with a sample chat that updates as the user drags a vertical comfort control. Expose equivalent accessible plus/minus controls. The preview responds across text size, line spacing, weight, bubble and control spacing, contrast, and glass opacity.
- Save a local Vision Profile only after the user confirms the preview looks clear. Allow separate optional **With Glasses** and **Without Glasses** profiles, a reset path, and a quick profile switch from chat.
- Apply the selected profile consistently to supported Chats, Calls, Status, Alerts, Profile, Mini Apps, Settings, and shared navigation surfaces. Layouts reflow with the current window and system font settings; text and controls remain reachable on narrow, wide, rotated, and folded displays.
- Offer optional self-reported sight or spectacle information as a starting hint before calibration. The user can skip it; no prescription maps to an exact display value, and the user-confirmed preview remains authoritative. Explain that the feature does not correct eyesight or replace glasses or an eye examination.
- Add focused automated checks and a device verification matrix for Android and iOS, 320 dp through tablet widths, rotation/fold/window resize, system text scale, Telugu and English, light and dark themes.

### Not building

- No validated visual-acuity measurement, diagnosis, medical correction claim, or automatic prescription-to-font formula. The optional Eye Check records nonclinical screen responses.
- No backend endpoint, account sync, analytics of sight information, new storage dependency, or screenshot-based zoom.
- No redesign of third-party/system interfaces outside app control. Do not change the security screen policy (`FLAG_SECURE`).

## Capabilities

### New Capabilities

- `vision-comfort`: calibration, local profiles, optional sight hint, app-controlled display adaptation, quick switching, and accessible responsive verification.

### Modified Capabilities

None. The overlapping `device-layout` and `typography-system` requirements are still change deltas in the active `global-device-support` work; this capability composes with them without redefining their contracts.

## Impact

- **Client:** Settings and calibration route; local profile state and persistence; shared text, palette, glass, controls and chat styles; supported app routes and navigation. Existing fixed-height and direct React Native `Text` sites need targeted adoption wherever Vision Comfort is claimed.
- **Dependencies/API:** Reuse installed React Native, Expo, AsyncStorage and existing primitives. No backend, SQL migration, network API, or account data change.
- **Delivery:** Client files must be included in an app build; the exact copy/build manifest is recorded during implementation. A written change, a deployed build, and device verification are separate milestones.
