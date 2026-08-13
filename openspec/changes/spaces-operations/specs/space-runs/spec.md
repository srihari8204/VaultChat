## ADDED Requirements

### Requirement: Runs as a single engine for scheduled multi-stop trips
The system SHALL model a run as a scheduled trip within a space, carrying a
kind, a name, an assigned driver, a vehicle label, an ordered list of stops and
a rider manifest. A run SHALL progress through `scheduled → started →
completed`, or to `cancelled` from either of the first two. School pickup,
school drop, cab pickup, cab drop and generic trips SHALL be the same structure
differing only in configuration.

#### Scenario: One engine, two verticals
- **WHEN** a school bus route and an office cab shuttle are both created
- **THEN** both are runs with stops and riders, and no vertical-specific trip structure exists

#### Scenario: Run lifecycle is ordered
- **WHEN** a client attempts to complete a run that was never started
- **THEN** the server rejects the transition

#### Scenario: A driver has one active run
- **WHEN** a second run is started for a driver who already has one in progress
- **THEN** the start is rejected until the first run is completed or cancelled

#### Scenario: Stops carry places, riders carry people
- **WHEN** a run's stops are read by a member without visibility of a given rider
- **THEN** the stop list is returned without revealing which riders are assigned to it

### Requirement: Driver manifest and rider state transitions
A driver SHALL be presented with their assigned run only: the next stop, the
riders expected at it, a call action for each rider's contact, and actions to
mark a rider boarded or absent. Rider state SHALL be one of `pending`,
`boarded`, `dropped`, `absent`, `no_show` or `cancelled`, and every transition
SHALL be recorded with its actor and timestamp in an append-only event log. The
server SHALL reject any rider transition from a member who is not the run's
driver or an ops administrator.

#### Scenario: Marking a rider boarded
- **WHEN** the driver marks a rider boarded
- **THEN** the rider's state becomes `boarded`, an event is appended with actor and time, the rider's guardians are notified, and the manifest advances to the next rider

#### Scenario: Rider not present at the stop
- **WHEN** the driver marks a rider absent at pickup
- **THEN** the rider's state becomes `absent`, the guardians are notified, and the run continues to the next stop without blocking

#### Scenario: Drop confirmation
- **WHEN** the driver marks a boarded rider dropped
- **THEN** the state becomes `dropped`, an event is appended, and the guardians receive an arrival notification naming the drop location

#### Scenario: A driver cannot reach unrelated data
- **WHEN** a driver requests a rider record, run or dashboard outside their assigned runs
- **THEN** the server rejects the request rather than returning a filtered result

#### Scenario: Transitions are idempotent under retry
- **WHEN** the same boarding action is submitted twice, for example after a network retry
- **THEN** the rider's state and the event log reflect a single boarding

### Requirement: Optional pickup verification
A space SHALL be able to require verification at handover, disabled by default.
When enabled, a rider's transition to `boarded` or `dropped` SHALL require a
code presented by the guardian or held by the rider.

#### Scenario: Verification enabled
- **WHEN** verification is enabled and a driver marks a rider boarded without a valid code
- **THEN** the transition is rejected and the driver is prompted for the code

#### Scenario: Verification disabled by default
- **WHEN** a new space is created
- **THEN** handover verification is off and no code is requested

### Requirement: Live run tracking over the sealed location path
A run's live position SHALL be carried by the driver device's existing sealed
location ping, tagged with the run identifier. The server SHALL NOT store or be
able to read a vehicle's coordinates. Viewers SHALL receive the stream subject
to space membership and their resolved visibility scope.

#### Scenario: A guardian tracks the run their child is on
- **WHEN** a guardian opens their child's run
- **THEN** they see the live vehicle position, estimated arrival at their stop, the driver's name, the vehicle label and the next stop

#### Scenario: A guardian cannot track an unrelated run
- **WHEN** a guardian subscribes to a run no linked rider is assigned to
- **THEN** the subscription is refused

#### Scenario: Administrators see every active run on one map
- **WHEN** an ops administrator opens the live map
- **THEN** every active run in the space is rendered from the same sealed stream, clustered when the count is large

#### Scenario: No plaintext position is persisted
- **WHEN** a run has been active and completed
- **THEN** no server-side record of the vehicle's coordinates exists

### Requirement: Arrival estimates as a window
Estimated arrival at a stop SHALL be presented as a continuously updated
window rather than a single time, and SHALL be recomputed on the viewing or
emitting device from live progress against the remaining stop sequence.

#### Scenario: Estimate updates with progress
- **WHEN** the vehicle is delayed between stops
- **THEN** the arrival window for every downstream stop widens and shifts, and affected guardians are notified once the delay exceeds the space's threshold

### Requirement: Run replay
A completed run SHALL be reviewable as a timeline of its stop arrivals and
rider transitions with timestamps and actors, derived from the run's event log.
Road-level path replay SHALL be available only to a device that received the
run's sealed position stream, and its absence SHALL be stated rather than
silently omitted.

#### Scenario: Timeline replay after the fact
- **WHEN** an administrator reviews yesterday's run
- **THEN** they see each stop's arrival time and each rider's boarding, drop or absence with times and actors

#### Scenario: Path replay is honest about what it has
- **WHEN** the reviewing device never received the run's live stream
- **THEN** the timeline is shown and the map path is explicitly reported as unavailable rather than interpolated between stops

### Requirement: Driver availability and substitution
The system SHALL record a driver's duty state — on duty, on break, off duty —
and SHALL allow a member with run management permission to reassign a run's
driver. Reassignment SHALL notify the outgoing driver, the incoming driver and
the affected riders' guardians.

#### Scenario: Substitute assignment mid-run
- **WHEN** an administrator reassigns an in-progress run to another driver
- **THEN** the new driver receives the manifest in its current state, the previous driver loses access to it, and guardians are notified that the driver changed
