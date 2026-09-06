## ADDED Requirements

### Requirement: Rummy tables can be filtered by seat count

The rummy table list SHALL let a player narrow it to head-to-head (2-seat) or
multi-player (6-seat) tables, using the `maxPlayers` the server publishes for
every table. The filter SHALL be honest about an empty result rather than
showing a blank list.

#### Scenario: Filtering to head-to-head

- **WHEN** a player selects the 2-player filter
- **THEN** only tables whose `maxPlayers` is 2 are listed

#### Scenario: Filtering to multi-player

- **WHEN** a player selects the 6-player filter
- **THEN** only tables whose `maxPlayers` is greater than 2 are listed

#### Scenario: No table of that size is open

- **WHEN** a filter matches no table
- **THEN** the list says so and offers the unfiltered view, rather than
  rendering as empty

#### Scenario: No filter chosen

- **WHEN** a player has not chosen a filter
- **THEN** every table is listed, in the order the server sent them

### Requirement: The rummy variant is named to the player

Rummy SHALL state which variant is being played wherever a player chooses or
sits at a table. A player who arrives expecting Pool or Deals MUST NOT be left
to infer the format from the scoreboard.

#### Scenario: Choosing a table

- **WHEN** the table list is shown
- **THEN** each table names its variant

#### Scenario: Seated at a table

- **WHEN** a player is in a table lobby
- **THEN** the variant is named there too

### Requirement: Pool and Deals matches run over repeated deals

Rummy SHALL support Pool 101, Pool 201, Deals best-of-2 and Deals best-of-6 as
matches composed of repeated single-deal games on one table, since the games
server settles only one deal at a time.

A match SHALL accumulate each player's score across its deals. In Pool, a player
whose accumulated score reaches or passes the limit (101 or 201) SHALL be
eliminated and SHALL NOT take part in later deals of that match. In Deals, the
match SHALL end after the agreed number of deals and the highest chip count
SHALL win.

The accumulated score SHALL be held by VaultChat's backend and read from there
by every client, so all seats agree on it. A client SHALL NOT be the authority
on its own score.

Matches SHALL be offered only on practice tables, where the games server moves
no coins per deal.

#### Scenario: A pool player crosses the limit

- **WHEN** a player's accumulated score reaches or passes the pool limit
- **THEN** they are shown as eliminated and are not dealt into later deals of
  that match

#### Scenario: A deals match completes its deals

- **WHEN** the agreed number of deals has been played
- **THEN** the match ends and the player with the highest chip count is declared
  the winner

#### Scenario: A player disconnects mid-match

- **WHEN** a player loses connection during a deal and returns
- **THEN** the score they see is the backend's, matching every other seat,
  rather than a total derived from the deals their device happened to witness

#### Scenario: A staked table

- **WHEN** a table settles coins per deal (`pointValue` is not 0)
- **THEN** Pool and Deals are not offered on it, so a player is never charged
  per deal and per match at once

#### Scenario: One deal within a match ends

- **WHEN** the server reports a deal's settlement
- **THEN** the match score is advanced by that deal's result and the next deal
  is offered to the players still in the match
