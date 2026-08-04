## 1. Lock core (pure modules + storage)

- [ ] 1.1 `lib/lock/zoneMachine.ts`: pure state machine (safe/warning/atLimit/outside) with accuracy gating, 3-fix smoothing, hysteresis, and grace handling; embedded self-checks covering the spec scenarios (walk-out sequence, noisy fix rejected, boundary hover, grace re-entry)
- [ ] 1.2 SQLite migration + `lib/lock/lockStore.ts`: `lock_sessions` / `lock_events` tables, active-lock persistence (arm state survives restart), session aggregates writer
- [ ] 1.3 `lib/lock/lockService.ts`: orchestration — arm/unlock, foreground GPS watch with adaptive cadence (Balanced deep-inside → BestForNavigation near boundary/outside), feeds zoneMachine, emits transitions, persists on every transition

## 2. Lock setup + active lock UI

- [ ] 2.1 `app/location-lock.tsx` setup flow: point selection (current location / search / drop-drag pin on NavMap), radius presets 10–1000 m + custom, animated preview circle, accuracy warning (radius < 2× accuracy), confirm-to-arm
- [ ] 2.2 Active-lock surface: status card (zone state, live distance, radius, GPS accuracy, time locked), Unlock and Navigate buttons, persistent "Location Locked" notification
- [ ] 2.3 NavMap WebView extensions: lock circle overlay with zone-colored fill, GPS accuracy circle, distance-to-boundary label, message-bridge throttling (state changes + 1 Hz position)
- [ ] 2.4 Compass control: DOM compass in NavMap fed by expo-sensors heading — rotates with heading, tap resets north, hidden when north-up (also active during navigate-back)
- [ ] 2.5 Navigate mini-app entry point + feature flag (ship dark until 6.3 field test passes)

## 3. Alarm stack

- [ ] 3.1 `lib/lock/alarmController.ts`: channel orchestration (grace timer, warning pre-alert one-shot, repeat cycle, auto-stop-on-return, manual stop, test mode); self-checks for grace/repeat/stop logic
- [ ] 3.2 Channels: siren/beep via expo-audio looped CC0 assets on alarm stream at configured volume; voice via expo-speech; vibration via existing hapticPlayer patterns; add expo-audio + expo-speech deps
- [ ] 3.3 Alert settings screen: per-channel toggles, volume, tone + vibration pattern pickers, grace time (0–60 s), repeat-until-return, Test Alarm; settings persist
- [ ] 3.4 `app/lock-alert.tsx` full-screen alert: red flash, "You have left the locked area", live distance, Stop Alarm + Navigate buttons; opened from the high-priority notification
- [ ] 3.5 Return handling: auto-stop all channels on re-entry, green "back inside the safe zone" confirmation, exit/return/alarm events recorded

## 4. Background monitoring

- [ ] 4.1 expo-task-manager background location task feeding the same zoneMachine; Notifee FGS notification as the persistent lock notification (`foregroundServiceType: location`); Android manifest + battery-optimization exemption prompt at arm time
- [ ] 4.2 Background alarm delivery: Notifee high-priority channel + full-screen intent → `lock-alert.tsx`; verify sound/vibration fire with screen locked
- [ ] 4.3 Restore path: relaunch after process death resumes the armed lock from lockStore without user action; degrade gracefully (foreground-only + clear warning) when background permission is missing
- [ ] 4.4 iOS: When-In-Use v1 behavior, "Always" usage string, critical-sounding notification fallback; document silent-switch limitation in alert settings

## 5. Navigate back + history

- [ ] 5.1 Navigate-back wrapper: one tap from Outside alert/active card → `startNavigation({to: lockCenter, costing})` with walk/cycle/drive choice; zone `return` event auto-calls `stopNavigation()`
- [ ] 5.2 History screen: sessions newest-first with filters (all/exits/returns/alarms), session detail with event timeline
- [ ] 5.3 Statistics screen: today / 7-day / 30-day SQL rollups (locks, exits, time outside, distance, avg speed, time protected)
- [ ] 5.4 Export (JSON/CSV via share sheet) + delete session / delete all

## 6. Hardening + release gates

- [ ] 6.1 Privacy audit: armed monitoring produces zero coordinate-bearing network calls (only `/nav/route` on navigate-back); history screens fully offline
- [ ] 6.2 Battery pass: measure drain with 30 m and 500 m locks; tune adaptive cadence toward the <5%/h goal
- [ ] 6.3 Two-device field test: arm → walk out → grace → alarm (background + screen locked) → navigate back → auto-stop → history correct; then flip the feature flag on
- [ ] 6.4 Play compliance decision: ship v1 as while-in-use + FGS; file background-location declaration only if/when `ACCESS_BACKGROUND_LOCATION` is added

## 7. Optional — self-hosted geocoding (separable)

- [ ] 7.1 Photon container in docker-compose + authenticated `GET /nav/geocode` backend proxy (rate-limited, no query logging)
- [ ] 7.2 Client search tries the proxy when flagged on; falls back to `lat,lng` parse / device geocoder as today
