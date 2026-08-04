## ADDED Requirements

### Requirement: Typed groups
The system SHALL let a user create multiple private groups, each carrying a
group type, name, icon, color, description and privacy setting. Each type SHALL
supply a default icon, color, member cap and permission preset. A user SHALL be
able to belong to many groups simultaneously with independent membership and
permissions in each.

#### Scenario: Create a typed group
- **WHEN** a user creates a group and selects a type
- **THEN** the group is created with that type's default icon, color, member cap and permission preset, and the creator is recorded as `owner`

#### Scenario: Custom type
- **WHEN** a user selects the Custom type
- **THEN** they SHALL supply their own icon and color, and the group receives the default permission preset

#### Scenario: Multiple simultaneous groups
- **WHEN** a user belongs to several groups
- **THEN** each group's members, safe zones, alerts, history, chat and shared resources are isolated from every other group

#### Scenario: Existing circles are typed on upgrade
- **WHEN** the migration runs against a Family Space circle created before this change
- **THEN** it is stamped `group_type='family'` and keeps every member, place and message

### Requirement: Role-based permissions
The system SHALL support the roles `owner`, `admin`, `member` and `guest`, and
SHALL resolve seven permissions — invite members, remove members, manage safe
zones, edit group settings, view location history, start group navigation, send
announcements — in the order: type default, then group override, then per-member
grant. The server SHALL re-check every permission on every mutating request;
client-side checks SHALL be treated as presentation only.

#### Scenario: Permission resolution order
- **WHEN** a group overrides a type default and a member carries an explicit grant
- **THEN** the member's explicit grant wins, followed by the group override, followed by the type default

#### Scenario: Server rejects an unpermitted mutation
- **WHEN** a client without the `remove members` permission calls the remove-member endpoint directly
- **THEN** the server rejects the request regardless of what the client UI allowed

#### Scenario: Owner cannot be demoted by an admin
- **WHEN** an admin attempts to change the owner's role
- **THEN** the request is rejected and the attempt is recorded in the audit log

#### Scenario: Guest scope
- **WHEN** a member holds the `guest` role
- **THEN** they SHALL see group chat and announcements, and SHALL NOT see member locations or location history

### Requirement: Member capacity
The system SHALL enforce a per-type maximum member count, configurable
server-side, and SHALL require a minimum of 2 members for a group to function.
The client SHALL read the cap from the group payload and SHALL NOT hardcode it.

#### Scenario: Cap enforced atomically
- **WHEN** several joins for the last remaining seat arrive concurrently
- **THEN** exactly one succeeds and the others are rejected, because the cap is checked in the same transaction as the member insert

#### Scenario: Cap raised without a release
- **WHEN** an operator raises a type's cap in server config
- **THEN** existing clients honour the new cap on their next group fetch, with no app update

#### Scenario: Cap lowered below current membership
- **WHEN** a type's cap is lowered below an existing group's member count
- **THEN** the group blocks new joins and NO existing member is removed

### Requirement: Group dashboard
The system SHALL present, per group, the group avatar, member count, count of
members currently online, shared-location status, last activity, any active
trip, pinned announcements and recent alerts, together with quick actions for
chat, live map, navigation, call, check-in and SOS.

#### Scenario: Quick actions reflect permissions
- **WHEN** a member lacks the `start group navigation` permission
- **THEN** the navigation quick action is unavailable to them and the server rejects the action if invoked directly

#### Scenario: Active trip surfaces
- **WHEN** a group trip is in progress
- **THEN** the dashboard shows the trip with participants and their ETAs

### Requirement: Live group map
The system SHALL render every sharing member of a group on one map, each marker
showing avatar, name, battery, online state, current activity, speed and — when
navigating — ETA. Markers SHALL be clustered when they overlap, and a cluster
SHALL expand smoothly on interaction. Clustering SHALL be performed on-device.

#### Scenario: Clustering on overlap
- **WHEN** several members are close enough for their markers to overlap at the current zoom
- **THEN** they render as a single cluster labelled with the member count

#### Scenario: Cluster expansion
- **WHEN** a user taps a cluster
- **THEN** the cluster expands to its individual members without a full map reload

#### Scenario: Clustering never reaches the server
- **WHEN** markers are clustered
- **THEN** the grouping is computed on-device from decrypted positions, and no position or cluster is sent to the server

### Requirement: Per-member group privacy
The system SHALL let each member choose, independently per group, to share a
precise location, an approximate location, or no location, and to hide battery
or speed, become Invisible, or share temporarily with an expiry. An approximate
share SHALL be rounded BEFORE sealing so the precise position never leaves the
device.

#### Scenario: Approximate sharing is enforced at seal time
- **WHEN** a member selects approximate sharing
- **THEN** the coordinate is rounded before the payload is sealed, so neither the server nor other members ever receive the precise position

#### Scenario: Invisible
- **WHEN** a member enables Invisible in a group
- **THEN** they publish no position to that group and appear as unavailable, while their other groups are unaffected

#### Scenario: Temporary sharing expires
- **WHEN** a member shares temporarily and the expiry passes
- **THEN** publishing stops automatically without further user action

#### Scenario: Naming does not collide with duress features
- **WHEN** this privacy setting is implemented
- **THEN** it SHALL NOT be named "ghost", which already denotes the duress/decoy-wipe feature in `lib/ghostProtocol.ts`

### Requirement: Membership audit log
The system SHALL record member additions and removals, role changes, settings
changes and invite revocations, each with actor, action, target and timestamp,
readable by members holding the `edit group settings` permission.

#### Scenario: Role change is recorded
- **WHEN** an admin changes a member's role
- **THEN** an audit entry records the actor, the target, the old and new role, and the time
