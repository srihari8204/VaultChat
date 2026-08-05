## 1. Lock core (pure modules + storage)

- [x] 1.1 `lib/lock/zoneMachine.ts`: pure state machine (safe/warning/atLimit/outside) with accuracy gating, 3-fix smoothing, hysteresis, and grace handling; embedded self-checks covering the spec scenarios (walk-out sequence, noisy fix rejected, boundary hover, grace re-entry)
- [x] 1.2 SQLite migration + `lib/lock/lockStore.ts`: `lock_sessions` / `lock_events` tables, active-lock persistence (arm state survives restart), session aggregates writer
- [x] 1.3 `lib/lock/lockService.ts`: orchestration — arm/unlock, foreground GPS watch with adaptive cadence (Balanced deep-inside → BestForNavigation near boundary/outside), feeds zoneMachine, emits transitions, persists on every transition

## 2. Lock setup + active lock UI

- [x] 2.1 `app/location-lock.tsx` setup flow: point selection (current location / search / drop-drag pin on NavMap), radius presets 10–1000 m + custom, animated preview circle, accuracy warning (radius < 2× accuracy), confirm-to-arm
- [x] 2.2 Active-lock surface: status card (zone state, live distance, radius, GPS accuracy, time locked), Unlock and Navigate buttons, persistent "Location Locked" notification
- [x] 2.3 NavMap WebView extensions: lock circle overlay with zone-colored fill, GPS accuracy circle, distance-to-boundary label, message-bridge throttling (state changes + 1 Hz position)
- [x] 2.4 Compass control: DOM compass in NavMap fed by expo-sensors heading — rotates with heading, tap resets north, hidden when north-up (also active during navigate-back)
- [x] 2.5 Navigate mini-app entry point + feature flag (LOCATION_LOCK in constants/flags.ts — ON for development; flip OFF for store builds until 6.3 passes)

## 3. Alarm stack

- [x] 3.1 `lib/lock/alarmController.ts`: channel orchestration (grace timer, warning pre-alert one-shot, repeat cycle, auto-stop-on-return, manual stop, test mode); self-checks for grace/repeat/stop logic
- [x] 3.2 Channels: siren/beep via expo-av looped CC0 assets (generated `lock_siren.wav`/`lock_beep.wav`) at configured volume; voice via expo-speech; vibration via looped RN Vibration patterns; expo-speech dep added
- [x] 3.3 Alert settings screen: per-channel toggles, volume, tone + vibration pattern pickers, grace time (0–60 s), repeat-until-return, Test Alarm; settings persist
- [x] 3.4 `app/lock-alert.tsx` full-screen alert: red flash, "You have left the locked area", live distance, Stop Alarm + Navigate buttons; opened from the high-priority notification
- [x] 3.5 Return handling: auto-stop all channels on re-entry, green "back inside the safe zone" confirmation, exit/return/alarm events recorded

## 4. Background monitoring

- [x] 4.1 expo-task-manager background location task feeding the same zoneMachine (via shared `lockEngine`); expo-location FGS notification as the persistent lock notification; permissions already declared (family work); battery-optimization exemption prompt at arm time
- [x] 4.2 Background alarm delivery: notifee `lock-alarm` channel (alarm sound in res/raw, loopSound) + full-screen intent → `lock-alert.tsx`; "Stop alarm" action handled killed via callBackground dispatcher — device verification pending (6.3)
- [x] 4.3 Restore path: relaunch after process death resumes the armed lock from lockStore without user action (restoreLock, incl. resuming a live alarm); degrades gracefully (foreground-only + clear warning + upgrade banner) when background permission is missing
- [x] 4.4 iOS: When-In-Use v1 behavior, "Always" usage string present (app.json), silent-switch limitation documented in alert settings

## 5. Navigate back + history

- [x] 5.1 Navigate-back wrapper: one tap from Outside alert/active card → `startNavigation({to: lockCenter, costing})` with walk/cycle/drive choice; zone `return` event auto-calls `stopNavigation()`
- [x] 5.2 History screen: sessions newest-first with filters (all/exits/returns/alarms), session detail with event timeline
- [x] 5.3 Statistics screen: today / 7-day / 30-day SQL rollups (locks, exits, time outside, distance, avg speed, time protected)
- [x] 5.4 Export (JSON/CSV via share sheet) + delete session / delete all

## 6. Hardening + release gates

- [x] 6.1 Privacy audit: armed monitoring produces zero coordinate-bearing network calls (only `/nav/route` on navigate-back); history screens fully offline — verified by grep over lib/lock + lock screens (device geocoder used for search until the optional Photon proxy lands)
- [ ] 6.2 Battery pass: measure drain with 30 m and 500 m locks; tune adaptive cadence toward the <5%/h goal *(requires physical device)*
- [ ] 6.3 Two-device field test: arm → walk out → grace → alarm (background + screen locked) → navigate back → auto-stop → history correct; then keep the feature flag on for release *(requires physical devices)*
- [x] 6.4 Play compliance decision: v1 runs while-in-use + FGS by default and only requests `ACCESS_BACKGROUND_LOCATION` (already declared for Family Space) when the user opts into kill-safe mode; documented in constants/flags.ts + design.md

## 7. Optional — self-hosted geocoding (separable)

- [x] 7.1 `GET /nav/geocode` backend proxy — landed on hetzner-deploy (`3c04a23 feat(nav): address search that works`), merged into this branch
- [x] 7.2 Client search uses the proxy first with type-ahead suggestions, platform geocoder / `lat,lng` fallback (same commit; lock setup search wired the same way)

## 8. Pro — GPS diagnostics + map controls

- [x] 8.1 Status card extras: speed (fix + derived fallback), heading readout, battery (reuse `lib/family/battery.ts`), 4-tier GPS quality label (Excellent/Good/Fair/Poor); wired into `lockService` view + active card
- [x] 8.2 Units support: metric/imperial in `lockSettings` + shared `lib/lock/format.ts` (`fmtDistance`/`fmtSpeed`/`fmtHeading`, self-checked) applied to status card, alert screen, history, statistics
- [x] 8.3 NavMap zoom in/out buttons (Leaflet `setZoom` via the bridge) next to the existing re-center + compass controls

## 9. Pro — modes + route options

- [x] 9.1 Mode presets (Walking/Cycling/Driving/Custom): `MODE_CONFIGS`/`MODE_COSTING` in zoneMachine (self-checked), threaded via `ActiveLock.zone`; Custom exposes warning band + hysteresis in settings; mode picker in setup + settings; persists and applies live
- [x] 9.2 `fetchRoute` route options: `{ shortest, avoidTolls, avoidHighways }` → Valhalla `costing_options` via pure `buildRouteRequest` (self-checked; pedestrian ignores toll/highway avoidance)
- [x] 9.3 Route options chips (Fastest/Shortest, Avoid tolls/highways) in Navigate with live re-route on change, "Re-route now" button in the active sheet (`forceReroute`); mode pre-selects navigate-back costing

## 10. Pro — voice guidance

- [x] 10.1 `lib/nav/voiceGuide.ts`: pure announcement core (far cue → now cue → arrival, reroute once per episode; self-checked) + expo-speech playback, fed from the nav banner publish
- [x] 10.2 Voice modes (Voice+banner+vibration / Voice+vibration / Voice+banner) in the Navigate guidance picker; lock navigate-back follows the lock's voice alert setting

## 11. Pro — richer statistics

- [x] 11.1 Additive columns `acc_sum`/`acc_n` on `lock_sessions` (with ALTER migration for existing installs) bumped per accepted fix; alarms-triggered from `alarm_start` event count
- [x] 11.2 Stats screen: alarms count, avg GPS accuracy, avg lock duration, avg radius + 7-day distance-per-day bar trend (plain Views, no chart lib)

## 12. Pro — settings hub

- [x] 12.1 Extended `app/lock-settings.tsx` into the hub: General (units, mode + custom sensitivity) / Sound & Vibration (existing alert settings) / Battery (background toggle + optimization exemption) / About (privacy summary)
- [x] 12.2 Background-tracking toggle wires to `enableKillSafe`/`disableKillSafe` with the foreground-only status-notification path
- [x] 12.3 ~~Family Space tile~~ REVERTED per user direction — Location Lock lives in the Navigate mini-app ONLY and Family Space screens are untouched; saved places remain available in lock setup as the "Saved location" lock type (read-only, labeled "Saved places")

## 13. v2.1 polish (Location Lock Pro final plan)

- [x] 13.1 Map: Leaflet scale bar (metric/imperial follows units), free-explore pause with auto-recenter after 10 s idle
- [x] 13.2 GPS intelligence: confidence % (`gpsConfidence`, self-checked), "GPS updated Ns ago" readout, indoor/degraded detection on raw fixes with spoken "weak GPS" + "GPS signal recovered" alerts
- [x] 13.3 Boundary prediction: "X remaining to the boundary" banner in warning/at-limit states
- [x] 13.4 Navigation: overall route progress bar in the active sheet (banner `totalM`)
- [x] 13.5 Alarm controls: separate Test voice and Test vibration in settings
- [x] 13.6 History: optional per-session notes (additive `notes` column, inline editor, shown on cards)
- [x] 13.7 Battery: stationary detection relaxes cadence; tracking-frequency setting (Adaptive / Battery saver / High precision)
- [x] 13.8 Reliability: GPS-services-off detected at arm with clear recovery guidance
- [x] 13.9 Accessibility pass: roles + labels on primary lock controls
- [ ] 13.10 Map rotation / 3D tilt / camera modes beyond follow+explore+overview — deferred to the MapLibre upgrade (user: "if we want we will update maplibre")
- [ ] 13.11 Language setting, screen-reader field audit, device matrix — app-level / physical-device work

## 14. One engine, two experiences — family-aware extensions (no Family core changes)

- [x] 14.1 Engine stays generic: `classifyDistance` pure shared classifier (self-checked), `onLockEvent` observer hook, `armLock` place tagging (`place_name` additive column), `statsForPlace` rollup — zero family knowledge in lib/lock/*
- [x] 14.2 `lib/family/lockBridge.ts`: the ONLY family↔engine glue — arming a Family Place runs the shared engine and translates engine events into the existing family alerts feed ("left Home", "returned to Home", ALARM); radius clamped to the engine's 10 m–1 km with user-visible note
- [x] 14.3 Family Places extensions (existing screen, existing workflows kept): Navigate + Lock here/Unlock actions in the edit sheet, live zone-colored LOCKED chip on the place row, per-place lock visits from shared history
- [x] 14.4 Member profile extensions: per-place zone chips (INSIDE/NEAR EDGE/AT LIMIT/OUTSIDE) via the shared classifier on the member's last sealed ping, speed/updated/battery diagnostics line via shared formatters
- [x] 14.5 Do-not-modify honored: family dashboard, groups, invites, chat, live location, and settings untouched; no duplicate GPS/geofence/alarm/nav/history services (one engine instance app-wide)
- [ ] 14.6 Shared lock DISTRIBUTION (owner pushes a place lock to members' devices with per-member permissions) — requires cross-device place sync over E2EE system messages; tracked with the `family-circle` change (F4), not duplicated here
- [x] 14.7 Family statistics from presence tracks: pure `timeAtPlace` (visits, time inside with ping-gap guard, first arrival; self-checked) shown per Safe Zone on the member profile ("2h 10m today, arrived 8:15 AM")
- [x] 14.8 Member GPS quality: optional `acc` field threaded through the sealed FamilyPing → presence → TrackSample chain (backward compatible — old pings simply lack it); quality chip (±m + tier) on the member diagnostics row
- [x] 14.9 Quick wins: live ETA + km-aware remaining distance in the navigation sheet; CSV export gains avg_accuracy/place/notes columns (quoted-safe)
