## Why

Users want to "lock" a spot — a parked bike, a campsite, a market stall, a child's play area — and be loudly warned the moment they (or the device) drift out of a chosen radius, then be guided back. VaultChat's Navigate mini-app already has the hard parts: a real GPS loop, self-hosted Valhalla routing with missed-turn rerouting (`lib/nav/navigationService.ts`), a no-GMS Leaflet map (`components/nav/NavMap.tsx`), haptic alert patterns, Notifee foreground-service infrastructure, and SQLite. Location Lock assembles these into a privacy-first geofence utility — all evaluation on-device, no server ever sees a coordinate. This is a utility inside the Navigate mini-app, **not** a family-tracking feature (that is the separate `family-circle` change).

## What Changes

- **Lock a location**: current position, searched address/coordinates, or a pin dropped on the map; radius 10 m – 1 km (presets + custom) with an animated preview circle and a GPS-accuracy warning when radius ≈ accuracy.
- **On-device zone engine**: hysteresis state machine — Safe → Warning (near boundary) → At-Limit → Outside → Returned — fed by fused GPS fixes (accuracy-gated, distance smoothed) to prevent false alarms from GPS drift.
- **Multi-channel alarm**: siren/continuous beep, vibration patterns, voice warning (TTS), screen flash, full-screen alert; each channel independently configurable with volume, grace time, repeat-until-return, and a Test Alarm. Alarm stops automatically on re-entry and the event is recorded.
- **Background monitoring**: lock survives app background/kill via `expo-task-manager` background location + a Notifee foreground service with a persistent "Location Locked" notification. **BREAKING dependency**: requires Android `ACCESS_BACKGROUND_LOCATION` + `foregroundServiceType="location"` and the Play Store background-location declaration.
- **Navigate back**: when Outside, one tap starts the existing Valhalla navigation flow back to the lock point (walk/cycle/drive costing), with the existing deviation-based rerouting; arrival inside the radius ends the alert.
- **Live lock map**: NavMap gains a radius circle overlay with zone-colored fill (green/yellow/orange/red), a GPS-accuracy circle, distance-to-boundary readout, and a Google-Maps-style compass (rotate with heading, tap to reset North, hidden when already North-up).
- **History & statistics**: every lock session persisted locally (SQLite) — exits, returns, max distance, time inside/outside, alarm durations — with daily/weekly/monthly rollups and export. Local-only; nothing leaves the device.
- **Search hardening**: keep the "lat, lng" fallback; add optional self-hosted Photon/Nominatim geocoding through the backend proxy so address search works on no-GMS devices (backend infra, feature-flagged).

### Pro (v2) additions — Location Lock Pro blueprint

- **Live GPS diagnostics**: the status card and map gain speed, heading, battery, and a GPS quality tier (Excellent/Good/Fair/Poor derived from accuracy). Raw satellite count and cellular signal strength need a native GNSS module — out of scope for the WebView/Expo stack; the quality tier is the honest replacement.
- **Route options for navigate-back**: fastest (default) / shortest, avoid tolls, avoid highways — mapped onto Valhalla `costing_options` through the existing `/nav/route` proxy; a "Re-route now" manual trigger.
- **Monitoring modes**: Walking / Cycling / Driving / Custom presets that tune the zone engine's sensitivity (warning band, hysteresis, GPS cadence) and pre-select the navigate-back travel mode; Custom exposes the sensitivity directly.
- **Voice guidance**: spoken turn-by-turn during navigate-back (expo-speech reading the existing banner instructions) — the Navigate engine's first voice mode.
- **Richer statistics**: alarms-triggered count, average GPS accuracy, average lock duration, and a 7-day distance trend chart on top of the existing rollups.
- **Settings hub**: one screen grouping General (units metric/imperial, mode), Sound & Vibration (existing alert settings), Battery (background tracking toggle, optimization exemption), and About — matching the blueprint's Settings surface.
- **Map controls**: zoom in/out buttons and re-center on the lock map (Leaflet), alongside the existing compass.

## Capabilities

### New Capabilities
- `location-lock`: lock lifecycle (select point → radius → arm → monitor → unlock), the on-device zone state machine with hysteresis and accuracy gating, background monitoring, and the live lock map UI (radius overlay, zone colors, compass, navigate-back entry).
- `lock-alarm`: the alert channel stack (beep, siren, vibration, voice, flash, full-screen), per-channel configuration, grace/repeat behavior, test alarm, and automatic stop-on-return.
- `lock-history`: local persistence of lock sessions and zone events, statistics rollups, and export.

### Modified Capabilities
<!-- No existing openspec/specs/* capabilities exist yet; Navigate engine reuse (routing, rerouting, haptics) is at the implementation layer and its behavior is unchanged. -->

## Impact

- **Client**: new `lib/lock/` engine (zone state machine, alarm controller, session recorder — pure modules with self-checks, matching `lib/nav/*` style); new screens `app/location-lock.tsx` (setup: point/radius/alerts) and lock-active UI; NavMap WebView extensions (circle overlays, zone colors, compass control); reuses `lib/nav/routing.ts`, `navigationService.ts`, `hapticPlayer.ts`, `geo.ts`.
- **Dependencies**: no new native map module (Leaflet WebView keeps the no-GMS, no-prebuild property). New: `expo-speech` (voice warnings) and audio playback for siren/beep (`expo-audio`); `expo-task-manager`, `expo-sensors`, Notifee, and SQLite are already installed.
- **Backend**: none required for core (geofencing is on-device; routing already proxied via `POST /nav/route`). Optional: Photon geocoder container in docker-compose + one proxy route for address search.
- **Native / compliance**: Android manifest additions (`ACCESS_BACKGROUND_LOCATION`, FGS location type), battery-optimization exemption prompt, Play background-location declaration; iOS "Always" location authorization string. These gate release of background mode — foreground-only lock works without them.
- **Privacy**: coordinates never leave the device; history is local SQLite (optionally encrypted with the existing app-lock story); no analytics.
