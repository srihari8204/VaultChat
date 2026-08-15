# Design — Theme Studio

## 1. Audit of what exists

Read before designing: `app/` (190 route files), `components/ui/*`,
`constants/theme.ts`, `lib/theme.tsx`, `app/(tabs)/*`, the personalization
screens already shipped, and the eight OpenSpec changes under
`openspec/changes/`.

### 1.1 Existing UI architecture

| Layer | What is there | Verdict |
|---|---|---|
| Navigation | Expo Router. Root stack with ~160 top-level screens; one 7-entry tab group (`app/(tabs)`); nested groups for `finance/`, `add/`, `join/`, `i/` | Pattern to **not** repeat |
| Design tokens | `constants/theme.ts` — `Palette` (dark + light), `SPACING`, `RADIUS`, `ELEVATION`, `MOTION`, `TYPOGRAPHY`, `FONT`, `BRAND_ACCENT`, `avatarColor()` | **Keep, adopt fully** |
| Runtime theming | `lib/theme.tsx` — `ThemeProvider`, `useTheme()`, `useColors()`, preference persisted as `vc_theme_pref` | **Keep, reuse** |
| Primitives | `components/ui/` — `AppText`, `Button`, `Card`, `Header`, `Avatar`, `Sheet` | **Keep, extend** |
| Personalization today | `app/chat-themes.tsx` (12 bubble colors), `app/chat-wallpaper.tsx` (solids, 9 gradients, photo), `app/stickers.tsx` | **Absorb** — these are two content types of one theme |
| Icons | Mixed: `@expo/vector-icons` on chat surfaces, **emoji** tiles in `app/(tabs)/mini.tsx`, a separate blue system for Business spaces | Inconsistent — see `ui-foundation` |

### 1.2 What the existing personalization screens get right

Both are worth preserving as behavior, not as screens:

- `chat-wallpaper.tsx` renders a **live preview with real themed bubbles** over
  the actual chat background, and persists per-chat with a global fallback.
- `chat-themes.tsx` computes legible text from the chosen fill
  (`idealText()` — luminance-based). That is the same contrast concern this
  change makes systematic for generated palettes.

Neither should be deleted. `getWallpaper()` and `getBubbleColors()` are consumed
by `app/chat.tsx:2145`; a theme apply writes through those existing seams rather
than replacing them.

### 1.3 Duplication found

| Duplicated concern | Instances | Collapses to |
|---|---|---|
| Colour picking | `chat-themes` swatch grid, `chat-wallpaper` solids grid, finance theme, business theme | One **Color Studio** panel |
| Preview surface | `chat-wallpaper` preview box, `chat-themes` preview box | One **PhonePreview** component |
| Wallpaper choice | `chat-wallpaper` (chat only) | **Wallpaper panel**, theme-scoped |
| Sheets | `components/ui/Sheet` + hand-rolled modals across screens | One `Sheet` with detents |

## 2. The model everything renders from

```
ThemeSpec {
  id, name, tagline, tags[], premium, creator{},
  palette   { bg[3], accent, accentAlt, surface, text, textDim, scheme }
  wallpaper { kind, angle, intensity, seed }
  icons     { shape, fill, tint, opacity, labels }
  widgets   { fill, transparency, radius, stack[] }
  type      { family, weight, tracking, uppercase }
  layout    { columns, density, dock }
  lock      { clock, showWidgets, showDate }
  stats{}, origin, parentId?, prompt?, createdAt
}
```

Consequences that the UI depends on:

- **One renderer.** Card artwork, the immersive preview, the Studio canvas, the
  AI result and the applied theme are the same component at four sizes.
- **Variations are a function.** `variation(base, 'sunset')` shifts hue and
  lightness while preserving icon shape, widget stack and layout — a sibling
  that still reads as the same theme. Six per theme, zero authoring.
- **Remix keeps the bones.** `remix(theme, 'luxury')` swaps material treatment
  only; the user's layout, widgets and lock config survive. That is what
  separates a remix from a reroll.
- **Contrast is enforced in the builder.** Text and accent are nudged in
  lightness (hue preserved) until they clear 4.5:1 against the wallpaper.

## 3. Screen decisions

### 3.1 Keep as destinations — 4

| # | Screen | Job | Why it earns a destination |
|---|---|---|---|
| 1 | **Home** | Find something worth applying | Owns a scroll position, reached from everywhere |
| 2 | **Create** | Make it yours | Long-lived editing session with its own undo stack |
| 3 | **Library** | Get back to what's mine | Owns a filter + scroll position |
| 4 | **Profile** | Account, plan, settings, help | Terminal surface, rarely re-entered mid-task |

Onboarding (Splash → Welcome → Style picker → Personalized) is a **one-time
modal flow**, not part of the tab architecture.

### 3.2 Merge — 21 category-typical screens become contextual surfaces

| Category-typical screen | Becomes | Host |
|---|---|---|
| Categories / Category | Style chip rail | Home |
| Theme detail | Immersive preview modal | Home, Library |
| Apply confirmation | Apply sheet | Preview, Studio, Library |
| Apply progress | Inline in the apply sheet | — |
| Wallpapers, Wallpaper category, Wallpaper detail | Wallpaper panel | Studio |
| Icon packs, Pack detail, Icon picker | Icons panel (3 segments) | Studio |
| Widgets, Widget categories, Widget editor | Widgets panel | Studio |
| Lock screens, Lock editor | Lock panel + canvas flip | Studio |
| Fonts | Typography panel | Studio |
| Colors | Color Studio panel | Studio |
| Layout | Layout panel | Studio |
| AI generator, AI result | AI sheet (medium → large) | Studio, Home |
| Remix | Remix sheet | Studio, Preview |
| Search, Results | Inline overlay | Home |
| Favorites, Downloads, Creations | Library filters | Library |
| Creator profile | Sheet (large detent) | Preview, Community |
| Publish | Sheet | Studio |
| Paywall | Sheet with preview behind | Anywhere premium is touched |
| Saved theme actions | Action sheet | Library |
| Help, FAQ, Contact | Rows → sheets | Profile |
| Settings groups | Rows → sheets | Profile |

### 3.3 Remove — 0

Nothing existing is deleted. `chat-themes` and `chat-wallpaper` keep working and
become write targets of a theme apply.

### 3.4 Rule of admission

A new destination is justified only when it (a) owns a scroll position worth
preserving, (b) is reachable from more than one place, and (c) loses meaning
inside its parent's context. Everything in §3.2 fails at least one test.

## 4. Navigation contract

- **Tab state persists** per destination for the session: scroll offset, active
  filter, search text. Re-tapping the active tab scrolls to top; a second tap
  clears the filter.
- **Customize hands off, it does not push.** "Customize" loads the theme into
  Create and switches tabs. The tab bar stays visible; the user lands somewhere
  they recognize.
- **Sheets dismiss to their host.** The preview modal dismisses back into the
  card it grew from. Nothing else pops.
- **Applying is global.** One applied-theme store updates Library's marker,
  the Studio canvas and Profile's appearance row in the same frame.
- **Maximum depth is 2**: tab → immersive preview. The phone changes at step 3.

## 5. Flows, counted

| Flow | Taps | Target |
|---|---|---|
| First-time apply | 3 | Cold launch → card → Apply theme → Apply everything, **< 30 s**, no account |
| Customize and apply | 8 | Preview → Customize → Colors → Icons → Widgets → Save → Apply, **zero pushes** |
| AI to applied | 4 | Create → AI → prompt → Generate → Use theme |
| Publish | 3 | Studio → Save → Publish |

These are acceptance criteria. A build that lengthens any of them regressed the
architecture regardless of what it added.

## 6. Platform honesty about "Apply"

An app cannot silently replace OS icons or the system lock screen. The apply
sheet therefore groups components by what actually happens:

| Component | Behavior |
|---|---|
| Colors, typography, in-app wallpaper | Applied immediately, in-app |
| Chat wallpaper, bubble accent | Written through the existing `getWallpaper()` / `getBubbleColors()` seams |
| Home-screen icons | Prepared, then handed to the platform's own installation step |
| System wallpaper, lock screen | Saved and handed off, with the platform step stated |

This is shown **before** the user commits, per component, with a one-line
explanation. Partial success reports which parts landed and offers to finish the
rest — never a single silent "Applied".

## 7. Responsive behavior

| Breakpoint | Layout |
|---|---|
| Phone portrait (≤ 480) | Single column. Rails scroll horizontally. Sheets are full-width with detents. |
| Phone landscape | Preview and controls sit side by side in Studio; Home keeps one column with shorter rails. |
| Tablet (≥ 768) | Two-column grids; Studio shows the canvas beside a persistent panel instead of a sheet. |
| Desktop (≥ 1100) | The app renders inside a phone frame with a screen index beside it — a review surface, not a product surface. |

## 8. Deferred

- Live / animated / depth-effect wallpapers.
- Cloud sync of the library across devices.
- Creator monetization.
- Hosted AI generation (the contract is designed for it; the implementation is
  on-device).
