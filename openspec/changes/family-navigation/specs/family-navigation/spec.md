# family-navigation

## ADDED Requirements

### Requirement: Route progress SHALL be constant-time in route length

The per-GPS-fix route mathematics SHALL NOT scan the whole route shape. It
SHALL use a windowed search seeded from the previous fix's index plus a
precomputed prefix-sum distance table.

#### Scenario: A long route costs no more per fix than a short one
- **WHEN** a fix is processed against a 6000-vertex route
- **THEN** the work SHALL be within the same order as a 500-vertex route
- **AND** the measured cost SHALL be ≈0.0029 ms/fix on the reference machine

#### Scenario: A stale index cannot silently lock onto the wrong road
- **WHEN** the seed index is far from the actual position (reroute, resume,
  first fix far from the start)
- **THEN** the implementation SHALL detect it and perform a full rescan
- **AND** the returned index SHALL match what a full scan would have produced

### Requirement: Off-route detection SHALL require corroboration

A single GPS sample outside the corridor SHALL NOT be treated as leaving the
route, and SHALL NOT trigger a reroute.

#### Scenario: One outlier is absorbed
- **WHEN** exactly one fix falls outside the corridor
- **THEN** the verdict SHALL be `temporarily_uncertain`
- **AND** no reroute SHALL be requested

#### Scenario: A sustained excursion is confirmed once
- **WHEN** three consecutive fixes fall outside the corridor
- **THEN** the verdict SHALL become `reroute_required` exactly once
- **AND** further fixes in the same excursion SHALL report `off_route`

#### Scenario: Returning to the route forgives with hysteresis
- **WHEN** two consecutive fixes fall back inside the corridor
- **THEN** the verdict SHALL return to `on_route` and the excursion SHALL reset

#### Scenario: The corridor widens with GPS uncertainty
- **WHEN** the reported accuracy is 60 m
- **THEN** a 100 m deviation SHALL NOT be treated as evidence of anything

### Requirement: Arrival SHALL require proximity AND a slowdown

Arrival SHALL be declared only when the remaining distance is within the
arrival radius AND the reported speed has dropped to walking pace. Proximity
alone SHALL NOT end a session.

#### Scenario: Driving past the destination is not arriving
- **WHEN** the remaining distance is under the arrival radius but speed is high
- **THEN** arrival SHALL NOT be declared

### Requirement: The camera SHALL NOT fight the user, and SHALL NOT oscillate

The camera SHALL yield to a deliberate gesture and SHALL only re-engage when
asked. Zoom SHALL move in discrete bands with a hysteresis margin, so that
distance jitter around a band edge produces no camera movement.

#### Scenario: A manual pan releases the camera
- **WHEN** the user pans, rotates or pinches the map during navigation
- **THEN** auto-follow SHALL disengage
- **AND** an explicit Follow control SHALL be offered to re-engage it

#### Scenario: A wobble across a zoom band edge does not move the camera
- **WHEN** the distance to the maneuver crosses a band boundary by less than
  the hysteresis margin
- **THEN** the camera zoom SHALL NOT change

#### Scenario: Ending a journey restores the camera
- **WHEN** a navigation session ends
- **THEN** the map SHALL return to north-up rather than remaining in the
  pitched, heading-up chase camera

### Requirement: The native core SHALL be optional and invisible

The Rust core SHALL be reachable through the Nitro/JSI bridge that already
ships, and its absence SHALL NOT change behaviour.

#### Scenario: The native library is missing
- **WHEN** the app runs on a build without the native library (iOS, or any
  build made without cargo-ndk)
- **THEN** navigation SHALL run on the TypeScript implementation
- **AND** the numbers produced SHALL be identical to the native path

#### Scenario: The native core fails mid-journey
- **WHEN** a native call throws during an active session
- **THEN** the session SHALL continue on the TypeScript path without
  interrupting guidance

### Requirement: Routing SHALL consume only already-authorised coordinates

Every coordinate reaching a route request SHALL come either from `presences`
(delivered by the server under `locVisibleWhere`/`locCanSee`, therefore already
authorised for this viewer) or from the viewer's OWN device-local saved places.
No routing path SHALL widen location visibility.

#### Scenario: Saved-place destinations are the viewer's own
- **WHEN** the saved-place destination chips are rendered
- **THEN** they SHALL enumerate only the viewer's own device-local places
- **AND** SHALL NOT read another member's published reference places

#### Scenario: Only real places are offered
- **WHEN** the viewer has saved no places
- **THEN** no destination chips SHALL be drawn — there SHALL be no fixed
  Home/School/Office chips that cannot work
