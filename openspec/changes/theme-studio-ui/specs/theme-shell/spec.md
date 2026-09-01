## ADDED Requirements

### Requirement: Four primary destinations
The system SHALL expose exactly four primary destinations — Home, Create, Library and Profile — and SHALL NOT expose a primary destination for any content type (wallpapers, icons, widgets, lock screens, themes, AI or categories).

#### Scenario: Content types are not destinations
- **WHEN** a user looks for wallpapers, icons, widgets or lock screens
- **THEN** they are reached as content inside Home or as an editor panel inside Create, and no tab exists for them

#### Scenario: Maximum navigation depth
- **WHEN** a user opens any theme from any surface
- **THEN** the deepest reachable state is the immersive preview presented over its host, and no further push occurs before the theme can be applied

### Requirement: Rule of admission for new screens
The system SHALL treat a new pushed destination as justified only when it owns a scroll position worth preserving, is reachable from more than one place, and loses meaning inside its parent's context. Every other interaction SHALL be a bottom sheet, modal, inline editor, carousel or expandable panel.

#### Scenario: An interaction that fails the test
- **WHEN** a designer proposes a screen for choosing an icon pack
- **THEN** it is implemented as a panel inside Create, because it loses meaning outside the theme being edited

### Requirement: Destination state persistence
The system SHALL preserve scroll position, active filter and search text per destination for the session.

#### Scenario: Returning to Home
- **WHEN** a user leaves Home for Create and returns
- **THEN** Home restores its previous scroll position and active style chip

#### Scenario: Re-tapping the active destination
- **WHEN** a user taps the active destination in the tab bar
- **THEN** the surface scrolls to top; a second tap clears the active filter

### Requirement: Customize hands off without pushing
The system SHALL load a theme into Create and switch destinations when the user chooses Customize, rather than pushing an editor screen.

#### Scenario: Customize from the preview
- **WHEN** a user taps Customize in the immersive preview
- **THEN** Create becomes the active destination with that theme loaded, the tab bar remains visible, and no screen is pushed

### Requirement: Onboarding is a one-time modal flow
The system SHALL present Splash, Welcome, Style picker and Personalized results as a one-time modal flow of at most four steps, SHALL allow guest use, and SHALL NOT require an account before the user sees personalized content.

#### Scenario: Guest path
- **WHEN** a user chooses Continue as guest
- **THEN** onboarding completes and every capability except publishing is available

#### Scenario: Style picker is skippable
- **WHEN** a user skips the style picker
- **THEN** Home personalizes from trending content instead, and no empty state is shown

#### Scenario: Notification permission timing
- **WHEN** onboarding runs
- **THEN** notification permission is requested in context after value is shown, never on the first screen

### Requirement: Applied theme is global state
The system SHALL hold one applied theme and SHALL reflect a change to it across every surface within the same frame.

#### Scenario: Applying from Library
- **WHEN** a user applies a theme from Library
- **THEN** the Library marker, the Create canvas and the Profile appearance row all show the new theme without a manual refresh
