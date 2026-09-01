## Context

Group calls already terminate on the self-hosted LiveKit SFU. `CALL_ENGINE_V2` and
`CALL_SESSIONS` are both `true`, `engine.startGroup` opens a server call session and joins
the same `joinCallRoom` a 1:1 call uses, and the mesh code in `app/group-call-active.tsx`
plus the `MESH_MAX_PARTICIPANTS` cap in `internal/realtime/handlers.go` are the legacy
branch, unreachable at current flag values.

What was never built is the part that makes an SFU worth having. Today every client:

- subscribes to **every** publication of **every** participant — `wantAll()` on
  `ParticipantConnected` plus an unconditional `setSubscribed(true)` on `TrackPublished`
  (`lib/call/room.ts:175-200`);
- runs with `adaptiveStream: false` (`room.ts:156`), so nothing is dropped when off-screen;
- publishes camera with no `publishDefaults` at all — SDK defaults, no device-tier policy;
- renders `peerIds.map` into an unbounded `ScrollView` at a fixed 3 columns
  (`group-call-active.tsx:183-193`);
- rings with a serial loop of one `call_incoming` emit per member (`signal.ts:281-293`)
  against a server budget of 120 per 60s per account (`handlers.go`), and seals in-call
  chat per peer (`signal.ts:306-321`).

At 64 that is 63 inbound video decodes and 64 mounted `RTCView`s per phone: the same
quadratic that mesh was abandoned for, relocated from the encoder to the decoder.

Two hard constraints shape every decision below. First, `room.ts:126-200` is a record of
device-measured failures — `singlePeerConnection: false` fixed one-way audio,
`adaptiveStream: false` fixed frozen tiles, `wantAll()` fixed a caller who never received
the callee's tracks. Each comment is evidence, and a change that deletes the behaviour
without replacing the guarantee reintroduces a bug that took device time to find. Second,
this project deploys by file copy, so a client that assumes a server behaviour must
tolerate the old server until the binary is actually on prod.

## Goals / Non-Goals

**Goals:**

- 64 participants in one group call, with cost per device flat in participant count.
- The 64 ceiling enforced in one place, server-side, with a refusal the user can read.
- Ring cost independent of group size.
- Identical behaviour at 1:1 and small-group sizes — no regression in the paths that are
  device-proven today.

**Non-Goals:**

- Webinar / large-audience mode. Go Live owns broadcast on its own isolated LiveKit
  (port 7890, `golive_` rooms) and must not be merged into this path.
- Recording, RTMP, HLS, Egress of any kind.
- End-to-end frame encryption for group calls (owner decision 2026-08-16 stands).
- Multi-region SFU; latency stays a single-region property.
- Deleting the legacy mesh path — it is the rollback.

## Decisions

### D-1 — The app owns the visible set; the SDK never guesses

**Decision.** Introduce an explicit visible set: an ordered list of participant identities
whose video the app wants. `room.ts` exposes `setVisible(ids: string[])`; it diffs against
the current subscription state and calls `setSubscribed(true/false)` per video publication.
Audio is subscribed for everyone, always, and is never touched by the diff.

**Why not simply `adaptiveStream: true`.** That was tried and turned off, deliberately: the
SDK infers visibility from view attachment, and in a native call UI that judgement was
wrong often enough to freeze a tile on a working call. Re-enabling it as the *only*
mechanism reintroduces exactly that bug. With the app declaring the set, `adaptiveStream`
becomes a second-order optimisation for tiles that are in the set but scrolled slightly out
of frame — safe, because a wrong guess now only affects a tile the app already wants.

**Why audio is exempt.** Subscribing audio selectively is how "nobody could hear the person
who spoke up" happens. 64 Opus streams at ~24 kbps is under 1.5 Mbps and the SFU already
drops silent streams; the decode cost is negligible next to video. Audio is not where the
scaling problem is, so it is not where the risk is taken.

**Alternative rejected:** server-side subscription control via LiveKit's
`UpdateSubscriptions` RPC. It moves the same decision behind a network hop, adds a
round-trip to every scroll, and the client already knows what is on screen.

### D-2 — Visible set = active speakers first, then roster order, with a dwell floor

**Decision.** The set is sized by the grid page (9 tiles at 3×3 on a phone, up to 12 on a
tablet). It is filled with the most recent active speakers, then by stable roster order.
A participant promoted for speaking holds their tile for a **3-second dwell floor** before
being eligible for displacement, and a currently-speaking participant is never displaced.

**Why the dwell floor.** LiveKit's `ActiveSpeakersChanged` fires on short energy bursts. A
naive "loudest wins" rule makes the grid flicker through a cross-talk moment, and every
flicker is a subscribe/unsubscribe pair — the most expensive thing the client can do.

**Alternative rejected:** pure roster-order paging with manual scroll. Simpler, but in a
64-person call the person talking is usually not on page one, which is the whole point.

### D-3 — The ceiling is enforced where the seat is taken, not by the room

**Decision, as built.** `POST /calls` — the join — counts live participants inside the same
transaction that inserts the participant row, and refuses past 64 with a 409 the client
renders as "This call is full". `livekit.yaml`'s `max_participants` is raised to a backstop
above 64.

**Amended from "at token mint".** `sfu-token` requires the caller to ALREADY be a live
participant (`myRole` selects `left_at IS NULL`), because the join is what creates that
row. Refusing at mint would therefore refuse someone who is already occupying the seat they
are being told they cannot have — and leave their row behind holding it. The join is the
only place a seat is claimed, so it is the only place a seat can be denied.

**Counted excluding the caller,** so a reconnect can never be refused: someone whose network
dropped is already one of the 64 and must be able to return to the call they are still on.
It also makes the check idempotent, which matters because clients retry.

**Why not the room cap.** Go Live already learned this: `goliveMaxStage` (`internal/routes/golive.go:216`)
moved its cap out of `livekit.yaml` precisely because a room cap counts every identity and
cannot tell a publisher from a spectator. A room-level refusal also arrives as a media-server
disconnect — the client cannot distinguish it from a network failure, so the user sees
"call failed" instead of "call is full". An HTTP 409 on the join is legible; a transport
drop is not.

**Where the count comes from.** `call_participants` (migration 066), filtered on
`left_at IS NULL`. The handler scopes by user itself; RLS is inert in prod.

**Race.** Two people joining simultaneously at 63 can both succeed, yielding 65. Accepted:
the room backstop holds, and one extra participant is a cosmetic breach, not a failure.
A `SELECT … FOR UPDATE` on the call row is the upgrade if it ever shows up in metrics.

### D-4 — Ring fan-out moves to the server

**Decision.** A new socket event `ring_group` carrying only a `chatId`. The server resolves
the members from `chat_members`, stamps `from` itself, and emits one `call_incoming` per
recipient — for one unit of the caller's ring budget instead of one per member. The
existing per-`to` `call_incoming` stays on the wire, unchanged.

**As built:** the server confirms with a `ring_group_ok` reply event rather than a socket.io
ack callback. No handler in the Go hub uses acks, and a ring — where the cost of getting it
wrong is a phone that never rings — is not the place to introduce the first one.

**Why keep both.** Deploys are file copy. A client that ships before the Go binary lands on
prod would ring nobody. The client uses the bounded path and falls back to the loop when
the server does not acknowledge the new event — the fallback is deleted in a later change,
once the binary is verified on prod.

**Consequence for in-call chat — CORRECTED, THEN DECIDED.** This paragraph assumed group
in-call chat sends N sealed copies. It sent none: both senders returned early on
`!s.peerUid`, which a group session never has, so the feature was inert in every group
call. It also does not use a `CallCipher` — the seal is the real pairwise E2EE ratchet
(`sealForPeer` → `e2eeEncrypt`).

**Owner decision: it stays end-to-end encrypted.** So the server fan-out is not built for
text. `sealAndFanOut` seals once per recipient and sends N addressed envelopes; 64 people
costs 63 seals per message, paid deliberately. The reasoning is the asymmetry between text
and media: media gave up E2EE because frame encryption was where every hard device failure
lived, and none of that applies to a handful of short strings. Text riding beside
unencrypted video is not a reason to stop encrypting the text.

Ring fan-out (the rest of D-4) is unaffected and shipped.

### D-5 — Device tier from what the app already knows

**Decision.** Tier is derived from the existing screen/pixel-ratio inputs already used by
`screenCaptureSize` plus core count, not from a new dependency or a device database.
Capable → 3 simulcast layers; low-end → 2. Screen share stays `simulcast: false` — that is
device-proven (odd panel geometry, hardware H.264 refusing non-multiple-of-16 dimensions)
and must not be touched.

**Alternative rejected:** a device-model allowlist. A maintenance burden with a long tail,
for a two-way decision.

### D-6 — The grid pages; it does not virtualize

**Decision.** `group-call-active.tsx` renders a fixed page of tiles with page controls,
not a `FlatList` of 64.

**Why.** A virtualized list still mounts and unmounts `RTCView`s as the user scrolls, and
each mount/unmount is a subscription change. A page is a stable set that changes only on a
deliberate tap or a speaker promotion — which is exactly the input D-1 wants.

## Risks / Trade-offs

- **The subscription rewrite touches the code that produced one-way audio twice** →
  `setVisible` must be strictly additive at small sizes: with ≤ page-size participants
  everyone is visible and the emitted calls are byte-identical to `wantAll()`. A selftest
  asserts this, and the OEM matrix runs a 1:1 and a 3-person call before anything larger.
- **Unsubscribing a tile the user then scrolls back to shows a black frame while the
  keyframe arrives** → keep a small trailing margin (the previous page stays subscribed for
  a few seconds), and request a keyframe on re-subscribe.
- **Ring fan-out on the server is a new amplification point** — one emit becoming 63 →
  the existing per-account ring rate limit applies to `ring_group` as one unit, and the
  server verifies chat membership before fanning out. A non-member's ring costs nothing.
- **Group in-call chat loses its seal (D-4)** → this is a visible change to a privacy
  property. The UI must not imply otherwise, and 1:1 keeps the seal. If the owner rejects
  it, the fallback is per-peer sealing with server fan-out of pre-sealed envelopes — more
  wire, same scaling.
- **64 is the token ceiling but not a tested capacity** → the SFU node's own limit is
  unmeasured. Load-test before claiming the number publicly.
- **Deploy skew** → the client tolerates the old server (D-4 fallback), but the 64 ceiling
  does not exist until the Go binary is on prod. Until then the effective ceiling is the
  room's `max_participants`.

## Migration Plan

1. Client-only work first (visible set, paged grid, simulcast policy) — it degrades to
   today's behaviour on the current server and can ship alone.
2. Go changes (`sfu-token` ceiling, `ring_group`, call chat fan-out) built and file-copied
   to prod; verify by hash, then restart.
3. Raise `livekit.yaml` `max_participants` to the backstop **after** step 2, never before —
   raising it first removes the only ceiling that currently exists.
4. Delete the client-side ring fallback in a follow-up change, once step 2 is verified.
5. **Rollback** is `CALL_ENGINE_V2 = false`: one constant, back to the legacy mesh path.

## Open Questions

- **Page size on a phone.** 9 (3×3) is assumed. 12 may be legible on a large display and
  is a config, not a redesign — confirm on the Redmi before fixing it.
- **Does group in-call chat lose its seal (D-4)?** Needs the owner's answer. Blocks the
  chat fan-out task only; everything else proceeds.
- **Audio-only ceiling.** 64 is specified for video calls. A voice-only call could go
  considerably higher, but no product requirement exists — not designed for.
