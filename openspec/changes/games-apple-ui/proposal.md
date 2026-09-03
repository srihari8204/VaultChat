# Games UI — Apple-inspired visual system

## Why

The games section works. Four games are playable, online and private play are
device-proven across two phones, and the section has a real identity: maroon
felt, gold hardware, a place rather than a screen.

What it does not have is composition. The current surfaces put every element at
the same volume — gold on borders, labels, buttons and icons at once; emoji
standing in for an icon family; four equal game cards stacked into a list;
controls crowding the hand. The result reads as a competent game screen rather
than a premium product, and the gap is entirely presentational.

This change defines the visual system to close that gap, and nothing else.

## What changes

**Presentation only.** Every game, mode, control, string, player limit, rule,
score, ranking, room behaviour, permission and navigation path stays exactly as
it is. No API, database, matchmaking or game-logic change is in scope, and none
is implied by anything here.

- A layered tonal colour system. Maroon becomes the environment
  (`#160607` / `#22090A` / `#300D0E`) rather than the colour of every component;
  surfaces become translucent white at low alpha. Gold (`#F3C245`) is retained
  but rationed to one primary action per screen, the active-turn mark and the
  wild card.
- Restrained glassmorphism on floating surfaces only: navigation, mode sheets,
  action groups, voice, overlays. Not on content, not on the felt, not on cards.
- One drawn icon family — 24 px grid, 1.5–1.7 px stroke, rounded caps and joins —
  replacing all emoji, with six defined states each.
- A floating glass navigation/tab treatment replacing rectangular button rows.
- An editorial type system: high-contrast serif for outcomes and game names, a
  clean sans for interface, mono for codes, clocks and scores.
- A four-step depth model, a deliberate radius scale, and a motion budget with
  no continuous decorative animation.
- Recomposed layouts for small phone, standard, large phone, tablet and the
  landscape orientations each game already permits.

## Impact

- **Affected surfaces:** games home, mode sheet, bot offer, private lobby,
  public table, the four boards, card states, result, leaderboard, recent games,
  voice, and every existing game state.
- **Affected code, when implemented:** `lib/games/theme.ts` (token layer),
  `components/games/*`, `app/games.tsx`. Presentation layers only.
- **Not affected:** `lib/games/*` logic modules, `lib/gamesSocket.ts`, the games
  server protocol, `vaultchat-backend-go`, migrations, permissions, navigation.
- **Deliberate departure:** the token values in this change do not match the
  current `lib/games/theme.ts`, which is a verbatim port of `games-web`'s
  `theme.css`. Adopting them means the native client's palette intentionally
  diverges from the web client's. That is a decision this proposal is asking
  for, not an oversight — see `design.md`.
- **Risk:** low and reversible. The one real risk is performance: blur is
  expensive on mid-range Android, which is why glass is restricted to small
  floating surfaces and excluded from anything that repaints per frame.
