# ccwire-protocol-safety

## ADDED Requirements

### Requirement: Parser liveness under arbitrary input

The CC-Wire frame decoder SHALL terminate and return control for any byte
sequence, including sequences no compliant encoder could produce. A malformed
frame is a protocol error to be reported, never a process outcome.

This is the load-bearing requirement of the change: CC-Wire is the only
application realtime protocol, so its decoder is reached by every realtime byte
any client sends, and a crash there is a gateway outage rather than one bad
session.

#### Scenario: Random bytes
- **WHEN** the decoder is given uniformly random bytes of any length
- **THEN** it SHALL return a decode error and SHALL NOT panic, abort, or
  terminate the process

#### Scenario: Truncated frame
- **WHEN** a validly encoded frame is truncated at any byte offset
- **THEN** the decoder SHALL return a decode error and SHALL NOT read beyond the
  supplied buffer

#### Scenario: Malformed varint
- **WHEN** a frame contains a varint that is unterminated, overlong, or exceeds
  64 bits
- **THEN** the decoder SHALL return a decode error rather than wrapping,
  truncating, or looping

#### Scenario: Oversized length declaration
- **WHEN** a frame declares a payload or field length exceeding
  `Limits.max_frame_bytes`
- **THEN** the decoder SHALL reject the frame WITHOUT first allocating the
  declared size

### Requirement: Declared limits hold under adversarial input

The decoder SHALL enforce every bound in the `Limits` message against hostile
input, not only against well-formed input. A limit that is enforced by the
encoder alone is not enforced.

#### Scenario: Nesting depth
- **WHEN** a frame nests messages more deeply than `Limits.max_nesting_depth`
- **THEN** the decoder SHALL reject it and SHALL NOT recurse without bound

#### Scenario: Repeated element count
- **WHEN** a frame declares more repeated elements than
  `Limits.max_repeated_elements`
- **THEN** the decoder SHALL reject it without allocating per declared element

#### Scenario: Reassembly budget
- **WHEN** fragments are submitted that would exceed
  `Limits.max_reassembly_bytes` or `Limits.max_concurrent_reassemblies`
- **THEN** the reassembler SHALL refuse further fragments and SHALL release the
  partial state rather than retaining it until process exit

#### Scenario: String field bound
- **WHEN** a string field exceeds `Limits.max_string_field_bytes`
- **THEN** the decoder SHALL reject the frame

### Requirement: Protocol invariants survive hostile framing

Invariants the protocol states in prose SHALL be enforced by the decoder, so
that a hand-crafted frame cannot obtain behaviour a compliant encoder is
forbidden from requesting.

#### Scenario: EPHEMERAL carrying a durable body
- **WHEN** a frame declares `TRAFFIC_CLASS_EPHEMERAL` and carries a body other
  than `typing_state`, `viewer_state` or `geo_relay`
- **THEN** the decoder SHALL reject it with a protocol violation and SHALL NOT
  handle it leniently

#### Scenario: Unspecified enum on the wire
- **WHEN** a frame carries `TRAFFIC_CLASS_UNSPECIFIED` or
  `STREAM_ID_UNSPECIFIED`
- **THEN** the decoder SHALL reject the frame

#### Scenario: Sequence extremes
- **WHEN** `seq` or `depends_on` is 0, `2^64-1`, or any value in between
- **THEN** the decoder SHALL either accept it as a well-formed number or reject
  the frame, and SHALL NOT wrap, truncate to 53 bits, or overflow

#### Scenario: Unknown future fields
- **WHEN** a frame carries protobuf field numbers this build does not know
- **THEN** the decoder SHALL ignore them per protobuf forward-compatibility
  rules and SHALL NOT fail the frame

### Requirement: The CC-Wire Rust runtime is covered by a scripted test gate

The repository SHALL run the `services/transport/rust` test suite from a
scripted gate. Fuzz targets added to a crate that no gate executes provide no
protection.

#### Scenario: Scripted Rust gate covers the transport crate
- **WHEN** `npm run test:rust` is executed
- **THEN** it SHALL run the `services/transport/rust` test suite in addition to
  `rust/vaultcore`, and SHALL fail if either fails

### Requirement: Discovered defects become regression corpus

Any input that causes a crash, hang, or limit violation SHALL be committed as a
corpus entry so the same input is replayed by the ordinary test run thereafter.

#### Scenario: Crash found by fuzzing
- **WHEN** a fuzz run discovers an input that panics or hangs the decoder
- **THEN** that input SHALL be added to the seed corpus, and the ordinary
  (non-fuzzing) test run SHALL exercise it

### Requirement: No protocol or behaviour change

This change SHALL NOT alter the wire format, negotiated capabilities, declared
limits, or the observable behaviour of any existing client.

#### Scenario: Existing gates stay green
- **WHEN** the change is complete
- **THEN** `go vet ./...`, `go test ./...`, the frontend suite, and the
  Socket.IO-removal guard SHALL all pass unchanged

#### Scenario: Parser is modified only on evidence
- **WHEN** no fuzz run has demonstrated a concrete defect
- **THEN** the parser implementation SHALL remain unmodified
