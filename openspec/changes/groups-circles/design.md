## Context

Groups & Circles is a **generalisation**, not a greenfield module. Almost every
subsystem it needs already ships; the work is making the group a first-class
object and re-pointing existing per-circle code at it. What is reused as-is:

- **Groups + membership** — `chats` / `chat_members` (`migrations/002_chats.sql`)
  already model a group with roles `owner|admin|member`, soft-leave via
  `left_at`, a per-member read pointer and mute.
- **Invite links** — `migrations/025_invite_links.sql` has a concurrency-safe
  redeem function, expiry, max-uses, revoke, and a join-request approval queue;
  `app/join/[code].tsx` handles the deep link.
- **Group chat** — `lib/chatService.ts` (~1,500 lines) already covers text,
  media, voice notes, polls (`createPoll`), reactions, replies, read receipts
  (`markRead`) and in-chat search.
- **Presence + geofences + alerts + history** — `lib/family/*`, shipped in the
  Family Space change. All of it is already keyed by a circle id, which is the
  chat id, which is the group id. The re-key is largely a rename.
- **Navigation** — `lib/nav/*`: real Valhalla routing, haptic Direction Lock,
  missed-turn detection, `navigateTo()`.
- **Map** — `components/family/FamilyMap.tsx`, a bundled-Leaflet WebView that
  renders on no-GMS devices and now supports a path overlay.

The honest scope is therefore: **one migration wave, one shell generalisation,
four genuinely new resource surfaces, and one blocked capability.**

## Goals / Non-Goals

**Goals:** many private groups per user; typed groups with distinct identity and
defaults; real role-based permissions; a working per-invitee invitation
lifecycle; per-group safe zones, alerts, history and shared resources; group
navigation.

**Non-Goals (v1):** public or discoverable groups; cross-group federation;
web client; N-way calling (blocked on infrastructure); nested groups or
sub-teams; billing/seat management.

## Decisions

- **A group IS a chat.** We do not introduce a parallel `groups` table. The
  Family Space change already established `circleId === chatId`, and every
  reusable subsystem (messages, members, invites, calls, search) is keyed on
  `chat_id`. A second identity space would force a join on every one of those
  paths and split the permission model. Group metadata becomes columns on
  `chats`; group-ness is `type='group'` plus a non-null `group_type`.

- **Permissions are a matrix, not a role ladder.** Today "admin can do
  anything" is implicit and scattered across call sites. We add an explicit
  `permission` set resolved as: *type default* → *group override* → *per-member
  grant*. The client resolves once and exposes `can(permission)`; the server
  re-checks on every mutating endpoint. Client checks are UX, never security.

- **Member caps live on the server, per type.** The client reads the cap from
  the group payload and never hardcodes a number, so raising the Sports cap is a
  config change and not a release. Enforced in the same transaction as the
  member insert, so concurrent joins cannot overshoot.

- **Invitations layer over links, they do not replace them.** A `chat_invitations`
  row is the *person*; an `invite_links` row is the *door*. A per-invitee invite
  mints a single-use link bound to that invitation, so redeem stays the existing
  atomic path and gains a status transition. Bare links keep working unchanged
  for "share to WhatsApp" flows where there is no addressable invitee yet.

- **Invite tokens are opaque and signed, not guessable.** The current code is a
  short random string; the per-invitee token binds invitation id + group id +
  expiry under an HMAC so a leaked token cannot be replayed against another
  group. The token is *not* E2EE — the server must validate it — so it carries
  no PII beyond ids.

- **Clustering is client-side, in the existing WebView.** Positions are
  decrypted on-device; the server cannot cluster what it cannot read. Leaflet
  markers are grid-clustered at the current zoom before injection, keeping the
  bridge payload bounded (the same reason `FamilyMap` already thins history
  paths to 400 points).

- **Shared resources reuse the E2EE message spine where the data is small and
  conversational** (announcements, tasks) and get their own encrypted tables
  where they are queryable (calendar events, album index). Tasks-as-messages
  keeps assignment and completion inside the existing sync and offline queue;
  calendar needs date-range queries a message log cannot serve.

- **Privacy is per-member, per-group.** "Share precise / approximate / hidden"
  is enforced **client-side at seal time** — an approximate share seals a
  rounded coordinate, so the server and other members never receive the precise
  one. Enforcing it at render time would be theatre.

- **Group calls: build the model, not the fiction.** The participant list, join
  and leave events and the call entry point are real; the media path falls back
  to the existing 1:1 WebRTC until an SFU exists. `app/group-calls.tsx` already
  refuses to fake this, and that stance is preserved.

## Risks / Trade-offs

- **The re-key is wide but shallow.** `circleId → groupId` touches every
  `lib/family/*` store key. Old AsyncStorage keys must be migrated on first run
  or users silently lose their places and history. This needs a real one-time
  migration with a version marker, not a rename.
- **Permission drift.** A matrix is only as good as its enforcement. Every
  mutating endpoint needs a server-side check; a client-only check is a bug.
  Mitigated by resolving permissions in one middleware rather than per-handler.
- **Cap changes are retroactive.** Lowering a type's cap leaves existing groups
  over the limit. Decision: over-cap groups are read-only for *joins* but never
  forcibly trimmed — never evict a member because of a config change.
- **Scope volume.** Four new resource surfaces (tasks/calendar/album/notes) are
  each a small app. They are deliberately last in the phase order so the spine
  ships and proves itself first.
- **Analytics vs. the privacy story.** Distance and attendance are derived from
  local history and must stay device-local; a "weekly summary" that uploads
  aggregates would quietly break the server-blind invariant.

## Migration Plan

1. **Schema, additive only.** New columns on `chats` default to NULL; existing
   groups keep working as untyped groups. `chat_members.role` gains `guest` via
   a widened CHECK constraint. New tables: `chat_invitations`, `group_permissions`,
   `group_audit_log`.
2. **Backfill.** Every existing Family Space circle is stamped
   `group_type='family'`; `guardian` collapses onto `admin` (it was already
   derived from owner/admin, so this is label-only).
3. **Local store migration.** A one-shot pass rewrites `vc_family_*_<circleId>`
   keys to their group-scoped equivalents behind a stored schema version.
4. **Phase gating.** G0–G3 (spine) ship before G4–G6 (resources, navigation,
   analytics). Group calling stays behind its infrastructure flag.

## Open Questions

- Do Guests see location at all, or only chat and announcements? Assumed
  chat + announcements only, no location and no history.
- Should Emergency-type groups override a member's Invisible setting during an
  active SOS? Safety argues yes, consent argues no. Assumed **no** for v1 —
  an override is a surprise, and surprises in a privacy product are expensive.
- Album storage: reuse the existing media/attachment pipeline per group, or a
  distinct bucket per group for cleaner deletion? Leaning reuse.
- Whether `family-circle`'s "guardian" label survives in the Family type's UI or
  is retired entirely in favour of "admin".
