//! Every bound in one place, named, with the reason it has that value.
//!
//! The design's rule: no magic numbers scattered through the transport. A bound
//! that only exists at its use site is a bound nobody can audit, and a bound
//! nobody can audit is one that gets "temporarily" raised.
//!
//! Numbers here are DERIVED, not chosen. Each carries where it came from.

/// Bytes before the payload: 1 version + 4 length.
pub const HEADER_BYTES: usize = 5;

/// Hard ceiling on one frame, independent of negotiation.
///
/// Matches the existing system rather than inventing a new limit:
///   * `internal/realtime/server.go`  — SetMaxHttpBufferSize(2 * 1024 * 1024)
///   * `internal/httpx/httpx.go`      — io.LimitReader(r.Body, 2<<20)
///
/// A negotiated max may be LOWER. It may never be higher.
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

/// Outbound queue depth per priority class.
///
/// The design's hard invariant is "never one runtime, connection or task per
/// conversation", so this is a fixed global budget, not per-chat. 512 control
/// frames is far past any legitimate burst; past it the queue sheds rather than
/// growing without bound — an unbounded queue is just a slower crash.
pub const MAX_QUEUED_CONTROL: usize = 512;

/// Outbound message frames held before backpressure is reported upward.
///
/// Deliberately larger than control: a user genuinely can type faster than a
/// bad network drains, and those messages are already durable in the host's
/// outbox, so the queue is a scheduling buffer and not the source of truth.
pub const MAX_QUEUED_MESSAGE: usize = 2048;

/// Bulk (attachment) frames in flight. Small on purpose: bulk must never be
/// able to starve control or messaging, and the file itself lives on disk.
pub const MAX_QUEUED_BULK: usize = 64;

/// Total bytes the outbound scheduler may hold across ALL classes.
///
/// A count-based bound alone is not a memory bound: 2048 frames of 2 MiB is
/// 4 GiB. Both apply, and whichever binds first wins.
pub const MAX_QUEUED_BYTES: usize = 8 * 1024 * 1024;

/// Records replayed per resume pass (design B2: `DurableWork::replay(limit)`).
/// Bounded so a long offline period drains in steady passes rather than one
/// unbounded read.
pub const REPLAY_BATCH: usize = 64;
