//! Path selection.
//!
//! Eligibility is a CONJUNCTION, so the only honest way to test it is to remove
//! one term at a time and prove the frame is refused anyway. A test that only
//! checks the happy path passes just as well against `if small { Datagram }`,
//! which is the exact bug this module exists to prevent.

use transport_core::select::{
    datagram_eligible, must_be_reliable, path, Candidate, Negotiated, NotDatagram, Path,
    MAX_DATAGRAM_BYTES,
};

const EPHEMERAL: u32 = 5;
const MESSAGING: u32 = 3;
const TYPING_STATE: u32 = 81;
const VIEWER_STATE: u32 = 82;
const GEO_RELAY: u32 = 84;
const CRYPTO_CONTROL: u32 = 98;

fn both() -> Negotiated {
    Negotiated {
        local: true,
        peer: true,
    }
}

fn typing() -> Candidate {
    Candidate {
        traffic_class: EPHEMERAL,
        body_field: Some(TYPING_STATE),
        bytes: 64,
        terminal: false,
    }
}

/// The one shape that is allowed. Everything below removes a term from it.
#[test]
fn every_term_present_earns_a_datagram() {
    assert_eq!(datagram_eligible(both(), &typing()), Ok(()));
    assert_eq!(path(both(), &typing()), Path::Datagram);

    let viewer = Candidate {
        body_field: Some(VIEWER_STATE),
        ..typing()
    };
    let live_geo = Candidate {
        body_field: Some(GEO_RELAY),
        ..typing()
    };
    assert_eq!(path(both(), &viewer), Path::Datagram);
    assert_eq!(path(both(), &live_geo), Path::Datagram);
}

/// Negotiation is agreement, not one side's wish.
#[test]
fn one_sided_support_is_not_a_negotiated_capability() {
    for n in [
        Negotiated {
            local: true,
            peer: false,
        },
        Negotiated {
            local: false,
            peer: true,
        },
        Negotiated::default(),
    ] {
        assert_eq!(
            datagram_eligible(n, &typing()),
            Err(NotDatagram::CapabilityNotNegotiated),
            "a datagram was allowed without both sides agreeing"
        );
    }
}

/// Removing the class term. The capability is on and the frame is tiny — the
/// two properties that tempt a "small and unimportant" shortcut.
#[test]
fn a_non_ephemeral_class_is_refused_even_with_the_capability_on() {
    for class in [1u32, 2, 3, 4] {
        let c = Candidate {
            traffic_class: class,
            bytes: 8,
            ..typing()
        };
        assert_eq!(
            datagram_eligible(both(), &c),
            Err(NotDatagram::ClassNotEphemeral),
            "class {class} was sent over a droppable path"
        );
        assert!(must_be_reliable(both(), &c));
    }
}

/// Removing the body term. EPHEMERAL class alone does not make a body droppable.
#[test]
fn an_ephemeral_class_with_a_non_ephemeral_body_is_refused() {
    for body in [
        Some(19u32),
        Some(80),
        Some(83),
        Some(CRYPTO_CONTROL),
        Some(112),
        None,
    ] {
        let c = Candidate {
            body_field: body,
            ..typing()
        };
        assert_eq!(
            datagram_eligible(both(), &c),
            Err(NotDatagram::BodyNotEphemeral),
            "body {body:?} was treated as ephemeral"
        );
    }
}

/// An unrecognised field number is not on the allow-list, so it is refused for
/// the same reason a known-but-wrong body is. Unknown must never mean permitted.
#[test]
fn an_unknown_body_field_is_refused_rather_than_assumed_harmless() {
    let c = Candidate {
        body_field: Some(1234),
        ..typing()
    };
    assert_eq!(
        datagram_eligible(both(), &c),
        Err(NotDatagram::BodyNotEphemeral)
    );
}

/// Removing the size term.
#[test]
fn an_oversized_ephemeral_frame_is_refused() {
    let fits = Candidate {
        bytes: MAX_DATAGRAM_BYTES,
        ..typing()
    };
    let does_not = Candidate {
        bytes: MAX_DATAGRAM_BYTES + 1,
        ..typing()
    };
    assert_eq!(datagram_eligible(both(), &fits), Ok(()));
    assert_eq!(
        datagram_eligible(both(), &does_not),
        Err(NotDatagram::OverDatagramBudget)
    );
}

/// envelope.proto: a terminal GeoRelay is MESSAGING, because losing one leaves a
/// phantom trip on every peer's map. Its class and body are indistinguishable
/// from a live position update, so only the `terminal` flag can catch it.
#[test]
fn a_terminal_geo_relay_is_refused_a_datagram() {
    let live = Candidate {
        body_field: Some(GEO_RELAY),
        ..typing()
    };
    let ended = Candidate {
        terminal: true,
        ..live
    };

    assert_eq!(datagram_eligible(both(), &live), Ok(()));
    assert_eq!(
        datagram_eligible(both(), &ended),
        Err(NotDatagram::TerminalGeoRelay)
    );
    assert!(must_be_reliable(both(), &ended));

    // And when the caller has already put it on MESSAGING, it stays reliable.
    let messaging = Candidate {
        traffic_class: MESSAGING,
        ..ended
    };
    assert!(must_be_reliable(both(), &messaging));
}

/// The failure the module exists to prevent, stated directly: a key event must
/// never travel over a droppable path, under ANY combination of the other terms.
#[test]
fn crypto_control_is_never_datagram_eligible() {
    for class in [1u32, 2, 3, 4, 5] {
        for bytes in [0usize, 1, 64, MAX_DATAGRAM_BYTES, MAX_DATAGRAM_BYTES + 1] {
            for terminal in [false, true] {
                for n in [
                    both(),
                    Negotiated {
                        local: true,
                        peer: false,
                    },
                    Negotiated::default(),
                ] {
                    let c = Candidate {
                        traffic_class: class,
                        body_field: Some(CRYPTO_CONTROL),
                        bytes,
                        terminal,
                    };
                    assert!(
                        must_be_reliable(n, &c),
                        "crypto_control became datagram-eligible: class={class} bytes={bytes}"
                    );
                }
            }
        }
    }
}

/// The inverse property. There is no third path: not eligible means reliable.
#[test]
fn anything_not_eligible_goes_reliably() {
    for class in [0u32, 1, 2, 3, 4, 5] {
        for body in [None, Some(19u32), Some(81), Some(82), Some(84), Some(98)] {
            for bytes in [0usize, 1200, 1201] {
                for terminal in [false, true] {
                    let c = Candidate {
                        traffic_class: class,
                        body_field: body,
                        bytes,
                        terminal,
                    };
                    let eligible = datagram_eligible(both(), &c).is_ok();
                    assert_eq!(eligible, path(both(), &c) == Path::Datagram);
                    assert_eq!(!eligible, must_be_reliable(both(), &c));
                }
            }
        }
    }
}

/// The safe answer is the one you get by doing nothing.
#[test]
fn the_default_path_is_reliable() {
    assert_eq!(Path::default(), Path::Reliable);
    assert!(must_be_reliable(
        Negotiated::default(),
        &Candidate::default()
    ));
}
