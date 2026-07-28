# Tasks

## F1 — Circle foundation (client + relay)
- [ ] 1.1 Circle create/join on top of groups (`type='family'`), roles (member/guardian), invite-link reuse
- [ ] 1.2 `family-setup.tsx` (create/join + consent prompt) and mini-app registry entry (flagged off)
- [ ] 1.3 Membership/roles migration IFF groups schema doesn't cover `type='family'` + per-member role
- [ ] 1.4 Presence publisher: extend `liveLocationCrypto` sealed payload with battery/motion/speed; publish on the existing socket at an adaptive interval; default sharing OFF
- [ ] 1.5 Relay verification: confirm server forwards ciphertext only and writes no plaintext coordinate/log

## F2 — Presence + roster (no map yet)
- [ ] 2.1 Decrypt incoming pings on-device; roster list with last-seen, battery, staleness
- [ ] 2.2 "Location off" state for members who haven't opted in
- [ ] 2.3 Adaptive interval tied to motion state; hard stop when sharing toggled off

## F3 — Map surface
- [ ] 3.1 Spike + pick renderer: MapLibre GL (+ PMTiles/self-host, no-GMS) vs `react-native-maps`
- [ ] 3.2 Add the native dependency; `expo prebuild`; update store listings for the new SDK
- [ ] 3.3 `family.tsx` map: member markers from decrypted pings, freshness dimming, tap→in-app `navigateTo`

## F4 — Geofences (on-device only)
- [ ] 4.1 On-device geofence engine (define/edit/delete places), evaluation never leaves device
- [ ] 4.2 Arrive/leave → E2EE system message into the Circle thread; local guardian notification

## F5 — SOS burst
- [ ] 5.1 Reuse SOS capture; send sealed high-priority ping + critical E2EE system message to guardians
- [ ] 5.2 Guardian tap → in-app navigation to sender (verify no-GMS path)

## F6 — Guardian escalation ladder
- [ ] 6.1 On-device state machine: missed check-in / unanswered call → retry +5min → +15min → Emergency Connect after N misses
- [ ] 6.2 "I'm OK" cancels ladder; every action logged as an E2EE system message (audit)
- [ ] 6.3 Guardian-initiated "request check-in" (v1 scheduling model)

## F7 — Emergency Connect + compliance
- [ ] 7.1 Full-screen critical alert via existing Notifee FGS + native FCM path (kill-safe delivery)
- [ ] 7.2 Android: optional auto-answer video + sealed location burst (confirm UX/OS constraints)
- [ ] 7.3 iOS: repeating critical alarm; graceful degrade when Critical Alerts entitlement absent
- [ ] 7.4 Compliance: Play background-location declaration, `USE_FULL_SCREEN_INTENT`, iOS Critical Alerts entitlement request
- [ ] 7.5 Battery + kill-safety field test; flip the feature flag on after two-device verification
