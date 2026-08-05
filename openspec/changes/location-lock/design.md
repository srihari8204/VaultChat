## Context

The Navigate mini-app already provides the primitives this feature needs (see proposal.md — Why): `lib/nav/geo.ts` (haversine/bearing), `lib/nav/routing.ts` + `navigationService.ts` (Valhalla routes via the authenticated `POST /nav/route` proxy, GPS watch loop, deviation reroute), `lib/nav/hapticPlayer.ts` (vibration patterns incl. iOS degrade), and `components/nav/NavMap.tsx` (Leaflet in a WebView, bundled JS, no native map module, renders on no-GMS devices). Installed and unused-for-this-yet: `expo-task-manager`, `expo-sensors`, `@notifee/react-native`, `@op-engineering/op-sqlite`, `expo-sqlite`. The original blueprint was written for a native Kotlin app; this design maps it onto the actual React Native/Expo codebase.

Project conventions that shape the approach: pure logic modules with embedded self-checks (`lib/nav/adaptiveDistance.ts`, `missedTurn.ts` style), orchestration kept thin, no new native modules unless unavoidable (prebuild + store friction), server never sees plaintext location.

## Goals / Non-Goals

**Goals:**
- False-alarm-resistant geofencing at 10–1000 m radii using GPS + accuracy gating + hysteresis, entirely on-device.
- Lock survives background and process death; alarm delivery does not depend on the UI being alive.
- Reuse the existing navigation engine unchanged for navigate-back.
- Keep the no-prebuild, no-GMS property of the Navigate mini-app for v1.

**Non-Goals (v1):**
- Full Kalman sensor fusion (accelerometer/gyro dead-reckoning). Accuracy gating + smoothing covers the false-alarm goal at these radii; fusion is a later optimization.
- Native MapLibre renderer, offline tile packs, 3D tilt, finger map-rotation. The Leaflet WebView map is extended instead; the MapLibre spike is already tracked in the `family-circle` change (F3) and this feature rides that upgrade when it lands.
- Multiple simultaneous locks, shared/remote locks, wearable companions.
- Traffic-aware or toll/highway-avoidance re-route options (Valhalla costing options exist, but v1 exposes only travel mode).

## Decisions

- **Zone engine is a pure module** — `lib/lock/zoneMachine.ts`: `(fix, lockGeometry, config, prevState) → {state, events[]}` with embedded self-checks, no RN imports. States: `safe | warning | atLimit | outside`; config: warning band (default 5 m), hysteresis margin (default max(3 m, 0.5×accuracy)), grace seconds. *Why*: matches the tested-pure-core pattern of `lib/nav/*`; every spec scenario becomes a unit self-check. *Alternative rejected*: folding logic into the service (untestable, the family-circle geofence engine will want to reuse this module).
- **Drift protection = accuracy gating + short-window smoothing, not Kalman.** A fix is rejected for state transitions when `accuracy > max(30 m, radius)`; distance is smoothed over the last 3 accepted fixes; transitions additionally require the hysteresis margin. `expo-sensors` magnetometer is used only for the compass/heading UI. *Why*: at 10–1000 m radii the dominant error is GPS scatter, which gating+hysteresis already absorbs; a JS Kalman under RN timer jitter adds tuning surface without changing outcomes. Revisit only if field testing shows flapping.
- **Background = `Location.startLocationUpdatesAsync` (expo-task-manager) + Notifee.** The task-manager headless task feeds fixes to the same zone machine; the Android foreground service notification is the "Location Locked" persistent notification (`foregroundServiceType: location`). Alarm from background uses a Notifee high-priority channel with full-screen intent, alarm-usage audio, and the existing haptic patterns. Active lock state (center, radius, settings, zone state, session id) is persisted on every transition so the headless task and a restarted process both resume from SQLite. *Alternative rejected*: `Location.startGeofencingAsync` — OS geofencing has ~100 m practical latency/accuracy and no warning-band concept; it may be added later as a battery-saving outer fence, but cannot be the primary engine for 10–50 m radii.
- **Adaptive GPS cadence by distance-to-boundary.** Deep inside the safe zone: Balanced accuracy, ~10 s / 25 m updates; inside the warning band or Outside: BestForNavigation, 1 s / 4 m (same profile the nav loop uses). *Why*: this is the main battery lever; a fixed BestForNavigation watch would blow the battery goal on 500 m+ radii.
- **Alarm controller is its own module** — `lib/lock/alarmController.ts` orchestrating channels: siren/beep via `expo-audio` looped asset on the alarm stream at configured volume, voice via `expo-speech`, vibration via existing `hapticPlayer` patterns, flash + distance readout via a dedicated full-screen alert screen (`app/lock-alert.tsx`, launched by the notification's full-screen intent). Grace timer, repeat cycle, warning pre-alert one-shot, auto-stop-on-return, manual stop, and test mode all live here so UI and background service share one implementation.
- **Persistence in op-sqlite**: `lock_sessions` (start/end, center, radius, aggregates) + `lock_events` (session id, type exit/return/alarm-start/alarm-stop, t, distance). Stats screens are SQL rollups — no separate stats store. Export writes JSON/CSV to a file and hands it to the OS share sheet. *Why op-sqlite over expo-sqlite*: already the app's primary DB path.
- **Map extensions stay inside the existing WebView** — new Leaflet layers driven by the current message bridge: lock circle (`L.circle`, zone-colored), accuracy circle, boundary distance label, and a DOM compass control fed by `expo-sensors` heading; tap posts `resetNorth`. Leaflet cannot rotate the basemap, so "map rotation" v1 = rotating the compass needle + heading-up user marker only. *Alternative rejected for v1*: MapLibre GL native (prebuild, store re-listing) — explicitly deferred to the shared spike.
- **Navigate-back is a thin wrapper** over `startNavigation({ to: lockCenter, costing })`; the lock service listens for the zone machine's `return` event and calls `stopNavigation()`. No routing code changes.
- **Search**: client keeps today's behavior (`lat,lng` parse → `Location.geocodeAsync` → error hint). Optional backend work adds a Photon container to docker-compose and an authenticated `GET /nav/geocode?q=` proxy; the client tries it first when the feature flag is on. This is separable and can ship after v1.

### Pro (v2) decisions

- **GPS diagnostics from what the stack already exposes.** Speed comes from the location fix (with the derived-from-last-fix fallback the nav loop already uses), heading from the existing heading watcher, battery via `lib/family/battery.ts` (`expo-battery` already wrapped there). Satellite count and cellular signal need `LocationManager.registerGnssStatusCallback` / `TelephonyManager` — a custom native module and prebuild churn for cosmetic numbers. **Excluded**; a 4-tier GPS quality label derived from accuracy replaces them honestly.
- **Route options = Valhalla `costing_options`.** `fetchRoute` gains an options param mapped to `{ shortest: true }` and `costing_options.{auto,truck}.{use_tolls: 0, use_highways: 0}` in the `/nav/route` proxy body — no backend change (the proxy forwards the Valhalla request shape). UI: chips on the navigate-back sheet + "Re-route now" that calls the existing reroute path.
- **Modes tune the existing knobs, not new machinery.** Walking/Cycling/Driving/Custom map to a `ZoneConfig` + cadence preset table (warning band, hysteresis floor, tight/relaxed thresholds) fed into the already-parameterized `zoneMachine`/`lockService`; Custom exposes the same three sliders. Mode also pre-selects navigate-back costing.
- **Voice guidance is a thin observer on the nav banner.** A speech module subscribes to the existing `NavBanner` store; when `instruction`/`distanceToManeuver` crosses the announce thresholds it speaks via `expo-speech` (already a dependency). No changes to the tested nav core — it stays a pure listener, and works for both plain Navigate trips and lock navigate-back.
- **Avg accuracy: two additive columns.** `lock_sessions` gains `acc_sum`/`acc_n` bumped per accepted fix (same `bumpAggregates` path); avg accuracy and alarms-triggered (COUNT of `alarm_start` events) come out in the stats SQL. The 7-day trend is a per-day `SUM(distance_traveled)` GROUP BY — rendered as plain Views, no chart library.
- **Settings hub is one screen, four groups.** General (units, mode) / Sound & Vibration (embeds the existing alert settings) / Battery (background toggle + exemption) / About. Units live in `lockSettings` and a shared `fmtDistance`/`fmtSpeed` helper used by every readout.

## Risks / Trade-offs

- [OEM battery killers / Doze stop the background task] → foreground service + battery-optimization exemption prompt at arm time; on resume, the persisted state restores; document per-OEM caveats. The lock is also fully usable foreground-only.
- [10–20 m radii vs. real GPS accuracy] → the arm-time accuracy guard (warn when radius < 2× accuracy) plus gating; we accept that a 10 m lock under ±25 m accuracy is best-effort and say so in the UI.
- [Leaflet: no true map rotation/tilt] → compass shows device heading and resets north; full rotate/tilt arrives with the MapLibre upgrade tracked in family-circle F3. UI copy avoids promising rotation.
- [iOS alarm limits] → iOS cannot override the hardware silent switch for app audio and has no full-screen intent; use critical-sounding notification + max app volume + haptics, and state the limitation in alert settings. Android is the reference alarm experience.
- [Alarm audio asset loudness/licensing] → ship 2–3 CC0 siren/beep assets, normalize loudness, validate on-device.
- [Play Store background-location review] → the declaration is required only when we request `ACCESS_BACKGROUND_LOCATION`; v1 can ship foreground-service-while-in-use first (arming keeps the app "in use" via FGS) and add the background permission in a follow-up release if review risk is a concern.
- [WebView map performance with per-second updates] → throttle bridge messages to state changes + 1 Hz position, same approach the nav map already uses.

## Migration Plan

1. Additive SQLite migration (`lock_sessions`, `lock_events`) — no existing tables touched.
2. Feature is a new entry inside the Navigate mini-app surface; ship behind a flag defaulting off until field-tested on two devices (armed exit → alarm → navigate back → auto-stop).
3. Android manifest: add FGS location type (+ `ACCESS_BACKGROUND_LOCATION` only when the background release is approved); iOS: add "Always" usage string but request only When-In-Use for v1.
4. Rollback = flag off; the migration is inert when unused.

## Open Questions

- Auto-open navigate-back when the alarm fires (blueprint shows alert → navigate as separate steps) or keep it one tap behind the alert? Default: one tap; revisit after field use.
- Whether the optional Photon geocoder ships inside this change or as its own backend change (it is separable; tasks mark it optional).
- Exact repeat-alarm cycle length and siren asset selection — tune on hardware during F5.
