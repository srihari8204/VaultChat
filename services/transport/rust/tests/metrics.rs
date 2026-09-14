//! Counters.
//!
//! Two properties matter here. A counter must never panic or wrap into a number
//! that reads as healthy, and a snapshot must be the truth about what was
//! recorded — a metric nobody can trust is worse than no metric, because it gets
//! acted on.

use transport_core::metrics::{DecodeFail, Metrics, Snapshot};

#[test]
fn a_snapshot_reflects_exactly_what_was_recorded() {
    let mut m = Metrics::new();
    m.frame_in(100);
    m.frame_in(50);
    m.frame_out(7);
    m.shed();
    m.shed();
    m.shed();
    m.rejected();
    m.decode_failed(DecodeFail::Framing);
    m.decode_failed(DecodeFail::Codec);
    m.decode_failed(DecodeFail::Codec);
    m.decode_failed(DecodeFail::Protocol);
    m.reconnect();
    m.heartbeat_timeout();

    let s = m.snapshot();
    assert_eq!(s.frames_in, 2);
    assert_eq!(s.bytes_in, 150);
    assert_eq!(s.frames_out, 1);
    assert_eq!(s.bytes_out, 7);
    assert_eq!(s.frames_shed, 3);
    assert_eq!(s.frames_rejected, 1);
    assert_eq!(s.decode_failed_framing, 1);
    assert_eq!(s.decode_failed_codec, 2);
    assert_eq!(s.decode_failed_protocol, 1);
    assert_eq!(s.reconnects, 1);
    assert_eq!(s.heartbeat_timeouts, 1);
}

/// Reasons must not bleed into each other — "the peer sends garbage" and "the
/// peer breaks the protocol" call for different responses.
#[test]
fn each_decode_reason_has_its_own_counter() {
    let mut m = Metrics::new();
    m.decode_failed(DecodeFail::Protocol);
    let s = m.snapshot();
    assert_eq!(s.decode_failed_protocol, 1);
    assert_eq!(s.decode_failed_framing, 0);
    assert_eq!(s.decode_failed_codec, 0);
}

/// Wrapping would turn a long connection's byte total into a small number that
/// reads as a quiet link; panicking would take down a live connection over a
/// statistic. Sticking at the ceiling is the only answer that is merely useless.
#[test]
fn counters_saturate_rather_than_wrap() {
    let mut m = Metrics::new();
    m.frame_in(usize::MAX);
    m.frame_in(usize::MAX);
    m.frame_out(usize::MAX);
    m.frame_out(usize::MAX);

    let s = m.snapshot();
    assert_eq!(s.bytes_in, u64::MAX, "the byte counter wrapped");
    assert_eq!(s.bytes_out, u64::MAX, "the byte counter wrapped");
    assert_eq!(s.frames_in, 2, "the frame counter must not be dragged along");
}

/// A fresh connection starts at zero, and a snapshot is a copy — reading one
/// must not disturb or borrow the live counters.
#[test]
fn a_new_metrics_is_zero_and_a_snapshot_is_a_copy() {
    let mut m = Metrics::new();
    assert_eq!(m.snapshot(), Snapshot::default());

    let before = m.snapshot();
    m.shed();
    assert_eq!(before.frames_shed, 0, "the snapshot tracked the live counter");
    assert_eq!(m.snapshot().frames_shed, 1);
}
