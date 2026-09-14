//! Connection behaviour, with no network and no clock.
//!
//! That is the whole argument for the sans-IO shape: "a partial frame split
//! across two reads", "a peer that dribbles a header and never finishes" and "a
//! close arriving mid-frame" are the cases that actually break transports, and
//! every one of them is a few lines here instead of a flaky integration test.

use transport_core::conn::{CloseReason, Conn, Event, SendError, MAX_BUFFERED_BYTES};
use transport_core::config::MAX_FRAME_BYTES;
use transport_core::frame::{encode, FrameError};
use transport_core::sched::{Class, Reject};

fn framed(payload: &[u8]) -> Vec<u8> {
    encode(payload, 0).unwrap()
}

fn open() -> Conn {
    let mut c = Conn::new();
    assert_eq!(c.on_open(), vec![Event::Open]);
    c
}

#[test]
fn a_whole_frame_in_one_read_yields_one_event() {
    let mut c = open();
    let ev = c.on_bytes(&framed(b"hello"));
    assert_eq!(ev, vec![Event::Frame(b"hello".to_vec())]);
    assert_eq!(c.buffered(), 0, "a fully consumed read must leave nothing behind");
}

/// The case a naive reader gets wrong: TCP does not preserve message boundaries,
/// so a frame arriving one byte at a time must still assemble.
#[test]
fn a_frame_split_across_many_reads_still_assembles() {
    let mut c = open();
    let bytes = framed(b"split me up");
    for (i, b) in bytes.iter().enumerate() {
        let ev = c.on_bytes(&[*b]);
        if i + 1 < bytes.len() {
            assert!(ev.is_empty(), "byte {i}: emitted an event before the frame was complete");
        } else {
            assert_eq!(ev, vec![Event::Frame(b"split me up".to_vec())]);
        }
    }
    assert_eq!(c.buffered(), 0);
}

#[test]
fn several_frames_in_one_read_come_out_in_order() {
    let mut c = open();
    let mut buf = framed(b"one");
    buf.extend_from_slice(&framed(b"two"));
    buf.extend_from_slice(&framed(b"three"));
    assert_eq!(
        c.on_bytes(&buf),
        vec![
            Event::Frame(b"one".to_vec()),
            Event::Frame(b"two".to_vec()),
            Event::Frame(b"three".to_vec()),
        ]
    );
}

/// A trailing partial frame must be KEPT, not discarded — discarding it would
/// corrupt the stream at the first read boundary that lands mid-frame.
#[test]
fn a_trailing_partial_frame_is_kept_for_the_next_read() {
    let mut c = open();
    let whole = framed(b"first");
    let partial = framed(b"second");
    let mut buf = whole.clone();
    buf.extend_from_slice(&partial[..3]);

    assert_eq!(c.on_bytes(&buf), vec![Event::Frame(b"first".to_vec())]);
    assert_eq!(c.buffered(), 3, "the partial frame was dropped");
    assert_eq!(c.on_bytes(&partial[3..]), vec![Event::Frame(b"second".to_vec())]);
    assert_eq!(c.buffered(), 0);
}

/// THE BOUND THIS MODULE EXISTS FOR. `frame.rs` refuses an oversized frame, but
/// a peer never has to finish one: it can send a header claiming the maximum and
/// then dribble forever. The buffer must stay bounded throughout — an unbounded
/// read buffer is a memory leak with a protocol attached.
#[test]
fn a_dribbling_peer_cannot_grow_the_buffer_without_bound() {
    let mut c = open();
    let mut header = vec![1u8];
    header.extend_from_slice(&(MAX_FRAME_BYTES as u32).to_be_bytes());
    assert!(c.on_bytes(&header).is_empty(), "an incomplete frame must not emit");

    let chunk = vec![0u8; 64 * 1024];
    for _ in 0..40 {
        c.on_bytes(&chunk);
        assert!(
            c.buffered() <= MAX_BUFFERED_BYTES,
            "buffered {} exceeds the bound {MAX_BUFFERED_BYTES}",
            c.buffered()
        );
        if !c.is_open() {
            break;
        }
    }
}

/// REGRESSION. An earlier version checked the bound BEFORE appending, which
/// dropped a peer that was behaving perfectly: a maximum-size frame leaves
/// ~2 MiB buffered, and the read that completes it normally also carries the
/// start of the next frame, so `buffered + read` exceeded the bound. Two
/// back-to-back maximum frames disconnected an ordinary user.
#[test]
fn back_to_back_maximum_frames_do_not_disconnect_a_healthy_peer() {
    let mut c = open();
    let big = framed(&vec![0u8; MAX_FRAME_BYTES]);
    let mut stream = big.clone();
    stream.extend_from_slice(&big);

    // Delivered in realistic socket-sized reads, so the boundary between the
    // two frames lands mid-read — which is the case that used to break.
    let mut frames = 0;
    for part in stream.chunks(64 * 1024) {
        for ev in c.on_bytes(part) {
            match ev {
                Event::Frame(p) => {
                    assert_eq!(p.len(), MAX_FRAME_BYTES);
                    frames += 1;
                }
                other => panic!("healthy traffic produced {other:?}"),
            }
        }
    }
    assert_eq!(frames, 2, "a legitimate peer lost frames or was disconnected");
    assert!(c.is_open(), "a healthy peer was disconnected");
}

/// The actual defence against an oversized frame, one layer down: a declared
/// length over the maximum is refused before anything is allocated for it.
#[test]
fn a_declared_length_over_the_maximum_ends_the_connection() {
    let mut c = open();
    let mut header = vec![1u8];
    header.extend_from_slice(&((MAX_FRAME_BYTES + 1) as u32).to_be_bytes());
    assert_eq!(
        c.on_bytes(&header),
        vec![Event::Closed(CloseReason::Protocol(FrameError::LengthOverMax))]
    );
    assert_eq!(c.buffered(), 0, "the peer's bytes were retained after close");
}

/// A length-prefixed stream has no resynchronisation point: after a bad length
/// the next frame's offset is unknowable. Continuing to parse means
/// interpreting payload as header.
#[test]
fn a_protocol_error_ends_the_connection_and_it_stays_ended() {
    let mut c = open();
    let ev = c.on_bytes(&[9, 0, 0, 0, 1, 0xff]); // version 9: not one we speak
    assert_eq!(ev, vec![Event::Closed(CloseReason::Protocol(FrameError::BadVersion))]);
    assert!(!c.is_open());

    // Everything after is inert — no events, no resurrection.
    assert!(c.on_bytes(&framed(b"anything")).is_empty());
    assert!(c.poll_out().is_none());
    assert_eq!(c.send(Class::Message, 0, b"x"), Err(SendError::NotOpen));
}

/// Frames decoded BEFORE the bad one are still delivered. Throwing away good
/// frames because a later one was malformed loses messages that were fine.
#[test]
fn frames_before_a_protocol_error_are_still_delivered() {
    let mut c = open();
    let mut buf = framed(b"good");
    buf.extend_from_slice(&[9, 0, 0, 0, 0]); // bad version
    let ev = c.on_bytes(&buf);
    assert_eq!(ev[0], Event::Frame(b"good".to_vec()));
    assert_eq!(ev[1], Event::Closed(CloseReason::Protocol(FrameError::BadVersion)));
}

#[test]
fn bytes_before_open_and_after_close_are_ignored() {
    let mut c = Conn::new();
    assert!(c.on_bytes(&framed(b"early")).is_empty(), "data before open must not be parsed");
    assert_eq!(c.on_open(), vec![Event::Open]);
    assert!(c.on_open().is_empty(), "a second open must not emit a second event");

    assert_eq!(c.close(), vec![Event::Closed(CloseReason::Local)]);
    assert!(c.close().is_empty(), "a second close must not emit a second event");
    assert!(c.on_transport_close().is_empty());
}

#[test]
fn sending_frames_the_payload_and_respects_priority() {
    let mut c = open();
    c.send(Class::Bulk, 0, b"bulk").unwrap();
    c.send(Class::Control, 0, b"ctrl").unwrap();

    assert_eq!(c.poll_out().unwrap(), framed(b"ctrl"), "control did not overtake bulk");
    assert_eq!(c.poll_out().unwrap(), framed(b"bulk"));
    assert!(c.poll_out().is_none());
    assert_eq!(c.frames_out, 2);
}

/// Priority must not be the mechanism that lets a frame overtake its own
/// prerequisite — the invariant `sched.rs` enforces, reachable through `Conn`.
#[test]
fn a_frame_waiting_on_an_epoch_is_not_sent_however_urgent() {
    let mut c = open();
    c.send(Class::Control, 9, b"needs epoch 9").unwrap();
    c.send(Class::Bulk, 0, b"ready").unwrap();

    assert_eq!(c.poll_out().unwrap(), framed(b"ready"));
    assert!(c.poll_out().is_none(), "a blocked frame was sent anyway");
    assert_eq!(c.blocked(), 1);
    assert_eq!(c.queued(), 1, "None must not be confused with an empty queue");

    c.set_applied_epoch(9);
    assert_eq!(c.poll_out().unwrap(), framed(b"needs epoch 9"));
    assert_eq!(c.blocked(), 0);
}

#[test]
fn an_oversized_payload_is_refused_at_send_not_on_the_wire() {
    let mut c = open();
    let huge = vec![0u8; MAX_FRAME_BYTES + 1];
    assert_eq!(
        c.send(Class::Message, 0, &huge),
        Err(SendError::Frame(FrameError::LengthOverMax))
    );
    assert_eq!(c.queued(), 0);
}

#[test]
fn backpressure_is_reported_not_silently_dropped() {
    let mut c = open();
    let payload = vec![0u8; 64 * 1024];
    let mut n = 0;
    loop {
        match c.send(Class::Message, 0, &payload) {
            Ok(()) => n += 1,
            Err(SendError::Backpressure(r)) => {
                assert!(matches!(r, Reject::ClassFull | Reject::BytesFull));
                break;
            }
            Err(e) => panic!("unexpected: {e:?}"),
        }
        assert!(n < 10_000, "nothing ever bounded the queue");
    }
    assert!(c.queued_bytes() > 0);
}

/// A negotiated ceiling may tighten. It may never loosen.
#[test]
fn a_negotiated_max_tightens_both_directions() {
    let mut c = open();
    c.set_max_frame(16);
    assert!(c.send(Class::Message, 0, &[0u8; 17]).is_err(), "encode ignored the ceiling");
    assert!(c.send(Class::Message, 0, &[0u8; 8]).is_ok());

    // A frame larger than the negotiated max must be refused inbound too.
    let mut d = open();
    d.set_max_frame(16);
    let ev = d.on_bytes(&framed(&[0u8; 100]));
    assert_eq!(ev, vec![Event::Closed(CloseReason::Protocol(FrameError::LengthOverMax))]);
}

#[test]
fn a_transport_close_is_distinguishable_from_a_protocol_error() {
    // The host must be able to tell "the network went away, reconnect" from
    // "the peer is broken", because the right response differs.
    let mut c = open();
    assert_eq!(c.on_transport_close(), vec![Event::Closed(CloseReason::Transport)]);
}
