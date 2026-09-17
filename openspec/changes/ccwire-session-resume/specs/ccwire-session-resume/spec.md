# ccwire-session-resume

## ADDED Requirements

### Requirement: Resume is an optimisation, never a correctness dependency

Resume SHALL be refusable at any point without data loss. Whenever the server
cannot resume with full confidence it SHALL answer `resumed=false` and the
client SHALL fall back to the existing application resync path, which remains
the authoritative recovery mechanism.

This is the requirement every other one is subordinate to: a failure of the
optimisation must never become a failure of messaging.

#### Scenario: Unknown or expired token
- **WHEN** a client presents a `resume_token` the server cannot resolve
- **THEN** the server SHALL answer `resumed=false` with a fresh session, and
  SHALL NOT error the connection

#### Scenario: Server restarted
- **WHEN** the gateway process has restarted since the token was issued
- **THEN** every prior token SHALL fail to resolve and clients SHALL receive
  `resumed=false`

#### Scenario: Doubt resolves to refusal
- **WHEN** any part of the resume state is missing, ambiguous, or inconsistent
- **THEN** the server SHALL refuse the resume rather than serve partial state

### Requirement: Resume token security

A resume token SHALL be cryptographically random, opaque to the client, and a
reference to server-side state — never a container of trust data.

#### Scenario: Token is unforgeable
- **WHEN** a token is issued
- **THEN** it SHALL be generated from a cryptographic random source with at
  least 128 bits of entropy, and SHALL carry no user, device or session
  identifier the client or an attacker could read or alter

#### Scenario: Token is bound to its principal
- **WHEN** a token is presented alongside credentials for a different user or a
  different device than it was issued to
- **THEN** the server SHALL refuse the resume

#### Scenario: Token is single-use
- **WHEN** a token is accepted for resume
- **THEN** it SHALL be invalidated and a new token issued, so a captured token
  cannot be replayed

#### Scenario: Token comparison is constant-time
- **WHEN** a presented token is compared against stored state
- **THEN** the comparison SHALL NOT leak length or content through timing

#### Scenario: Logout invalidates
- **WHEN** a session ends through logout or a security-sensitive change
- **THEN** its resume token SHALL be invalidated immediately

### Requirement: Parked sessions are bounded

Session state retained across disconnection SHALL be bounded by count, by age
and by memory. An unbounded session map is how this feature becomes an outage.

#### Scenario: Expiry
- **WHEN** a parked session exceeds its resume lifetime
- **THEN** it SHALL be released and its token SHALL no longer resolve

#### Scenario: Capacity
- **WHEN** the number of parked sessions reaches the configured maximum
- **THEN** the server SHALL release the oldest rather than growing without bound

#### Scenario: No message content is retained
- **WHEN** a session is parked
- **THEN** it SHALL retain identity, subscriptions and cursor positions only,
  and SHALL NOT retain message bodies or ciphertext

### Requirement: Connection generation supersedes

Each accepted connection for a logical session SHALL carry a monotonically
increasing generation. A connection from an older generation SHALL NOT advance
session state.

#### Scenario: Late frame from a superseded connection
- **WHEN** a frame arrives on connection generation N while generation N+1 is
  live
- **THEN** it SHALL NOT advance cursors, presence, receipts or delivery state

#### Scenario: Stale connection still open
- **WHEN** a client resumes while the previous physical connection has not yet
  been detected as dead
- **THEN** the newer generation SHALL become authoritative and the older SHALL
  be closed

### Requirement: Capability is advertised only when true

`Capabilities.resumption` SHALL NOT be advertised until the server can genuinely
resume.

#### Scenario: Capability matches behaviour
- **WHEN** the server advertises `resumption`
- **THEN** presenting a valid unexpired token SHALL produce `resumed=true`

#### Scenario: Client without the capability is unaffected
- **WHEN** a client does not negotiate `resumption`
- **THEN** its behaviour SHALL be byte-for-byte what it is today

### Requirement: Cursor validation

Progress reported in `resume_from` SHALL be validated before it is trusted.

#### Scenario: Future cursor
- **WHEN** a client reports a cursor beyond what the server actually sent
- **THEN** the server SHALL refuse the resume rather than accept the claim

#### Scenario: Cursor regression
- **WHEN** a client reports a cursor behind the session's recorded position
- **THEN** the recorded position SHALL NOT move backwards

#### Scenario: Wrong stream
- **WHEN** `resume_from` names a stream the session never used
- **THEN** the entry SHALL be rejected without failing the whole handshake

### Requirement: No application-visible change

Session resume SHALL be invisible above the transport. The application event
contract, the historical catch-up path and message idempotence SHALL behave
exactly as they do today, whether a connection resumed or started fresh.

#### Scenario: Event contract unchanged
- **WHEN** this change is complete
- **THEN** the 33 client→server and 44 server→client events SHALL be unchanged
  and the backend contract check SHALL pass

#### Scenario: Historical catch-up still works
- **WHEN** `deliv_cur`/`read_cur` are behind `chat_max` and the client cold
  starts, reconnects, or resumes
- **THEN** missing historical messages SHALL still be delivered

#### Scenario: Replay is idempotent at the UI
- **WHEN** the same durable frame is delivered twice
- **THEN** exactly one visible message, notification and unread increment SHALL
  result
