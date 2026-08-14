# Family Location & Tracking Upgrade

## Why

The Family space concept (complete location + tracking + routing + invitation) was specified end-to-end. The 2026-08-14 audit found most of it already shipped: membership v2 invitations, E2EE live presence, the Leaflet family map with clustering, on-device geofences with hysteresis and schedules, day/week/month history, and Valhalla routing. What remains is a set of additive gaps — freshness tiers, derived member statuses, speed alerts, trip summaries, route-to-member, a post-join consent step — plus a handful of real bugs the audit surfaced.

## What Changes (all additive)

- **Invitation polish**: membership push taps route to the invitations screen (today they open the chat of a group the invitee is not in); after Join, the new member lands on the location-sharing consent step instead of silently defaulting.
- **Freshness tiers**: LIVE / RECENT / STALE / UNAVAILABLE replaces the binary 90-second stale flag, on the map, member rows and member details. Never "LIVE" without a fresh ping.
- **Family status board**: At Home / At School / At Office / Traveling / Location unavailable, derived **on the viewing device** from decrypted authorized presences × the viewer's saved places. No fake counts; "loading" and "unknown" stay distinct states.
- **Place kinds**: Home / School / Office / Grandparents / Other formalized on the existing Places model; arrival/departure events keep feeding the existing timeline.
- **Speed tiers + alerts**: stationary/normal/high/very-high bands; opt-in high-speed alert with threshold and cooldown, honouring the existing `hideSpeed` privacy setting.
- **Trip summaries**: segment the existing on-device history into trips (start, destination, distance, duration, avg/max speed, stops) with a trip detail view.
- **Route to member / follow member**: in-app Valhalla routing to a member's current position, "destination moved" handling, and a follow mode on the family map.
- **Bug fixes**: Go routing proxy drops `costing_options` (avoid-tolls/highways silently no-ops); `lib/spaces/layout.ts` FAMILY/GENERIC sections route to three screens that do not exist; space-type identity regression test added (`scripts/check-space-identity.ts`).

## Non-Goals

- No server-side location storage, in any form. See design.md — this is a documented product decision, restated in three backend file headers.
- No second map, geofence, invitation, navigation or permission system.
- No change to Business/School space behaviour.

## Impact

- **Client**: `lib/family/*` (presence, geofence, history, alerts, types), `lib/groups/privacy.ts`, `lib/push.ts`, `app/family*.tsx`, `app/navigate.tsx`, `components/family/FamilyMap.tsx`. All pure logic lands in tsx-runnable self-checked modules.
- **Backend (Go)**: `internal/routes/nav.go` (forward `costing_options`). Nothing else — every location feature stays inside the zero-knowledge relay.
- **DB**: no migrations required for this slice. Shared-places sync across a family's devices is deliberately deferred (see design.md §Deferred).
