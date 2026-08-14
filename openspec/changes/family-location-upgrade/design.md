# Design — Family Location & Tracking Upgrade

Audit date: 2026-08-14. Four parallel audits (frontend, backend, location/routing
infra, invitations) over the working tree at `retention/ephemeral-bodies-reconciled`.

## 1. The architecture constraint everything else follows from

**The server never sees a coordinate for a person.** Positions travel as sealed
AES-GCM blobs (`lib/liveLocationCrypto.ts`) over Socket.IO
(`live_location_update` → room `chat:<id>`, gated by `liveLocAllowed`), and are
never persisted. Three backend file headers state this as a product decision
(`spaces_devices.go`, `spaces_runs.go` ×2). The only stored coordinates are
**fixed published places** (`run_stops`), never people.

Consequences, documented here per the spec's §33:

| Concern | Where it lives | Why |
|---|---|---|
| Who may receive a member's position | **Server** (socket room membership, `chat_members` check per socket) | Delivery is the confidentiality boundary; the seal key is known to circle members |
| What a position says (lat/lng/speed/battery) | **E2EE blob**, sealed on the publishing device | Zero-knowledge: a DB breach yields nothing |
| Precision / invisibility / hide-speed / hide-battery / sharing-until | **Publishing device**, applied *before* sealing (`lib/groups/privacy.ts`) | The owner of the data enforces their own policy |
| Geofences, saved places | **Device-local** AsyncStorage (`lib/family/store.ts`), coordinates never uploaded | Places reveal home/school addresses |
| Arrival/departure events | Detected on the publishing device, announced as E2EE system messages | Server cannot compute what it cannot read |
| Location history | **Device-local**, encrypted at rest (`lib/family/history.ts`), 31-day retention, never uploaded | Same |
| Membership, invitations, roles, permissions | **Server-authoritative** (membership v2, four-layer permission model) | This is what actually gates location visibility |
| Dashboard member-status counts | **Viewing device**, derived from authorized decrypted presences | The spec's "server-derived" intent is "authoritative, never faked"; under E2EE the authoritative source for *content* is the decrypting client, and the server stays authoritative for *access* |

Anything in the spec that assumes server-side location state (server geofence
computation, server history, server speed validation) is implemented instead at
the edge that can actually read the data, with the server keeping its existing
role: authenticating, authorizing, and relaying.

**Known limitation (pre-existing, documented, not widened):** the presence seal
key is delivered per-circle, so per-member "share with A but not B" within one
circle is precision-only, not cryptographic; and a member removed mid-session
keeps receiving room traffic until their socket disconnects. Both are stated in
`handlers.go` as accepted for this granularity. Removal also revokes membership,
so reconnect re-gates immediately.

## 2. Gap analysis (spec § → verdict)

| Spec § | Feature | Verdict |
|---|---|---|
| 4–8 | Invitations inside VaultChat, search, pending, accept | **EXISTS** (membership v2: candidates search, strict/user/admin approval modes, 7-status state machine, cooldowns, push). Gap: push tap opens `/chat?id=` instead of `/group-invitations` — fix in `lib/push.ts` |
| 9 | Location consent after joining | **PARTIAL** — sharing is already opt-in per device (§39 holds today); add: route the freshly-joined member to the sharing/privacy step |
| 10–11 | Live update after acceptance, live family map | **EXISTS** (`lib/family/presence.ts`, `FamilyMap` with clustering) |
| 12 | Freshness LIVE/RECENT/STALE/UNAVAILABLE | **GAP** — binary 90 s today (`lib/family/types.ts STALE_MS`); add tiers |
| 13 | Member location details | **EXISTS** (`app/family-member.tsx`); extend with freshness + accuracy |
| 14, 31 | Status counts / FAMILY NOW board | **GAP** — derive on-device (pure helper), never fake |
| 15–16 | Saved places, save current location | **EXISTS** (`app/family-places.tsx`); add kind (home/school/office/grandparents/other) |
| 17 | Routing | **EXISTS** (Valhalla + `app/navigate.tsx`). Bug: Go proxy drops `costing_options` |
| 18–19 | Route to member, follow member | **GAP** — member dest + moved-destination + follow mode |
| 20–21 | Daily timeline, day/week/month | **EXISTS** (`app/family-history.tsx`) |
| 22 | Trip summaries | **GAP** — pure segmentation over existing samples |
| 23–24 | Speed tiers, speed alerts | **GAP** — bands + opt-in alert with cooldown, honouring `hideSpeed` |
| 25–28 | School/office/home geofences, safe zones | **EXISTS** (`lib/family/geofence.ts`, hysteresis + schedules + expiry) |
| 29 | Sharing schedule | **PARTIAL** — `sharingUntil` exists; windows deferred (see §Deferred) |
| 30 | Duty status honesty | Covered by the status derivation (status only from real geofence membership) |
| 32–33 | Privacy, E2EE | **EXISTS** — documented above |
| 34–36 | Offline, background, battery | **EXISTS** (`lib/family/background.ts` 60 s/75 m balanced; nav 1 s only while navigating) |
| 37 | Realtime | **EXISTS** (single Socket.IO stack) |
| 38–41 | E2E flow, no auto-track, removal, leave | **EXISTS** (verified in code; removal → 403 → local forget) |
| 42–46 | UI states, map UI, marker, route UI | **EXISTS**; keep three-state loading patterns on anything touched |
| 47–51 | Backend model/authz/validation | **EXISTS** for what the server holds (membership, invitations); no new location endpoints, so no new IDOR surface |
| 52 | No fake data | Enforced by derivation-from-real-presence everywhere; unknown renders as "unavailable" |

## 3. Bugs found by the audit (fixed in this change or listed honestly)

1. **Family→Business identity**: no code path maps `group_type='family'` to
   business icon/theme/layout — verified across catalog, layout, theme,
   dashboard, group-create, server seeds, server create/read, registry
   migration, and on-device (build vc23) across all four space types. The
   decision is now pinned: `usesBusinessTheme()` in the pure module +
   `scripts/check-space-identity.ts`. Residual risk is *data*: a space created
   with the wrong type keeps it forever (there is no retype UI) and its stored
   identity legitimately wins over the family default.
2. **Membership push tap** lands in `/chat?id=` for a group the invitee cannot
   open (`lib/push.ts`).
3. **`POST /nav/route` drops `costing_options`** (`nav.go` decodes only
   From/To/Costing) — avoid-tolls/highways/shortest silently do nothing.
4. **Dead routes** `/family-map`, `/family-sos`, `/family-members` in
   `lib/spaces/layout.ts` FAMILY/GENERIC sections (dormant today; the layout
   self-check's SCREENS list deliberately skipped family/generic).
5. `app/family-add.tsx` still mints a permanent unlimited invite link,
   contradicting the membership-v2 no-links doctrine (left in place this pass —
   removal is a product call; flagged).
6. Socket events `member_approved`/`join_requested` emitted, never subscribed —
   admin's Waiting list refreshes only on focus (cosmetic; deferred).

## 4. Deferred, with reasons

- **Shared places across a family's devices**: places are device-local by
  design. The right sync path that preserves zero-knowledge is sealing places
  as E2EE circle messages (like geofence announcements), not a server table.
  Worth its own change; nothing in this slice depends on it.
- **Sharing schedule windows (§29)**: `sharingUntil` covers the acute case;
  recurring windows extend `lib/groups/privacy.ts` cleanly later.
- **Retype UI for mistyped spaces** (root-cause follow-up from bug 1): needs a
  server PATCH for `group_type` with permission + audit; product call first.
- **RLS enforcement** (`scripts/enable-rls-force.sql` exists, never run) —
  tracked in docs/RLS_ENFORCEMENT.md; handler-level WHERE clauses remain the
  enforcement everywhere this change touches (it adds no new server reads).

## 5. Testing

- Pure logic (freshness tiers, status derivation, trip segmentation, speed
  bands/cooldown) ships with tsx self-checks in the same file, matching
  `lib/family/geofence.ts` style.
- `scripts/check-space-identity.ts` pins the space-identity mapping.
- Device (Honor ELI-NX9, arm64 release APK): invitation flow, live map,
  freshness, places, routing, history, background behaviour — reported
  honestly; anything not physically exercised is NOT TESTED, never PASS.
