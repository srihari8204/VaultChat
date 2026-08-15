## ADDED Requirements

### Requirement: Profile holds account, plan, settings and help
The system SHALL present avatar, name, plan status, created themes, saved themes and downloads on Profile, with settings, help and support reached as rows that open sheets rather than pushed screens.

#### Scenario: Guest profile
- **WHEN** a guest opens Profile
- **THEN** the stat row is replaced by a single explanation and one Create account action, and every other row still works

### Requirement: Settings are native-style rows
The system SHALL group settings as Account, Appearance, Notifications, Language, Downloads, Privacy, Terms, Help and About, and SHALL NOT create a destination per group.

#### Scenario: Opening a group
- **WHEN** a user taps Appearance
- **THEN** a sheet presents light / dark / system and text size, applying immediately

### Requirement: Premium is presented, never forced
The system SHALL present the subscription with a visual preview of what it unlocks, SHALL provide a clearly visible dismissal, and SHALL NOT use countdown pressure, obscured close controls or launch interstitials.

#### Scenario: Paywall presentation
- **WHEN** the paywall opens
- **THEN** it rises as a sheet with the theme being bought still visible behind it, and the close control is immediately findable

#### Scenario: Declining
- **WHEN** a user chooses Continue free
- **THEN** they return exactly where they were, with the free entitlement unchanged

#### Scenario: No launch interstitial
- **WHEN** the app launches
- **THEN** no subscription screen is shown

### Requirement: Premium boundaries are visible before the tap
The system SHALL badge premium content in browse so a user knows the boundary before committing to an action.

#### Scenario: Premium theme in a rail
- **WHEN** a premium theme appears in any rail or grid
- **THEN** it carries a premium badge with a word, not colour alone

#### Scenario: Applying a premium theme on the free plan
- **WHEN** a free-plan user applies a premium theme
- **THEN** the paywall opens with the preview still running behind it

### Requirement: Free tier is usable
The system SHALL keep discovery, preview, customization, library and publishing available on the free plan, and SHALL limit only premium content, unlimited AI generation, advanced customization, exclusive collections and creator analytics.

#### Scenario: Free AI generation
- **WHEN** a free user generates themes
- **THEN** a daily allowance applies and the fourth attempt presents the result behind the paywall rather than refusing before generating

### Requirement: Help and support
The system SHALL provide searchable help topics, expandable FAQ rows and a support form with subject, message and attachment.

#### Scenario: Sending a support request
- **WHEN** a user submits the support form
- **THEN** the request is confirmed with a reference the user can quote, and the form content is preserved if sending fails
