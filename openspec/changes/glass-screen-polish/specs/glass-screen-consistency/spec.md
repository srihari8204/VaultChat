## ADDED Requirements

### Requirement: Both appearance modes are coherent
The app SHALL apply its selected light or dark appearance to normal screen backgrounds, glass surfaces, text, icons and finance forms without mixing dark text with dark surfaces or light text with light surfaces.

#### Scenario: Switching appearance
- **WHEN** the user selects day or night mode
- **THEN** mounted screens and their shared components update together, while saturated hero surfaces keep matching foreground colours

#### Scenario: Readable light surfaces throughout the app
- **WHEN** light appearance is active on authentication, messaging, settings, finance, family, spaces or the Games hub
- **THEN** normal page backgrounds, glass cards, inset fields and boundaries remain visually distinct, and text and icons have readable foreground colours
- **AND** existing dark appearance, security behavior and gameplay remain preserved

### Requirement: Controls fit accessible layouts
Shared controls SHALL support readable labels, at least 44dp touch targets, font scaling, safe-area insets and narrow windows without hiding primary actions.

#### Scenario: Large text on an action sheet
- **WHEN** an action sheet opens in a short window with enlarged text
- **THEN** its heading and actions scroll within the available height and Cancel remains reachable

#### Scenario: Custom heading size
- **WHEN** a screen overrides AppText font size without a line height
- **THEN** its line box grows proportionally instead of inheriting a smaller body line height

### Requirement: Verification claims are evidence based
The delivery SHALL maintain an inventory of every route with separate source review and physical-device status, preserving FLAG_SECURE and account data.

#### Scenario: A route needs a live fixture
- **WHEN** a call, invitation, SOS or other stateful route cannot be safely opened
- **THEN** it remains marked not device verified rather than being reported as passed

### Requirement: Four game boards retain responsive glass presentation
Chess, Rummy, Ludo and Tic-Tac-Toe SHALL provide distinct readable vector artwork, layered glass surfaces and clear active/selected/winning states while preserving existing game rules. Layout SHALL derive from the available container, including safe areas and board borders.

#### Scenario: Six players at a Rummy table
- **WHEN** a Rummy table has six players on a supported narrow landscape viewport
- **THEN** the local hand and five opponent seats remain distinct and the controls remain reachable without seat or card overlap

#### Scenario: Short screen or enlarged text
- **WHEN** the game viewport becomes shorter, narrower or uses enlarged system text
- **THEN** the measured board stays within its available horizontal bounds and surrounding controls wrap or scroll rather than being lost off-screen

#### Scenario: Rotation during gameplay
- **WHEN** a focused game rotates or its available window changes during play
- **THEN** the layout follows the current viewport and device rotation setting, safe-area edges are applied once, and player information and primary actions remain reachable without resetting the game

#### Scenario: Returning from another game
- **WHEN** the user returns to a game that remains mounted on the navigation stack
- **THEN** the focused route controls orientation and recomputes the board layout rather than inheriting another game's orientation lock or stale measurements

#### Scenario: Decorative redesign preserves play
- **WHEN** Chess pieces, Ludo tokens/dice or Tic-Tac-Toe marks are redrawn
- **THEN** their original hit areas, legal-move guards, player ownership and server intent payloads are preserved

### Requirement: Navigation artwork retains familiar placement
The app SHALL provide distinct day/night vector icons for Chats, Status, Apps, Calls and Profile without changing their order, positions or destinations. The center Apps button SHALL retain its raised touch area, and Chats SHALL retain unread badges. The top five chat actions SHALL also retain their existing order and handlers with their new glass artwork.

#### Scenario: Selecting a bottom tab
- **WHEN** the user selects any of the five bottom tabs
- **THEN** the original destination opens and the selected tab has a visual indicator beyond colour alone

#### Scenario: Narrow screen and reduced motion
- **WHEN** the window narrows or reduced motion is enabled
- **THEN** tab labels fit their available slots and selection animations respect the motion preference
