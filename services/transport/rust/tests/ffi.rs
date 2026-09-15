//! The host boundary.
//!
//! The handle is an integer standing in for a pointer, so the mistakes a
//! pointer would make are available to it: use-after-free, double-free, and
//! one connection's handle addressing another's state. The type system cannot
//! catch any of them across an FFI boundary, so they are pinned here.

use transport_core::conn::{CloseReason, Event};
use transport_core::ffi::{
    encode_events, from_hex, to_hex, Handle, Registry, CLOSE_LOCAL, CLOSE_PROTOCOL, EVENT_CLOSED,
    EVENT_FRAME, EVENT_OPEN,
};
use transport_core::frame::encode;
use transport_core::sched::Class;

fn framed(p: &[u8]) -> Vec<u8> {
    encode(p, 0).unwrap()
}

#[test]
fn a_handle_drives_its_own_connection() {
    let mut r = Registry::new();
    let h = r.open();
    assert_eq!(r.on_open(h), vec![Event::Open]);
    assert_eq!(
        r.on_bytes(h, &framed(b"hi")),
        vec![Event::Frame(b"hi".to_vec())]
    );
    r.send(h, Class::Message, 0, b"out").unwrap();
    assert_eq!(r.poll_out(h).unwrap(), framed(b"out"));
}

/// THE USE-AFTER-FREE. A host that keeps a handle after closing must get
/// nothing — never a connection that has since been opened in the same slot.
/// Without the generation tag this is somebody else's traffic.
#[test]
fn a_stale_handle_never_addresses_a_reused_slot() {
    let mut r = Registry::new();
    let first = r.open();
    r.on_open(first);
    assert!(r.close(first));

    let second = r.open();
    assert_eq!(
        r.allocated(),
        1,
        "the freed slot was not reused, so this proves nothing"
    );
    assert_ne!(first, second, "a reused slot produced an identical handle");

    r.on_open(second);
    // The stale handle must be inert against the connection now living there.
    assert!(r.on_bytes(first, &framed(b"leak")).is_empty());
    assert!(r.poll_out(first).is_none());
    assert!(r.send(first, Class::Message, 0, b"x").is_err());
    // And the live one must be unaffected by any of that.
    assert!(r.send(second, Class::Message, 0, b"fine").is_ok());
    assert_eq!(r.poll_out(second).unwrap(), framed(b"fine"));
}

/// A host may legitimately race a close against a transport error, so a second
/// close is a no-op rather than a panic — but it must report that it did
/// nothing, so a caller cannot mistake it for having closed something.
#[test]
fn closing_twice_is_a_no_op_not_a_panic() {
    let mut r = Registry::new();
    let h = r.open();
    assert!(r.close(h));
    assert!(!r.close(h));
    assert_eq!(r.live(), 0);
}

#[test]
fn an_unknown_handle_is_inert() {
    let mut r = Registry::new();
    let bogus = Handle::from_raw(0xdead_beef_0000_0001);
    assert!(r.on_open(bogus).is_empty());
    assert!(r.on_bytes(bogus, b"x").is_empty());
    assert!(r.poll_out(bogus).is_none());
    assert!(!r.close(bogus));
    r.set_applied_epoch(bogus, 5); // must not panic
}

#[test]
fn connections_do_not_share_state() {
    let mut r = Registry::new();
    let a = r.open();
    let b = r.open();
    r.on_open(a);
    r.on_open(b);

    r.send(a, Class::Message, 0, b"for a").unwrap();
    assert!(
        r.poll_out(b).is_none(),
        "a frame queued on one connection surfaced on another"
    );
    assert_eq!(r.poll_out(a).unwrap(), framed(b"for a"));
}

#[test]
fn slots_are_reused_rather_than_grown() {
    let mut r = Registry::new();
    for _ in 0..1000 {
        let h = r.open();
        r.on_open(h);
        r.close(h);
    }
    assert_eq!(r.live(), 0);
    // A thousand reconnects must not leave a thousand slots resident.
    assert_eq!(r.allocated(), 1);
}

/// One crossing for many frames. A JSI call per frame is the cost that makes
/// people abandon a native module.
#[test]
fn events_flatten_into_one_buffer() {
    let events = vec![
        Event::Open,
        Event::Frame(b"ab".to_vec()),
        Event::Closed(CloseReason::Local),
    ];
    let out = encode_events(&events);
    assert_eq!(
        out,
        vec![
            EVENT_OPEN,
            EVENT_FRAME,
            0,
            0,
            0,
            2,
            b'a',
            b'b',
            EVENT_CLOSED,
            CLOSE_LOCAL
        ]
    );
}

/// The specific parse failure must NOT cross the boundary. The host's only
/// correct response to any of them is the same — drop and reconnect — and a
/// parse-failure detail handed to application code ends up in a log, attached
/// to whoever was talking to us.
#[test]
fn a_protocol_close_carries_no_parse_detail_across_the_boundary() {
    use transport_core::frame::FrameError;
    let a = encode_events(&[Event::Closed(CloseReason::Protocol(FrameError::BadVersion))]);
    let b = encode_events(&[Event::Closed(CloseReason::Protocol(
        FrameError::LengthOverMax,
    ))]);
    assert_eq!(
        a, b,
        "two different parse failures are distinguishable to the host"
    );
    assert_eq!(a, vec![EVENT_CLOSED, CLOSE_PROTOCOL]);
}

#[test]
fn hex_round_trips_and_refuses_malformed_input() {
    assert_eq!(to_hex(&[0x00, 0x0f, 0xff]), "000fff");
    assert_eq!(from_hex("000fff").unwrap(), vec![0x00, 0x0f, 0xff]);
    assert_eq!(from_hex("000FFF").unwrap(), vec![0x00, 0x0f, 0xff]);
    assert_eq!(to_hex(&[]), "");
    assert_eq!(from_hex("").unwrap(), Vec::<u8>::new());

    // A half-decoded identifier is worse than none.
    assert!(from_hex("abc").is_none(), "odd length accepted");
    assert!(from_hex("zz").is_none(), "non-hex accepted");
    assert!(from_hex("0g").is_none());
}
