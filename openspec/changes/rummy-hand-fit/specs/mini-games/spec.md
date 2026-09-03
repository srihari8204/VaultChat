# Mini games

## ADDED Requirements

### Requirement: The whole rummy hand is visible without scrolling
A player SHALL be able to see every card in their hand at once, on every
supported display and orientation.

#### Scenario: Thirteen cards are on screen
- **WHEN** a hand of thirteen cards is dealt on any supported display
- **THEN** all thirteen are rendered within the hand's visible viewport
- **AND** no card requires scrolling to be seen

#### Scenario: The tuck is actually applied
- **WHEN** the computed fan is less than 1
- **THEN** the cards overlap on screen by the computed amount
- **AND** the overlap is expressed in a way the layout engine honours, never as a negative gap

#### Scenario: The width model matches the rendered layout
- **WHEN** the model reports that a hand fits a given width
- **THEN** the laid-out hand fits that width on device
- **AND** the model accounts for tray padding, tray borders, the gap between trays and the scroll container's own padding

#### Scenario: Spread when there is room
- **WHEN** the display is wide enough for thirteen cards at full width
- **THEN** the cards do not overlap at all
