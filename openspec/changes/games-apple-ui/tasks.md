# Tasks — Games Apple-inspired visual system

Design-only change. Nothing here edits app source; the deliverable is the visual
system and its specification. Implementation, if approved, is a separate change.

## 1. Foundations

- [x] 1.1 Tonal colour system defined, with every token's role stated
- [x] 1.2 Gold budget written down as a limit — one fill per screen, plus turn ring and wild edge
- [x] 1.3 Glass recipe specified, with an explicit allowlist and forbidden list
- [x] 1.4 Four-layer depth model and single shadow scale
- [x] 1.5 Radius scale (20–28 / 16–20 / 12–16 / pill / square boards)
- [x] 1.6 Type system: serif for outcomes, sans for interface, mono for codes and clocks
- [x] 1.7 Motion budget with durations per interaction and a reduced-motion rule

## 2. Icon family

- [x] 2.1 Draw the full set on a 24 px grid at 1.5–1.7 px stroke, rounded caps and joins
- [x] 2.2 Cover all 28 named meanings — four games, modes, table controls and navigation
- [x] 2.3 Define the six states and prove none depends on colour alone
- [x] 2.4 Remove every emoji from the design

## 3. Screens

- [x] 3.1 Games home — continue, featured game, secondary tiles, and the quiet list
- [x] 3.2 Floating glass tab / navigation treatment
- [x] 3.3 Mode sheet — three existing modes as glass decision rows
- [x] 3.4 Bot offer — wording preserved verbatim
- [x] 3.5 Private room, with the code as a glass ticket
- [x] 3.6 Public table, with the substitution notice preserved
- [x] 3.7 Rummy table — header, table, hand, actions
- [x] 3.8 Rummy card states — all ten
- [x] 3.9 Rummy actions as a floating glass group, layout stable when disabled
- [x] 3.10 Chess, Ludo, Tic-Tac-Toe boards
- [x] 3.11 Voice — idle, connected, speaking, muted
- [x] 3.12 Result screen
- [x] 3.13 Leaderboard
- [x] 3.14 Recent games, with the chess move list preserved
- [x] 3.15 All sixteen game states

## 4. Layout — auto-responsive on every display

- [x] 4.1 Small phone, standard, large phone, tablet compositions
- [x] 4.2 Landscape recomposed for the games that already support it
- [x] 4.3 Thumb-reach map — every in-play action in the lower 42 %
- [x] 4.4 State the derive-everything rule: no hard-coded size, no device branch,
      every dimension from live window + safe-area insets
- [x] 4.5 Separate the two mechanisms — continuous scaling makes it FIT,
      breakpoints only change composition
- [x] 4.6 Define the degradation order: decoration → label length → spacing →
      target size last, never below 44 px
- [x] 4.7 Cover live re-derivation: rotation, split screen, multi-window, fold,
      system font scale — none losing game state
- [x] 4.8 Safe areas on every edge, in both orientations
- [x] 4.9 Extend the rule beyond rummy to home, sheets, lobby, the other three
      boards, result, leaderboard, history and the state set

## 5. Verification

- [x] 5.1 Functional continuity table — every existing control mapped to its new home
- [x] 5.2 Confirm nothing invented: no badge, rating, reward, streak or statistic
- [x] 5.3 Contrast checked against composited grounds, not base colours
- [x] 5.4 Answer all fifteen questions of the brief's final design test
- [x] 5.5 **Measured on device, and it found a defect.** Redmi Note 8 Pro,
      shipping build, rummy vs bot. Two corrections and one real bug:

      **Correction — rummy plays in LANDSCAPE.** `Rummy.tsx:272` locks the
      orientation to landscape while playing and portrait in the lobby. Every
      earlier card measurement was therefore already a landscape measurement.
      Confirmed: lobby root `1080x2220`, playing root `2264x1036`.

      **Correction — earlier slack figures were wrong.** They compared the hand
      extent against the phone's *physical* long edge (2340) instead of the
      *usable* window width (2264, after system bars). Real slack is far smaller
      than the 176-298 px previously reported.

      **DEFECT — the hand overflows and the last card is lost.** The app reports
      `13 cards`, but only **12 render**, and the hand extends to exactly the
      usable edge:

      | | usable W | says | rendered | extent | last card |
      |---|---|---|---|---|---|
      | font scale 1.0 | 2264 | 13 cards | 12 | 112..2264 | `5 of spades, joker` at 2230..2264 — 34 px wide instead of 148 |
      | font scale 1.3 | 2264 | 13 cards | 12 | 112..2264 | same |

      With five groups the containers alone need ~2502 px: four groups of
      ~534 px (3 cards + 2x44 px tray padding), one of 385 px, plus four 33 px
      gaps. That is ~238 px more than the 2264 px available, so the trailing
      group is clipped and its cards fall off the edge. In the measured hand the
      lost card was the **joker** — the one card a rummy player most needs to see.

      Enlarging the system font does not worsen it: card geometry is dp-based,
      not sp-based.

      Not yet measured: split screen / multi-window, and tablet.

## 6. Decisions the owner must make

These are not blocked on design work. They are choices only the owner can make,
and both are written up in `design.md`.

- [x] 6.1 **ACCEPTED, 2026-09-03 (owner).** The tonal ground is implemented in
      `lib/games/theme.ts` (commit 28573b1) and the two clients now differ until
      the web one follows. Original wording:
      **Accept or reject the palette divergence.** `lib/games/theme.ts` is a
      verbatim port of the web client's `theme.css`, kept so the two clients can
      be compared side by side. These tokens break that parity. Adopt them on
      native only, adopt them on both, or keep the current palette.
- [ ] 6.2 **Decide the glass fallback tier.** Backdrop blur is the most expensive
      effect on mid-range Android. Measure `expo-blur` on the Redmi Note 8 Pro
      and decide whether glass needs a solid-fill fallback below a device tier.

## 7. Not in this change

- Implementation in `lib/games/theme.ts`, `components/games/*` or `app/games.tsx`
- Any behaviour, rule, scoring, ranking, matchmaking, limit, room, permission,
  navigation or backend change
