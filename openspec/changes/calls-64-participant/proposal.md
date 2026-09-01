## Why

Group calls already ride the LiveKit SFU — `CALL_ENGINE_V2` and `CALL_SESSIONS` are both
`true`, and `engine.startGroup` joins the same room as a 1:1 call. But **nothing in the
client scales**: every phone subscribes to every published track, renders every tile, and
rings every member in a serial socket loop. The transport is 64-ready; the client is
6-ready. A 64-person call today reproduces the exact quadratic cost that mesh was
abandoned for, moved from the encoder to the decoder.

The archived change `2026-08-28-calls-sfu-platform` was archived with **27 of 35 tasks
unchecked** — Phase 1 (selective subscription, simulcast policy, the 64 ceiling) was never
built. This change finishes only that, for ordinary group calls.

## What Changes

**Already built — not rebuilt here**

| Piece | Where |
|---|---|
| SFU transport for group calls | `lib/call/engine.ts:486` `startGroup` → `lib/call/room.ts` `joinCallRoom` |
| Role model `host · cohost · speaker · audience`, DB-backed | migration 066, `lib/callSession.ts` |
| `POST /calls/{id}/sfu-token`, role-scoped JWT, `canPublish=false` for audience | `internal/routes/call_sessions.go` |
| Screen-share track swap, dynacast, reconnect, foreground service, call log | `lib/call/room.ts`, `lib/call/engine.ts` |
| Empty-room self-end, encryption badge derived from live count | `engine.ts` `ALONE_GRACE_MS`, `CallEncryptionBadge` |

**New in this change**

- **Selective subscription.** Replace `wantAll()` + unconditional `TrackPublished`
  subscribe with a visible-set model: subscribe video for the tiles actually on screen
  (~9–12), audio for everyone. This is the single change that makes 64 possible.
- **Active-speaker-driven, paged grid.** `group-call-active.tsx` renders a bounded page of
  tiles instead of `peerIds.map` over an unbounded `ScrollView`; loudest speakers are
  promoted into the visible set.
- **`adaptiveStream` stays `false`** — investigated and deliberately not changed. It infers
  visibility from LiveKit's own `<VideoTrack>` components attaching, and this app renders
  remote video with `RTCView`, so the SDK would see no attached views and could pause every
  tile. The visible set replaces it rather than complementing it.
- **Device-tier camera simulcast policy** (`publishDefaults`): 3 layers on capable
  devices, 2 on low-end. Camera publish currently sets nothing.
- **A real 64 ceiling, enforced server-side at the JOIN** (`POST /calls`), inside the same
  transaction that takes the seat — the token-mint path requires the participant row to
  exist already, so it is too late to refuse there. Nothing enforces 64 anywhere today;
  `livekit.yaml` `max_participants: 100` counts everyone, cannot distinguish a caller from a
  spectator, and refuses by disconnecting.
- **Bounded group ring.** One `ring_group` server call replaces 63 client-side
  `call_incoming` emits, so a 64-person call costs one unit of the caller's ring budget
  instead of 63 of 120.
- **In-call chat and reactions work in group calls, and stay end-to-end encrypted.** The
  audit read `sendCallChat(to, …)` as N emits per message; it was zero — both senders
  returned early on `!s.peerUid`, which a group session never has, so the feature was
  **inert in every group call** and failed silently. Fixed by sealing once per recipient
  over the existing pairwise ratchet (N envelopes, `allSettled`), **not** by a server
  fan-out: that would be plaintext, and text must not lose the guarantee because the media
  gave it up. Group calls also now accept in-call messages only from live participants.
- **Delete `lib/call/sfuRoom.ts`** — a dead copy; `lib/call/reconnectWiring.selftest.ts`
  already asserts nothing imports it.

**Not building**

- Webinar / 1000-audience mode (Phase 2 of the archived change). Go Live already covers
  broadcast on its own isolated SFU and must not be merged with this path.
- Recording, RTMP egress, HLS tiers.
- End-to-end frame encryption for group calls. Owner decision 2026-08-16 stands: calls are
  encrypted in transit, and the badge says exactly that. 64 does not change it.
- Removing the legacy mesh path. It stays behind `CALL_ENGINE_V2=false` as the one-constant
  rollback until the OEM matrix passes.
- Multi-region SFU. Single-region latency is restated, not solved.

## Capabilities

### New Capabilities
- `group-call-scale`: how a group call admits, subscribes, publishes and rings at up to 64
  participants — the visible-set subscription model, the simulcast policy, the
  server-enforced ceiling, the bounded group ring, and the end-to-end-encrypted in-call
  side channel.

### Modified Capabilities
<!-- None. No existing spec under openspec/specs/ covers calls. -->

## Impact

- **App**: `lib/call/room.ts` (subscription model, `publishDefaults`, `adaptiveStream`),
  `lib/call/engine.ts` (visible-set plumbing, active speaker), `lib/call/signal.ts`
  (`ringGroup`), `lib/callSession.ts` (surface the 409), `app/group-call-active.tsx` (paged
  grid), `hooks/useCall.ts` + `lib/call/machine.ts` + `lib/call/types.ts` (speaker order).
  New: `lib/call/visibleSet.ts`. Deleted: `lib/call/sfuRoom.ts`.
- **Go backend**: `internal/routes/call_sessions.go` (participant ceiling at JOIN — see
  tasks 4.1 for why not at token mint),
  `internal/realtime/handlers.go` (`ring_group` fan-out). Handlers scope by user themselves
  — RLS is inert in prod.
- **Infra**: `livekit/livekit.yaml` `max_participants` becomes a backstop above 64, not the
  product rule. No new services; no Egress.
- **Deploy**: file-copy of the Go binary + changed sources; no migration.
- **Risk**: the subscription rewrite touches the code path that produced one-way audio on
  device twice before (`singlePeerConnection`, `wantAll`). Every comment in
  `room.ts:126-200` records a device-measured failure and must survive the change.
