## Purpose

Defines the alert stack that reacts to zone-state changes of an armed location lock: which channels fire (beep, siren, vibration, voice, screen flash, full-screen alert), how they are configured, and when they start, repeat, and stop.

## ADDED Requirements

### Requirement: Independently configurable alert channels
The system SHALL provide these alert channels, each with its own on/off toggle: loud beep/siren, continuous beep, vibration, voice warning (spoken text), and screen flash with full-screen alert. Channel settings SHALL be editable before arming and while a lock is armed, and SHALL persist across sessions.

#### Scenario: Vibration-only configuration
- **WHEN** the user disables all channels except vibration and the device exits the radius
- **THEN** only vibration fires — no sound, no flash — and the full-screen alert still shows the textual warning

### Requirement: Warning-zone pre-alert
On the transition into the Warning zone the system SHALL emit a gentle pre-alert — short vibration and, if voice is enabled, a spoken "approaching boundary" — at most once per boundary approach, without triggering the main alarm.

#### Scenario: Approaching the boundary
- **WHEN** the zone state changes from Safe to Warning
- **THEN** a short vibration plays (plus voice if enabled), the main alarm does not start, and no further pre-alert repeats while the state stays Warning

### Requirement: Outside alarm with grace time
On the transition to Outside the system SHALL start a configurable grace countdown (default 5 s, configurable 0–60 s); if the device is still Outside when it expires, the alarm SHALL fire on all enabled channels with a full-screen alert showing "You have left the locked area" and the live distance from the boundary. Returning inside during the grace period SHALL cancel the alarm silently.

#### Scenario: Alarm after grace period
- **WHEN** the device goes Outside and remains outside for the 5 s grace time
- **THEN** all enabled channels fire together and the full-screen alert shows the live distance

#### Scenario: Grace period re-entry
- **WHEN** the device goes Outside but is back inside within the grace time
- **THEN** no alarm fires and the brief exit is still recorded in history

### Requirement: Alarm volume and patterns
The system SHALL provide an alarm volume control (up to max media volume), a choice of siren/beep tones, and vibration intensity patterns (strong/medium/pulse); the alarm SHALL play at the configured volume even if the device media volume is lower, subject to OS limits.

#### Scenario: Configured volume enforced
- **WHEN** alarm volume is set to 100% and device media volume is at 20% when the alarm fires
- **THEN** the alarm plays at the configured alarm volume, not the ambient 20%

### Requirement: Repeat until return
When "repeat until back inside" is enabled, the alarm SHALL re-fire on its repeat interval for as long as the state remains Outside; when disabled, the alarm SHALL play one full cycle and then leave the persistent notification and full-screen alert active without sound.

#### Scenario: Continuous alarm outside
- **WHEN** repeat is enabled and the device stays Outside for three minutes
- **THEN** the alarm keeps cycling for those three minutes and stops immediately on re-entry

### Requirement: Automatic stop on return and manual stop
The alarm SHALL stop automatically the moment the zone state returns to Safe, showing a "back inside the safe zone" confirmation; the full-screen alert SHALL also offer a manual "Stop Alarm" control that silences sound/vibration while keeping the lock armed and the Outside status visible.

#### Scenario: Auto-stop on re-entry
- **WHEN** the alarm is sounding and the device re-enters the radius
- **THEN** all channels stop without user action and a green "safe again" confirmation is shown

#### Scenario: Manual stop keeps the lock armed
- **WHEN** the user taps "Stop Alarm" while still Outside
- **THEN** sound and vibration stop, the lock remains armed, the status remains Outside, and navigate-back stays available

### Requirement: Test alarm
The system SHALL provide a Test Alarm action in alert settings that plays the currently configured channels for a short bounded duration without an armed lock and without writing an alarm event to history.

#### Scenario: Test with current settings
- **WHEN** the user taps "Test Alarm" with siren and vibration enabled
- **THEN** siren and vibration play for the test duration and stop automatically, and history records nothing

### Requirement: Alarm works from the background
Alarm delivery SHALL NOT require the app to be in the foreground: when the exit is detected in the background, sound and vibration SHALL start from the service layer and the notification SHALL open the full-screen alert. If notification or full-screen permissions are missing at arm time, the user SHALL be warned before the lock is armed.

#### Scenario: Backgrounded exit alarm
- **WHEN** the alarm condition is met while the screen is locked
- **THEN** the alarm sounds, the device vibrates, and a high-priority notification opens the full-screen alert when tapped
