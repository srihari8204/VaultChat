# Theme Studio — personalization UI

## Why

The request is a Themify-class personalization product: complete themes, icon
packs, wallpapers, widgets, lock screens, a theme maker, AI generation, a
creator community, a library and a subscription. The category ships that scope
as roughly **28 pushed destinations** — a screen per content type, then a screen
per editor, then a screen per collection — and the cost lands on the user, who
must assemble a look by hand across five or six places before anything changes
on their phone.

This repo has the same disease at a larger scale and is the reason to be
careful: `app/` already holds **190 route files, 160 of them top-level screens**,
because every capability so far arrived as its own file. A personalization
surface built the same way would add another twenty-plus.

The correction is to make the **theme** the unit of the product, not the
category. A theme is one serializable token bundle — wallpaper, icons, widgets,
palette, typography, lock screen, layout — and every surface renders from that
one object. Cards, the immersive preview, the editor canvas, the AI result and
the applied theme are the same renderer with different chrome.

Two things follow, and they are the whole argument:

1. **Live preview is structural, not an optimization.** The editor mutates the
   bundle; the preview reads it. There is no build step between them, so every
   edit is already on screen and no "Preview" screen needs to exist.
2. **The catalog is unbounded without assets.** Themes are derived from a seed,
   so browse can page forever and a variation ("Ocean Glass Sunset") is a
   function of its parent rather than new authored content.

## What Changes

- **Four primary destinations only** — Home, Create, Library, Profile. No tab
  for wallpapers, icons, widgets, lock screens, categories or AI; each is a
  content type inside Home or a panel inside Create.
- **One immersive preview** replaces the category-typical product-detail page.
  A card expands into a phone frame; Home / Lock / Widgets are a swipe apart.
- **One Theme Studio** replaces seven editors. Wallpaper, Icons, Widgets,
  Colors, Layout, Lock Screen and Typography are bottom sheets over a live
  canvas — the canvas never leaves the screen while it is being edited.
- **Apply is a sheet, not a flow.** It lists exactly what will change, applies
  everything in one action, and reports per-component progress so a partial
  failure is legible instead of silent.
- **AI generation and remix** are sheets over the current preview. Results land
  in the phone already on screen; generating never navigates away.
- **The library is one shelf.** Saved, downloaded, created, AI and recently used
  are filters over a single grid, distinguished by badge rather than by tab.
- **A complete state language** — loading, skeleton, empty, no-results, offline,
  network error, download error, apply error, premium-locked and success — is
  specified once and reused, rather than invented per screen.
- **A high-fidelity HTML prototype** (`design/theme-studio/`) is the reference
  implementation of this specification: every screen, every sheet, every state,
  a working router, and a phone preview driven by real theme tokens. It is a
  design artifact, not shipping code.

## Decisions taken (defaults, pending override)

1. **Tokens come from `constants/theme.ts`, not a new system.** Obsidian Aurora
   already defines two palettes, a 4-point spacing scale, a radius scale, three
   elevations, spring presets and a nine-step type scale. A second design system
   is where the third one starts. One addition is required: `#9D6FD0` measures
   ≈3.0:1 on the light ground, so a `brandOnLight` token is needed for text and
   icons on light surfaces — the accent stays correct as a fill.
2. **A theme is a token bundle, generated — not an image pack.** This is what
   makes a card cost zero bytes, a variation cost zero authoring, and offline
   browse work. Optional CDN thumbnails remain an enhancement, never a
   dependency.
3. **AI generation runs on-device and deterministically.** It returns in one
   frame, works offline, keeps prompts on the device in an app built around
   E2EE, and makes "Regenerate" reproducible. A hosted model can replace the
   implementation behind the same `prompt → ThemeSpec` contract without a single
   screen changing.
4. **Generated palettes are contrast-checked before render.** A prompt can ask
   for "purple on purple"; the bundle must still hand the UI something legible.
   This is enforced in the token builder, not left to the person prompting.
5. **Applying is honest about scope.** On iOS and Android an app cannot silently
   replace system icons or the OS lock screen. The apply sheet states which
   components apply in-app immediately and which require the platform's own
   handoff, per component, before the user commits — not after.
6. **Guest-first.** Everything except publishing works without an account.
   Account creation is offered at publish or sync, never before first value.

## Non-goals

- No new bottom-tab destination for any content type.
- No second map, icon, storage or notification system.
- No live/animated wallpapers, video previews or depth-effect rendering in v1 —
  the token renderer covers gradient, mesh, aurora, waves, grid, stars and blobs.
- No creator monetization, revenue share or payout flows.
- No server-side theme rendering; previews are drawn on-device.

## Capabilities

### New Capabilities
- `theme-shell`: the four-destination architecture, routing rules, onboarding,
  and the rule of admission that governs new screens.
- `theme-discovery`: Home sections, style chips, search intent parsing, results,
  and paged browse over an unbounded catalog.
- `theme-preview-apply`: the immersive preview, surface swiping, variations,
  complete-the-look, the apply sheet and apply progress.
- `theme-editor`: Theme Studio, the seven editor panels, undo/redo, save, and
  the live-canvas contract.
- `ai-theming`: prompt → theme generation, generation states, results and remix.
- `theme-library`: the unified shelf, filters, saved-theme actions and recents.
- `creator-community`: community feed, creator profile and the publish flow.
- `account-premium`: profile, subscription presentation, settings, help and
  support.
- `ui-foundation`: design tokens, the component inventory, the phone preview
  component, responsive behavior, accessibility, motion and the state language.

### Modified Capabilities
<!-- No existing openspec/specs/* capability changes its requirements. Reuse of
     constants/theme.ts, components/ui/* and the Expo Router shell is at the
     implementation layer. -->

## Impact

- **Design**: `design/theme-studio/` — the interactive HTML prototype covering
  every screen and state named in these specs. This is the acceptance reference:
  a build disagreeing with the prototype is a build that changed the spec.
- **Client (when implemented)**: one route group with four tab routes; a
  `ThemeSpec` model plus a token-driven renderer; reusable card, sheet, preview
  and state components. Every editor is a sheet, so the route count added by
  this change is four.
- **Backend**: none required for v1 — the catalog is generated on-device and the
  library is local. A hosted catalog slots in behind the paged query contract.
- **Storage**: library entries and the applied theme persist locally; user
  content is sealed with the existing cache DEK like every other local store.
- **Blocked**: nothing. Platform handoffs for icons and lock screens are a
  scope statement in the apply sheet, not a dependency.
