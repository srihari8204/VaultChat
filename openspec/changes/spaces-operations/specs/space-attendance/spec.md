## ADDED Requirements

### Requirement: Geofence attendance against a shift window
Attendance SHALL be derived from the space's existing safe-zone entry and exit
events evaluated against a configured shift window, on the device that owns the
event. The system SHALL NOT introduce a second geofence mechanism and SHALL NOT
evaluate location server-side. Derived states SHALL be present, late,
left-early, absent and unknown.

#### Scenario: Automatic check-in
- **WHEN** an employee's device records entry into the workplace safe zone during the shift window
- **THEN** they are recorded as checked in at that time, and as late if entry falls after the window's grace period

#### Scenario: Leaving during the shift
- **WHEN** an employee exits the workplace zone before the shift ends
- **THEN** a check-out is recorded and, if the space is configured to do so, their supervisor is notified

#### Scenario: Unknown rather than absent
- **WHEN** no entry or exit event exists for a member for a shift, for example because location sharing is off
- **THEN** their state is reported as unknown, never as absent

#### Scenario: Attendance respects sharing privacy
- **WHEN** a member has set their location sharing to hidden for the space
- **THEN** no attendance state is derived or shown for them, and the dashboard reports the gap rather than inferring one

### Requirement: Scoped attendance views
Attendance SHALL be visible only within the viewer's resolved visibility scope:
a supervisor sees their reporting line, an ops administrator sees the space, and
no other member sees anyone but themselves.

#### Scenario: Supervisor view
- **WHEN** a supervisor opens attendance
- **THEN** they see their direct and indirect reports' states, late arrivals and missing check-ins, and no one outside that line

#### Scenario: Employee self view
- **WHEN** an employee opens attendance
- **THEN** they see their own check-in, check-out, shift and history only

### Requirement: Visitor passes
A member with roster management permission SHALL be able to issue a time-boxed
visitor pass naming a host and a validity window. A pass SHALL be redeemable
once, SHALL notify the host on redemption, SHALL record entry and exit, and
SHALL NOT confer space membership or any visibility beyond its own record.

#### Scenario: Issuing and redeeming a pass
- **WHEN** a visitor redeems a valid pass
- **THEN** entry is logged, the host is notified, and the visitor gains no access to space members, messages, runs or location

#### Scenario: Expired pass
- **WHEN** a pass is presented outside its validity window or a second time
- **THEN** redemption is refused and the attempt is recorded

### Requirement: Attendance analytics stay on device
Aggregate attendance figures SHALL be computed on the viewing device — hours
worked, late counts, occupancy over time — from data it is already entitled to
see, and SHALL NOT be uploaded.

#### Scenario: Weekly summary
- **WHEN** a supervisor views a weekly attendance summary
- **THEN** it is computed locally from their scoped data and no aggregate is transmitted to the server
