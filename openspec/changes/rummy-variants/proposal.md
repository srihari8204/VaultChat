## Why

Measured against the RummyCircle feature set, VaultChat rummy offers **one of
the three gameplay variants and none of the table-format filtering**.

What exists today, verified in source and against `docs/GAMES_PROTOCOL.md`:

| RummyCircle feature | VaultChat today |
|---|---|
| **Points rummy** | ✅ built — this is the only thing the games server plays |
| **Pool 101** | ❌ absent |
| **Pool 201** | ❌ absent |
| **Deals — best of 2** | ❌ absent |
| **Deals — best of 6** | ❌ absent |
| **2-player table filter** | ❌ absent — no filter of any kind |
| **6-player table filter** | ❌ absent |
| Variant named to the player | ❌ the app never says which rummy this is |

The two halves of that table have **completely different costs**, and conflating
them is how this gets mis-planned:

**The table-size filter is free.** The server already sends `maxPlayers` on
every entry of `{t:'tables'}` (`tables[]` is
`{ id, name, stakes, players, maxPlayers, status }`, per GAMES_PROTOCOL.md).
The app receives it, renders it as text — `2/6 seated` — and offers no way to
filter on it. A head-to-head player has to read every card to find a 2-seat
table. This is a client-side filter over data already in hand.

**Pool and Deals do not exist on the games server, and cannot be asked for.**
The protocol doc is explicit: *"There is no pool (101/201) and no deals variant
on this server: the wire protocol has no pool score, no elimination and no deal
count, and the engine only ever settles a single deal at a time."* The server is
distroless and we do not own its source, so no engine change is available.

But they are **not therefore impossible**, and that is the finding worth acting
on. Pool and Deals are both *scoring wrappers around repeated Points deals*, and
the server already hands us every input one needs:

- `settlement: { [playerId]: { delta } }` and `players[].points` at the end of
  each deal — the per-deal result.
- `start` re-deals the same table with the seats it has (this is how the
  existing rematch works).

So a match becomes: a sequence of server deals, plus an accumulated score and an
elimination rule that **VaultChat** owns. That layer is buildable. It is a real
feature with a database behind it, not a UI toggle — and it must not be sold as
one.

## What Changes

**Phase A — table formats (client-only, no server work)**
- Filter the rummy table list by seat count: All / 2-player / 6-player, driven
  by the `maxPlayers` the server already sends.
- Name the variant on the table card and in the lobby, so "Points rummy" is
  stated rather than assumed.

**Phase B — Pool and Deals as a VaultChat-owned match layer**
- A *match* wraps repeated deals on one table: Pool 101, Pool 201,
  Deals best-of-2, Deals best-of-6.
- Accumulated score per player across deals, held by the VaultChat backend so
  every seat agrees.
- Pool elimination at 101 / 201; Deals ends after a fixed deal count and the
  highest chip count wins.
- **Matches run only on practice tables (`pointValue === 0`).** A staked table
  settles coins on *every* deal, so a pool run there would charge a player per
  deal *and* per match — see design.md.

## Capabilities

### New Capabilities

_None._ This extends an existing capability rather than introducing one.

### Modified Capabilities

- `mini-games`: rummy SHALL let a player filter tables by seat count, SHALL name
  the variant it is playing, and SHALL support Pool (101/201) and Deals
  (best-of-2/6) matches layered over the server's single-deal engine.

## Impact

**Phase A — code**
- `lib/games/rummyTable.ts` — a pure seat-count filter beside the existing pure
  helpers.
- `components/games/Rummy.tsx` — filter control on the table list; variant label
  on `TableCard` and in the lobby.
- `lib/games/rummyTable.selftest.ts` — filter cases.

**Phase B — code and systems**
- Migration: a match record and its per-deal scores.
- Go API: create/read/advance a match; the authority every client reads.
- `components/games/Rummy.tsx`: match lobby, running scoreboard, elimination and
  match-over states.
- Depends on a backend deploy, which this session cannot perform — the auto-mode
  classifier refuses prod writes (see `vaultchat-mini-games-pro`).

**Blast radius**
- Phase A cannot affect a running game: it filters a list.
- Phase B adds states around the board and does not touch the deal itself; the
  server remains the sole authority on cards, turns and validity.

## Not building

- **No server-side pool engine.** We do not own the games server's source. Every
  option here layers on the single-deal engine we were given.
- **No cash/real-money play.** VaultChat coins are play coins. Pool and Deals
  are the *formats*, not the wagering — see `vaultchat-lucky-draw` for why money
  paths are handled separately and locally.
- **No Pool or Deals on staked tables.** Double-charging is the reason
  (design.md, Decision 2); practice-only is a deliberate constraint, not a
  simplification to revisit casually.
- **No client-authoritative scoring.** A device that misses a deal while
  disconnected would carry a different total from its opponents, and rummy
  scores decide who is eliminated. The backend holds the score or the feature
  does not ship.
- **No new game.** The catalogue stays exactly four (owner decision, 2026-09-02).
