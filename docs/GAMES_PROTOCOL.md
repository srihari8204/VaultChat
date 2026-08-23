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

**Send:** `join{tableId}` · `addbot` · `draw{source: 'open' | 'closed'}` ·
`discard{cardId}` · `arrange{groups}` · `declare{discardId, groups}` · `drop`

**`game`:** `phase`, `players`, `turnPlayerId`, `winnerId`, `wildRank`,
`wildJokerCard`, `openTop`, `closedCount`, `points`, `type`, `label`

`arrange` is cosmetic hand grouping and is persisted per seat, so a
reconnecting player gets their arrangement back. `declare` is the scoring
move and the server validates the melds.

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
