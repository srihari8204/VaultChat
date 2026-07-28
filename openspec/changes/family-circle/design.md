## Context

Family Circle is built entirely on primitives that already ship in VaultChat, so the design is mostly *assembly + one new native dependency*, not new cryptography or backend trust. Reused as-is:

- `lib/liveLocationCrypto.ts` — seals location payloads; the server already relays these as ciphertext.
- Groups + invite links — a Circle is a group with `type='family'`.
- The socket relay — ciphertext pass-through; no plaintext storage.
- The native call + Notifee foreground-service + FCM path (from calls-when-killed) — reused for Emergency Connect full-screen alerts.
- E2EE system messages — used for geofence events and the audit log.
- `lib/nav/openNavigation.ts` `navigateTo()` — guardians tap an SOS to route in-app (works on no-GMS).

## Goals / Non-Goals

**Goals:** private (server-blind) family presence, geofence alerts, SOS, and a guardian escalation ladder with Emergency Connect — shipped as a self-contained mini-app.

**Non-Goals (v1):** cross-family/public sharing, driving-behavior analytics, history/timeline playback, web client, place-based automations beyond arrive/leave.

## Decisions

- **Presence = sealed pings only.** No new plaintext location endpoint. Payload extends the existing sealed shape with `battery`, `motion`, `speed`. Server relays, never decrypts. This keeps the untrusted-server invariant intact.
- **Geofences are on-device.** Definitions and crossing evaluation never leave the device; only the *result* is posted as an E2EE system message. This avoids the server learning place semantics.
- **Escalation state machine lives on-device** with server help only to *deliver* high-priority events (SOS/Emergency Connect) via the existing FCM/FGS topic. The ladder's timers, "I'm OK" cancel, and audit entries are client-driven and logged as E2EE system messages.
- **Map renderer.** Introduce ONE new native dependency (`react-native-maps` or MapLibre GL). MapLibre + self-hosted/PMTiles tiles is the $0, no-GMS-friendly path and aligns with the existing Valhalla self-hosting; `react-native-maps` is faster to integrate but pulls Google Maps on Android. Pick during F3; either way it forces a prebuild + store-listing update.
- **Keep @noble crypto.** No libsignal migration (standing project constraint).

## Risks / Trade-offs

- **Store compliance is the long pole**, not code: Play background-location declaration, `USE_FULL_SCREEN_INTENT`, and especially the **iOS Critical Alerts entitlement** (needs Apple approval). Emergency Connect must degrade gracefully when an entitlement is absent (fall back to max-priority notification + record unavailability).
- **Battery**: continuous location + geofencing drains battery. Mitigate with adaptive ping intervals tied to motion state and a hard "sharing off" default.
- **Escalation correctness**: timers must survive app-kill for the *delivery* leg — that leans on the already-proven native FCM path; the on-device timer half only needs to run while the at-risk member's app can, with server-side high-priority push as the kill-safe backstop.

## Migration Plan

- One migration for Circle membership/roles only if the groups schema doesn't already cover `type='family'` + per-member role. No plaintext location columns — ever.
- Feature-flag the mini-app entry; ship dark (flag off) until the map dependency prebuild + compliance items land.

## Open Questions

- MapLibre vs `react-native-maps` final pick (resolve in F3 with a spike).
- Android auto-answer-video on Emergency Connect: confirm it's acceptable UX + within OS constraints, or make it tap-to-answer.
- Check-in scheduling model: fixed schedule vs. one-tap "request check-in" from a guardian (v1 may ship only the guardian-initiated request).
