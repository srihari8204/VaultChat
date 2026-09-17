# CC-Wire replay window

## Why

`ccwire-session-resume` restores a session's **position** — identity, device
binding, subscriptions, and how far each stream had got. It does not resend the
frames that were missed. So today a resumed client keeps its place and then
still reconciles content through the full application sync path, which is most
of the cost resume was meant to avoid.

Resume without replay is a partial win by construction. This change is the other
half: a small, bounded, short-lived buffer of recent outbound frames, so a
two-second tunnel costs a handful of retransmitted frames instead of a full
resync against PostgreSQL.

The position to replay *from* is already correct and already validated:
`parkForResume` parks the **acked** position (what the client confirmed), not
the sent one, and `acceptCursors` refuses a claim past what the server sent. The
hard part — knowing where to resume from without trusting the client — is done.

## What Changes

- A per-session ring of recent outbound frames, bounded by **bytes, count and
  age simultaneously**, retained only while a session is parked.
- On a successful resume, frames after the client's acked position are resent in
  stream order before new traffic.
- When the gap exceeds what the window holds, the resume still succeeds but the
  server answers `resumed=false` so the client takes the existing resync path —
  the same conservative branch every other uncertain case takes.
- Frames are dropped from the window as they are acknowledged, so a healthy
  connection holds almost nothing.

Explicitly NOT in scope:
- **No SACK.** Whether cumulative acknowledgement causes enough wasteful replay
  to justify selective acknowledgement is a question this change makes
  *measurable* for the first time. Deciding it before measuring is the mistake
  the ponytail rule exists to prevent.
- **No new durable store.** The window is memory, short-lived, and never the
  source of truth. PostgreSQL and the application sync path remain authoritative.
- **No attachment bytes.** Large payloads must not enter the window.
- **No cross-node replay.** The window lives with the gateway that created it.

## Capabilities

### New Capabilities
- `ccwire-transport-replay`: what may be retained, for how long, under what
  bounds, and the guarantee that exceeding those bounds degrades to the existing
  resync rather than to loss or duplication.

### Modified Capabilities
<!-- None. No application event changes and no protobuf change: frames are
     replayed exactly as they were first sent. -->

## Impact

- **Code**: `internal/realtime/` — a ring buffer on the session, retention on
  park, and replay on a successful resume.
- **Memory**: this is the risk that matters. A window that is not bounded three
  ways is a gateway outage waiting for a commuter train. Bounds are per-session
  and enforced on insert, not on a sweep.
- **Correctness**: replay means a frame may be delivered twice. The application
  layer already deduplicates durable messages — `ON CONFLICT (chat_id,
  sender_id, client_id)` — so the requirement is "exactly-once visible effect",
  never "exactly-once delivery", and this change must not claim otherwise.
- **Compatibility**: gated behind the same `CCWIRE_RESUME` flag. With it unset
  nothing is retained and nothing is replayed.
