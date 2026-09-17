## ADDED Requirements

### Requirement: The status bar has exactly one owner
The root layout SHALL be the only place that configures the status bar, and it SHALL choose bar style from the active theme. No screen SHALL import `StatusBar` from `react-native` to override it.

#### Scenario: Light theme active
- **WHEN** the app runs in light theme and the user opens any screen
- **THEN** status-bar icons render dark and remain visible against the light background

#### Scenario: Dark theme active
- **WHEN** the app runs in dark theme
- **THEN** status-bar icons render light, and no screen forces the opposite

#### Scenario: Screen attempts to override
- **WHEN** any file outside the root layout imports `StatusBar` from `react-native`
- **THEN** the guardrail selftest fails and names the file

#### Scenario: Deprecated status-bar colour
- **WHEN** a screen sets a status-bar `backgroundColor` or `translucent` prop
- **THEN** the guardrail fails, because both are no-ops under edge-to-edge on targetSdk 35+ and produce divergent rendering across Android versions

### Requirement: Text input is never covered by the keyboard
Every screen and modal containing a `TextInput` SHALL keep the focused input and its primary action visible when the software keyboard is open, using the shared keyboard-inset utility.

#### Scenario: Account recovery on Android
- **WHEN** the user focuses an answer field on the account-recovery screen on Android
- **THEN** the field and its submit control stay visible above the keyboard

#### Scenario: Composer inside a React Native Modal
- **WHEN** the user focuses a text field inside a screen-level `Modal`
- **THEN** the composer lifts above the keyboard, without relying on the activity's `adjustResize`, which a `Modal` window does not receive

#### Scenario: Platform-conditional behaviour that resolves to nothing
- **WHEN** a keyboard-avoiding wrapper resolves its behaviour to `undefined` on Android
- **THEN** the guardrail fails, because that renders an inert `View` and provides no avoidance

### Requirement: Interactive controls meet the minimum touch target
Every interactive control SHALL present at least a 44×44 dp touch area, using `hitSlop` where the visual size is smaller.

#### Scenario: Small icon-only control
- **WHEN** a control renders with a visual size below 44×44 dp
- **THEN** it declares `hitSlop` sufficient to reach 44×44 dp of touchable area

#### Scenario: Destructive control
- **WHEN** the control cancels a transfer, closes a player, or removes an item
- **THEN** it meets the minimum target, so a near-miss cannot trigger an adjacent control
