## ADDED Requirements

### Requirement: One studio, seven panels, zero pushes
The system SHALL provide a single Theme Studio containing a live phone canvas and a horizontal toolbar of seven editors — Wallpaper, Icons, Widgets, Colors, Layout, Lock Screen, Typography — each opening as a bottom sheet or expandable panel over the canvas.

#### Scenario: Opening an editor
- **WHEN** a user taps any toolbar entry
- **THEN** a panel rises over the canvas, the canvas stays visible, and no screen is pushed

#### Scenario: Moving between editors
- **WHEN** a user moves from Colors to Icons
- **THEN** the open panel swaps content in place without dismissing to an intermediate surface

### Requirement: The editor is the preview
The system SHALL apply every token change to the canvas immediately and SHALL NOT provide a separate preview mode, screen or button.

#### Scenario: Colour change
- **WHEN** a user selects a new accent
- **THEN** icons, widgets, buttons and the wallpaper tint update within one frame, cross-faded rather than cut

#### Scenario: Icon treatment change
- **WHEN** a user selects a glass icon fill
- **THEN** every icon on the canvas re-renders in that treatment immediately

### Requirement: Studio chrome
The system SHALL present back, theme name, undo, redo and save in the Studio header, and SHALL show whether the theme has unsaved changes.

#### Scenario: Undo and redo
- **WHEN** a user makes three edits and taps undo twice
- **THEN** the canvas returns through the previous two token states and redo restores them

#### Scenario: Leaving with unsaved changes
- **WHEN** a user leaves Studio with unsaved edits
- **THEN** a compact sheet offers Save, Discard and Keep editing — changes are never lost silently

### Requirement: Wallpaper panel
The system SHALL offer wallpaper by category — Trending, AI, Nature, Anime, Minimal, Abstract, Gradient, Space, Cars, Architecture, Seasonal, Live — as visual thumbnails, with select, position, blur and brightness adjustments applied live.

#### Scenario: Adjusting blur
- **WHEN** a user drags the blur control
- **THEN** the canvas wallpaper blurs continuously while dragging, and icon legibility is re-evaluated against the new background

### Requirement: Icons panel
The system SHALL offer complete icon packs, individual app icon replacement, and generated icon styles as three segments of one panel, and SHALL match icon colour to the theme accent automatically when a pack is applied.

#### Scenario: Applying a pack
- **WHEN** a user applies an icon pack
- **THEN** every icon on the canvas changes at once and the pack is recorded on the theme

#### Scenario: Replacing one app icon
- **WHEN** a user selects a single app and replaces its icon
- **THEN** only that icon changes, and a reset affordance returns it to the pack default

### Requirement: Widgets panel
The system SHALL offer clock, weather, calendar, battery, photos, music, quotes, countdown, steps, health, notes and system widgets as visual cards, with size, shape, colour, transparency, font, background and layout controls, and SHALL support placing widgets by drag with an accessible alternative.

#### Scenario: Placing a widget
- **WHEN** a user drags a widget card onto the canvas
- **THEN** it lands in the widget stack and renders in the theme's current treatment

#### Scenario: Accessible reorder
- **WHEN** a user cannot drag
- **THEN** Move up and Move down actions perform the same reorder

### Requirement: Colors panel
The system SHALL expose accent, background, surface, text, icon and widget colour as one palette, offer preset palettes, custom colour, gradient and a generated palette, and SHALL guarantee contrast.

#### Scenario: Illegible choice
- **WHEN** a chosen combination falls below 4.5:1 for text
- **THEN** the text token is adjusted in lightness with its hue preserved, and the adjustment is stated rather than silent

### Requirement: Lock screen panel
The system SHALL flip the canvas to the lock surface when the lock panel opens, and offer clock style, font, colour, wallpaper, widgets, position and effects.

#### Scenario: Opening the lock panel
- **WHEN** the lock panel opens
- **THEN** the canvas animates to the lock surface so every control has a visible effect

### Requirement: Typography panel
The system SHALL present fonts as visual previews grouped as Elegant, Modern, Minimal, Bold, Playful and Classic, rendered in preview text rather than named in a list.

#### Scenario: Selecting a font
- **WHEN** a user selects a font
- **THEN** the clock, widget and label type on the canvas update immediately

### Requirement: Save and name
The system SHALL save a theme with a name into the library, and SHALL default the name from its origin rather than requiring input before saving.

#### Scenario: Saving a remixed theme
- **WHEN** a user saves an edited copy of a catalog theme
- **THEN** it is stored as their creation with a default name, editable in the same sheet, and the original is untouched
