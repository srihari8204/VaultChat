# Tasks

Phases G0–G3 are the spine and ship in order. G4–G6 are additive and can ship
independently once G3 lands. G7 is blocked on infrastructure, not code.

## G0 — Data model (server)
- [ ] 0.1 Migration: `chats` + `group_type`, `icon`, `color`, `description`, `privacy` (`private|invite_only`); all nullable so existing groups are untouched
- [ ] 0.2 Migration: widen `chat_members.role` CHECK to include `guest`
- [ ] 0.3 Migration: `group_permissions` (per-group overrides) + seeded per-type defaults for the 7 permissions
- [ ] 0.4 Migration: `group_audit_log` (actor, action, target, at) for member/role/settings changes
- [ ] 0.5 Per-type member caps as server config; enforce in the SAME transaction as the member insert so concurrent joins cannot overshoot
- [ ] 0.6 Permission middleware: resolve type default → group override → member grant, once, and re-check on every mutating chat/group endpoint
- [ ] 0.7 Backfill: stamp existing Family Space circles as `group_type='family'`; collapse `guardian` onto `admin`
- [ ] 0.8 `GET /chats/:id` returns group metadata, resolved caps and the caller's resolved permission set

## G1 — Invitations
- [ ] 1.1 Migration: `chat_invitations` (group, inviter, invitee identity, channel, token hash, status, expires_at, responded_at)
- [ ] 1.2 Signed opaque token: HMAC over invitation id + group id + expiry; no PII in the token
- [ ] 1.3 Mint a single-use `invite_links` row bound to each invitation so redeem reuses the existing atomic path
- [ ] 1.4 Status machine: Pending → Accepted | Rejected | Expired | Revoked, with resend (new token, same invitation) and revoke
- [ ] 1.5 Duplicate guard: reject an invite to an existing active member or an already-Pending invitee
- [ ] 1.6 Address an invitee by VaultChat username, phone, or email; QR and bare link stay identity-less
- [ ] 1.7 QR generate (`react-native-qrcode-svg`, already a dependency) + scan via the existing `app/scanner.tsx`
- [ ] 1.8 Share sheet: SMS, WhatsApp, email, copy link, copy code
- [ ] 1.9 Admin approval path when `privacy='invite_only'` — reuse the existing join-request queue
- [ ] 1.10 Invitations screen: pending/sent list with resend, revoke and status
- [ ] 1.11 Fix the real gap in the current flow: an invitee who already has groups had no screen to enter a code (`/family-setup` was reachable only at zero circles)

## G2 — Group shell (client)
- [ ] 2.1 `lib/groups/` — group list, active group, typed metadata, resolved permissions, `can(permission)` helper
- [ ] 2.2 One-shot local migration: rewrite `vc_family_*_<circleId>` keys to group-scoped keys behind a schema version marker (must not silently drop places/history)
- [ ] 2.3 Group switcher + create-group flow (name, type, icon, color, description, privacy)
- [ ] 2.4 Per-type theming: icon and color drive the dashboard, map markers and list rows
- [ ] 2.5 Generalise `app/family.tsx` into a group dashboard: avatar, member count, online count, sharing status, last activity, active trip, announcements, recent alerts
- [ ] 2.6 Quick actions: Chat, Live Map, Navigation, Call, Check-in, SOS — each gated on the caller's permissions
- [ ] 2.7 Retire the single-circle assumption: `listCircles()[0]` fallbacks, the `/family-setup` redirect, hardcoded "guardian" copy

## G3 — Re-key existing features to the group
- [ ] 3.1 Safe zones: per-group, with entry/exit alerts, scheduled activation and temporary zones
- [ ] 3.2 Alerts: add GPS-disabled, connectivity-lost, route-deviation and announcement kinds to `lib/family/alerts.ts`
- [ ] 3.3 Location history + member detail: group-scoped, and respect the viewer's `view history` permission
- [ ] 3.4 Per-member per-group privacy: precise / approximate / hidden, hide battery, hide speed, **Invisible** (NOT "ghost" — that name is taken by `ghostProtocol.ts`), temporary sharing with an expiry
- [ ] 3.5 Enforce approximate sharing at SEAL time (round the coordinate before sealing) so the precise position never leaves the device
- [ ] 3.6 Live group map: avatar, name, battery, online state, activity, speed, ETA per marker
- [ ] 3.7 Marker clustering with smooth expand, clustered client-side before injection into the Leaflet WebView

## G4 — Shared resources
- [ ] 4.1 Tasks: create, assign, due date, complete; carried on the E2EE message spine so offline queue and sync come free
- [ ] 4.2 Task reminders via the existing local-notification scheduler
- [ ] 4.3 Calendar: encrypted event table with date-range queries (a message log cannot serve these), recurring events, reminders
- [ ] 4.4 Album: group-scoped encrypted media index over the existing attachment pipeline; group by trip, event, date, member
- [ ] 4.5 Notes: group-scoped encrypted notes reusing `lib/notesCrypto.ts`
- [ ] 4.6 Announcements: pinned, permission-gated, surfaced on the dashboard and as an alert

## G5 — Group navigation
- [ ] 5.1 Share a destination to the group
- [ ] 5.2 Group trip: start/join/leave, membership and state over a socket topic
- [ ] 5.3 ETA fan-out — each member's ETA computed on-device from their own route and shared as a sealed field
- [ ] 5.4 Follow-the-leader mode
- [ ] 5.5 Deviation alerts, reusing `lib/nav/missedTurn.ts` off-route detection
- [ ] 5.6 Arrival notifications per member
- [ ] 5.7 Active-trip card on the group dashboard

## G6 — Analytics
- [ ] 6.1 Per-member activity and distance from local history (`history.summarize()`)
- [ ] 6.2 Attendance from safe-zone entry/exit events
- [ ] 6.3 Shared trip history
- [ ] 6.4 Weekly summary — computed and rendered ON DEVICE; uploading aggregates would break the server-blind invariant

## G7 — Group calling (BLOCKED — infrastructure, not code)
- [ ] 7.1 Provision SFU + TURN. Nothing below can start until this exists
- [ ] 7.2 N-way voice, then video
- [ ] 7.3 Screen share, raise hand, mute controls, join/leave notifications
- [ ] 7.4 Until 7.1 lands, keep the honest 1:1 fallback in `app/group-calls.tsx` — do not simulate participants

## Cross-cutting
- [ ] X.1 Server-side permission check on EVERY mutating endpoint; client `can()` is UX only
- [ ] X.2 Audit-log entries for member add/remove, role change, settings change, invite revoke
- [ ] X.3 Over-cap groups (after a cap reduction) block new joins but NEVER evict existing members
- [ ] X.4 Self-checks for the pure logic: permission resolution, cap enforcement, invitation state machine, clustering
- [ ] X.5 `tsc --noEmit` and `eslint` clean per phase
