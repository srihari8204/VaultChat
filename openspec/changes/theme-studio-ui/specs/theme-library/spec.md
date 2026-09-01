## ADDED Requirements

### Requirement: One shelf, not one screen per collection
The system SHALL present My themes, Favourites, Downloads, Created and Recently used as filters over a single library grid, and SHALL NOT create a destination per collection.

#### Scenario: Switching collection
- **WHEN** a user switches from All to Created
- **THEN** the same grid re-filters in place, preserving scroll where possible

#### Scenario: Origin is visible
- **WHEN** the grid contains saved, downloaded, created and AI themes together
- **THEN** each carries a badge naming its origin, so the difference is legible without a separate tab

### Requirement: Content-type filters
The system SHALL offer All, Themes, Icons, Widgets and Wallpapers as filters over the same library content.

#### Scenario: Filtering to wallpapers
- **WHEN** a user filters to Wallpapers
- **THEN** the grid shows the wallpaper surface of each owned theme, opening the same preview with that surface foregrounded

### Requirement: The applied theme is pinned
The system SHALL show the currently applied theme at the top of Library with an explicit marker.

#### Scenario: Applied marker
- **WHEN** Library opens
- **THEN** the applied theme appears first, labelled as applied with the time it was applied

### Requirement: Saved theme actions
The system SHALL offer Apply, Customize, Share and Delete on a saved theme, presented as an action sheet or inside the preview.

#### Scenario: Deleting
- **WHEN** a user deletes a saved theme
- **THEN** the tile collapses, neighbours reflow, and an undo remains available for five seconds

#### Scenario: Applying from Library
- **WHEN** a user applies a saved theme
- **THEN** the same apply sheet used everywhere else opens, with the same component list

### Requirement: Library works offline
The system SHALL keep every library entry available without a network connection.

#### Scenario: Offline library
- **WHEN** the device is offline
- **THEN** the full library renders, applying works, and only cloud-synced additions are unavailable — stated in a dismissible strip

### Requirement: Empty library is a route to content
The system SHALL present an empty library with a visual state, an explanatory line and an action that leads to Home.

#### Scenario: First open
- **WHEN** a user opens Library with nothing saved
- **THEN** the state reads "Your library is waiting for its first theme." with an Explore themes action, and never "No content found"
