## ADDED Requirements

### Requirement: Audience-targeted announcements
An announcement SHALL carry an audience: the whole space, a single run, a single
role, or the subtree beneath a member. The audience SHALL be resolved by the
same server-side resolver used for visibility scoping, and both the permission
to send AND the sender's entitlement to that audience SHALL be checked on the
server for every send.

An audience SHALL scope notification and display. It SHALL NOT be presented as
confidentiality: an announcement is an ordinary end-to-end encrypted message in
the space's chat, so every member's device receives the ciphertext and can
decrypt it. The product SHALL NOT claim otherwise in its wording.

#### Scenario: Announcement to one run
- **WHEN** an administrator sends an announcement addressed to a run
- **THEN** that run's driver and the guardians of its riders are notified and shown it, and no other member is notified or shown it

#### Scenario: The audience is not a confidentiality boundary
- **WHEN** a member outside the addressed audience inspects their own device's stored messages
- **THEN** the announcement is readable to them, and the composer SHALL NOT have described the audience as private

#### Scenario: An audience the sender may not address is refused
- **WHEN** a sender attaches an audience naming a run in another space, an unknown role, or a subtree they cannot see
- **THEN** the server rejects the message rather than downgrading it to a space-wide announcement

#### Scenario: Announcement to a department
- **WHEN** a manager sends an announcement addressed to their subtree
- **THEN** it reaches exactly the members the visibility resolver returns for them

#### Scenario: Unpermitted send is refused server-side
- **WHEN** a member without announcement permission posts an announcement directly to the endpoint
- **THEN** the server rejects it regardless of what the client offered

#### Scenario: Announcements are not live broadcast
- **WHEN** an announcement is sent
- **THEN** it uses the announcement path and does not create a live broadcast session

### Requirement: Incident reporting
A member with incident permission SHALL be able to file an incident against a
space and, optionally, a run: a category, a note and photographs. Photographs
SHALL be stored through the existing space album with the space's encryption.
Filing SHALL notify the space's ops roles.

#### Scenario: Driver reports a breakdown
- **WHEN** a driver files a breakdown incident on their active run with a photo and a note
- **THEN** the incident is recorded against that run, ops roles are notified immediately, and the photo is stored encrypted in the space album

#### Scenario: Incident visibility
- **WHEN** a guardian views a run their child is on that has an open incident
- **THEN** they see that an incident is open and its category, without the reporter's photographs unless the space is configured to share them

### Requirement: Ops safety alerts
The system SHALL raise alerts for: an SOS or panic press, overspeed, route
deviation, an unexpectedly long stop, and a vehicle whose position stream has
gone stale. The first four SHALL be detected on the emitting device and
delivered as sealed alerts on the existing alert path. Staleness SHALL be
detected on the server from the absence of pings, because the device that has
gone offline cannot report its own absence.

#### Scenario: Driver panic press
- **WHEN** a driver presses the panic control
- **THEN** every ops role in the space is alerted immediately with the run identifier, and the alert is escalated by push

#### Scenario: Overspeed on the vehicle
- **WHEN** the driver's device measures sustained speed above the space's threshold
- **THEN** it emits a sealed overspeed alert naming the run

#### Scenario: Route deviation
- **WHEN** the driver's device detects departure from the route implied by the remaining stop sequence beyond the configured tolerance
- **THEN** a deviation alert is raised to ops roles

#### Scenario: Position stream goes stale
- **WHEN** an active run has produced no position ping for longer than the configured interval
- **THEN** the server raises a GPS-offline alert to ops roles

#### Scenario: Detection limits are stated, not hidden
- **WHEN** device-side detection is unavailable because the driver's app is not reporting
- **THEN** the space surfaces the stale stream rather than presenting the absence of alerts as an absence of problems

### Requirement: Emergency coordination view
During a declared emergency, a member with ops-wide view permission SHALL see
every active run's current position and status on one view, and SHALL be able to
send an instruction to a selected subset of runs, roles or members from the same
screen.

#### Scenario: Coordinating during an emergency
- **WHEN** an administrator declares an emergency
- **THEN** all active runs and their statuses are shown together and the administrator can address instructions to any selected subset without leaving the view

### Requirement: Notification set for guardians and riders
Guardians and riders SHALL be notified on: run started, vehicle approaching
their stop, boarded, arrived at destination, departed, dropped, run delayed
beyond threshold, driver changed, and any emergency. Each notification SHALL be
scoped to the recipient's own linked rider.

#### Scenario: Notifications never leak another rider
- **WHEN** a run notification is delivered to a guardian
- **THEN** it names only riders linked to that guardian

#### Scenario: Delay notification is thresholded
- **WHEN** a run is running behind schedule by less than the configured threshold
- **THEN** no delay notification is sent, and the arrival window updates silently
