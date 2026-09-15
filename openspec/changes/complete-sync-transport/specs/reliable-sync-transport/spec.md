## ADDED Requirements

### Requirement: Paginated cold sync preserves policy
The server SHALL issue an opaque continuation for a restricted cold sync, and the client SHALL echo it until all pages are durably applied.

#### Scenario: Interleaved chats span pages
- **WHEN** a cold sync page ends before all undelivered messages are returned
- **THEN** later pages SHALL retain the same cold floor and per-chat delivery restriction

#### Scenario: Continuation is forged
- **WHEN** a continuation is invalid or belongs to another authenticated user
- **THEN** the server SHALL reject it without returning message data

### Requirement: Cursor checkpoints follow durable storage
The client SHALL advance message, mutation and cold-sync continuation state only after the corresponding page is durably stored.

#### Scenario: Storage fails during a page
- **WHEN** applying a page fails
- **THEN** a later run SHALL resume without advancing past that page

### Requirement: Transport fallback has one owner
Each message submission and inbound delivery SHALL have exactly one owner, and an optional CC-Wire or Rust transport SHALL fall back without disabling HTTP or Socket.IO before parity is verified.

#### Scenario: Optional transport fails
- **WHEN** CC-Wire, Rust networking or a future WebTransport session fails to connect or negotiate
- **THEN** the existing HTTP submission and Socket.IO realtime paths SHALL remain usable without duplicate delivery

### Requirement: Protobuf negotiation is honest
Peers SHALL advertise only implemented capabilities and SHALL treat unknown fields as inert within declared limits.

#### Scenario: Unknown legal protobuf field arrives
- **WHEN** a peer receives a bounded unknown field with a legal wire type
- **THEN** it SHALL skip the field without enabling an unknown capability or rejecting the whole valid message

