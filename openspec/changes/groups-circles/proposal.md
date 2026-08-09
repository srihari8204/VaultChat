## Why

Family Space solves exactly one relationship: your household. Everything is
keyed to a single Circle, and the Circle is hardcoded to family semantics —
"guardian" roles, family safe zones, a family map. But the same machinery
(presence, geofences, alerts, history, chat, navigation) is what a friends
group, an office team, a riders club, a school bus route or a pet-care rota all
want, with different membership, different permissions and different privacy.

The work to get there is far smaller than it looks, because most of it already
ships. A Circle already **is** a group chat; group chat already has polls,
reactions, replies, read receipts, voice notes and media; safe zones, alerts and
location history landed with the Family Space PR; navigation is a working
Valhalla + haptic engine. What is missing is not the features — it is the
**group as a first-class object**: typed, permissioned, capped, invitable, and
able to own its own resources.

This change generalises Family Space into Groups & Circles: one user, many
private groups, each with independent members, permissions, safe zones, chat,
alerts and shared resources.

## What Changes

- **Groups become typed objects.** `chats` gains `group_type`, `icon`, `color`,
  `description` and `privacy`. Twelve seeded types (Family, Friends, Office,
  Colleagues, Travel, School, College, Sports, Emergency, Neighborhood,
  Business, Custom), each with a default icon, color and permission preset.
- **Role-based permissions.** `chat_members.role` gains `guest`; a permissions
  matrix replaces today's implicit "owner/admin can do anything". Seven
  permissions: invite, remove, manage zones, edit settings, view history, start
  navigation, send announcements.
- **Per-type member caps**, server-configurable. Today nothing is enforced
  anywhere.
- **Invitations become per-invitee.** The existing invite *link* system keeps
  working; a new `chat_invitations` table tracks a specific person through
  Pending → Accepted / Rejected / Expired / Revoked, addressable by username,
  phone, email or QR, shareable over SMS/WhatsApp/email, with resend and revoke.
- **Group dashboard + live group map**, generalised from the Family Space
  dashboard, with marker clustering once a group outgrows a handful of members.
- **Existing per-circle features re-key to `groupId`**: safe zones, alerts,
  location history, member detail, presence privacy.
- **New shared resources per group**: tasks, calendar, album, notes.
- **Group navigation**: shared destination, group trip, follow-the-leader, ETA
  fan-out, deviation and arrival alerts.
- **Group analytics**: activity, distance, attendance, weekly summaries.

## Decisions taken (defaults, pending override)

These were open questions; sensible defaults are assumed so work can start.
Any of them can be reversed cheaply before G1.

1. **Member cap is per-type, not a flat 10.** A flat cap of 10 breaks the very
   examples this change is for — a Cricket Team needs 11 players minimum, and
   Office/College groups routinely exceed 10. Defaults: Family 10, Emergency 10,
   Travel 15, Sports 30, School/College 50, Office/Business 50, others 20. All
   values are server-configurable per type; the client never hardcodes a cap.
2. **Invitations extend, they do not replace.** `migrations/025_invite_links.sql`
   already implements a concurrency-safe redeem (`SELECT … FOR UPDATE`, atomic
   `uses++`), expiry, max-uses, revoke and an approval queue, with deep-link
   handling in `app/join/[code].tsx`. Rebuilding that from scratch would discard
   working atomic logic and reintroduce double-join races. The per-invitee layer
   sits **on top** of it.
3. **"Ghost mode" is renamed to "Invisible".** `lib/ghostProtocol.ts` already
   means duress/decoy-account wipe — a security feature. Reusing that name for
   "hide my location" would be actively dangerous in a codebase where one of the
   two triggers a wipe.
4. **Group calls ship against the existing 1:1 fallback.** Real N-way calling
   needs an SFU + TURN media server that is not provisioned; `app/group-calls.tsx`
   already documents this. The group dashboard gets the call entry point and the
   participant model, and the SFU seam is left explicit. No client work can
   unblock this.

## Capabilities

### New Capabilities
- `groups-core`: typed groups, roles and the permission matrix, member caps,
  group dashboard, live group map with clustering.
- `group-invitations`: per-invitee invitation records, multi-channel addressing
  (username / phone / email / QR / link / code), lifecycle and admin approval.
- `group-resources`: per-group tasks, calendar, album, notes and announcements.
- `group-navigation`: shared destination, group trips, ETA fan-out, deviation
  and arrival alerts.

### Modified Capabilities
- `family-circle`: a Family group becomes one *type* of group rather than the
  only kind. Its requirements are preserved; "Circle" becomes "Group" and
  "guardian" becomes the Family type's label for `admin`.

## Impact

- **Client**: a group-scoped shell replacing the single-circle assumption in
  `app/family.tsx`; re-keying `lib/family/*` stores from `circleId` to `groupId`;
  new screens for tasks, calendar, album, invitations and group trips.
- **Backend**: migrations for group metadata, roles/permissions, member caps,
  invitations and an audit log; endpoints for invitations, tasks, calendar,
  album and trips; socket topics for group trip state. No new plaintext
  location storage — the sealed-ping invariant is unchanged.
- **Storage**: local stores keyed per group; history and alerts already carry a
  circle id and re-key cleanly.
- **Blocked**: group voice/video calling, screen share, raise-hand — all gated
  on SFU + TURN provisioning, which is a deployment task, not a code task.
- **Dependencies**: no new native module. Clustering is implemented over the
  existing Leaflet WebView renderer.
