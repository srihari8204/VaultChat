# Design — Chat–Map Separation

## Context

Three location-adjacent things currently touch chat threads:

1. **Live-key delivery** (`presence.deliverKeys`) — a location-type message
   carrying the session key. Already fixed upstream of this change: one key per
   sharing session, one delivery per (circle, key), and the thread has filtered
   these envelopes since 39ceec0. Out of scope here, listed so nobody re-solves it.
2. **Geofence announcements** — `processFix` calls `opts.announce(text)`, and
   both announce implementations (`presence.ts:332`, `background.ts:177`) do
   `sendMessage(cid, text, 'system')`. That plain text is BOTH the transport to
   other members and the thing polluting the thread. Receivers have NO other way
   to learn a crossing: `alerts.ts` is device-local and today only the emitting
   device records into it; `watchAlerts.ts` derives only battery/silence.
3. **The speed alert** rides the same announce callback (`fixPipeline.ts`), so
   whatever the crossing envelope does, overspeed does too — one mechanism.

Constraint that shapes everything: **the server must not learn positions or
place names** (standing rule). Whatever replaces the chat text must stay inside
the existing E2EE message path.

## Goals / Non-Goals

**Goals**
- No location/geofence text in any chat thread on current builds.
- Other members still learn crossings — in their alerts inbox, with kind,
  severity and read state instead of prose.
- One chat per group, reachable from space/family screens.

**Non-Goals**
- No parallel chat store (explicitly rejected by the owner).
- No server-side alert fan-out (the E2EE message IS the fan-out).
- No redesign of the alerts inbox UI.
- Key-delivery messages (already solved).

## Decisions

### D1 — The envelope: structured JSON over a marker string

`announce` changes signature from `(text)` to `(event)` and sends:

```json
{ "famEvent": { "v": 1, "kind": "enter|leave|overspeed", "actorId": "…",
  "actorName": "…", "text": "Rohan arrived at Home", "at": 1724839000000 } }
```

as a `system` message. Rationale: chat.tsx already filters location messages by
`content.includes('"family":true')` — proven mechanism, same trick. The
receiver ingest gets typed fields instead of parsing prose, and `v` exists so a
future field is not a guessing game. `text` stays inside the envelope because
the alerts inbox renders exactly that string today.

### D2 — Receiver ingest lives beside the app-wide `new_message` listener

`app/_layout.tsx:365` already holds the ONE listener that sees every incoming
message app-wide (it drives notifications). The ingest hooks there: decrypted
system message whose content parses to `famEvent` → `recordAlert({circleId:
chatId, …})`, skipping `actorId === myId` (the emitting device already recorded
its own alert in `processFix`; `recordAlert`'s dedupe window is the backstop).

Rejected alternative: ingest in `chat.tsx`'s message list — only works while
the thread is open, which is exactly when an alerts inbox matters least.

### D3 — Filtering: extend the existing thread filter, plus the preview

`chat.tsx`'s render filter grows one clause: drop `type === 'system'` whose
content contains `"famEvent"`. The chat-LIST preview (`chats.tsx`) maps these
to nothing new — a hidden system message should not become a chat row's "last
message"; preview code skips it the same way. If the server computes previews,
the preview shows the generic system label at worst — accepted, rare.

### D4 — Compatibility: hard cut, no dual-send

An old build receiving the envelope renders one line of JSON in the thread; a
new build receiving old-style plain text renders it as today (it cannot be
distinguished from human text safely — no ingest for it). Dual-send (envelope +
legacy text) would put TWO messages in every old thread and defeat the entire
point on current ones. Both test phones and the owner's family run
current-or-next builds; the fleet is pre-launch. Hard cut is correct NOW and
would be wrong after Play launch — this decision does not survive a public
user base.

### D5 — Header shortcut: one helper, both surfaces

`spaceHeader()` in `lib/spaces/theme.ts` already owns headerRight for every
space screen — add the chat icon there (`router.push('/chat', {chatId: spaceId,
name})`). `app/family.tsx` renders its own header; same icon, same push, active
circle's id. No new navigation shape: `/chat` already accepts exactly these
params from the chats list.

## Risks / Trade-offs

- **Old-build JSON line in thread** — accepted per D4; window is days.
- **Alerts inbox growth**: inbox is capped/pruned already (`alerts.ts` store);
  ingest adds member events at human scale — no new pressure.
- **A member with alerts never opened** misses crossings they used to see in
  chat. Mitigated by the existing unread badge on the alerts tab; if that
  proves insufficient the alerts screen, not the chat thread, is where to fix it.

## Migration Plan

Single app release. No server change, no data migration. Order inside the
release is free — filter, ingest and envelope land together; a build carrying
only part of them would regress visibility (see D4).

## Open Questions

- Should `checkin` / SOS system texts follow the same envelope later? (SOS
  deliberately stays IN chat — a human emergency is conversation. Owner said
  arrived/left only; leaving the rest as-is.)
