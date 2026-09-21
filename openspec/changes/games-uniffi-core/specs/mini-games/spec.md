## MODIFIED Requirements

### Requirement: Every board fits the screen it is on
Each board SHALL size itself from the available width AND height so that no control is rendered outside the display or beneath system insets, in portrait or landscape, on small and large screens. Any native games-core layout helper used by a board SHALL have a TypeScript fallback that preserves the same fitting behavior when the native module is unavailable.

#### Scenario: A short screen
- **WHEN** a board is rendered where height is the binding constraint
- **THEN** the board shrinks and every control remains within the screen

#### Scenario: A rummy hand
- **WHEN** thirteen cards are held
- **THEN** the hand, the table and the action bar all fit within the safe area

#### Scenario: Native layout helper is unavailable
- **WHEN** a game screen starts on a device where the native games core cannot initialize
- **THEN** the screen uses the TypeScript layout helper and remains playable

#### Scenario: Native and TypeScript layout parity
- **WHEN** a native games-core helper is enabled for a board
- **THEN** a runnable parity check proves the native output matches the TypeScript reference for representative portrait and landscape screen sizes before that helper is used by default

### Requirement: The server stays authoritative
The client SHALL NOT compute game truth. Whose turn it is, which moves are legal, who won, the deck, the dice and every score SHALL be taken from the server's `state` snapshot, which SHALL be applied as a wholesale replacement and never as a patch. Native games-core helpers SHALL NOT create, validate or override server-owned game truth.

#### Scenario: A state frame arrives
- **WHEN** a `state` frame is received for the open table
- **THEN** the rendered board is replaced from that snapshot, and no locally derived turn, legality or winner survives it

#### Scenario: An intent the server refuses
- **WHEN** the player submits a move the server rejects
- **THEN** an `error` toast is shown and the board is corrected by the next snapshot, with no local rollback logic

#### Scenario: An expected field is missing from a snapshot
- **WHEN** a `state` frame omits a field the board reads
- **THEN** the board renders with a defined fallback and remains usable, rather than rendering blank

#### Scenario: Native helper receives a server snapshot
- **WHEN** a native games-core helper derives a view model from a server snapshot
- **THEN** it only normalizes display data and never invents a legal move, winner, score, dice value, deck card or balance absent from the snapshot
