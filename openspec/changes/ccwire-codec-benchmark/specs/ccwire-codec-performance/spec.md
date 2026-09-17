# ccwire-codec-performance

## ADDED Requirements

### Requirement: A measured codec baseline exists

The repository SHALL carry runnable benchmarks over the real CC-Wire encode and
decode path, so that a performance claim can be checked rather than asserted.

#### Scenario: Benchmarks run without infrastructure
- **WHEN** a developer runs `go test ./internal/ccwire -bench=. -benchmem -run='^$'`
- **THEN** encode, decode, round-trip and rejection figures SHALL be produced
  with no server, network, database or second process

#### Scenario: Allocation is reported
- **WHEN** any benchmark reports a result
- **THEN** it SHALL include bytes and allocations per operation, because ns/op
  alone hides the cost that decides GC behaviour at connection scale

#### Scenario: Benchmarks do not slow the ordinary gate
- **WHEN** `go test ./...` runs without `-bench`
- **THEN** the benchmarks SHALL NOT execute

### Requirement: Rejection cost is bounded and measured

The cost of REFUSING hostile input SHALL be measured alongside the cost of
accepting valid input, and SHALL NOT grow with attacker-controlled input size.

An attacker chooses which path the gateway runs. If refusing is far more
expensive than accepting, the parser's strictness is itself the denial-of-service
vector, and a limit that bounds memory while leaving CPU unbounded is only half
a limit.

#### Scenario: Cost does not scale with input size
- **WHEN** a repeated-field input is decoded at 1 KiB, 8 KiB, 64 KiB and 128 KiB
- **THEN** time and allocation per rejection SHALL plateau rather than grow in
  proportion to the input

#### Scenario: Rejection asymmetry is recorded
- **WHEN** the baseline is published
- **THEN** it SHALL state the cost of rejection relative to the cost of
  accepting a valid frame, so the ratio is a known quantity rather than a
  surprise

### Requirement: The benchmark never reintroduces Socket.IO

The benchmark harness SHALL be written against CC-Wire directly. The previous
harness depended on `socket.io-client`; that dependency was removed deliberately
and the removal guard forbids its return, including as a dev-only dependency. A
benchmark is not a reason to weaken that.

#### Scenario: No Socket.IO dependency
- **WHEN** the benchmark is added or later extended
- **THEN** `socket.io-client` SHALL NOT be added to dependencies,
  devDependencies or any lockfile, and the existing Socket.IO removal guard
  SHALL continue to pass
