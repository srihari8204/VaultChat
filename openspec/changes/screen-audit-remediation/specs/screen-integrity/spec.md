## ADDED Requirements

### Requirement: A screen never reports an outcome that did not happen
A screen SHALL NOT tell the user that a message was sent, a person was notified, data was
encrypted or a setting took effect unless the code path that shows the message performed
that action and it succeeded.

#### Scenario: The action is a stub
- **WHEN** a control has no real implementation behind it
- **THEN** the control is removed or hidden, not shown with a success message

#### Scenario: A saved setting has no reader
- **WHEN** a toggle's stored value is read by no code
- **THEN** the toggle is not shown

### Requirement: Every registered route is reachable or removed
Every screen registered in the root stack SHALL have an in-app entry point, be an
intentional deep-link or redirect target listed in `lib/orphanRoutes.selftest.ts`, or be
deleted.

#### Scenario: A mock screen is found
- **WHEN** a registered route renders mock data and no screen links to it
- **THEN** the route file and its stack registration are deleted

### Requirement: A load failure is shown as a failure
A screen SHALL show an error with a retry when its data fails to load, and SHALL NOT show
its empty state or overwrite stored data on the strength of a failed load.

#### Scenario: The network call fails
- **WHEN** a screen's load request rejects
- **THEN** the screen shows an error message and a retry control
- **AND** no save path writes the empty result over the user's stored data

### Requirement: Destructive actions are confirmed
A control that deletes data, resigns or drops a game, wipes keys or broadcasts to all
users SHALL ask for confirmation before acting.

#### Scenario: The user taps a destructive control
- **WHEN** the user taps Delete, Resign, Drop, Clear or Broadcast
- **THEN** a confirmation names what will happen
- **AND** nothing happens unless the user confirms
