## ADDED Requirements

### Requirement: Circle lifecycle
The system SHALL let a user create a Circle (a group with `type='family'`), invite members via the existing invite-link mechanism, and assign each member a role of `member` or `guardian`. The server SHALL store only Circle membership and roles, never location content.

#### Scenario: Create a Circle
- **WHEN** a user creates a Circle and names it
- **THEN** a `type='family'` group is created with the creator as the first guardian, and an invite link is generated

#### Scenario: Join via invite
- **WHEN** an invited user opens the Circle invite link
- **THEN** they are added as a `member` and appear in the Circle roster after accepting the location-sharing consent prompt

#### Scenario: Role assignment
- **WHEN** a guardian promotes a member to guardian
- **THEN** that member gains guardian privileges (receives SOS/escalation alerts) recorded as an E2EE system message in the Circle thread

### Requirement: Encrypted presence pings
The system SHALL publish a member's location only as a sealed payload produced by `liveLocationCrypto`, carrying latitude, longitude, battery percentage, motion state, and speed. The server SHALL relay the ciphertext over the existing socket and SHALL NOT persist or decrypt it.

#### Scenario: Opt-in sharing
- **WHEN** a member enables location sharing in the Circle
- **THEN** the client publishes sealed pings at an interval, and the server forwards ciphertext to Circle members without storing it

#### Scenario: Sharing off by default
- **WHEN** a member has not opted in
- **THEN** no ping is published and the member shows as "location off" on the map

#### Scenario: Server cannot read
- **WHEN** a sealed ping transits the server
- **THEN** the payload is ciphertext and no plaintext coordinate is written to any store or log

### Requirement: Circle map
The system SHALL render Circle members from locally decrypted pings on an offline-capable map, showing each member's last-known position, staleness, and battery. Members with sharing off SHALL render as unavailable.

#### Scenario: Live positions
- **WHEN** a member's sealed ping is received and decrypted on-device
- **THEN** their marker updates on the map with a freshness indicator

#### Scenario: Stale position
- **WHEN** no ping has arrived from a member for longer than the staleness threshold
- **THEN** their marker is dimmed and labeled with the last-seen time

### Requirement: On-device geofences
The system SHALL evaluate geofences entirely on-device and SHALL emit "arrived at" / "left" events only as E2EE system messages into the Circle thread. Geofence definitions and evaluations SHALL NOT be sent to the server.

#### Scenario: Arrival alert
- **WHEN** a member's device crosses into a Circle geofence
- **THEN** an E2EE "arrived at <place>" system message is posted to the Circle and guardians are notified locally

#### Scenario: No server evaluation
- **WHEN** a geofence is created or crossed
- **THEN** the geofence coordinates and crossing decision remain on-device and never reach the server
