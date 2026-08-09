## ADDED Requirements

### Requirement: Shared destination
The system SHALL let a member holding the `start group navigation` permission
share a destination with their group, and SHALL let any member route to it using
the existing in-app navigation engine.

#### Scenario: Share a destination
- **WHEN** a permitted member shares a destination
- **THEN** every member sees it on the group map and can start navigation to it

#### Scenario: Permission gate
- **WHEN** a member without the navigation permission attempts to share a destination
- **THEN** the server rejects the request

### Requirement: Group trips
The system SHALL let members start a group trip toward a shared destination,
join or leave an active trip, and see the trip's participants. Trip state SHALL
be relayed over the existing socket.

#### Scenario: Start a trip
- **WHEN** a permitted member starts a group trip
- **THEN** other members are invited to join and the trip appears on the group dashboard

#### Scenario: Join in progress
- **WHEN** a member joins a trip already under way
- **THEN** they are added to the participant list and their ETA joins the others

#### Scenario: Leave a trip
- **WHEN** a member leaves a trip
- **THEN** they stop publishing trip state and are removed from the participant list

### Requirement: ETA sharing
The system SHALL compute each participant's ETA on their own device from their
own route and share it with trip participants as a sealed field. The server
SHALL NOT compute or read ETAs.

#### Scenario: ETA fan-out
- **WHEN** several members navigate to the same destination
- **THEN** each sees every other participant's ETA

#### Scenario: ETA is sealed
- **WHEN** an ETA is shared
- **THEN** it travels sealed and the server cannot read it

#### Scenario: ETA updates as conditions change
- **WHEN** a participant is delayed and their route is recalculated
- **THEN** their shared ETA updates for the other participants

### Requirement: Follow the leader
The system SHALL support a follow-the-leader mode in which one participant is
designated leader and the others navigate along the leader's route rather than
their own independently computed route.

#### Scenario: Follow the leader
- **WHEN** a trip is in follow-the-leader mode
- **THEN** participants navigate the leader's route and are alerted if they fall behind or leave it

#### Scenario: Leader leaves the trip
- **WHEN** the leader leaves an active trip
- **THEN** participants are notified and the trip either promotes a new leader or reverts to independent routing

### Requirement: Deviation and arrival alerts
The system SHALL alert the group when a participant leaves the expected route,
and when a participant arrives at the destination.

#### Scenario: Route deviation
- **WHEN** a participant leaves the expected route beyond the off-route threshold
- **THEN** a deviation alert is raised to the group, reusing the existing off-route detection

#### Scenario: Arrival
- **WHEN** a participant reaches the destination
- **THEN** an arrival notification is raised to the group

#### Scenario: Deviation respects privacy
- **WHEN** a participant has chosen approximate or hidden location sharing
- **THEN** the deviation alert reports the fact of deviation without revealing a precise position that member has not shared
