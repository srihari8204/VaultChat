# mini-games Specification

## Purpose
The four games VaultChat ships — Chess, Rummy, Ludo and Tic-Tac-Toe — and the parts of them VaultChat owns.

The games themselves run on a separate, external server (`games.corefinite.com`) whose source we do not have: it owns the deck, the dice, the rules and every result, and this app renders the snapshots it sends. So this capability is deliberately not about game logic. It covers how a player REACHES a table (online, a private room, or the house bot), how an invitation travels through a VaultChat chat, how a game survives closing the app, what the app is allowed to claim about a game it does not referee, and what it must say when the server does something it did not ask for.

Two rules run through all of it. The server is authoritative — nothing here computes whose turn it is, which moves are legal, or who won. And the app never asserts more than the server actually told it: a missing field degrades one affordance rather than the screen, and an unproven claim is not made at all.

## Requirements
### Requirement: Fixed four-game catalogue
The games section SHALL expose exactly four games — Chess, Rummy, Ludo and Tic-Tac-Toe — regardless of what the external games server implements. Any other game identifier SHALL fall back to the hub menu rather than open a board.

#### Scenario: Unknown game in a deep link
- **WHEN** the app opens `vaultchat://games?game=carrom&room=abc`
- **THEN** the games hub is shown with the four games and no board is opened

#### Scenario: Catalogue is complete
- **WHEN** the games hub renders
- **THEN** exactly Chess, Rummy, Ludo and Tic-Tac-Toe are listed, each with its own entry point

### Requirement: The server stays authoritative
The client SHALL NOT compute game truth. Whose turn it is, which moves are legal, who won, the deck, the dice and every score SHALL be taken from the server's `state` snapshot, which SHALL be applied as a wholesale replacement and never as a patch.

#### Scenario: A state frame arrives
- **WHEN** a `state` frame is received for the open table
- **THEN** the rendered board is replaced from that snapshot, and no locally derived turn, legality or winner survives it

#### Scenario: An intent the server refuses
- **WHEN** the player submits a move the server rejects
- **THEN** an `error` toast is shown and the board is corrected by the next snapshot, with no local rollback logic

#### Scenario: An expected field is missing from a snapshot
- **WHEN** a `state` frame omits a field the board reads
- **THEN** the board renders with a defined fallback and remains usable, rather than rendering blank

### Requirement: Game invites travel through chat
A player at a table SHALL be able to send an invite into a VaultChat 1:1 or group chat. The invite SHALL render in the thread as a card naming the game and offering a single action to join that specific table, and SHALL carry the room identifier so the recipient lands at the same table.

#### Scenario: Inviting from a table
- **WHEN** the player taps Invite at a table with a shareable room id and picks a chat
- **THEN** an invite card for that game and room is posted to that chat

#### Scenario: Recipient joins from the thread
- **WHEN** the recipient taps Join on the invite card
- **THEN** the app opens that game's board seated at that same room

#### Scenario: No shareable room
- **WHEN** the player is at a default table with no room id worth sending
- **THEN** the invite action is disabled rather than sending a link that leads nowhere

#### Scenario: Out-of-app fallback
- **WHEN** the player chooses to share outside VaultChat
- **THEN** the existing OS share sheet sends a `vaultchat://games` deep link

### Requirement: Asynchronous games survive leaving the app
The system SHALL keep a per-player list of tables the player is seated at, showing for each the game, the opponent, whose move it is and the remaining turn time. The list SHALL be reachable from the games hub and SHALL be the destination of a turn notification.

#### Scenario: Returning after closing the app
- **WHEN** the player reopens the app while seated at an unfinished table
- **THEN** that table appears in the list marked with whose move it is

#### Scenario: Opening a turn notification
- **WHEN** the player taps a "your turn" push
- **THEN** the app opens that table's board directly

#### Scenario: The list is scoped to the requesting player
- **WHEN** the backend serves the live-table list
- **THEN** the handler scopes rows to the authenticated player itself and never relies on a database policy to do so

#### Scenario: A finished table
- **WHEN** a table reaches a result
- **THEN** it leaves the live list

### Requirement: Matchmaking states the real state of the room
Quick Match SHALL NOT present a bot as the result of a search. While searching it SHALL say what it is doing, and when no human is available it SHALL offer the bot as a labelled choice alongside the alternative of inviting someone.

#### Scenario: No human found
- **WHEN** the matchmaker returns a bot offer
- **THEN** the player is shown that no one is available right now, and is offered both a game against a labelled house bot and the option to invite someone from chat

#### Scenario: A human is found
- **WHEN** the matchmaker pairs the player with a human
- **THEN** the table opens and the opponent is shown as a player, not a bot

#### Scenario: Bots are always labelled
- **WHEN** any seat at a table is held by a bot
- **THEN** that seat is visibly marked as a bot on the board and in the lobby

### Requirement: Turn clock and connection state are visible
Every board SHALL show the remaining time for the current turn from the server-supplied deadline, and SHALL show an unambiguous state when the connection drops, is reconnecting, or the seat has been lost.

#### Scenario: A turn is running down
- **WHEN** the server sends a turn deadline
- **THEN** the board shows the remaining time counting down for the player to move

#### Scenario: The socket drops mid-game
- **WHEN** the table connection is lost
- **THEN** the board shows a reconnecting state and disables input, rather than accepting taps that go nowhere

#### Scenario: Reconnected
- **WHEN** the connection is re-established
- **THEN** the board is rendered from the next server snapshot and input is re-enabled according to that snapshot

### Requirement: Rematch at the end of a board
When a game finishes, the system SHALL offer a rematch with the same opponent from the result screen, and SHALL only seat the rematch once the opponent accepts.

#### Scenario: Offering a rematch
- **WHEN** a game finishes and the player taps Rematch
- **THEN** the opponent is offered the rematch and the player is shown as waiting

#### Scenario: Opponent has left
- **WHEN** the opponent is no longer reachable
- **THEN** the rematch offer reports that and falls back to inviting them, rather than waiting indefinitely

### Requirement: Ludo dice are verifiably fair
The client SHALL contribute its own seed to every Ludo roll and SHALL make the resulting roll verifiable to the player: the client seed, the server's contribution and the resulting number SHALL be inspectable after the roll.

#### Scenario: Inspecting a roll
- **WHEN** the player opens the fairness detail for a completed roll
- **THEN** the client seed, the server contribution and the resulting die value are shown

#### Scenario: Every roll carries a client seed
- **WHEN** the player rolls
- **THEN** the roll intent carries a client seed generated on the device for that roll

### Requirement: Coins are demo coins
The system SHALL treat game coins as demo coins with no monetary value. It SHALL NOT offer purchase, cash-out, transfer or any exchange of coins for value, and every surface showing a balance or a stake SHALL state that the coins are not real money. Balances SHALL be read from the server and never computed on the device.

#### Scenario: Viewing a balance
- **WHEN** the wallet balance is shown
- **THEN** it is the server-supplied balance and it is accompanied by a statement that the coins are demo coins, not real money

#### Scenario: Staking at a table
- **WHEN** a table shows a stake
- **THEN** the stake is presented in demo coins with no purchase or top-up path

### Requirement: Standings are the server's
The leaderboard SHALL render the server's returned rows in the server's order without re-sorting, re-ranking or truncating them, and SHALL show for each form only the statistic that form actually carries.

#### Scenario: Global standings
- **WHEN** the global leaderboard is shown
- **THEN** rows are ranked by the server's order on coin balance, and no rating is displayed

#### Scenario: Per-game standings
- **WHEN** a per-game leaderboard is shown
- **THEN** each row's server-supplied rating is displayed

#### Scenario: A malformed row
- **WHEN** one row in the response fails to parse
- **THEN** the remaining rows still render

### Requirement: How to play
Each of the four games SHALL offer rules the player can read without starting a game, reachable from that game's entry point and from the board.

#### Scenario: First time opening a game
- **WHEN** the player opens a game they have not played before
- **THEN** the rules for that game are offered before the first move is required

#### Scenario: Rules during a game
- **WHEN** the player opens rules from the board
- **THEN** the rules are shown without leaving or forfeiting the table

### Requirement: A player can see the games they have already played
The system SHALL keep a record of finished games on the device and show them newest first: the game, who else was at the table, how it ended and when. Chess records SHALL retain the full move list for the most recent games. Records SHALL be built only from the server's own final snapshot; a field the server did not send SHALL NOT be inferred.

#### Scenario: A game finishes
- **WHEN** a snapshot reports a finished game
- **THEN** one record is written for that table, however many times that snapshot repeats

#### Scenario: Reviewing a chess game
- **WHEN** the player opens a recent chess game that retained its moves
- **THEN** every move of that game is listed in order

#### Scenario: Older chess games
- **WHEN** more chess games are played than the move-retention limit
- **THEN** the older games keep their result and lose only their moves

#### Scenario: The server said nothing conclusive
- **WHEN** a finished snapshot carries no winner and no result
- **THEN** the record reads as finished rather than as a win or a loss

#### Scenario: One game's records cannot crowd out another's
- **WHEN** many games of one kind are played
- **THEN** the records of the other games are retained

### Requirement: Standings show the player's own position honestly
The leaderboard SHALL mark the player's own row when the server's returned table contains it, and SHALL state that the player is not in the table when it does not. It SHALL NOT display a rank the server did not send.

#### Scenario: The player is in the returned table
- **WHEN** the standings include the player
- **THEN** their row is marked and their position is stated

#### Scenario: The player is outside it
- **WHEN** the standings do not include the player
- **THEN** the screen says so, and no position is shown

### Requirement: Every board fits the screen it is on
Each board SHALL size itself from the available width AND height so that no control is rendered outside the display or beneath system insets, in portrait or landscape, on small and large screens.

#### Scenario: A short screen
- **WHEN** a board is rendered where height is the binding constraint
- **THEN** the board shrinks and every control remains within the screen

#### Scenario: A rummy hand
- **WHEN** thirteen cards are held
- **THEN** the hand, the table and the action bar all fit within the safe area
