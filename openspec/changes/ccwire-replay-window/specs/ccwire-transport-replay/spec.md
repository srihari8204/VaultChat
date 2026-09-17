# ccwire-transport-replay

## ADDED Requirements

### Requirement: Replay is an optimisation over durable sync

Transport replay SHALL NOT be the source of truth for any message. Whenever the
window cannot serve a gap in full, the server SHALL answer `resumed=false` and
the client SHALL fall back to the existing application resync.

The same rule that governs resume governs replay: the worst outcome must be
today's behaviour, never a gap the client does not know about.

#### Scenario: Gap exceeds the window
- **WHEN** a client resumes from a position older than the oldest frame retained
- **THEN** the server SHALL refuse the resume with `resumed=false` rather than
  replay a partial range

#### Scenario: Window empty after restart
- **WHEN** the gateway has restarted since the frames were sent
- **THEN** no replay SHALL be attempted and the client SHALL full-resync

#### Scenario: Partial replay is never served
- **WHEN** only some frames after the client's position are still retained
- **THEN** the server SHALL refuse rather than deliver a sequence with a hole in
  it — a silent hole is worse than an honest resync

### Requirement: The window is bounded three ways simultaneously

Retained frames SHALL be bounded by total bytes, by frame count, and by age, per
session. Exceeding any bound SHALL evict the oldest frames.

A window bounded by only one of these is unbounded in practice: a bound on count
says nothing about a session sending large frames, and a bound on bytes says
nothing about a session that parks and is never reclaimed.

#### Scenario: Byte ceiling
- **WHEN** retained frames would exceed the per-session byte budget
- **THEN** the oldest SHALL be evicted until the budget holds, before the new
  frame is retained

#### Scenario: Count ceiling
- **WHEN** retained frames would exceed the per-session frame count
- **THEN** the oldest SHALL be evicted

#### Scenario: Age ceiling
- **WHEN** a retained frame is older than the retention lifetime
- **THEN** it SHALL be released even if the byte and count budgets are unused

#### Scenario: Acknowledged frames are released
- **WHEN** a client acknowledges a position through `Ping.progress`
- **THEN** frames at or before that position SHALL be dropped, so a healthy
  connection retains almost nothing

### Requirement: Attachment and bulk payloads never enter the window

The window SHALL NOT retain a frame above the per-frame retention limit, and
SHALL NOT retain bulk-class traffic. Large file bytes must never sit in gateway
memory waiting for a reconnect that may not come.

#### Scenario: Large payload
- **WHEN** a frame exceeds the per-frame retention limit
- **THEN** it SHALL NOT be retained, and the session SHALL record that its
  window has a hole so a later resume refuses rather than skipping it

#### Scenario: Bulk traffic class
- **WHEN** a frame is `TRAFFIC_CLASS_BULK`
- **THEN** it SHALL NOT be retained — bulk is resumable by its own mechanism and
  replaying it would put file bytes in gateway memory

### Requirement: Replay preserves order and causality

Replayed frames SHALL preserve per-stream ordering and SHALL NOT weaken the
`depends_on` guarantee. Replay is a retransmission, not a re-ordering
opportunity.

#### Scenario: Stream order
- **WHEN** frames are replayed
- **THEN** they SHALL be delivered in ascending sequence within each stream,
  before any new traffic on that stream

#### Scenario: Causal dependency
- **WHEN** a replayed frame carries `depends_on`
- **THEN** the dependency SHALL still be satisfied — replay SHALL NOT allow a
  message to overtake the key rotation or membership change it depends on

### Requirement: Duplicate delivery is safe, and is not claimed to be absent

Replay MAY deliver a frame the client already received, and the system SHALL
NOT claim otherwise. The guarantee offered SHALL be exactly-once **visible
effect** — one message, one notification, one unread increment — and never
exactly-once delivery.

#### Scenario: Duplicate durable message
- **WHEN** the same durable message frame is delivered twice
- **THEN** exactly one visible message, one notification and one unread
  increment SHALL result

#### Scenario: Cursor does not regress on replay
- **WHEN** a replayed frame is processed
- **THEN** no delivery or read cursor SHALL move backwards

### Requirement: Off by default

Retention and replay SHALL be gated behind the same flag as session resume. A
window that retains frames while resume is off is memory spent on a feature that
cannot run.

#### Scenario: Feature flag unset
- **WHEN** `CCWIRE_RESUME` is not set
- **THEN** no frame SHALL be retained and no replay SHALL be attempted, and
  memory use SHALL be unchanged from today

### Requirement: Outbound frames carry a per-session sequence number

Every frame the gateway fans out to a session SHALL carry a monotonic,
per-session, per-stream `seq`, except frames whose traffic class is
`TRAFFIC_CLASS_EPHEMERAL` or `TRAFFIC_CLASS_BULK` and control-plane replies that
answer a request rather than carrying a position.

Without this the rest of this capability does nothing: cursors record `seq`,
`resume_from` reports it, and the window is indexed by it. A stream of
unsequenced frames leaves every window empty and every resume refused, while all
of the machinery reports itself correct.

#### Scenario: A resuming session receives sequenced frames
- **WHEN** a session that negotiated resumption is delivered a fan-out event
- **THEN** each frame SHALL carry the next `seq` for its stream, the session's
  cursor SHALL advance to it, and the frame SHALL be retained

#### Scenario: A session that cannot resume is unaffected
- **WHEN** a session has no replay window
- **THEN** it SHALL receive the fan-out's shared encoding byte-for-byte, with no
  additional encode and no sequence number — the fan-out encodes ONCE for all
  such sessions, which is why a chat message to fifty devices is one encode

#### Scenario: Sequence numbers are per session
- **WHEN** two sessions of the same user receive different numbers of frames
- **THEN** each SHALL see a gapless sequence of its own; a shared counter would
  hand each of them a stream with holes in it

#### Scenario: Ephemeral traffic is never sequenced
- **WHEN** a typing or presence frame is delivered
- **THEN** it SHALL carry no `seq`, move no cursor, and enter no window — it is
  lossy by design, and sequencing it would let a stale typing indicator refuse
  an otherwise serviceable resume

### Requirement: The client reports what it has received

The client SHALL track the highest `seq` handed to the application per stream,
report it in `Ping.progress` on each heartbeat, and offer it as
`ClientHello.resume_from` on reconnect.

Progress is what lets the server release retained frames; without it every
window fills to its ceiling and stays there. `resume_from` is what lets the
server replay rather than refuse; without it the server has a token that names
the session but no position to serve from, and answers `resumed=false`.

#### Scenario: A position is recorded only once delivered
- **WHEN** a frame is decoded but not yet handed to the application
- **THEN** its position SHALL NOT be reported — the claim is "I have this", and
  reporting a frame the application never saw loses it in exactly the way
  `resumed=false` exists to prevent

#### Scenario: A client with nothing to report
- **WHEN** no sequenced frame has been delivered
- **THEN** `Ping.progress` SHALL encode to a zero-byte body, byte-for-byte the
  bare Ping sent before resume existed

#### Scenario: Sequence past 2^53
- **WHEN** a sequence number exceeds what a double represents exactly
- **THEN** it SHALL survive the client encoding without truncation — `seq` is
  `jstype = JS_STRING` for this reason and SHALL NOT pass through `Number()`
