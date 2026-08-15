## 1. Discover + audit (complete)

- [x] 1.1 Read the existing project: `app/` (190 routes, 160 top-level screens), `app/(tabs)`, nested groups, `components/ui/*`, `constants/theme.ts`, `lib/theme.tsx`, and the eight OpenSpec changes under `openspec/changes/`
- [x] 1.2 Audit existing personalization surfaces — `app/chat-themes.tsx` (bubble colours, `getBubbleColors()`), `app/chat-wallpaper.tsx` (solids / gradients / photo, `getWallpaper()`), consumed by `app/chat.tsx:2145` — and record them as **write targets**, not screens to delete
- [x] 1.3 Identify duplication: four colour pickers, two preview boxes, two wallpaper surfaces, hand-rolled sheets alongside `components/ui/Sheet`
- [x] 1.4 Identify the token gap: `#9D6FD0` on `#F6F7F9` ≈3.0:1 — needs a `brandOnLight` token for text and icons on light surfaces
- [x] 1.5 Identify the icon inconsistency: Ionicons on chat, emoji tiles in `app/(tabs)/mini.tsx`, a separate blue system for Business spaces

## 2. Specification (complete)

- [x] 2.1 `proposal.md` — why, what changes, decisions, non-goals, capabilities, impact
- [x] 2.2 `design.md` — audit tables, the ThemeSpec model, keep / merge / remove decisions, navigation contract, counted flows, platform honesty about Apply, responsive matrix
- [x] 2.3 Capability specs: `theme-shell`, `theme-discovery`, `theme-preview-apply`, `theme-editor`, `ai-theming`, `theme-library`, `creator-community`, `account-premium`, `ui-foundation`

## 3. HTML prototype — the acceptance reference (complete)

- [x] 3.1 `design/theme-studio/index.html` — self-contained high-fidelity prototype, no build step, no external requests
- [x] 3.2 Shell: four destinations, tab bar, per-destination state, screen index for review, light / dark, device / full-bleed modes
- [x] 3.3 Onboarding A1–A4: splash, welcome, style picker (12 styles, multi-select), personalized results
- [x] 3.4 Home B1 with hero, chips and six rails; search C1 zero-state and C2 results with type filters
- [x] 3.5 Preview D1: phone frame, Home / Lock / Widgets swipe, variations, complete-the-look, metadata, sticky actions
- [x] 3.6 Apply E1 sheet with per-component scope, E2 staged progress and confirmation
- [x] 3.7 Studio F1: canvas, undo / redo / save, seven panels G1–L1 as sheets, every control live on the canvas
- [x] 3.8 AI M1–M4: prompt with starters, named generation stages, result actions, remix grid
- [x] 3.9 Community N1–N3, Library O1–O2, Profile P1, Premium Q1, Settings R1, Help S1–S3
- [x] 3.10 States T: skeleton, empty library, no results, network error, download error, apply error, premium locked, offline, success toast
- [x] 3.11 Phone preview component driven by theme tokens — one renderer at four sizes
- [x] 3.12 Responsive: phone portrait, landscape, tablet, desktop-in-frame

## 4. Validate

- [x] 4.1 Navigation: four destinations, maximum depth 2, every sheet dismisses to its host
- [x] 4.2 Screen count: 4 destinations + 1 one-time onboarding flow; 21 category-typical screens rendered as contextual surfaces
- [x] 4.3 Component reuse: one card, one sheet, one preview, one state component across every surface
- [ ] 4.4 Accessibility pass on the prototype with a screen reader and at 200% text
- [ ] 4.5 Flow timing: first-time apply under 30 s with three taps, measured on device

## 5. Implementation (not started — requires approval)

- [ ] 5.1 `brandOnLight` token added to `constants/theme.ts`; audit light-mode accent usage
- [ ] 5.2 `ThemeSpec` model + token-driven renderer (colour math, contrast enforcement, seeded generation, variations, remix)
- [ ] 5.3 `PhonePreview` component — Home / Lock / Widgets, four sizes
- [ ] 5.4 Shared components: theme card, sheet detents, chips, segmented control, skeleton, state views, toast
- [ ] 5.5 Four routes under one group, plus the applied-theme store
- [ ] 5.6 Apply path writing through the existing `getWallpaper()` / `getBubbleColors()` seams, plus the platform handoff for icons and system wallpaper
- [ ] 5.7 Library persistence, sealed with the existing cache DEK
- [ ] 5.8 Analytics: `theme_applied` with taps and ms-since-launch as the headline metric
