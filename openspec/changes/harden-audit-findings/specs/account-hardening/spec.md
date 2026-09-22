## ADDED Requirements

### Requirement: An account leaves nothing behind on sign-out
Signing out SHALL purge every trace of the account from the device through ONE routine,
called from every sign-out path — the user-initiated one and the forced one alike. The
purge SHALL include the E2EE identity and the per-user keys, not only the session tokens.
No sign-out path may clear a subset.

#### Scenario: A second person signs in on the same phone
- **WHEN** one account signs out and another signs in on that device
- **THEN** the new account sees none of the previous account's messages, media, PIN
  record or cryptographic identity

#### Scenario: A forced sign-out
- **WHEN** the session is ended by the server rather than by the user
- **THEN** the same purge runs, with the same coverage as a user-initiated sign-out

#### Scenario: Key wipe means the real keys
- **WHEN** the key wipe routine runs
- **THEN** it purges the keys the app actually writes today, not a list that has gone stale

### Requirement: A security control is reachable or it is not a control
A control that the product presents as protection SHALL be wired to the path it claims to
protect. Brute-force counting SHALL live in the one function every live PIN check routes
through. A chat locked with both a PIN and biometric SHALL require BOTH, in every surface
that opens it. Biometric verification SHALL NOT report success on a platform where it did
not run.

#### Scenario: Repeated wrong PINs
- **WHEN** a wrong PIN is entered repeatedly through any live path
- **THEN** the attempt is counted, because the counter sits inside the verification itself

#### Scenario: A chat locked with both factors
- **WHEN** a chat's lock method is "PIN and biometric"
- **THEN** it opens only after both succeed, both when opening the chat and when exporting it

#### Scenario: Biometric on a platform without it
- **WHEN** biometric verification is attempted where no biometric check can run
- **THEN** it reports failure rather than success

### Requirement: Money is parsed the same way everywhere it is written
Every surface that accepts an amount SHALL apply one parsing rule, including grouped
digits in both the thousands and the lakh forms. A value that is not a number SHALL be
refused at the write, never stored, and never carried into a derived figure, a schedule or
an export.

#### Scenario: A shopkeeper types a grouped amount
- **WHEN** an amount is entered as `1,200` or `1,00,000`
- **THEN** it is stored as that amount, not as zero

#### Scenario: A non-number reaches a guard
- **WHEN** a value that is not a number reaches a numeric comparison
- **THEN** the guard refuses it rather than letting it pass into a stored or rendered figure

#### Scenario: An unbounded duration
- **WHEN** an interest duration would compute to infinity
- **THEN** it is bounded before anything is persisted

### Requirement: Permission is checked before the data is fetched
A screen that requires permission to show data SHALL verify that permission BEFORE it
requests the data, so an unauthorised viewer never causes the read. Code with no importer
SHALL be removed rather than left where an import would give it side effects, and a
library module SHALL NOT import from the application layer.

#### Scenario: An unauthorised viewer opens a tracked screen
- **WHEN** someone without permission opens a member or insights screen
- **THEN** the permission check refuses them before any track or history is fetched

#### Scenario: A module with an import-time side effect
- **WHEN** a module's only effect is to replace a global handler when imported
- **AND** nothing imports it
- **THEN** it is deleted rather than retained
