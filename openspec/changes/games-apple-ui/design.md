# Design — Games Apple-inspired visual system

## Context

The games section already carries a deliberate identity, and the code says so:

> "A card table is a place, and it looks the same whichever way the rest of the
> app is set. Mixing the two is what made the first native boards look like a
> form." — `lib/games/theme.ts`

That decision holds. This change keeps the games world separate from VaultChat's
app theme and keeps it dark. What it changes is how that world is built: from
opaque maroon panels edged in gold, to a tonal environment with translucent
surfaces and a rationed accent.

## Goals

- Premium at a glance, calm rather than busy.
- Game state readable in under two seconds: who, whose turn, what next.
- Gameplay is always the visual hero; chrome recedes.
- Comfortable one-handed play.
- Achievable on a mid-range Android device.

## Non-goals

- Any change to behaviour, rules, scoring, ranking, matchmaking, limits,
  navigation, permissions or backend.
- Any new feature, statistic, badge, reward, achievement or currency.
- Copying another product's interface or branding.

## Decision 1 — Palette becomes tonal; maroon is the room, not the furniture

Current tokens paint every panel a solid maroon and edge it gold. Replacing the
panel fills with low-alpha white over a darker ground gives depth without adding
colour, and lets one gold element actually read as primary.

| Role | Value |
|---|---|
| Background | `#160607` |
| Secondary background | `#22090A` |
| Game surface | `#300D0E` |
| Elevated surface | `rgba(255,255,255,0.07)` |
| Glass surface | `rgba(255,255,255,0.08)` |
| Strong glass | `rgba(255,255,255,0.12)` |
| Primary text | `#FFF8F1` |
| Secondary text | `#CDBBBB` |
| Gold accent | `#F3C245` (unchanged) |
| Success | `#63E6A0` |
| Error | `#FF7D86` |
| Neutral icon | `rgba(255,255,255,0.72)` |
| Disabled | `rgba(255,255,255,0.35)` |

**Trade-off, stated plainly.** `lib/games/theme.ts` is a verbatim port of the web
client's `theme.css`, kept "deliberately close to the source so the two clients
can be compared side by side". These values break that parity. The native and web
clients will look different until the web client follows. That is a real cost and
the proposal asks for it explicitly rather than smuggling it in.

**Gold budget.** At most one gold *fill* per screen — the primary action. Gold is
otherwise allowed only on the active-turn ring and the wild-card edge. Section
labels, secondary buttons, borders and icons use text and neutral tokens.

## Decision 2 — Glass is a material, used sparingly

Glass is permitted **only** on floating surfaces: navigation and tab bars, mode
sheets, floating action groups, the voice strip, and overlays.

Recipe: translucent white fill, backdrop blur 20–24 px, a 1 px
`rgba(255,255,255,0.14)` hairline, a 1 px inner top highlight at 0.06 alpha, and
one soft shadow. No glow, no gradient borders, no rainbow.

Glass is **forbidden** on: the felt, cards, the board, seats, and any surface that
repaints every frame. This is a performance rule as much as a taste one — blur is
the most expensive effect available on mid-range Android, and a blurred surface
over an animating board is the fastest way to drop frames.

## Decision 3 — One icon family, six states

24 px master grid, 1.5–1.7 px stroke, rounded caps and joins, optically aligned,
consistent corner radius. Every existing icon meaning is preserved; only the
drawing changes. No emoji, no second library, no mixed fills.

States: default (`rgba(255,255,255,0.72)`), selected (gold with a soft halo),
pressed (1 px inward, surface darkens), disabled (0.35 alpha), destructive
(error), success (green). State is never carried by colour alone — every state
pairs colour with position, label, shape or border.

## Decision 4 — Depth has four layers and one shadow scale

Background → glass/surface → card/board → active object. Only cards, sheets and
the active object cast shadows. Everything else separates with a hairline or with
space. No 3D, no neon, no particles.

## Decision 5 — Radius scale

Large surfaces 20–28 px, cards 16–20 px, small controls 12–16 px, capsules full
pill, board squares stay square. Soft, not childish.

## Decision 6 — Typography

High-contrast serif for outcomes and game names; clean sans for all interface
text; mono with tabular figures for room codes, clocks and scores. Few weights,
large jumps between steps, no text below 11 px.

## Decision 7 — Auto-responsive: derive everything, hard-code nothing

Every dimension in the games UI comes from the live window and the safe-area
insets. There are no device branches and no fixed layouts anywhere.

The machinery for this already exists and is the model to extend, not replace:

- `lib/games/rummyTable.ts` — `metrics(win, insets)` computes card width from
  `min(byWidth, byHeight, byBudget)` clamped between `CARD_MIN` 32 and
  `CARD_MAX` 54; `fanFor(cardW, width)` and `handWidthAt()` decide the overlap
  so thirteen cards fit the actual edge; `seatSpots(n, w, h)` places seats.
  Its own header states the goal: "hard-coded sizes fit one device and clip on
  every other, and a clipped Declare button is a lost hand."
- `lib/games/theme.ts` — `typeScale(width)` resolves the three fluid type sizes
  the way CSS `clamp(min, vw, max)` would.
- All four boards already read `useWindowDimensions()`.

**Two mechanisms, doing different jobs.**

*Continuous* — sizes scale and clamp with the display. This is what guarantees
the layout always fits, at any width, including sizes no one has tested.

*Breakpoints* — change the COMPOSITION only: where the actions sit, how many
tiles per row, whether seats move to the rails. A breakpoint may never be what
makes the layout fit; if it is, the continuous rule underneath is wrong.

**What gives way when space is short**, in order: decoration, then label
length, then spacing, then — last, and never below 44 px — target size. A
control is shortened before it is dropped, and dropped only if it does not
exist on that surface at all.

**Live re-derivation.** Rotation, split screen, multi-window, a fold opening,
and a change in system font scale all re-derive the layout. None of them loses
game state.

**Verification is measurement, not inspection.** The existing device method
stands: dump the view hierarchy and assert the real numbers — card count, card
width, overlap, row extent against screen width, remaining slack. Both test
phones currently pass at 54 dp with 298 px and 214 px of slack.

## Decision 8 — Reach

Every action taken during play sits in the lower 42 % of the screen. The top bar
carries identity and settings only — nothing needed mid-turn. Minimum target
44 × 44 px, and disabled controls hold their position so the grid never reflows
under a finger already moving.

## Risks

| Risk | Mitigation |
|---|---|
| Blur costs frames on mid-range Android | Glass confined to small, static, floating surfaces; never over the board |
| Native/web palette divergence | Called out in the proposal as a decision to accept or reject |
| Translucent surfaces reduce contrast | Every text token checked against its actual composited ground, not the base colour |
| "Premium" drifting into decorative | Gold budget, glass allowlist and motion budget are all stated as limits, not suggestions |

## Open questions

1. Does the web client follow this palette, or do the two clients diverge
   permanently?
2. Does `expo-blur` perform acceptably on the Redmi Note 8 Pro, or does glass
   need a solid-fill fallback below a device tier?
