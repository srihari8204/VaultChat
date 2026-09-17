# Cold-start measurement and evidence

## ADDED Requirements

### Requirement: Startup metrics MUST state their measurement boundary
Every reported startup number SHALL name the build identity, the device, and the exact
start and end points it measures. Two numbers measured to different endpoints SHALL NOT
be compared or presented as a before/after pair.

#### Scenario: A first-draw figure is not compared to a readiness figure
- **WHEN** a "first visible frame" duration and a "messaging ready" duration both exist
- **THEN** the report SHALL keep them as separate rows
- **AND** SHALL NOT present one as an improvement over the other

#### Scenario: A claim about the installed app names the build it came from
- **WHEN** a performance claim is made about the installed application
- **THEN** the report SHALL name the APK that was measured
- **AND** SHALL state whether that APK was built from the current working tree

### Requirement: Counters MUST be shown to cover what a conclusion needs
A conclusion drawn from a counter SHALL be supported by the counter's increment sites.
A zero reading SHALL NOT be reported as absence of activity unless the counter is shown
to cover every path that would produce that activity.

#### Scenario: A zero submit/ack reading is not reported as zero traffic
- **WHEN** a frame counter reads zero after a cold start
- **AND** that counter is shown to increment only on an outbound submit path
- **THEN** the report SHALL state that received and decoded frames are uncounted
- **AND** SHALL NOT conclude that no frames were exchanged

### Requirement: Serialization format established per layer
Each layer SHALL have its serialization format established from the implementation: the HTTP body, the CC-Wire envelope, the payload nested inside that envelope, and each local persistence store. A comment, header, or .proto schema alone SHALL NOT be treated as proof.

#### Scenario: An envelope format is not generalised to its payload
- **WHEN** the CC-Wire envelope is shown to be protobuf
- **THEN** the encoding of the payload nested inside it SHALL be established separately
- **AND** SHALL cite the code that produces and consumes those inner bytes

### Requirement: Unverifiable work is labelled, not assumed
Validation that cannot be performed SHALL be reported as NOT RUN, with the exact commands required to complete it. Absence of a measurement SHALL NOT be reported as a passing result.

#### Scenario: No device is attached during the task
- **WHEN** no physical device is available for cold-start measurement
- **THEN** device measurements SHALL be reported as NOT RUN
- **AND** source analysis and automated test results SHALL be reported separately from them
