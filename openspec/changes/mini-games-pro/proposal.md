## Why

The four games (Chess, Rummy, Ludo, Tic-Tac-Toe) are built, native and server-refereed — and almost nobody plays them. The games platform has ~19 registered players and typically zero online at the same moment, so Quick Match nearly always falls through to a bot offer. The tables work; the room is empty.

The reference apps — Chess.com, RummyCircle, Ludo King — solve this the same way, and none of it is a rules engine: you are never shown an empty lobby, a game you started is still waiting for you tomorrow, and the invite travels through a chat thread. VaultChat is *already* the chat thread. That is the unfair advantage this feature has not used once: today a game invite leaves the app through the OS share sheet and hopes it comes back.

This change closes the gap between "four working boards" and "a game section that behaves like the apps people already play", without adding a fifth game and without touching the external games server's engine.

## What Changes

**Already built — not rebuilt here:** native boards for all four games, the server-authoritative wire protocol (`docs/GAMES_PROTOCOL.md`), themed table UI, SFX and haptics, rummy drag-and-drop with meld hints, dice tumble, table voice mesh, leaderboard (global by coin balance, per-game Elo), demo-coin wallet, Quick Match against the `/live/ws` matchmaker, `vaultchat://games` deep links, and the inbound turn-notification route (`games_notify.go`).

- **Game invites become chat messages.** A new in-chat invite card ("Ravi invited you to Rummy — Join") rendered in 1:1 and group chats, carrying the game and room id. The OS share sheet stays as the out-of-app fallback. **This is the change with the most leverage and it needs no games-server work.**
- **A "Your turn" home for asynchronous play.** The turn push already arrives; there is nowhere for it to land. Adds a persistent list of the player's live tables — whose move it is, how long the turn has left — so a game survives closing the app. This is Chess.com's daily-chess loop, which is the loop that works when the lobby is empty.
- **Rematch.** Every reference app offers it at the end of a board; ours drops the player back to the menu and loses the opponent it just took days to find.
- **Honest matchmaking.** Quick Match currently searches, fails, and offers a bot. It will state the real state of the room (how many are online, that it is about to offer a bot) and offer the asynchronous alternative — invite someone — rather than presenting a bot as the outcome of a search.
- **Turn clock and disconnect handling rendered everywhere.** `deadline` is on the wire every frame; a visible countdown and a clear reconnecting/dropped state are table stakes in all three reference apps.
- **The fairness claim is shown, not just implemented.** Ludo's commit-reveal dice already exist; Ludo King and RummyCircle both advertise provable fairness because players assume dice are rigged. A verifiable roll receipt makes an existing property visible.
- **How-to-play and the demo-coin statement, per game.** A first-run rules sheet, and the "demo coins, never real money" wording kept on every surface that shows a stake.

## Capabilities

### New Capabilities
- `mini-games`: The four-game section as a product — the catalogue and its boundary (exactly four, server-refereed), invitation and re-entry through chat, asynchronous turn continuity, matchmaking honesty, table lifecycle (clock, disconnect, rematch), standings, and the demo-coin boundary.

### Modified Capabilities
<!-- None. The existing specs under openspec/specs/ are all shop-domain (orders, invoicing,
     catalogue, shop notifications) and none of their requirements change. -->

## Impact

- **App:** `app/games.tsx` (hub, Quick Match, entry points), `components/games/*` (four boards, `feedback.tsx`, `ui.tsx`), `lib/games/*` (`invite.ts`, `useQuickMatch.ts`, `useGameSocket.ts`, new turn-list state), and the chat message renderer for the new invite card type.
- **Backend (Go):** `internal/routes/games.go` and `games_notify.go` — the turn notification already lands here; the change is persisting it into a per-player list the app can read, and scoping that read by user in the handler (RLS is inert in prod).
- **Database:** one new numbered migration for the player's live-table list (next after 122). No schema change to messages: the invite card is an existing message row with a typed payload — and any local-only row must keep a negative `messages.id`, since that column is also the delta-sync cursor.
- **External games server:** unchanged. No engine, rules, deck, dice or matchmaker changes are requested of it; everything here is VaultChat-side or already on the wire.
- **Risk:** the wire protocol is reverse-engineered, and a drifted field renders a blank board with no error. Any new field read from `state` needs an explicit fallback.

## Not building

- **No fifth game.** The catalogue is exactly the four on the hub screen. No Carrom, no Poker, no Snakes & Ladders, no Durak — even though the games server implements some of them.
- **No game engines on the device.** No chess move generation, no meld validation, no dice. The server stays authoritative; the client sends intents and renders snapshots.
- **No changes to the external games server.** We do not own its source (distroless image, no shell on the box). Anything requiring a server change — pool/deals rummy, new variants, tournament formats — is out of scope and stays out.
- **No real money.** Coins are demo coins. No purchase, no cash-out, no payment rail, no stake with monetary value. Real-money gaming is a separately licensed product and a legal project, not a UI change.
- **No ranked ladder rework, no seasons, no clubs, no in-game chat.** The table voice mesh already exists; text chat at the table is not part of this.
- **No bots dressed as humans.** A bot is always labelled a bot. Filling an empty room with fake players is how these apps lose trust, and it is the opposite of the honesty this change is arguing for.
