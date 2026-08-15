## ADDED Requirements

### Requirement: AI generation is a sheet over the current preview
The system SHALL present theme generation as a bottom sheet hosted by Create or Home, and SHALL render the result into the phone canvas already on screen rather than navigating to a result screen.

#### Scenario: Generating from Studio
- **WHEN** a user generates a theme from Studio
- **THEN** the sheet expands and the result renders in the canvas behind it, with the current theme recoverable by undo

### Requirement: Prompt entry with starters
The system SHALL offer a free-text prompt field with example prompts shown before anything is typed.

#### Scenario: Prompt starters
- **WHEN** the AI sheet opens with an empty field
- **THEN** example prompts such as "Dark futuristic glass", "Luxury black and gold", "Minimal ocean", "Pink anime" and "Cyberpunk" are tappable and fill the field

### Requirement: Generation states are named
The system SHALL show the stages of generation — designing wallpaper, matching colours, creating icons, designing widgets, building layout — and SHALL NOT show an unlabeled spinner.

#### Scenario: Generating
- **WHEN** generation runs
- **THEN** each stage is named as it completes and the canvas shimmers rather than going blank

#### Scenario: Unusable result
- **WHEN** a prompt produces nothing usable
- **THEN** the sheet keeps the prompt text and explains what would help: "Try naming a colour and a mood"

### Requirement: Deterministic, on-device generation
The system SHALL generate a theme from a prompt on-device, without a network round trip, and SHALL produce the same theme for the same prompt and attempt number.

#### Scenario: Offline generation
- **WHEN** the device is offline
- **THEN** generation still succeeds and the result is applyable

#### Scenario: Regenerate
- **WHEN** a user taps Regenerate
- **THEN** the attempt number increments and a different but reproducible theme is produced

#### Scenario: Prompt privacy
- **WHEN** a prompt is submitted
- **THEN** it does not leave the device

### Requirement: Result actions
The system SHALL offer Use theme, Customize, Remix, Regenerate and Save on a generated result.

#### Scenario: Keeping a result
- **WHEN** a user taps Use theme
- **THEN** the apply sheet opens with that theme, exactly as it would for a catalog theme

### Requirement: Remix preserves structure
The system SHALL restyle a theme into a target style while preserving its layout, widget stack and lock configuration, and SHALL present the original alongside its variations.

#### Scenario: Remixing
- **WHEN** a user remixes "Minimal Black" to Cyberpunk
- **THEN** the material treatment changes while the user's layout, widgets and lock settings survive

#### Scenario: Comparing
- **WHEN** the remix sheet opens
- **THEN** the original is shown first, followed by Glass, Luxury, Dark, Neon, Pastel and Anime variations rendered as previews rather than named in a list

### Requirement: Generated palettes are legible by construction
The system SHALL contrast-check a generated palette before it renders.

#### Scenario: Low-contrast prompt
- **WHEN** a prompt implies text and background of the same hue and lightness
- **THEN** the text token is adjusted until it clears 4.5:1, preserving hue
