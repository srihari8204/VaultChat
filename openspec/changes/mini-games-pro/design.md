## Context

The four games are native RN screens against an external, authoritative games server (`games.corefinite.com`). We do **not** own that server's source — distroless image, no shell on the box — and its wire protocol is reverse-engineered in `docs/GAMES_PROTOCOL.md`. Everything in this change therefore has to be built on the VaultChat side, out of fields the server already sends.

Current state that matters to the design:

- `lib/gamesSocket.ts` mints an Ed25519 launch token from our backend, exchanges it for a `gsid` cookie, and opens `wss://games.corefinite.com/<game>/ws`. Rummy joins with `tableId`, the other three with `roomId`.
- `lib/games/useQuickMatch.ts` talks to `/live/ws` and gets back `match{roomId}` or `botoffer{roomId}`.
- `vaultchat-backend-go/internal/routes/games_notify.go` already **receives** signed turn notifications from the games server and pushes them via FCM with a 4h TTL. It stores nothing.
- `lib/games/invite.ts` builds a `vaultchat://games?game=&room=` deep link and hands it to the OS share sheet.
- `app/chat.tsx` already renders non-text message types (`system`, `location`, `poll`) by discriminating on `m.type`.
- Prod is at migration 122; 123 (`call_invites`) exists locally and is not yet applied.

Reference bar: Chess.com (daily/async play, a "your move" list, rematch), RummyCircle (turn clock ring, table state, fairness claim), Ludo King (invite a friend into the same room, labelled bots).

## Goals / Non-Goals

**Goals:**
- A game invite that travels inside a VaultChat chat thread and lands the recipient at the same table.
- A game that survives closing the app: a live-tables list that a turn push can open.
- Honest matchmaking, a visible turn clock, a legible disconnect state, and rematch.
- Do all of it without a games-server change and without a rules engine on the device.

**Non-Goals:**
- A fifth game, any engine work, any real-money path, ranked seasons, clubs, or table text chat.
- Replacing the OS share sheet — it stays as the out-of-app path.

## Decisions

### 1. The invite is a typed chat message, not a new subsystem

`app/chat.tsx` already switches on `m.type` for `system`, `location` and `poll`. A game invite becomes one more type — `game_invite` — whose content carries `{game, room}`. Reusing that path means no new table, no new sync route, no new delivery guarantees: the invite inherits E2EE, delivery, retention and the existing renderer.

*Alternatives considered.* A dedicated invites table with its own endpoint — rejected: it would need its own delivery, its own retention and its own read path to do what a message row already does. Posting a plain text link — rejected: it renders as a URL, not as a card with a Join action, and the reference apps all use a card.

**Constraint carried in:** any locally inserted invite row must use a negative `messages.id`, because that column is both the sort key and the delta-sync cursor. (In the end the invite inserts no local row at all — `sendMessage` returns the server row — so the rule is satisfied by construction and asserted by the selftest.)

**What "reuse the message path" actually costs (found during implementation).** A message type is not free-form: it is gated in *three* places, and all three must agree or the send fails.

1. A Postgres `CHECK` constraint on `messages.type` (last written by migration 075). → migration **124**.
2. A Go allowlist, `chatsMsgTypes` in `chats_helpers.go`. → one entry.
3. A per-type validation arm in the same file's send switch.

So the invite card is **not** the zero-backend change the proposal implied — it needs a migration and a Go deploy before it works, even though it adds no table and no endpoint. The proposal's claim that it "needs no games-server work" still holds: none of this touches the external games server.

**And the third place is where the card stops being a link.** `group_ref` is validated by *overwriting* its meta from the database. That is impossible here — the games server is a separate deployment whose rooms this database has never heard of — so the server validates instead: the game must be one of the four, and the room must match `^[A-Za-z0-9_-]{1,64}$`, the same shape `gamesNotifySlug` already enforces on the notification path. Validating only on the client would leave both rules to a modified client, and the room id goes into a URL other people open.

### 2. The live-tables list is derived from the turn notifications we already receive

`games_notify.go` is already the endpoint the games server signs and POSTs to for every turn. Instead of asking the games server for a list it may not expose, we persist what it already tells us: upsert a row per `(vaultId, game, room)` on each notification, mark whose move it is and when the turn expires, and delete the row when a notification reports a result. The app reads that list from our own backend.

*Alternatives considered.* Polling the games server for the player's tables — rejected: no such endpoint is known to exist, and we cannot add one. Keeping the list only on the device — rejected: it would not survive a reinstall and could not be the target of a push that arrives while the app is dead.

**Constraint carried in:** RLS is inert in prod (the API connects as superuser), so the read handler must scope by the authenticated vaultId itself.

**Known ceiling:** the list is only as current as the last notification. A game whose opponent never moves ages out rather than being reconciled against the server. Acceptable — the table itself is authoritative the moment it is opened, and the list is a launcher, not a source of truth.

### 3. Nothing new is computed from the game state

The turn clock renders the server's `deadline`; the "whose move" flag renders `turnPlayerId`; the bot label renders `members[].isBot`. Every one of these is already on the wire every frame. The rule from the protocol doc holds unchanged: local guesses drift from the server and produce a board that disagrees with the opponent's.

Because the protocol is reverse-engineered and a missing field renders a blank board with **no error**, every field this change starts reading gets an explicit fallback: no deadline → no countdown (not a frozen zero), no `isBot` → unlabelled seat (not "human").

### 4. Rematch is `start`, and the invite is only its fallback

**Revised during implementation.** The plan was to open a fresh room and send an invite card. That was wrong: all four boards already send `{t:'start'}` from their result screen and the server re-deals the same table with the seats it already has. A fresh room would discard the opponent it just took days to find.

What was actually missing is everything around the button. It fired into the socket and, if the opponent had already left, nothing on screen changed — so the player tapped a dead control with no way to tell. `lib/games/useRematch.ts` adds the three states that were absent: waiting (which **ends**, on the next snapshot or on a 20s timer, never indefinitely), they-did-not-come-back, and nobody-is-seated. The last two both offer the invite card from decision #1, pointed at this same room — so a friend who taps it lands at the table that is already set up.

The invite therefore stays in the design exactly where it belongs: as what happens when the cheap path fails, not as the path itself.

### 5. Fairness is disclosure of an existing mechanism

Ludo's `roll{clientSeed}` commit-reveal already exists. The work is retaining the seed and the server's reveal for the last rolls and showing them, not building a new RNG.

## Risks / Trade-offs

- **Protocol drift renders a blank board silently** → every newly read field gets a fallback; the four boards keep rendering from the snapshot they get, and a missing field degrades one affordance rather than the screen.
- **A notification-derived list can go stale** → the list is a launcher only; opening a table re-syncs from the server, and a table whose notifications stop ages out instead of lying indefinitely.
- **The invite card is a new message type older clients will not know** → it must fall back to a readable text form (the deep link and the game name) on any client that does not render the type, so an invite is never an empty bubble.
- **Coins are demo coins and this change makes stakes more visible** → the demo-coin wording stays on every surface showing a balance or a stake; no purchase or cash-out path is added anywhere, in any build.
- **More push traffic from turn notifications** → the existing 4h TTL and text bounds in `games_notify.go` are unchanged; persistence is added beside the push, not in place of it.

## Migration Plan

1. Two migrations (prod is at 122; 123 is local and unapplied). **124** widens the `messages.type` CHECK to admit `game_invite` — a strict superset of 075, so it can only accept previously-rejected rows. **125** creates the live-tables table; additive only, so rollback is dropping it.
2. Go files change under `internal/routes/`: `chats_helpers.go` (the `game_invite` type and its validation), `games_notify.go` (to persist), plus the new scoped read handler on `games.go`. Deploys are **file copy**, not git: the change is not shipped until the file is on prod and the migration ledger reads 125.

   `chats_helpers.go` is the file prod was once ahead of the repo on. Diff prod against the repo copy before overwriting it, LF-normalised.
3. App changes ship in the next Android build. Ordering is NOT free for the invite card: until 124 and `chats_helpers.go` are on prod, sending one returns `400 invalid type`. Backend first, then the app. The live-tables list is the tolerant half — no endpoint means an empty list, so those two can land in either order.
4. Rollback: drop the migration and revert the two Go files; the app degrades to today's behaviour — no live list, share-sheet invites only.

## Open Questions

- Does the games server expose any endpoint for a player's current tables? If it does, decision #2 becomes a read-through instead of a derived list. Unknown without access to the box.
- ~~Does the games server send a notification on game *end*?~~ **RESOLVED during implementation: no.** The signed claims carry `kind` of `turn | invite | friend` and nothing else, so no game-over event exists and delete-on-result is impossible server-side. The list is therefore swept by age (14 days), and the app deletes a row when it opens a table whose snapshot says the game is over — the client is the only party that ever learns this.
- The notify contract also carries no turn deadline, only the token's own 5-minute `exp`. So the list shows when we last heard ("3h ago"), not time remaining; the real deadline reaches the board over the WebSocket every frame.
- Should the invite card be joinable by anyone in a group chat, or only the first responder? Rummy tables seat 2–6, so a group invite is genuinely multi-seat; chess is not.
