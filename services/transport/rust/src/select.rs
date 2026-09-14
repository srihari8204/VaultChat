//! Path selection: which transport a frame may travel over.
//!
//! PURE. A decision function, not a connection manager.
//!
//! CONTRACT (proto/ccwire/v1/envelope.proto, capabilities.proto):
//!   `datagrams` is a negotiated capability and is EPHEMERAL-ONLY.
//!   TrafficClass EPHEMERAL is the only class that is datagram-eligible,
//!   because a datagram may be dropped and only EPHEMERAL tolerates that.
//!
//! THE RULE THIS FILE EXISTS TO ENFORCE: eligibility is a CONJUNCTION, and
//! every term must be checked. Datagram-eligible means the capability was
//! negotiated AND the class is EPHEMERAL AND the body is one of the three
//! EPHEMERAL bodies AND it fits a datagram. A frame that is merely "small and
//! unimportant" is not eligible. Getting this wrong sends a key event over a
//! droppable path.
//!
//! The API is shaped so that the reliable path is what you get by default and
//! the datagram is what you must argue for: [`path`] returns [`Path::Reliable`]
//! unless every term of [`datagram_eligible`] holds. A future term added to that
//! conjunction therefore takes traffic OFF the droppable path, never onto it.

use crate::parse::{is_body_field, EPHEMERAL_BODIES, TRAFFIC_CLASS_EPHEMERAL};

/// Largest frame that may be sent as a datagram.
///
/// Derived, not chosen: the IPv6 minimum MTU is 1280 bytes, and a QUIC datagram
/// must survive it without IP fragmentation — 80 bytes are left for IP, UDP and
/// QUIC headers. A datagram that gets fragmented loses the only property it was
/// chosen for, since one lost fragment drops the whole thing anyway.
///
/// Independent of `config::MAX_FRAME_BYTES`, which bounds what a frame may be at
/// all. This bounds what fits in one packet, which is a different question.
pub const MAX_DATAGRAM_BYTES: usize = 1200;

/// `geo_relay`'s field number. Named because the terminal-event rule below
/// applies to this body and no other.
const BODY_GEO_RELAY: u32 = 84;

/// The `datagrams` capability, as negotiated — BOTH sides, not one.
///
/// Two fields rather than one bool because "we support datagrams" and "the
/// capability was negotiated" are different claims, and capabilities.proto is
/// explicit that negotiation is not authority. A single pre-ANDed flag lets a
/// caller pass its own wish and call it agreement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Negotiated {
    pub local: bool,
    pub peer: bool,
}

impl Negotiated {
    /// Negotiated means agreed. Either side withholding it settles the matter.
    pub fn datagrams(self) -> bool {
        self.local && self.peer
    }
}

/// Which path a frame travels. `Reliable` is the default in the literal sense:
/// it is what `Default` yields, and what every refusal falls back to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Path {
    #[default]
    Reliable,
    Datagram,
}

/// Why a frame was refused a datagram.
///
/// A value, not a log line: the caller can report WHY without reconstructing the
/// decision, and a test can assert WHICH term of the conjunction bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotDatagram {
    /// The `datagrams` capability was not agreed by both sides.
    CapabilityNotNegotiated,
    /// traffic_class is not EPHEMERAL. Every other class must be delivered.
    ClassNotEphemeral,
    /// EPHEMERAL class, but not one of typing_state / viewer_state / geo_relay —
    /// which parse.rs already refuses outright; reaching here means a caller
    /// built the frame by hand.
    BodyNotEphemeral,
    /// A terminal `GeoRelay` (`ended = true`). See [`Candidate::terminal`].
    TerminalGeoRelay,
    /// Would not fit one packet. See [`MAX_DATAGRAM_BYTES`].
    OverDatagramBudget,
}

/// The frame, reduced to exactly the facts the decision needs.
///
/// Sealed bytes are counted, never inspected: this module decides a route and
/// has no business reading a payload to do it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Candidate {
    pub traffic_class: u32,
    /// The `Frame.body` field number, as `parse::Frame` reports it. `None` is a
    /// bodyless frame, which is never datagram-eligible — there is nothing there
    /// whose loss could be tolerable.
    pub body_field: Option<u32>,
    /// Wire size of the whole framed frame, not just the body.
    pub bytes: usize,
    /// `GeoRelay.ended`. envelope.proto: "Terminal events (ended = true) are
    /// MESSAGING: losing one leaves a phantom trip on every peer's map." The
    /// class and body of a terminal GeoRelay look exactly like a live position
    /// update, so nothing else in the conjunction can catch it — the caller that
    /// built the body is the only party that knows, and must say so here.
    ///
    /// Meaningless for any other body and ignored there; a caller that sets it
    /// on a typing_state only makes that frame reliable, which is never unsafe.
    pub terminal: bool,
}

/// Every term of the conjunction, in order, or the first one that failed.
///
/// Order is for the REASON, not the answer — the answer is the same whatever
/// order the terms are checked in. Capability first because "we never negotiated
/// datagrams" explains a whole connection's worth of refusals at once, and size
/// last because it is the only term that varies frame to frame.
pub fn datagram_eligible(n: Negotiated, c: &Candidate) -> Result<(), NotDatagram> {
    if !n.datagrams() {
        return Err(NotDatagram::CapabilityNotNegotiated);
    }
    if c.traffic_class != TRAFFIC_CLASS_EPHEMERAL {
        return Err(NotDatagram::ClassNotEphemeral);
    }
    // `None` and any non-ephemeral body fail together. A body field this build
    // does not recognise is also refused, by the same rule parse.rs uses: the
    // allow-list is the three EPHEMERAL bodies, so an unknown field number is
    // not on it and cannot become droppable by being unrecognised.
    let body = match c.body_field {
        Some(b) if is_body_field(b) && EPHEMERAL_BODIES.contains(&b) => b,
        _ => return Err(NotDatagram::BodyNotEphemeral),
    };
    if body == BODY_GEO_RELAY && c.terminal {
        return Err(NotDatagram::TerminalGeoRelay);
    }
    if c.bytes > MAX_DATAGRAM_BYTES {
        return Err(NotDatagram::OverDatagramBudget);
    }
    Ok(())
}

/// The decision. Reliable unless every term held.
pub fn path(n: Negotiated, c: &Candidate) -> Path {
    match datagram_eligible(n, c) {
        Ok(()) => Path::Datagram,
        Err(_) => Path::Reliable,
    }
}

/// The inverse, stated so it can be asserted directly: anything not eligible
/// MUST go reliably. There is no third option and no "best effort" middle.
pub fn must_be_reliable(n: Negotiated, c: &Candidate) -> bool {
    path(n, c) == Path::Reliable
}
