# Design — CC-Wire session resume

## Context

Measured from the repository before designing anything:

| Piece | State |
|---|---|
| `ClientHello.resume_token` (7), `resume_from` (8) | in the schema, **never parsed** |
| `ServerHello.resume_token` (6), `resumed` (8) | in the schema, **hardcoded empty/false** |
| `Capabilities.resumption` (2) | deliberately **not advertised** |
| `StreamCursor{stream,last_delivered_seq}` | defined; `Ping.progress` **echoed verbatim, never read** |
| `ccwireSession` | holds `sessionID`, `deviceID`, `subs`, `d.uid`, `lim` |
| `Hub.cwSessions` | `uid → set(*ccwireSession)`, entries **deleted** on disconnect |

So the wire format was designed for resume and the server never built it. This
change is implementation, not protocol design — which is why it needs no schema
change and no new capability field.

## Goals / Non-Goals

**Goals:**
- A logical session that survives its connection, bounded in count, age, memory.
- An opaque, single-use, principal-bound resume token.
- Connection generation so a resumed connection supersedes its predecessor.
- Resume advertised only once it is real.

**Non-Goals:**
- **Replay.** Restoring identity/subscriptions/cursors without replaying missed
  frames is still worth having — the client keeps its subscriptions and its
  place — and replay is the next change. Bundling them would make one diff no
  one can review.
- **Cross-node resume.** A token issued by gateway A will not resolve on gateway
  B. It will answer `resumed=false` and the client resyncs. Correct, and it must
  never be described as working.
- **Redis/Kafka/a new table.** Bounded memory first; shared state only if
  multi-gateway measurement demands it.
- **SACK, compression, heartbeat redesign.** All wait for measurement.

## Decisions

**Park, don't destroy.** `ccwireUnregister` currently deletes the session. It
will instead move it to a parked table keyed by session id, with an expiry. The
live path is untouched, which keeps the diff small and the failure mode obvious:
if parking breaks, sessions expire and clients resync — today's behaviour.

**Opaque random token, server-side lookup.** 32 bytes from `crypto/rand`,
compared in constant time, stored as a reference to parked state. The
alternative — a signed token carrying uid/device/session — puts trust data on
the client and invites every mistake in that family. An opaque token cannot be
tampered with because it says nothing.

**Single-use with rotation.** A token is consumed on use and a fresh one issued
in `ServerHello`. A captured token is then worth one race, not a standing
capability.

**Bind to (uid, deviceID).** The token resolves to parked state, and the resumed
`ClientHello`'s authenticated uid and device must match it. Authentication still
happens normally: resume never substitutes for it — it only avoids rebuilding
state after authentication succeeds.

**Generation is an integer on the parked session.** Incremented on every
successful resume. A frame from an older generation is dropped. This is the
smallest mechanism that solves the stale-connection race; a full epoch/fencing
scheme would be more than the problem requires.

**Refusal is the default.** Every uncertain branch — unknown token, expired,
uid/device mismatch, future cursor, wrong stream — answers `resumed=false` and a
fresh session. That is exactly today's behaviour, so the worst case of this
change is the current behaviour.

## Risks / Trade-offs

- **Parked sessions are memory held for absent clients.** Bounded three ways
  (count, age, bytes) and swept. Unbounded here would turn a mobile network
  event into a gateway outage.
- **Resume without replay is a partial win.** It saves re-subscription and
  keeps cursor position; it does not save the missed frames. Stated plainly so
  the measurement in `ccwire-e2e-benchmark` is read honestly.
- **A restart invalidates every token.** In-memory state dies with the process,
  so a rolling deploy resyncs every client. Acceptable now, and the reason
  `GoAway` + resume (Change 9) matters later.
- **Cross-node resume silently absent.** A token presented to the wrong gateway
  refuses cleanly. The risk is documentation, not correctness: nobody must claim
  multi-node resume until it is tested.
- **The security surface is real.** A resume token that is guessable, reusable,
  or not bound to its principal is an account-takeover primitive. This is why
  the spec fixes entropy, single-use, binding and constant-time comparison as
  requirements rather than implementation detail.
