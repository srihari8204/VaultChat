# CC-Wire session resume

## Why

Every transport interruption today costs a full application resync. The server
keeps no resume state, so a two-second tunnel — or a Wi-Fi→cellular handover, or
a backgrounded app — discards the logical session entirely and the client
rebuilds it from durable state.

The server says so in its own code:

```go
// resume_token (6) stays empty: resumption is not implemented, and an
// unusable token is worse than none.
// resumed (8) is false — a proto3 default, and honest: the client must
// full-resync.
```

**The protocol already has the whole vocabulary and none of it is used**:
`ClientHello.resume_token` (7), `ClientHello.resume_from` (8),
`ServerHello.resume_token` (6), `ServerHello.resumed` (8),
`Capabilities.resumption` (2), `StreamCursor`. The schema was designed for this
and the server never implemented it — so this change implements what the wire
format already promises rather than inventing anything.

## What Changes

- A **logical session** that outlives its physical connection: bounded,
  in-memory, parked on disconnect with an expiry rather than destroyed.
- An **opaque random resume token** bound to user + device + session, referencing
  server state. No trust data inside the token.
- `ClientHello.resume_token` / `resume_from` parsed and validated; `ServerHello`
  answers with `resumed` and a rotated token.
- `Capabilities.resumption` advertised **only after** the server can genuinely
  resume — never before.
- **Connection generation**, so a resumed connection supersedes its predecessor
  and a late frame from a dead connection cannot advance state.

Deliberately NOT in this change:
- **No replay window.** Resume restores session identity, subscriptions and
  cursor position. Replaying missed frames is `ccwire-replay-window`, next.
- **No SACK, no compression.** Both wait for measurement.
- **No new database, no Kafka, no Redis.** Single-gateway bounded memory first;
  cross-node resume is explicitly out of scope and must not be claimed.

## Capabilities

### New Capabilities
- `ccwire-session-resume`: the logical session, its lifetime and bounds, resume
  token security properties, and the guarantee that resume failure degrades to
  the existing resync path rather than to data loss.

### Modified Capabilities
<!-- None. No application contract changes: the same 33 client→server and 44
     server→client events, unchanged. This is transport-internal. -->

## Impact

- **Code**: `internal/realtime/` — a session store, token issue/validate, and
  the `ClientHello`/`ServerHello` resume path. Client side follows once the
  server can resume.
- **Wire**: no schema change. Fields that already exist stop being ignored.
- **Compatibility**: a client that sends no `resume_token` behaves exactly as
  today. A client without the `resumption` capability is unaffected.
- **Risk**: the honest one — resume is a correctness-sensitive path. It is
  designed as an OPTIMISATION over the existing resync: any doubt (unknown
  token, expired session, generation conflict, cursor beyond what we can serve)
  answers `resumed=false`, and the client full-resyncs exactly as it does today.
  **A failure of the optimisation must never become a failure of messaging.**
- **Memory**: parked sessions are bounded by count, bytes and age. An unbounded
  session map is the obvious way this feature becomes an outage.
