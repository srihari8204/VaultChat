## ADDED Requirements

### Requirement: Complete negotiated event compatibility
An exclusive CC-Wire client SHALL negotiate full application event support before replacing Socket.IO, and SHALL retain existing event authorization and mixed-client delivery semantics.

#### Scenario: Server lacks full event capability
- **WHEN** a server does not negotiate the full application event capability
- **THEN** the client SHALL close the unsupported candidate and retain the legacy event path

#### Scenario: Mixed carriers share a chat
- **WHEN** authorized members use different supported realtime carriers
- **THEN** messages, receipts, room events and call signals SHALL reach their intended recipients without bypassing existing authorization

### Requirement: Bounded single-carrier realtime
An upgraded client SHALL maintain one active steady-state realtime carrier and SHALL bound pending network queues by count and bytes.

#### Scenario: Slow peer or blocked UDP
- **WHEN** a peer cannot drain queued traffic or establish WebTransport
- **THEN** the system SHALL apply bounded backpressure or reconnect/fallback while preserving durable message recovery

### Requirement: Receipt states reflect durable delivery and visible reading
Grey delivery receipts SHALL follow local message persistence; read receipts SHALL require an active focused chat. Receipt state SHALL survive concurrent hydration, network requests and recoverable failures.

#### Scenario: Push arrives without the receiver opening the chat
- **WHEN** a message is durably synchronized while the chat is not visible
- **THEN** the receiver SHALL report delivery without reporting read

#### Scenario: Receipt advances during an in-flight request
- **WHEN** a higher receipt pointer is recorded during an earlier request
- **THEN** the higher pointer SHALL remain durable and receive a subsequent flush

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

### Requirement: Recoverable history remains local
The client SHALL retain locally recoverable message records when the server may have purged their bodies, and SHALL bound memory through indexed paging rather than destructive history pruning.

#### Scenario: A user scrolls old delivered history
- **WHEN** delivered message bodies are no longer available from the server
- **THEN** cached local history SHALL remain readable, searchable and pageable without a network request or Double Ratchet replay

### Requirement: Large histories do not scale first paint
Chat opening SHALL query and render a bounded newest-first window, then load older indexed pages as the user scrolls while keeping a bounded in-memory window.

#### Scenario: A chat contains one hundred thousand messages
- **WHEN** the user opens the chat or scrolls one cached page upward
- **THEN** the client SHALL avoid loading the full history and SHALL preserve ordering, deduplication, edits, tombstones, receipts and viewport position

### Requirement: Startup work is evidence-gated
The client SHALL keep nonvisual initialization off the first-content path where doing so preserves killed-call, notification, security and realtime behavior, and SHALL report cold-start results from equivalent physical-device runs.

#### Scenario: A signed-in user cold-starts with existing history
- **WHEN** authentication and local history already exist
- **THEN** routing SHALL not deserialize the entire chat/history store or wait for unrelated feature initialization before cached content can paint
