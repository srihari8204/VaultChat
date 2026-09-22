## Context

VaultChat already has a theme provider with AsyncStorage persistence, a shared `AppText`, palette tokens, and `GlassView` with an opaque mode. Coverage is incomplete: many screens still use direct React Native `Text`, fixed heights, and literal sizes. `global-device-support` is independently fixing live layout metrics and basic OS font scale behavior. Vision Comfort must compose with those changes, not overwrite them. No backend is needed because these are local display choices.

## Goals / Non-Goals

**Goals:** An accessible live calibration; two optional local glasses profiles; quick switch; consistent app-owned readability across named surfaces; reflow under current window size and OS text settings; truthful, optional sight hint.

**Non-Goals:** Visual diagnosis or prescription correction, cloud sync, system/third-party screen adaptation, image zoom, a second theme system, or a new dependency.

## Decisions

1. **A small bounded profile model drives the app.** Store the active profile key and up to two named profiles in local AsyncStorage. Each profile holds a calibrated comfort level and explicit contrast/transparency choices. Validate and clamp loaded values; malformed data falls back to normal display. Profile state lives alongside the existing appearance provider or in one adjacent provider so every supported screen re-renders on a switch. Do not store raw prescription data. Alternative: per-screen state or remote profile; both create inconsistent displays and more data exposure.

2. **The vertical control changes a coordinated preset curve; contrast and transparency remain independently adjustable.** A bounded comfort level increases type scale, line height, weight, bubble spacing, and hit-target spacing in measured steps. The preview uses the same token computation as real screens. Plus/minus buttons and screen-reader adjustable actions produce identical changes. A short self-check explains reading at the usual distance and checking each eye separately. The only percentage shown is the app's text enlargement; no eyesight percentage is inferred. Avoid one continuous gesture that silently sets seven unrelated preferences. Alternative: seven sliders up front; that makes first use hard and hides the single useful action, calibrating until clear.

3. **Explicit confirmation commits the profile.** Dragging only changes a draft preview; leaving the route without saving preserves the previous app setting. A profile can be reset or removed. The saved active profile restores at startup without a flash of inaccessible tiny content where practical. OS text scaling remains enabled; effective size composes with, rather than replaces, the OS setting. Cap only the app-added multiplier at a documented bound and let containers grow or scroll. Alternative: transform/zoom the full screen; this clips content and does not reflow controls.

4. **Sight information is an optional, transient hint below the preview.** Show the preview immediately. Offer plain-language categories and an optional spectacle value field to explain the user's situation; the number is never interpreted or saved. A selected category may suggest a general starting level if the user has not adjusted the preview. Do not derive an exact font size from diopters, infer diagnosis, persist the input, or change a saved profile until the user confirms what looks clear. Show the medical boundary next to the input. Alternative: exact power mapping; visual comfort depends on device, distance, OS scaling and the user, so that mapping would imply false precision.

5. **Adopt existing primitives from shared roots outward.** Route `AppText`, palette/contrast tokens, glass opacity, controls, and the chat bubble/composer through the profile. Then audit Chats, Calls, Status, Alerts, Profile, Mini Apps, Settings and shared chrome for direct text, fixed heights, one-line truncation and absolute-positioned controls. Each adopted surface must reflow on `useWindowDimensions` changes and preserve touch targets. Do not put per-row blur passes into virtualized lists. A labeled eye-icon action in the chat header quick-switches profiles; long press opens calibration, which is also available from Settings.

6. **Verification distinguishes source checks, emulator checks, and real-device checks.** A focused assert-based selftest covers profile validation/mapping, persistence behavior at its boundary, and stable style tokens. Device matrix covers 320/369/393/600 dp and tablet width, portrait/landscape, fold or split resize where hardware permits, OS font scale 1.0/1.5, Telugu/English, light/dark, Android and iOS. Check text wrapping, controls, TalkBack/VoiceOver actions, profile switching and restart. Windows host cannot build iOS locally; iOS verification remains open until a build and device are available.

7. **The Eye Check follows the reference portal's live interaction sequence as a nonclinical screen.** The reference landing article still describes eight typed letters, but its current interactive test uses a standard-card calibration slider, ten adaptive Landolt C gap choices per eye, six colour plates with both eyes open, a semicircular line chart per eye, and two Amsler-grid questions per eye. Our C-gap screen extends this to sixteen trials per eye and smaller detail levels, with an explicit cannot-see response. On phones, use the card's short edge for calibration so the reference fits the display, then render eight large gap-direction choices around a ring. Use original SVG charts and vary orientation/dot colours each run; no reference assets or lead-collection form are copied. Show qualitative interim results and separate-eye final responses, with the exact Telugu disclaimer at start and end. Detail levels remain uncalibrated and no responses are persisted. The app does not claim portal equivalence, visual-acuity fractions, eyesight percentage, prescription, diagnosis, or validated screening. Link to WHOeyes information for validated near/distance screening.

## Risks / Trade-offs

- Broad UI adoption can reveal old fixed-height clipping → audit every named supported surface and record device results; do not claim app-wide coverage from the provider alone.
- Two user profiles could be mistaken for medical modes → labels describe glasses use, and all values remain user-confirmed display preferences.
- Persistent profile loaded after first paint could flash old sizes → hydrate before showing calibrated routes or use a stable readable default until load completes.
- Applying high contrast through colors may collide with existing theme styles → compute contrast-aware token overrides centrally and verify both themes, including translucent overlays.
- Gesture-only calibration excludes some users → buttons, screen-reader adjustable actions, visible value and a labeled Save/Reset path are required.

## Migration Plan

1. Implement and validate local model, storage, calibration route and Settings entry. Existing users stay on the current display until they save a profile.
2. Apply shared tokens and the chat switcher, then migrate named surfaces in groups. Each group gets focused tests and clipping review at the minimum and enlarged widths.
3. Build and distribute a client release. There is **no SQL migration** (migration number: none) and no backend file copy. Record the exact changed client files and build artifact in the release manifest; a Git commit alone is not deployment.
4. Run the device matrix and leave any unavailable platform/device cell explicitly unverified. Rollback removes the client feature and ignores its local storage key; old display behavior remains the fallback.

## Open Questions

- Which iOS build/device will verify the iOS cells? The current Windows host cannot provide that evidence.
- Does the product want the optional numeric spectacle input in the first shipped build, or only the plain-language categories? Both must remain transient and nonmedical.
