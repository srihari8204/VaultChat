## Why

Families want a private "where is everyone / is everyone OK" layer without handing their live location to Life360, Google, or any server that can read it. VaultChat already has the hard parts — E2EE live-location (`lib/liveLocationCrypto.ts`), a ciphertext-only socket relay, groups, invite links, and a native full-screen call/foreground-service stack for calls-when-killed. Family Circle assembles these into a Circle: a shared map, geofence alerts, an SOS burst, and a Guardian escalation ladder — all E2EE, server stores nothing readable. It ships as a mini-app so it stays self-contained and optional.

## What Changes

- New **Family Circle** mini-app entry: create/join a Circle (a group with `type='family'`), invite via existing invite links, per-member roles (member / guardian).
- **Live presence**: opt-in encrypted location pings (reuse `liveLocationCrypto` sealed payload; add battery %, motion state, speed). Server relays ciphertext over the existing socket and stores nothing.
- **Circle map**: members rendered from decrypted pings. **BREAKING dependency**: needs an offline-capable map renderer (`react-native-maps` or MapLibre) — a new native module → prebuild + store-listing update.
- **Geofences**: on-device (never server-side) "arrived at / left" places → emitted as E2EE system messages into the Circle thread. No coordinates leave the device except as sealed pings.
- **SOS burst**: reuse the existing SOS capture; send a sealed high-priority ping + system message to all guardians, and deep-link them into in-app navigation to the location (the `navigateTo` seam just added).
- **Guardian escalation ladder**: missed check-in / unanswered call → retry at +5/+15 min → after N misses, **Emergency Connect** (full-screen critical alert via the existing Notifee FGS + native FCM path; Android may auto-answer video + location burst; iOS repeating alarm). "I'm OK" cancels the ladder.
- **Audit log**: every escalation action recorded as an E2EE system message (tamper-evident, readable only inside the Circle).

## Capabilities

### New Capabilities
- `family-circle`: Circle lifecycle (create/join/roles), encrypted presence pings, and the map surface.
- `guardian-escalation`: the missed-check-in → retry → Emergency Connect state machine, SOS burst, and audit log.

### Modified Capabilities
<!-- No existing openspec/specs/* capabilities change their requirements; reuse is at the implementation layer (liveLocationCrypto, socket relay, calls). -->

## Impact

- **Client**: new mini-app screens (`family.tsx` map, `family-setup.tsx`), a presence publisher on the existing socket, on-device geofence engine, escalation state machine. Reuses `liveLocationCrypto`, `navigateTo` (in-app nav), the call UI, and Notifee FGS.
- **Backend**: presence relay is ciphertext pass-through over the existing socket (no new plaintext storage); one migration for Circle membership/roles if not covered by the groups schema; a relay topic for high-priority SOS/escalation events. Server never decrypts.
- **Native / compliance**: new map dependency → prebuild + EAS. Background-location declaration (Play Store), `USE_FULL_SCREEN_INTENT`, and iOS Critical Alerts entitlement (requires Apple approval). These are the long-pole items and gate release.
- **Dependencies**: KEEP existing @noble crypto (no libsignal). New: a map renderer only.
