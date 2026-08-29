# Chat–Map Separation

## Why

Location plumbing has been leaking into chat threads: live-key delivery posted a
"Location" bubble on every presence re-arm (owner screenshot: seven in one
thread by lunchtime), and geofence crossings ("X arrived at Home") post as
system messages indistinguishable from conversation. The owner's decision:
**chat carries only human messages; location lives on maps and in the alerts
inbox.** The key-spam half is already fixed (session-key reuse + delivery
ledger); this change finishes the separation.

## What Changes

- Geofence arrive/left announcements stop rendering in chat threads. They
  become STRUCTURED system messages (a `famEvent` JSON envelope) that the chat
  screen filters out — exactly the mechanism already proven for `family:true`
  live-location envelopes.
- Receiving devices gain an app-wide ingest: `famEvent` system messages fold
  into the existing device-local alerts inbox (`lib/family/alerts.ts`), which
  today only the EMITTING device fills. Other members currently learn about
  crossings ONLY from the chat text this change hides — without ingest the
  information would vanish, so ingest ships in the same change, not later.
- Space and family screens gain a chat shortcut in their headers that opens the
  group's EXISTING thread. Explicitly NOT a parallel chat store: one thread,
  one history, one E2EE session.
- The E2EE transport is unchanged: announcements still travel as sealed chat
  messages (that transport is what makes receivers learn anything at all);
  only their rendering and destination surface change.

## Capabilities

### New Capabilities

- `family-event-envelope`: the structured `famEvent` system-message envelope —
  its shape, who sends it, how chat suppresses it, how receivers ingest it
  into the alerts inbox, and backward compatibility with older builds that
  still render plain-text announcements.

### Modified Capabilities

<!-- No existing openspec/specs capabilities change requirements; spaces-core
     dashboards and space-ops-comms notification requirements are untouched.
     The chat-shortcut header row is UI navigation, below spec level. -->

## Impact

- **Affected code**: `lib/family/presence.ts` + `lib/family/background.ts`
  (announce call sites), `lib/family/fixPipeline.ts` (announce text →
  envelope), `app/chat.tsx` (thread filter), `app/_layout.tsx` (app-wide
  ingest beside the existing `new_message` listener), `lib/family/alerts.ts`
  (ingest helper), `lib/spaces/theme.ts` + `app/family.tsx` (header chat
  shortcut).
- **No server change**: the envelope rides existing E2EE system messages; the
  server relays ciphertext as today.
- **Compatibility**: an old build receiving a `famEvent` envelope would render
  raw JSON in the thread — mitigated by sending BOTH during a transition
  (envelope + legacy text) or accepting the one-line JSON on stale builds;
  design.md decides.
