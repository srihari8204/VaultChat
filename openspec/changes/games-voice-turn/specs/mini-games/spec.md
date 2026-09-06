## ADDED Requirements

### Requirement: Table voice offers a relay candidate

Table voice SHALL negotiate every peer connection with an ICE list that
includes VaultChat's own TURN servers, obtained from the app's existing cached
credential helper. A STUN-only negotiation cannot traverse symmetric NAT or
carrier CGNAT, and the games server publishes `sfu: false`, so a relay is the
only remaining path to audio for two players on mobile data.

The list SHALL be the union of VaultChat's servers and any the games server
publishes, so a relay added to that deployment later is used as well.

Failure to obtain TURN credentials SHALL NOT prevent voice from being
attempted: the negotiation falls back to the STUN-only list, which still works
on a permissive network.

#### Scenario: Two players on mobile data

- **WHEN** two players at the same table each join voice from a network that
  blocks direct P2P
- **THEN** the peer connection completes over a relay candidate and each player
  hears the other, instead of the voice bar remaining on "waiting" indefinitely

#### Scenario: The games server publishes its own ICE servers

- **WHEN** `config.js` on the games server lists ICE servers
- **THEN** those servers are used in addition to VaultChat's, not discarded and
  not used instead of them

#### Scenario: TURN credentials cannot be fetched

- **WHEN** the credential request fails or times out
- **THEN** voice still attempts to connect using the STUN-only list, and the
  failure does not throw or block the player from entering voice

### Requirement: Voice meshes every seat at a full table

Table voice SHALL establish a connection between every pair of non-bot players
present at a table, for tables up to the largest size each game offers —
**6 seats for rummy** and **4 seats for ludo**. No seat is left unconnected, and
no pair negotiates twice.

Bots and the local player SHALL be excluded from the mesh: a bot has no
microphone, and offering to oneself yields a connection that never completes.

#### Scenario: A six-seat rummy table

- **WHEN** six human players are seated at a rummy table and all join voice
- **THEN** each player holds a connection to the other five, and every player
  can hear every other player

#### Scenario: A four-seat ludo table

- **WHEN** four human players are seated at a ludo table and all join voice
- **THEN** each player holds a connection to the other three

#### Scenario: A table containing bots

- **WHEN** a table seats a mix of human players and bots
- **THEN** only the human seats are meshed, and the bot seats are skipped
  without error

#### Scenario: Exactly one side dials each pair

- **WHEN** any two players become aware of each other at the same moment
- **THEN** exactly one of them sends the offer, so the negotiation cannot
  collide and leave the pair with no media
