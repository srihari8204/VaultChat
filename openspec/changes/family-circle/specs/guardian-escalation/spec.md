## ADDED Requirements

### Requirement: SOS burst
The system SHALL let any Circle member trigger an SOS that captures the current location, sends a sealed high-priority ping plus an E2EE system message to all guardians, and deep-links guardians into in-app navigation to the location.

#### Scenario: Trigger SOS
- **WHEN** a member triggers SOS in the Circle
- **THEN** all guardians receive a high-priority sealed ping and a critical E2EE system message, and each can tap to open in-app navigation to the sender

#### Scenario: Works without Google services
- **WHEN** a guardian on a no-GMS device taps the SOS location
- **THEN** in-app navigation opens to the coordinates without requiring Google Maps

### Requirement: Escalation ladder
The system SHALL run a guardian escalation state machine when a check-in is missed or a Guardian call is unanswered: retry at +5 minutes, then +15 minutes, then after a configured number of misses trigger Emergency Connect. A member's "I'm OK" response SHALL cancel the active ladder immediately.

#### Scenario: Missed check-in retries
- **WHEN** a member misses a scheduled check-in
- **THEN** the system retries notification at +5 min and +15 min before escalating further

#### Scenario: I'm OK cancels
- **WHEN** the member responds "I'm OK" at any point in the ladder
- **THEN** the ladder is cancelled and the cancellation is recorded as an E2EE system message

#### Scenario: Escalate to Emergency Connect
- **WHEN** the configured number of misses is reached
- **THEN** Emergency Connect is triggered for guardians

### Requirement: Emergency Connect
The system SHALL deliver Emergency Connect as a full-screen critical alert via the existing Notifee foreground-service and native FCM path, even when the guardian's app is killed. On Android it MAY auto-answer a video call and burst the member's sealed location; on iOS it SHALL play a repeating critical alarm. Delivery SHALL degrade gracefully where an OS entitlement is unavailable.

#### Scenario: Guardian app killed
- **WHEN** Emergency Connect fires and the guardian's app is not running
- **THEN** a full-screen critical alert is shown via the native FCM + foreground-service path

#### Scenario: Entitlement missing
- **WHEN** the iOS Critical Alerts entitlement has not been granted
- **THEN** the system falls back to the highest-priority notification available and records that the critical channel was unavailable

### Requirement: Escalation audit log
The system SHALL record every escalation action (trigger, retry, cancel, Emergency Connect) as an E2EE system message in the Circle thread, readable only by Circle members.

#### Scenario: Actions are logged
- **WHEN** any escalation action occurs
- **THEN** an E2EE system message describing the action and timestamp is appended to the Circle thread

#### Scenario: Log is private
- **WHEN** the audit messages transit the server
- **THEN** they are ciphertext and unreadable by the server
