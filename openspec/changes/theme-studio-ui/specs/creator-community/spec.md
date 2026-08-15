## ADDED Requirements

### Requirement: Community is a section, not a social network
The system SHALL present community themes as a visual-first section inside Home and SHALL NOT build feeds, comments, direct messaging or follower timelines.

#### Scenario: Browsing community
- **WHEN** a user opens the Community section
- **THEN** creator themes render with the same card component used everywhere else, showing likes, downloads and creator

### Requirement: Creator profile is a sheet
The system SHALL present a creator as a large-detent bottom sheet showing avatar, name, followers, themes, likes and downloads, with the theme the user came from still visible behind it.

#### Scenario: Opening a creator
- **WHEN** a user taps a creator name in the preview
- **THEN** the creator sheet rises over the preview and dismisses back to it

### Requirement: Publishing is three taps from Studio
The system SHALL let a creator publish the theme currently in Studio via Save, then a publish toggle, then Publish, without leaving the destination.

#### Scenario: Publishing
- **WHEN** a creator publishes
- **THEN** the theme becomes visible in Community and a share link is offered in the confirmation

#### Scenario: Publish fields
- **WHEN** the publish sheet opens
- **THEN** it asks only for name, description, tags, preview surface and free/premium — and shows the preview alongside

#### Scenario: Account requirement
- **WHEN** a guest attempts to publish
- **THEN** account creation is offered at that moment as the only gate in the product, with the theme preserved

### Requirement: Publishing is free
The system SHALL NOT place publishing behind the subscription.

#### Scenario: Free-plan creator
- **WHEN** a creator on the free plan publishes
- **THEN** publishing succeeds; creator analytics and collections remain the premium part
