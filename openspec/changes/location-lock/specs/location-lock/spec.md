## Purpose

Lets a user lock a geographic point with a chosen radius and have the device continuously monitor, on-device only, whether it remains inside that radius — through foreground and background — with a live map, zone states, and a guided way back.

## ADDED Requirements

### Requirement: Lock point selection
The system SHALL let the user choose a lock point by (a) using the current GPS position, (b) searching an address or entering `lat, lng` coordinates, or (c) dropping/dragging a pin on the map, and SHALL display the selected point with its resolved coordinates before the lock is armed.

#### Scenario: Lock at current location
- **WHEN** the user chooses "Use current location" and a GPS fix is available
- **THEN** the fix's coordinates become the pending lock point and are shown on the map with the GPS accuracy value

#### Scenario: Coordinates entry works without any geocoder
- **WHEN** the user enters text matching `lat, lng` (e.g. `17.385044, 78.486671`)
- **THEN** the point is set from the parsed coordinates without requiring network or a geocoding service

#### Scenario: Address search unavailable
- **WHEN** address search fails or no geocoder is available on the device
- **THEN** the user is told to use coordinates or drop a pin, and pin-drop remains fully functional

### Requirement: Radius selection with accuracy guard
The system SHALL offer radius presets of 10, 20, 30, 50, 100, 200, 500 and 1000 meters plus a custom value clamped to 10–1000 m, SHALL render an animated preview circle at true scale on the map, and SHALL warn when the chosen radius is smaller than twice the current GPS accuracy (false-alarm risk).

#### Scenario: Preset selection previews the circle
- **WHEN** the user selects the 30 m preset
- **THEN** a 30 m circle is drawn around the pending lock point at correct map scale

#### Scenario: Radius too small for current accuracy
- **WHEN** GPS accuracy is ±25 m and the user selects a 10 m radius
- **THEN** a warning explains that alarms may misfire at this accuracy, and the user may proceed or pick a larger radius

### Requirement: Arming and unlocking
The system SHALL arm a lock only after point, radius, and alert settings are confirmed; while armed it SHALL show an active-lock surface with radius, live distance from center, GPS accuracy, zone status, and time locked; and it SHALL let the user unlock at any time, ending monitoring and saving the session.

#### Scenario: Arm a lock
- **WHEN** the user confirms "Lock Location"
- **THEN** monitoring starts, a persistent "Location Locked" notification appears, and the active-lock surface shows status Safe with live distance and accuracy

#### Scenario: Unlock while outside
- **WHEN** the user unlocks while the zone state is Outside and an alarm is sounding
- **THEN** the alarm stops, monitoring ends, and the session is saved with its exit still recorded

### Requirement: Zone state machine with drift protection
The system SHALL evaluate every accepted GPS fix on-device against the lock geometry and maintain exactly one zone state — Safe (distance < radius − warning band), Warning (within the warning band, default 5 m inside the boundary), At-Limit (at or within accuracy margin of the boundary), Outside (distance > radius beyond hysteresis), Returned→Safe (re-entry) — and SHALL apply accuracy gating and hysteresis so that a single noisy fix cannot flip the state.

#### Scenario: Normal walk-out sequence
- **WHEN** successive fixes move the device from 5 m to 28 m to 35 m from center with a 30 m radius
- **THEN** the state transitions Safe → Warning/At-Limit → Outside in order, with each transition surfaced to the alert layer exactly once

#### Scenario: Noisy fix rejected
- **WHEN** the device is stationary 10 m from center (30 m radius) and one fix with ±50 m accuracy reports 40 m
- **THEN** the state remains Safe and no alarm or warning is emitted

#### Scenario: Boundary hover does not flap
- **WHEN** fixes oscillate between 29 m and 31 m around a 30 m radius
- **THEN** hysteresis prevents repeated Outside/Returned transitions and at most one alarm cycle occurs until the device clearly leaves or returns

#### Scenario: Return to safe zone
- **WHEN** the state is Outside and an accepted fix places the device back inside radius − hysteresis
- **THEN** the state becomes Safe, the return is surfaced to the alert layer, and the return time and duration outside are recorded

### Requirement: Background monitoring
The system SHALL continue evaluating the geofence while the app is backgrounded or the screen is off, using a foreground service with a persistent notification on Android, and SHALL restore the active lock (point, radius, state, settings) after process death so a lock is never silently dropped.

#### Scenario: Exit detected while app is backgrounded
- **WHEN** an armed device leaves the radius while another app is in the foreground
- **THEN** the alarm fires and the full-screen alert is available from the notification within the configured grace time

#### Scenario: Process restart during an active lock
- **WHEN** the OS kills and later restarts the app while a lock is armed
- **THEN** the lock is restored from persisted state and monitoring resumes without user action

#### Scenario: Background permission missing
- **WHEN** the user arms a lock without background-location permission
- **THEN** the lock still works in the foreground, and the user is clearly told background protection is off with a path to grant the permission

### Requirement: Live lock map
The map SHALL render the lock radius as a circle whose fill/stroke color reflects the zone state (green Safe, yellow Warning, orange At-Limit, red Outside), plus the user's position with heading, the GPS accuracy circle, and a numeric distance-from-center readout that updates on every accepted fix.

#### Scenario: Zone color follows state
- **WHEN** the zone state changes from Safe to Warning
- **THEN** the radius overlay changes from green to yellow on the same fix, and the distance readout matches the state

### Requirement: Map compass with north reset
The map SHALL show a floating compass while the map heading is not north-up; the compass SHALL rotate with the map, tapping it SHALL animate the map back to north-up, and it SHALL hide when the map is already north-up (Google Maps behavior), including during navigate-back.

#### Scenario: Rotate then reset
- **WHEN** the user rotates the map 90° and then taps the compass
- **THEN** the map animates back to north-up and the compass disappears

### Requirement: Navigate back to the lock point
While the state is Outside, the system SHALL offer one-tap navigation from the current position back to the lock point using the existing routing engine (pedestrian/bicycle/auto costing), SHALL reroute automatically on deviation, and SHALL end guidance when the device re-enters the radius.

#### Scenario: Guided return
- **WHEN** the user taps "Navigate" on the outside alert
- **THEN** a route from current position to the lock point is shown with distance/ETA and turn guidance, and guidance ends automatically once the device is back inside the radius

#### Scenario: Deviation while returning
- **WHEN** the user strays off the return route beyond the GPS margin
- **THEN** the route is recalculated automatically and guidance continues on the new route

### Requirement: Location privacy
All geofence evaluation SHALL happen on-device; lock coordinates, fixes, zone events, and history SHALL never be transmitted off the device by this feature. The only permitted network calls are route requests to the app's own authenticated routing proxy and (if enabled) geocoding queries to the app's own search proxy.

#### Scenario: Monitoring generates no location traffic
- **WHEN** a lock is armed and the device moves between zones for an hour without using navigate-back or search
- **THEN** the feature performs no network requests containing coordinates
