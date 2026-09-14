//! Counters. Plain integers, read by the host, reported nowhere by this crate.
//!
//! WHAT THIS MODULE IS FORBIDDEN FROM COUNTING
//! -------------------------------------------
//! Anything per-chat, per-peer, per-message or per-user. The product's claim is
//! that the operator cannot see your activity, and a transport that counts
//! "frames sent to chat X" rebuilds exactly the activity log the rest of the
//! system refuses to keep — see internal/routes/usage.go, which is authenticated
//! yet deliberately stores (screen, day, views) and no identity at all.
//!
//! So: connection-scoped totals only. "How many frames were shed", never "whose".
//! A counter that can answer a question about a PERSON does not belong here,
//! however useful it would be for debugging.
//!
//! No allocation, no clock, no strings in the hot path.
//!
//! HOW THAT RULE IS ENFORCED RATHER THAN ASSERTED
//! ----------------------------------------------
//! The API has no way to express an identifier. Every recording method takes
//! either nothing or a byte count; none takes a chat id, peer id, request id or
//! label, and there is no map, no dimension, no tag. [`Snapshot`] is a fixed set
//! of named `u64`s, so a new dimension cannot be added by a caller — it would
//! take an edit to this file, which is the review usage.go's `SysPool` comment
//! is making the same bet on. The privacy property is structural: there is
//! nowhere to put the identity, so no call site can leak one by accident.
//!
//! Every counter saturates. A counter is diagnostic, never a control input, so
//! the correct behaviour at `u64::MAX` is to stick — wrapping would turn a long
//! connection's shed count into a small number that reads as healthy, and
//! panicking would take down a live connection over a statistic.

/// Broad reason a frame failed to decode.
///
/// Deliberately three buckets, not the twelve of `parse::CodecError`. The
/// question a counter answers is "is this peer sending us garbage, or are we
/// disagreeing about the protocol" — the exact variant belongs in the error
/// returned to the caller, which is where it can be acted on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeFail {
    /// Wire framing refused the bytes — length prefix, version, size.
    Framing,
    /// The framing held; the protobuf inside it was malformed.
    Codec,
    /// Well-formed bytes that break an invariant (EPHEMERAL carrying a
    /// crypto_control, a duplicate body). Distinct from `Codec` because this one
    /// means a peer is doing something, not that a byte got flipped.
    Protocol,
}

/// A consistent read of every counter. Copy, so the host can take one and let
/// the connection keep running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Snapshot {
    pub frames_in: u64,
    pub frames_out: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    /// Ephemeral frames dropped under pressure (see `sched::Sched::shed`).
    pub frames_shed: u64,
    /// Enqueues refused by backpressure — reported, never silent.
    pub frames_rejected: u64,
    pub decode_failed_framing: u64,
    pub decode_failed_codec: u64,
    pub decode_failed_protocol: u64,
    pub reconnects: u64,
    pub heartbeat_timeouts: u64,
}

/// Connection-scoped totals. One per connection, never one per conversation —
/// the same rule `sched::Sched` follows, for the same two reasons: the design
/// forbids per-conversation state, and a per-chat counter is the activity log
/// this module exists to not keep.
#[derive(Debug, Clone, Copy, Default)]
pub struct Metrics {
    s: Snapshot,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    /// One frame received. Frames and bytes move together because a byte count
    /// without a frame count cannot distinguish a big frame from a busy peer.
    pub fn frame_in(&mut self, bytes: usize) {
        self.s.frames_in = self.s.frames_in.saturating_add(1);
        self.s.bytes_in = self.s.bytes_in.saturating_add(bytes as u64);
    }

    pub fn frame_out(&mut self, bytes: usize) {
        self.s.frames_out = self.s.frames_out.saturating_add(1);
        self.s.bytes_out = self.s.bytes_out.saturating_add(bytes as u64);
    }

    pub fn shed(&mut self) {
        self.s.frames_shed = self.s.frames_shed.saturating_add(1);
    }

    pub fn rejected(&mut self) {
        self.s.frames_rejected = self.s.frames_rejected.saturating_add(1);
    }

    pub fn decode_failed(&mut self, why: DecodeFail) {
        let c = match why {
            DecodeFail::Framing => &mut self.s.decode_failed_framing,
            DecodeFail::Codec => &mut self.s.decode_failed_codec,
            DecodeFail::Protocol => &mut self.s.decode_failed_protocol,
        };
        *c = c.saturating_add(1);
    }

    pub fn reconnect(&mut self) {
        self.s.reconnects = self.s.reconnects.saturating_add(1);
    }

    pub fn heartbeat_timeout(&mut self) {
        self.s.heartbeat_timeouts = self.s.heartbeat_timeouts.saturating_add(1);
    }

    /// What the host may read. By value: nothing here is a handle, so a reader
    /// cannot hold a borrow across the connection's work.
    pub fn snapshot(&self) -> Snapshot {
        self.s
    }
}
