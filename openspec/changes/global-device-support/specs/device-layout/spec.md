## ADDED Requirements

### Requirement: Insets and breakpoints track the live window
Safe-area insets and width/height breakpoints SHALL be read from the live window at render time. They SHALL NOT be computed at module scope, because `AndroidManifest.xml` declares `configChanges="keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize"`, so the activity is never recreated and module-scope values stay frozen for the process lifetime.

#### Scenario: Device rotated
- **WHEN** the user rotates the device from portrait to landscape
- **THEN** every screen re-reads top and bottom insets and the narrow/short breakpoints, and chrome repositions to the new geometry without an app restart

#### Scenario: Foldable unfolded or split-screen entered
- **WHEN** the window size changes because the device is unfolded or the app enters split-screen
- **THEN** breakpoint-dependent layout re-evaluates against the new width, and no value derived at launch is reused

#### Scenario: Guardrail rejects a frozen read
- **WHEN** a module under `app/`, `components/`, `lib/` or `constants/` calls `Dimensions.get()` or reads `initialWindowMetrics` at module scope without a documented exemption
- **THEN** the responsive-coverage selftest fails and names the file and line

### Requirement: Self-drawn headers use the shared top inset
A screen that renders its own header (with `headerShown: false` or no native header) SHALL derive its top spacing from the shared `HEADER_TOP` value. It SHALL NOT hardcode a status-bar height.

#### Scenario: Header on a device with a tall status bar
- **WHEN** a self-drawn header renders on a device whose top inset exceeds 48 dp
- **THEN** the header content clears the status bar and no title, icon or control is occluded

#### Scenario: Header on a device with a short status bar
- **WHEN** the same header renders on a device with a ~28 dp top inset
- **THEN** the header adds no more than the shared inset plus its designed spacing, leaving no dead band

#### Scenario: Screen already padded by the router
- **WHEN** a screen is listed in the router's inset-injecting set and also applies its own top padding
- **THEN** the guardrail fails, because the padding is applied twice

### Requirement: Bottom-pinned chrome clears the system gesture area
Any control pinned to the bottom of the screen SHALL offset by the live bottom inset. Primary actions SHALL remain fully tappable when a gesture navigation bar is present.

#### Scenario: Primary action on a gesture-navigation device
- **WHEN** a screen pins a primary action bar to the bottom on a device using gesture navigation
- **THEN** the action sits above the gesture area and receives touches over its whole height

#### Scenario: Floating action button
- **WHEN** a floating action button is positioned with a literal bottom offset and no inset
- **THEN** the guardrail fails and names the file and line

### Requirement: Rows of fixed-width children cannot overflow
A row that lays out a variable number of fixed-width children SHALL either wrap, scroll horizontally, or size its children flexibly. The sum of child widths plus gaps plus container padding SHALL NOT exceed the narrowest supported width of 320 dp without one of those escapes.

#### Scenario: Group call control bar at the narrowest supported width
- **WHEN** a group video call renders its full control set on a 320 dp-wide window
- **THEN** every control, including Mute and End call, is fully on-screen and tappable

#### Scenario: Control count grows with call state
- **WHEN** call state adds controls (video on, a free seat available, screen share active)
- **THEN** the row wraps to an additional line rather than pushing controls past either screen edge

#### Scenario: Content card inside a width-capped bubble
- **WHEN** a media or file card renders inside a bubble capped at a percentage of row width
- **THEN** the card sizes relative to its container and does not clip at 320 dp or at any OS font scale

### Requirement: Layout is verified across the supported device range
Layout SHALL be verified across widths from 320 dp to 600 dp and above, Android 7 (minSdk 24) through Android 16, and OS font scale up to 1.5.

#### Scenario: OS font scale increased
- **WHEN** the OS font scale is set to 1.5
- **THEN** text grows, containers grow with it, and no label is clipped by a fixed-height ancestor

#### Scenario: Edge-to-edge on an older Android version
- **WHEN** the app runs on Android 11 with edge-to-edge enabled
- **THEN** insets are honoured exactly as on Android 16, because edge-to-edge is enabled for all API levels
