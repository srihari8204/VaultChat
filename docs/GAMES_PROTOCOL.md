# VaultGames wire protocol

Reverse-engineered from the deployed web clients at `games.corefinite.com`
(`tictactoe.js`, `chess.js`, `ludo.js`, `rummy.js`, `vgnet.js`) on 2026-08-24.
The games server is a single static binary in a distroless image — no shell, no
source on the box — so the shipped clients ARE the specification.

Written down because the native screens are being built against it. Guessing at
a field name here produces a board that renders blank with no error, which is
the most expensive kind of bug to chase.

## The server is authoritative

It owns the deck, the dice and the rules, validates every move, and broadcasts
the whole state after each one. The client sends **intents** and renders what
comes back. It never computes a legal move, a winner, or a score.

That is what makes four games tractable natively: no chess rules engine, no
rummy meld validation, no dice fairness — those already exist server-side and
are the same code the web clients trust.

## Connection

`lib/gamesSocket.ts` already implements this:

1. `POST /games/launch-token` on **VaultChat's** backend → short-lived
   Ed25519-signed token carrying vaultId + name, nothing else.
2. `POST https://games.corefinite.com/api/session` with `credentials:'include'`
   → sets a `gsid` cookie in the native cookie jar.
3. `wss://games.corefinite.com/<path>/ws` — RN's WebSocket sends that cookie.

WS paths: `/tictactoe/ws`, `/chess/ws`, `/ludo/ws`, and rummy is `/ws`.

## Envelope — identical for all four games

Every frame is JSON with a `t` discriminator.

### Server → client

| `t` | Payload | Meaning |
|---|---|---|
| `hello` | `you`, `name` | Your vaultId, before joining |
| `joined` | `you`, `spectator` | Seat confirmed; `spectator` = watching |
| `state` | `you`, `seat`, `spectator`, `lobby`, `game` | **The whole authoritative state.** Replace local state wholesale |
| `event` | `msg` | Human-readable notice → toast |
| `error` | `msg` | Rejected intent → toast |

`state` is a full snapshot, never a delta. Render from it directly rather than
mutating anything locally.

### `lobby`

```
{ status: 'lobby' | ..., hostId, members: [{ vaultId, name, isBot, wins }] }
```

A finished board outranks `status === 'lobby'` — the web clients show the
result on the board rather than bouncing back to the lobby.

## Per-game

### Tic-Tac-Toe

**Send:** `join{roomId}` · `start` · `addbot` · `mark{cell}`

**`game`:** `phase` (`'playing' | 'finished'`), `board: number[9]`,
`turn` (seat index), `turnPlayerId`, `lastCell`, `line`, `winnerId`,
`players: [{ id, seat, name }]`

Board cells: `-1` empty, `0` seat-0, `1` seat-1. Marks are `✕` and `◯`.
`lastCell` drives the just-played animation; `line` is the winning triple.

### Chess

**Send:** `join{roomId, tc}` · `addbot{level}` · `move{from, to, promo}` ·
`draw-offer` · `draw-accept`

**Top-level (beside `game`):** `color` (`'w'|'b'|null` — chess seats by COLOUR,
not seat index), **`legal: [{from,to,promo}]`**, `clock`.

**`game`:** `board`, `turn`, `check`, `result`, `winner`, `lastMove`, `history`

**`legal` IS THE MOVE GENERATOR.** The server sends the complete legal-move list
for the player to move, every frame, along with `check`. So the native client
needs *no chess rules at all* — no sliding-piece generation, no pin detection,
no castling or en-passant special cases, no checkmate search. Tapping a piece is
`legal.filter(m => m.from === square)`.

Several entries sharing a `to` with different `promo` values means a promotion:
ask the player which piece before sending.

`board` is 64 entries, `index = row*8 + col`, **row 0 = rank 8** (black's back
rank). A square is `null` or `{t:'p'|'n'|'b'|'r'|'q'|'k', c:'w'|'b'}`.
`game` is `null` while in the lobby.

Verified against the server source
(`go-server/internal/realtime/chessrooms.go`,
`internal/games/chess/engine.go`), not inferred from the shipped client.

### Ludo

**Send:** `join{roomId}` · `start{mode, stake}` · `addbot` ·
`roll{clientSeed}` · `move{tokenIndex}` · `emote{emoji}`

**`game`:** `phase`, `players`, `pendingDie`, `movable`, `turnPlayerId`,
`winnerId`

`clientSeed` is the player's half of a commit-reveal die roll — the server
combines it with its own so neither side alone decides the number. `movable`
is the set of token indices the current roll permits; anything else is refused.

### Rummy

13-card **Points** rummy. There is no pool (101/201) and no deals variant on
this server: the wire protocol has no pool score, no elimination and no deal
count, and the engine only ever settles a single deal at a time. Anything
resembling those would have to be built server-side first.

**Send:** `lobby` · `join{tableId}` · `addbot` ·
`draw{source: 'open' | 'closed'}` · `discard{cardId}` · `arrange{groups}` ·
`declare{discardId, groups}` · `drop` · `start`

> **`join` takes `tableId`, NOT `roomId`.** Rummy is the only one of the four
> that does. The server does not complain about the wrong key — it simply reads
> a field that is not there and seats you at its default table, so a mistyped
> join looks like it worked and a shared invite code silently goes nowhere.
> This cost the native client every table it ever tried to pick.

**`{t:'lobby'}` → `{t:'tables'}`.** Sent on connect when no table has been
chosen. `tables[]` is `{ id, name, stakes, players, maxPlayers, status }` — the
public tables, their seat counts and their 2–6 player limits. It arrives
*before* any lobby, so it never appears inside a `state` frame and a client that
only handles `state` can never show it.

**Top-level, beside `game`** (all easy to miss, all sent every frame):

| field | meaning |
|---|---|
| `hand` | THIS player's cards. Nobody else's are ever sent to a device. |
| `deadline` | Server epoch-ms the current turn expires. The turn clock. |
| `settlement` | `{ [playerId]: { delta } }` — coins won or lost, at the end. |
| `wallet` | The player's coin balance, refreshed with the table. |

**`game`:** `phase`, `players`, `turnPlayerId`, `winnerId`, `wildRank`,
`wildJokerCard`, `openTop`, `closedCount`

**`players[]`:** `{ id, name, handCount, points, status, isTurn }` where
`status` is `'active' | 'won' | 'dropped' | 'lost'`. **`status` is the field that
says whether a player is still in the hand** — there is no `dropped` boolean,
and reading one that is not sent leaves a player who dropped still looking like
they are holding cards.

**`lobby`** additionally carries `maxPlayers` and
`table: { name, stakes, pointValue }`. **`pointValue === 0` marks a practice
table, and only a practice table accepts `addbot`** — a staked table seating a
bot would be putting the house in the pot, so the server refuses, and an offer
the server refuses reads to a player as a broken button.

`arrange` is cosmetic hand grouping and is persisted per seat, so a
reconnecting player gets their arrangement back. `declare` is the scoring
move and the server validates the melds.

## Table voice — NOT on the games server

Rummy and Ludo boards have a "talk at the table" control. **It does not use the
games server at all**, and the history of getting that wrong is worth keeping:

- The first implementation minted a token from `POST /api/voice/token` on the
  games host. That endpoint answers **404**, and `GET /config.js` on the same
  host reports `{"dev":false,"sfu":false,"sfuMinSeats":4}` — the SFU is off.
  Voice was dead in all four games and looked like a microphone fault.
- The second ported the shipped web client's peer-to-peer mesh
  (`games-web/vgvoice.js`), signalled with `voice-hello|bye|state|offer|answer|
  ice` frames shaped `{t, to, data}` relayed by the games socket. That works,
  but it is O(n²): a six-handed table is five uploads from one phone.
- It now joins a room on **VaultChat's own LiveKit cluster** — the one already
  carrying calls and Go Live — with the token minted by **our** backend at
  `POST /games/voice-token` (`games_voice.go`). Body `{game, room, spectator}`;
  answers `{token, url, room, identity, role}`, or **503** when `LIVEKIT_*` is
  unset, which the board renders as "not available here" rather than a failure.

The room name is composed server-side as `gametable-<game>-<room>`, both halves
slug-validated, so a client can never name a room and cannot reach `call-<id>`
or a Go Live room. A seated player gets the `speaker` role; a spectator gets
`audience`, which carries **no publish grant** — listen-only is enforced by the
media server rather than by the client keeping its own track disabled.

**The trade, stated plainly:** the mesh's membership was enforced by the one
party that knows the seating — the games server relayed a `voice-*` frame only
between peers at the same table. We cannot ask it who is seated (no endpoint),
and `games_live_tables` only has a row once a turn/invite push has arrived. So
the token route's real rule is *a signed-in VaultChat user who knows the table's
room id*. Room ids travel in invite links. Tightening that needs the games
server to vouch for a seat.

## Rules for the native clients

- **Never derive game truth locally.** Whose turn, what is legal, who won — all
  of it arrives in `state`. Local guesses drift from the server and produce a
  board that disagrees with the opponent's.
- **Disable input rather than validate it.** Grey out what `movable` /
  `turn` says is unavailable; if something slips through, the server answers
  `error` and the state snapshot corrects the screen.
- **Treat `state` as a replacement**, not a patch.
- **`addbot` before `start`** is how the web clients do "play a bot": add the
  bot, wait for the seat to appear in `lobby.members`, then send `start`.
