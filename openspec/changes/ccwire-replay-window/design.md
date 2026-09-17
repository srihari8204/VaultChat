# Design — CC-Wire replay window

## Context

`ccwire-session-resume` already built the hard half. Measured from the code:

| Piece | State |
|---|---|
| `s.cursors` | what the server SENT, advanced in `noteSent()` at the single outbound chokepoint |
| `s.acked` | what the client CONFIRMED, from `Ping.progress`, clamped to `cursors` both ways |
| `parkForResume` | parks the **acked** position, falling back to sent |
| `acceptCursors` | refuses a claim past what was sent; never regresses |

So "where does this client resume from, without trusting the client" is solved.
What is missing is the frames themselves.

## Goals / Non-Goals

**Goals:**
- Retain recent outbound frames per session, bounded three ways.
- Replay the gap on a successful resume, in stream order.
- Refuse — not partially serve — when the gap exceeds the window.

**Non-Goals:**
- **SACK.** This change is what finally makes the question measurable: how much
  replay is wasted because acknowledgement is cumulative. Answering it first
  would be guessing.
- **Durability.** The window is memory and dies with the process. PostgreSQL
  stays authoritative.
- **Attachments and bulk.** Explicitly excluded from retention.
- **Cross-node.** The window lives with the gateway that created it.

## Decisions

**Retain the ENCODED frame, not the message.** Replay must reproduce exactly
what was sent — re-encoding invites a subtly different frame, and a frame that
differs on replay is the hardest class of bug to find. Cost is memory, which is
what the bounds are for.

**Bound on insert, never on a sweep.** A sweep-based bound is unbounded between
sweeps, and the burst that overruns it is exactly when the sweep has not run.

**Refuse partial replay.** If the client's position predates the oldest retained
frame, the resume fails and the client resyncs. Serving what we happen to have
would deliver a sequence with a hole in it — and a hole the client does not know
about is worse than an honest resync.

**A dropped frame poisons the window.** When a frame is not retained (too large,
or `BULK`), the session records the hole. Any later resume across that point
refuses. Otherwise replay would silently skip precisely the frames too big to
keep.

**Free on acknowledgement.** `Ping.progress` already tells us what the client
has. Frames at or before that are dropped, so a healthy connection holds close
to nothing and the window is sized for the unhealthy case.

**Gate behind the existing `CCWIRE_RESUME`.** No second flag: a window that
retains frames while resume is off is memory spent on a feature that cannot run.

## Risks / Trade-offs

- **Memory is the whole risk.** Per-session bounds are enforced on insert. The
  failure mode to fear is a commuter train of parked sessions each holding a
  full window, which is why the byte budget is per-session AND the parked-session
  table is itself capped.
- **Replay means duplicates.** Accepted and stated: the app layer already
  deduplicates durable messages on `(chat_id, sender_id, client_id)`. The
  guarantee offered is exactly-once *visible effect*, and the spec says so
  rather than implying more.
- **More memory retained per session than resume alone.** Resume parks a few
  cursors; this parks frames. That is the cost being bought, and it is bounded.
- **Measurable only end to end.** Whether this actually beats a resync is a
  claim for `ccwire-e2e-benchmark`, not for this change. Nothing here should be
  reported as a performance win until that measurement exists.
