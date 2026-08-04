## Purpose

Local, private record of every lock session and its zone events, with statistics rollups and export — so users can review exits, returns, and protection time without any data leaving the device.

## ADDED Requirements

### Requirement: Session recording
The system SHALL persist every lock session locally with: start/end timestamps, lock point, radius, and per-session aggregates — time inside, time outside, number of exits and returns, maximum distance from center, total alarm duration, and per-event entries (exit/return with timestamp and distance). Recording SHALL survive process restarts during an active session.

#### Scenario: Session with one exit and return
- **WHEN** a lock session includes one exit (peak 31.4 m outside a 30 m radius, alarm 40 s) and one return
- **THEN** the saved session shows 1 exit, 1 return, max distance ≈ 31.4 m, alarm duration ≈ 40 s, and matching timestamped events

### Requirement: History browsing
The system SHALL show past sessions newest-first with each entry's date, time, radius, and outcome, and SHALL support filtering by event type (all / exits / returns / alarms) and viewing a session's detail including its event timeline.

#### Scenario: Filter to alarm events
- **WHEN** the user filters history to "Alerts"
- **THEN** only sessions containing at least one alarm are listed

### Requirement: Statistics rollups
The system SHALL compute statistics for today, last 7 days, and last 30 days: number of locks, total exits, total time outside, distance traveled while locked, average speed, and total time protected; values SHALL be derived from stored sessions so they are reproducible offline.

#### Scenario: Daily summary
- **WHEN** the user opens statistics for "Today" after two sessions with 7 total exits and 1 h 24 m outside
- **THEN** the summary shows 7 exits and 1 h 24 m outside for today

### Requirement: Export and deletion
The system SHALL let the user export history to a local file (shareable via the OS share sheet) and delete individual sessions or all history; deletion SHALL be immediate and irreversible on-device.

#### Scenario: Clear all history
- **WHEN** the user confirms "Delete all history"
- **THEN** all sessions and statistics reset to empty and no residual location data remains in the database

### Requirement: Local-only storage
History and statistics SHALL be stored only in the app's local database, SHALL never sync or upload, and SHALL be included in the app's existing storage-boundary guarantees (removed on uninstall).

#### Scenario: No network from history
- **WHEN** the user browses history and statistics
- **THEN** no network requests are made by these screens
