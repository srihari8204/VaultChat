## ADDED Requirements

### Requirement: A press cannot execute twice while it is still running
An interactive element whose press handler returns a pending promise SHALL NOT
run that handler again until the promise settles. The guard SHALL NOT depend on
a re-render having occurred. A second press SHALL be dropped, never queued.

A handler that returns nothing SHALL behave exactly as it does today, so the
guard cannot change the behaviour of the synchronous handlers that are already
correct.

#### Scenario: Two presses before any render
- **WHEN** a user presses a control twice in quick succession and the handler is
  still awaiting
- **THEN** the handler runs once
- **AND** it runs once whether or not React has re-rendered between the presses

#### Scenario: A queued press is never replayed
- **WHEN** a press is dropped because one is already running
- **THEN** it is discarded, and does not run when the first completes

#### Scenario: A synchronous handler is unaffected
- **WHEN** a press handler returns no promise
- **THEN** every press runs it, exactly as before the guard existed

### Requirement: An interaction always reaches a terminal state
An asynchronous interaction SHALL always settle into success, failure or
cancellation. A control that entered a busy state SHALL leave it on every path,
including thrown errors and early returns.

#### Scenario: The operation throws
- **WHEN** an action's handler throws
- **THEN** the busy state is cleared
- **AND** the failure is surfaced to the user rather than swallowed

#### Scenario: The screen unmounts mid-flight
- **WHEN** the user leaves the screen while an action is running
- **THEN** no state update is attempted against the unmounted screen

### Requirement: A failure is never silent
An interaction that fails SHALL tell the user something. A caught error inside a
press handler SHALL NOT be discarded with neither feedback nor a log.

#### Scenario: A network call fails
- **WHEN** an action fails because the request failed
- **THEN** the user is told the action did not complete
- **AND** the message distinguishes failure from an empty result

### Requirement: Every navigation target exists
A route referenced by a navigation call SHALL correspond to a route file. A
reference to a route that does not exist SHALL fail the build-time check, in
both directions: a screen nothing links to, and a link to a screen that is not
there.

#### Scenario: A push names a deleted screen
- **WHEN** a navigation call names a route with no file
- **THEN** the check fails and names the call site

#### Scenario: A screen exists but nothing links to it
- **WHEN** a route file is reachable by deep link but referenced nowhere
- **THEN** the check fails unless it is listed with a reason

### Requirement: Opting out of the interaction guard is a recorded act
A handler that bypasses the guard SHALL be listed with a reason. The count of
bypasses SHALL only decrease; a rise SHALL fail the check. The check SHALL also
fail when the real count falls below the recorded budget, so that a completed
sweep must be written down rather than silently leaving slack.

#### Scenario: A new bypass appears
- **WHEN** a handler opts out and is not on the list
- **THEN** the check fails, and going green requires writing down why

#### Scenario: The sweep gets ahead of the budget
- **WHEN** the real number of bypasses is lower than the recorded budget
- **THEN** the check fails until the budget is lowered to match

### Requirement: The interaction inventory is generated, not written
The per-feature inventory of interactive surfaces and failure classes SHALL be
produced by a re-runnable script. A hand-written census SHALL NOT be the record,
because it cannot be trusted after the code moves.

#### Scenario: The code changes after the audit
- **WHEN** screens are added, removed or changed
- **THEN** re-running the generator produces the current inventory, and the
  previous one is not treated as authoritative
