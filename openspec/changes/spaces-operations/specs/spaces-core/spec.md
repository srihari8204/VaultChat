## ADDED Requirements

### Requirement: Spaces naming and ops space types
The product SHALL present the module as "Spaces", with Family as one space type
among many. The existing twelve types SHALL be preserved, and the types
`school_transport`, `office_transport` and `pet_care` SHALL be added. Type
identity (label, icon, colour, member cap, permission defaults) SHALL remain
server-owned configuration; the client SHALL NOT hardcode any of it.

#### Scenario: Family is a type, not the frame
- **WHEN** a user opens the module
- **THEN** they see a list of their spaces of every type, and a Family space appears as one entry rather than as the only destination

#### Scenario: Existing groups are unaffected by the rename
- **WHEN** a space created before this change is opened
- **THEN** its members, messages, zones, resources and permissions are unchanged, and only its presentation labels differ

#### Scenario: A new ops type needs no client release
- **WHEN** an operator adds a row to the type configuration with a label, icon, colour, cap and permission defaults
- **THEN** the client renders and enforces it without a new build

### Requirement: Display roles resolved from a per-type role catalog
Each space type SHALL carry a role catalog: a list of display roles, each
mapping a stable key and human label to exactly one of the five ranks
(`guest`, `member`, `moderator`, `admin`, `owner`) and an optional additional
permission set. A member SHALL carry an optional role key. Permission
resolution SHALL be: type default for the rank, then role-catalog permissions,
then space override, then per-member grant. Adding a display role SHALL NOT
require a schema migration or a server code change.

#### Scenario: A school member is shown their job title
- **WHEN** a member with role key `transport_manager` is listed
- **THEN** they are displayed as "Transport Manager" and hold the permissions of the `admin` rank plus the catalog's additional permissions

#### Scenario: Rank still gates rank
- **WHEN** a Transport Manager (rank `admin`) attempts to remove a Principal (rank `owner`)
- **THEN** the server rejects the request, because rank comparison — not the role label — governs member management

#### Scenario: A member with no role key behaves as before
- **WHEN** a member has no role key
- **THEN** their permissions resolve from their rank exactly as they did before this change

#### Scenario: An invalid catalog entry is refused at write time
- **WHEN** a role catalog is saved containing an unknown rank or an unknown permission name
- **THEN** the write is rejected and the previous catalog remains in force

### Requirement: Scoped visibility through space links
The system SHALL model directed relationships between members of a space —
`guardian_of`, `supervises`, `teaches` — and SHALL resolve a viewer's visible
subject set from them. A viewer without an ops-wide view permission SHALL see
only the subjects reachable from them through these relationships. Resolution
SHALL be performed on the server on every read of a member, rider, attendance
or run record; client-side filtering SHALL NOT be relied upon.

#### Scenario: A parent sees only their own child
- **WHEN** a parent requests the space roster or any rider record
- **THEN** the response contains only children linked to them by `guardian_of`, and requesting another child's record by id is rejected

#### Scenario: A supervisor sees their reporting line
- **WHEN** a manager requests their team
- **THEN** the response contains employees reachable through `supervises`, including indirect reports through intermediate supervisors

#### Scenario: Hierarchy depth is bounded and honest
- **WHEN** a reporting chain is deeper than the resolver's bound
- **THEN** the response is truncated at the bound AND carries an explicit flag indicating the subtree was not fully resolved

#### Scenario: An ops administrator bypasses links
- **WHEN** a member holding the ops-wide view permission requests the roster
- **THEN** they see every member of the space without needing any link

#### Scenario: Links are space-scoped
- **WHEN** the same two users belong to two spaces and are linked in one
- **THEN** the link grants no visibility in the other space

### Requirement: Type-specific dashboards derived from live state
Each ops space type SHALL render a dashboard composed only of values derived
from run, rider, attendance and alert state. No dashboard figure SHALL require
a stored aggregate. Every figure SHALL respect the viewer's resolved visibility
scope.

#### Scenario: School dashboard counts
- **WHEN** a school administrator opens the space dashboard
- **THEN** they see totals for roster size, present, absent, active runs, delayed runs, riders boarded, riders pending, riders dropped and open alerts, each derived from current run and attendance state

#### Scenario: A driver has no dashboard
- **WHEN** a member whose only ops permission is to drive a run opens the space
- **THEN** they are taken to their run manifest, and space-wide analytics are neither rendered nor fetched
