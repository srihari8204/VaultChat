# Tasks

Phases G0–G3 are the spine and ship in order. G4–G6 are additive and can ship
independently once G3 lands. G7 is blocked on infrastructure, not code.

Status reconciled by re-reading the code, not by memory. Marks mean:

- `[x]` built and verified
- `[~]` built, but NOT as written here — the deviation is stated
- `[-]` deliberately dropped; superseded by the membership v2 change
- `[ ]` still outstanding

**Membership v2 changed the shape of G1 after it was written.** Invitations are
now fully in-app: no links, no QR, no SMS, no WhatsApp. Several G1 tasks
describe a design that was deliberately removed, so they are marked `[-]` rather
than left looking unfinished — a dropped task and a forgotten one are not the
same thing, and this file is the only place that distinction survives.

## G0 — Data model (server)
- [x] 0.1 Migration: `chats` + `group_type`, `icon`, `color`, `description`, `privacy` (`private|invite_only`); all nullable so existing groups are untouched — migration 070
- [x] 0.2 Migration: widen `chat_members.role` CHECK to include `guest` — 066; `moderator` added in 069
- [~] 0.3 Migration: `group_permissions` (per-group overrides) + seeded per-type defaults — no separate table. Overrides live in `chats.permission_overrides` and defaults in `group_type_config.default_permissions`, both JSONB, so the three layers are read in ONE join rather than three. Now 10 permissions, not 7 (069 added tasks/calendar/album)
- [x] 0.4 Migration: `group_audit_log` — 066
- [x] 0.5 Per-type member caps enforced in the SAME transaction as the member insert — trigger in 066, `FOR NO KEY UPDATE` on the chat row. A plain COUNT was raced in testing and let a 4th member into a cap-3 group
- [x] 0.6 Permission middleware — `internal/groups.Resolve`, one enforcement point (`chatsRequirePerm`)
- [x] 0.7 Backfill: existing circles stamped `group_type='family'`; `guardian` collapsed onto `admin`
- [x] 0.8 `GET /chats/:id` returns group metadata, caps and the caller's resolved permissions — plus `approvalMode` since 069

## G1 — Invitations
- [x] 1.1 Migration: `chat_invitations` — 067, revised by 069/070
- [~] 1.2 Signed opaque token, HMAC over invitation id + group id + expiry — built and still verifies LEGACY tokens, but nothing mints one. `token_hash` became nullable in 070
- [-] 1.3 Mint a single-use `invite_links` row bound to each invitation — dropped. The bound link was the forwardable credential membership v2 exists to remove
- [x] 1.4 Status machine — extended past the original: `joined` and `cancelled` added, and `accepted` is no longer terminal. Accepting is consent; approving is admission
- [x] 1.5 Duplicate guard — partial unique index, and since 069 it covers `accepted` as well as `pending`
- [~] 1.6 Address an invitee by username, phone or email — the three handles work, but a handle that resolves to nobody is now REFUSED rather than stored as an off-platform invite. "QR and bare link stay identity-less" no longer applies: there are none
- [-] 1.7 QR generate + scan — dropped
- [-] 1.8 Share sheet: SMS, WhatsApp, email, copy link, copy code — dropped, all five
- [~] 1.9 Admin approval path — built as three `approval_mode` values (069) rather than keyed off `privacy`. `chat_join_requests` is untouched and still serves legacy link joins; membership v2 requests live in `chat_invitations`
- [x] 1.10 Invitations screen with status, resend and revoke — `app/group-invites.tsx`, plus a pending-approval queue the original design had no need for
- [x] 1.11 Fix the real gap: an invitee with existing groups had no screen to accept on — `app/group-invitations.tsx`

## G2 — Group shell (client)
- [x] 2.1 `lib/groups/` — list, active group, typed metadata, resolved permissions, `can()`
- [~] 2.2 One-shot local migration of `vc_family_*_<circleId>` keys — reads through to the legacy keys instead of rewriting them, and deliberately does NOT delete them. A destructive rewrite cannot survive a rollback; this can
- [x] 2.3 Group switcher + create-group flow — `app/group-create.tsx`
- [x] 2.4 Per-type theming across dashboard, markers and rows
- [x] 2.5 `app/family.tsx` generalised into a group dashboard
- [x] 2.6 Quick actions gated on the caller's permissions
- [x] 2.7 Single-circle assumption retired

## G3 — Re-key existing features to the group
- [x] 3.1 Safe zones: per-group, entry/exit alerts, scheduled activation, temporary zones
- [x] 3.2 Alerts: GPS-disabled, connectivity-lost, route-deviation, announcement
- [x] 3.3 Location history + member detail, gated on `view_history`
- [x] 3.4 Per-member per-group privacy: precise / approximate / hidden, hide battery, hide speed, Invisible, temporary sharing
- [x] 3.5 Approximate sharing enforced at SEAL time — grid-snapped before sealing, so the precise position never leaves the device. Snapping, not jitter: jitter averages back to the true point over repeated pings
- [x] 3.6 Live group map with per-marker detail
- [x] 3.7 Marker clustering, client-side before injection into the WebView — grid clustering, which is order-independent

## G4 — Shared resources
- [x] 4.1 Tasks on the E2EE message spine
- [x] 4.2 Task reminders via the local-notification scheduler — a RECONCILER, not schedule-on-save: the task list is a fold, so a due date moved on another device arrives as a rebuild rather than a tap. Idempotent, so it is safe on every screen focus
- [x] 4.3 Calendar: encrypted event table, date-range queries, recurrence, reminders — 068
- [x] 4.4 Album: group-scoped encrypted media index
- [x] 4.5 Notes — group encryption, NOT `lib/notesCrypto.ts` as written: that key is device-local, so "shared" notes would have been unreadable by everyone else in the group
- [x] 4.6 Announcements: pinned, permission-gated on the SERVER, surfaced on the dashboard

## G5 — Group navigation
**These four were marked done on a previous pass and were not.** The client had
emitted `trip_update` since G5 shipped and NEITHER socket server listened for
it — Socket.IO drops unknown events silently, so every ping went into a void and
no member ever saw another member's ETA. The earlier pass checked that the
client code existed and never checked that anything received it. Relay added to
both Node and Go, sharing live location's membership check.

- [x] 5.1 Share a destination to the group
- [x] 5.2 Group trip: start/join/leave over a socket topic — the relay now exists
- [x] 5.3 ETA fan-out, computed on-device and shared as a sealed field — reached nobody until the relay landed
- [x] 5.4 Follow-the-leader mode — the leader broadcasts a bounded, sampled route on its ping; followers adopt it and measure deviation against the agreed road. Opt-in at trip start: silently making the starter the leader would quietly redefine "off-route" for everyone
- [x] 5.5 Deviation alerts reusing the off-route detection
- [x] 5.6 Arrival notifications per member
- [x] 5.7 Active-trip card on the group dashboard

## G6 — Analytics
- [x] 6.1 Per-member activity and distance from local history
- [x] 6.2 Attendance from safe-zone entry/exit events
- [x] 6.3 Shared trip history — derived, not stored: a fold over the group thread's own trip announcements plus the local alert inbox. Attribution is by `tripId` on the alert, never by parsing its text, which is rendered for humans and changes with the copy
- [x] 6.4 Weekly summary computed and rendered ON DEVICE; nothing is uploaded, not even a total

## G7 — Group calling (BLOCKED — infrastructure, not code)
- [ ] 7.1 Provision SFU + TURN. Nothing below can start until this exists
- [ ] 7.2 N-way voice, then video
- [ ] 7.3 Screen share, raise hand, mute controls, join/leave notifications
- [x] 7.4 Until 7.1 lands, keep the honest 1:1 fallback in `app/group-calls.tsx` — no simulated participants

## Cross-cutting
- [x] X.1 Server-side permission check on EVERY mutating endpoint; client `can()` is UX only
- [x] X.2 Audit-log entries for member add/remove, role change, settings change, invite revoke — plus approve/reject/cancel and ownership transfer
- [x] X.3 Over-cap groups block new joins but never evict existing members — `SeatsRemaining` clamps at 0, never negative
- [x] X.4 Self-checks for the pure logic — permissions, caps, invitation states, clustering, calendar recurrence, analytics, tasks, notes, trips
- [x] X.5 `tsc --noEmit` and `eslint` clean per phase

## Membership v2 (added after the original plan)
- [x] M.1 Three-step flow with three approval modes; `accepted` and `joined` are different things
- [x] M.2 Moderator role between admin and member
- [x] M.3 In-app candidate search — exact handle, or name among people you already share a chat with. Deliberately not a user directory
- [x] M.4 Pending-approval queue for owners; invitation inbox for invitees
- [x] M.5 Ownership transfer behind its own door, not as a role edit
- [x] M.6 Removal cooldown, window configurable per group type
- [x] M.7 Removal gated on RANK as well as the permission — moderators hold `remove_members`, so the permission alone let one remove the owner
- [x] M.8 Membership notifications routed by audience, with push for the three events the recipient cannot otherwise discover
- [x] M.9 Group discovery as a `group_ref` card: a pointer that grants nothing, never a link
- [x] M.10 Exhaustive Go↔TypeScript permission-mirror check — the drift it catches is silent, so matching test tables prove nothing

## Known outstanding
Beyond the unticked boxes above:

- **Nothing has run on a device.** Every claim here is from tests, self-checks
  and queries verified against a real Postgres 16 — not from the app running.
  The missing trip relay is what that limitation looks like in practice: the
  client code was right, the server had no listener, and nothing short of two
  devices in a room would have shown it.
- **Migrations 066–071 need renumbering (+1 each)** once the `vc_redeem_invite`
  hotfix merges ahead of them.
- **`/internal/notify` push path is unexercised** — syntax-checked only; it
  needs a real Expo token to prove out.
- **`feature_access` (069) is unused.** The column exists and nothing reads it.
