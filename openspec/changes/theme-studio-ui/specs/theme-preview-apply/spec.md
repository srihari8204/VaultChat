## ADDED Requirements

### Requirement: Immersive preview replaces the detail page
The system SHALL present a tapped theme as a full-screen immersive preview dominated by a phone frame, and SHALL NOT present a traditional product-detail page.

#### Scenario: Opening from a card
- **WHEN** a user taps a theme card
- **THEN** the card's artwork expands into the phone frame as a shared element, and the theme fills the screen

#### Scenario: Dismissal
- **WHEN** the user swipes down or taps back
- **THEN** the preview collapses into the card it grew from, and the host surface keeps its scroll position

### Requirement: Surfaces are a swipe apart
The system SHALL let the user move between Home screen, Lock screen and Widgets inside the preview by horizontal swipe, and SHALL provide an equivalent visible control.

#### Scenario: Swiping surfaces
- **WHEN** the user swipes the phone frame horizontally
- **THEN** the preview pages between Home, Lock and Widgets with the wallpaper parallaxing behind

#### Scenario: Gesture has a control
- **WHEN** a user cannot perform the swipe
- **THEN** a segmented control performs the same change, and no surface is reachable only by gesture

### Requirement: Preview metadata and actions
The system SHALL show theme name, creator, style tags, premium status, likes and downloads beneath the preview, with a sticky primary action of Apply theme, a secondary of Customize, and a favourite affordance.

#### Scenario: Premium theme
- **WHEN** the theme is premium and the user is on the free plan
- **THEN** the premium status is visible before the user taps Apply, and the paywall never arrives as a surprise

### Requirement: Variations and complete-the-look are inline
The system SHALL offer sibling variations of a theme and matching content as inline rails inside the preview, and SHALL NOT open a new surface for either.

#### Scenario: Switching variation
- **WHEN** a user taps a variation chip
- **THEN** the phone frame re-renders in place with that variation, preserving the current surface (Home / Lock / Widgets)

### Requirement: Apply is a sheet that states its scope
The system SHALL present Apply as a bottom sheet listing every component that will change — wallpaper, icons, widgets, lock screen, colours — with a per-component statement of whether it applies in-app immediately or requires a platform installation step, shown before the user commits.

#### Scenario: Committing
- **WHEN** the user taps Apply everything
- **THEN** all in-app components apply immediately and any platform handoff is presented as a named next step, not as a silent omission

#### Scenario: Choosing to customize instead
- **WHEN** the user taps Customize first
- **THEN** the sheet dismisses and the theme loads into Create without applying anything

#### Scenario: Deselecting a component
- **WHEN** the user unchecks Widgets
- **THEN** widgets are excluded from the apply and the summary count updates before commit

### Requirement: Apply progress is legible per component
The system SHALL show progress per component during apply — preparing theme, wallpaper, icons, widgets, finishing — and SHALL end in an explicit confirmation.

#### Scenario: Success
- **WHEN** every component applies
- **THEN** the sheet shows "Your new look is ready" with a Done action and a success haptic

#### Scenario: Partial failure
- **WHEN** one component fails
- **THEN** the sheet names which components landed, which did not and why, and offers to finish the remainder — never reporting a blanket success

#### Scenario: Failure recovery
- **WHEN** apply fails entirely
- **THEN** the previous theme remains intact and the error explains what failed with a retry
