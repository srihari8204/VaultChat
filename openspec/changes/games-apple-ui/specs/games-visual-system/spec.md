# Games visual system

## ADDED Requirements

### Requirement: Tonal colour system with a rationed accent
The games UI SHALL render on a layered tonal ground rather than opaque coloured
panels, and SHALL restrict the gold accent to primary and state roles.

#### Scenario: Surfaces are tonal
- **WHEN** any games surface is rendered
- **THEN** the ground is `#160607`, `#22090A` or `#300D0E`
- **AND** raised surfaces are translucent white at 0.07–0.12 alpha, not a solid maroon fill

#### Scenario: One gold fill per screen
- **WHEN** a screen presents actions
- **THEN** at most one control is filled gold, and it is the primary action
- **AND** every other control uses a neutral or semantic treatment

#### Scenario: Gold's other permitted uses
- **WHEN** a seat is the active turn, or a card is a joker
- **THEN** gold MAY be used for that ring or edge
- **AND** gold is used nowhere else — not on section labels, secondary buttons, or icons

### Requirement: Restrained glassmorphism
Glass SHALL be applied only to floating surfaces, and never to content that
repaints per frame.

#### Scenario: Permitted glass
- **WHEN** rendering navigation, a mode sheet, a floating action group, the voice strip, or an overlay
- **THEN** the surface uses translucent fill, 20–24 px backdrop blur, a 1 px white hairline at 0.14 alpha, one inner top highlight and one soft shadow

#### Scenario: Forbidden glass
- **WHEN** rendering the felt, a card, a board, or a seat
- **THEN** no backdrop blur is applied

#### Scenario: Glass never glows
- **WHEN** any glass surface is rendered
- **THEN** it has no outer glow, no gradient border, and no more than one shadow

### Requirement: A single icon family
All icons SHALL come from one drawn set with consistent construction, and no
emoji SHALL appear in the games UI.

#### Scenario: Construction
- **WHEN** any icon is rendered
- **THEN** it is drawn on a 24 px grid with a 1.5–1.7 px stroke, rounded caps and rounded joins

#### Scenario: No emoji, no mixed libraries
- **WHEN** the games UI renders an icon
- **THEN** it is not an emoji glyph and not from a second icon library

#### Scenario: Meanings are preserved
- **WHEN** an existing control is redrawn
- **THEN** its icon means exactly what it meant before

### Requirement: Icon and control states never rely on colour alone
Every state SHALL be distinguishable without colour perception.

#### Scenario: Six defined states
- **WHEN** an icon is default, selected, pressed, disabled, destructive or success
- **THEN** each renders distinctly, and each pairs its colour with position, label, shape or border

#### Scenario: Disabled controls hold position
- **WHEN** a control becomes disabled
- **THEN** it drops to 0.35 alpha and remains in place
- **AND** the surrounding layout does not reflow

### Requirement: Gameplay is the visual hero
During play the board or table SHALL dominate, and chrome SHALL recede.

#### Scenario: Three questions answered
- **WHEN** a player looks at an active game
- **THEN** who they are playing, whose turn it is, and what to do next are all readable without interaction

#### Scenario: Turn state is multi-cue
- **WHEN** it is a player's turn
- **THEN** the active seat carries a ring, illumination, an inline clock and the words "Your turn"

### Requirement: One-handed reach
Actions taken during play SHALL be reachable with one thumb.

#### Scenario: Action zone
- **WHEN** a game is in progress
- **THEN** every action control sits within the lower 42 % of the screen

#### Scenario: Target size
- **WHEN** any control is rendered
- **THEN** its touch target is at least 44 × 44 px

#### Scenario: Top bar is not needed mid-turn
- **WHEN** a game is in progress
- **THEN** the top bar carries only identity and settings

### Requirement: Motion budget
Motion SHALL be short, purposeful and finite.

#### Scenario: Durations
- **WHEN** a selection, panel transition, card movement or result is animated
- **THEN** it completes within 90–120 ms, 180–220 ms, 180–240 ms or 200 ms respectively

#### Scenario: Nothing animates forever
- **WHEN** a game is idle
- **THEN** no decorative animation is running
- **AND** the only recurring animation is the turn clock inside its warning window

#### Scenario: Reduced motion
- **WHEN** the device requests reduced motion
- **THEN** all transitions are removed and the interface renders in its settled state

### Requirement: Every game state has a designed presentation
Each state the product already produces SHALL have a specific visual answer.

#### Scenario: The state set
- **WHEN** the game is loading, waiting, starting, on the player's turn, on the opponent's turn, warning on time, reconnecting, disconnected, completed, cancelled, errored, empty, full, or a player joins or leaves, or a public table is substituted
- **THEN** each renders a distinct, specific presentation

#### Scenario: No blank waiting
- **WHEN** the table is loading
- **THEN** a skeleton in the table's own shape is shown rather than a bare spinner or an empty screen

#### Scenario: Errors say what happened
- **WHEN** a table cannot be reached
- **THEN** the message names the failure and offers a retry

### Requirement: Functional continuity
The redesign SHALL preserve every existing control, string, mode and navigation
path.

#### Scenario: No control is lost
- **WHEN** the redesigned UI is compared against the shipping build
- **THEN** every existing control is present and reachable by the same navigation

#### Scenario: No feature is invented
- **WHEN** the redesigned UI displays information
- **THEN** every value shown is one the product already computes
- **AND** no badge, rating, reward, achievement, streak or statistic is introduced

#### Scenario: Existing copy is preserved
- **WHEN** a screen carries copy that already exists
- **THEN** the wording is unchanged, including the bot-offer text and the public-table notice

### Requirement: Responsive composition
Layouts SHALL be recomposed per class rather than scaled.

#### Scenario: Five classes
- **WHEN** rendering on a small phone, standard phone, large phone, tablet, or a supported landscape orientation
- **THEN** each has its own composition, and gameplay remains dominant in all of them

#### Scenario: Landscape is composed, not rotated
- **WHEN** a game that supports landscape is rotated
- **THEN** actions move to a side column rather than the portrait layout being stretched

#### Scenario: Orientation behaviour is unchanged
- **WHEN** the redesign is applied
- **THEN** no game gains or loses a supported orientation
