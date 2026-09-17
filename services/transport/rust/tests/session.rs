//! Session lifecycle.
//!
//! The questions here — "does a dead connection get noticed", "does a rejected
//! resume ever look like a success", "do ten thousand clients come back at the
//! same millisecond" — are normally answered by an outage. `session` is pure
//! and takes both its clock and its jitter entropy from the caller precisely so
//! they can be answered by assertions instead.

use transport_core::parse::Limits;
use transport_core::session::{
    backoff_delay_ms, Accepted, Beat, Capabilities, ErrorClass, Recovery, ResumeToken, ServerHello,
    Session, SessionError, State, BACKOFF_MAX_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS,
};

fn hello(caps: Capabilities, resumed: bool) -> ServerHello {
    ServerHello {
        capabilities: caps,
        limits: Limits::default(),
        heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
        resumed,
        resume_token: None,
    }
}

/// Drive a fresh session to Ready against a server offering `peer`.
fn ready(peer: Capabilities, now_ms: u64) -> Session {
    let mut s = Session::new(Capabilities::all(), 1);
    s.connect().unwrap();
    s.send_client_hello(false).unwrap();
    s.on_server_hello(hello(peer, false), now_ms).unwrap();
    s
}

/// A dropped transition is how a client ends up believing it is Ready on a
/// socket that finished no handshake, then sends frames to a peer that agreed
/// to nothing. Refused, and the refusal names the edge.
#[test]
fn an_illegal_transition_is_refused_not_ignored() {
    let mut s = Session::new(Capabilities::all(), 1);
    assert_eq!(
        s.on_server_hello(hello(Capabilities::all(), false), 0),
        Err(SessionError::IllegalTransition {
            from: State::Idle,
            to: State::Ready
        })
    );
    assert_eq!(
        s.state(),
        State::Idle,
        "a refused edge must not have moved the machine"
    );

    s.connect().unwrap();
    s.send_client_hello(false).unwrap();
    s.on_server_hello(hello(Capabilities::all(), false), 0)
        .unwrap();
    assert_eq!(s.state(), State::Ready);

    // A second connect on a live session would leave two sockets and one state.
    assert!(matches!(
        s.connect(),
        Err(SessionError::IllegalTransition { .. })
    ));
    assert_eq!(s.state(), State::Ready);
}

/// Union would mean the peer decides what code runs here.
#[test]
fn capabilities_negotiate_by_intersection_never_union() {
    let peer = Capabilities {
        fragmentation: true,
        resumption: false,
        datagrams: true,
        ..Capabilities::default()
    };
    let s = ready(peer, 0);
    let n = s.negotiated().expect("Ready implies a negotiated set");

    assert!(n.fragmentation, "both offered it");
    assert!(
        !n.resumption,
        "the server did not offer it — we must not have it"
    );
    assert!(
        !n.causal_epochs,
        "only we offered it — that is not agreement"
    );
    assert!(n.datagrams);
}

/// An unknown capability is INERT: carried, never consulted. A build that
/// cannot name a capability cannot implement it.
#[test]
fn an_unknown_capability_stays_inert() {
    let peer = Capabilities {
        experimental: vec!["quantum_tunnel".into(), "plaintext_fallback".into()],
        ..Capabilities::default()
    };
    let s = ready(peer, 0);
    let n = s.negotiated().unwrap();

    assert_eq!(
        n.experimental,
        ["quantum_tunnel", "plaintext_fallback"],
        "echoed back unmodified"
    );
    assert_eq!(
        *n,
        Capabilities {
            experimental: n.experimental.clone(),
            ..Capabilities::default()
        },
        "an unknown name activated something"
    );
}

/// Negotiation is not authority. A peer proposing a LARGER bound than this
/// build compiled with does not get it.
#[test]
fn a_peer_cannot_negotiate_a_limit_upward() {
    let mut s = Session::new(Capabilities::all(), 1);
    s.connect().unwrap();
    s.send_client_hello(false).unwrap();

    let greedy = ServerHello {
        limits: Limits {
            max_frame_bytes: 64 * 1024 * 1024,
            max_string_field_bytes: 128, // smaller: this one binds
            ..Limits::default()
        },
        heartbeat_interval_ms: 600_000, // "ping me once every ten minutes"
        heartbeat_timeout_ms: 2_000,    // stricter: this one binds
        ..hello(Capabilities::all(), false)
    };
    s.on_server_hello(greedy, 0).unwrap();

    assert_eq!(
        s.limits().max_frame_bytes,
        Limits::default().max_frame_bytes,
        "a bound was raised"
    );
    assert_eq!(
        s.limits().max_string_field_bytes,
        128,
        "a smaller proposal must be accepted"
    );
    assert_eq!(
        s.heartbeat_interval_ms(),
        HEARTBEAT_INTERVAL_MS,
        "a peer stretched the liveness window — dead connections would go unnoticed"
    );
    assert_eq!(s.heartbeat_timeout_ms(), 2_000);
}

/// THE POINT OF A PURE CLOCK. Silence is noticed at an exact millisecond, and
/// the test says which one.
#[test]
fn silence_past_the_timeout_declares_the_connection_dead() {
    let mut s = ready(Capabilities::all(), 0);

    assert_eq!(s.poll(9_999), Beat::Idle);
    assert_eq!(
        s.poll(10_000),
        Beat::SendPing,
        "the interval elapsed and nothing was probed"
    );
    assert_eq!(
        s.poll(10_001),
        Beat::Idle,
        "a ping is outstanding — do not flood"
    );
    assert_eq!(s.poll(14_999), Beat::Idle);
    assert_eq!(
        s.poll(15_000),
        Beat::Dead,
        "the deadline IS the deadline, not the ms after it"
    );
}

/// A ping exists only because nothing else arrived. Real traffic proves the
/// same thing, so it must reset the same timer.
#[test]
fn inbound_traffic_defers_the_ping() {
    let mut s = ready(Capabilities::all(), 0);
    assert_eq!(s.poll(10_000), Beat::SendPing);
    s.on_traffic(10_050); // pong, or anything else
    assert_eq!(
        s.poll(15_000),
        Beat::Idle,
        "answered ping still declared dead"
    );
    assert_eq!(s.poll(20_049), Beat::Idle);
    assert_eq!(s.poll(20_050), Beat::SendPing);
}

/// `ServerHello.resumed = false` is a COMMAND. A half-resumed stream that
/// nobody was told about is missing messages nobody will ask for again.
#[test]
fn a_rejected_resume_demands_a_full_resync() {
    let mut s = Session::new(Capabilities::all(), 1);
    s.connect().unwrap();
    s.send_client_hello(false).unwrap();
    let issued = ServerHello {
        resume_token: Some(ResumeToken::new("tok-1")),
        ..hello(Capabilities::all(), false)
    };
    s.on_server_hello(issued, 0).unwrap();
    assert!(s.can_resume());

    assert_eq!(
        s.on_disconnect(ErrorClass::Retryable, 0),
        Recovery::Retry {
            at_ms: backoff_delay_ms(0, 1)
        },
        "the wake-up instant must be reproducible from the seed alone"
    );
    s.connect().unwrap();
    s.send_client_hello(true).unwrap();
    assert_eq!(
        s.on_server_hello(hello(Capabilities::all(), false), 1_000)
            .unwrap(),
        Accepted::FullResync
    );
    assert!(
        !s.can_resume(),
        "a rejected token was kept and will be offered again"
    );

    // And the success path is reachable, so FullResync is not just a constant.
    let mut ok = Session::new(Capabilities::all(), 1);
    ok.connect().unwrap();
    ok.send_client_hello(false).unwrap();
    ok.on_server_hello(
        ServerHello {
            resume_token: Some(ResumeToken::new("tok-2")),
            ..hello(Capabilities::all(), false)
        },
        0,
    )
    .unwrap();
    ok.on_disconnect(ErrorClass::Retryable, 0);
    ok.connect().unwrap();
    ok.send_client_hello(true).unwrap();
    assert_eq!(
        ok.on_server_hello(hello(Capabilities::all(), true), 10)
            .unwrap(),
        Accepted::Resumed
    );
}

/// A server claiming `resumed` for a client that presented nothing is not
/// resumed. The safer reading wins: a needless resync costs bandwidth, a
/// missed one costs messages.
#[test]
fn resumed_without_an_offered_token_is_still_a_full_resync() {
    let mut s = Session::new(Capabilities::all(), 1);
    s.connect().unwrap();
    s.send_client_hello(false).unwrap();
    assert_eq!(
        s.on_server_hello(hello(Capabilities::all(), true), 0)
            .unwrap(),
        Accepted::FullResync
    );
}

/// Offering a resume with nothing to offer fails HERE, loudly, rather than
/// being discovered later as a fake success.
#[test]
fn a_resume_cannot_be_offered_without_a_token() {
    let mut s = Session::new(Capabilities::all(), 1);
    s.connect().unwrap();
    assert_eq!(
        s.send_client_hello(true),
        Err(SessionError::ResumeUnavailable)
    );
    assert_eq!(s.state(), State::Connecting);
}

/// Unjittered backoff turns one server blip into a synchronised stampede.
#[test]
fn backoff_grows_is_capped_and_does_not_synchronise_clients() {
    let seed = 0xabcd_ef01;
    let d0 = backoff_delay_ms(0, seed);
    let d3 = backoff_delay_ms(3, seed);
    let d6 = backoff_delay_ms(6, seed);
    assert!(d0 < d3 && d3 < d6, "backoff did not grow: {d0} {d3} {d6}");

    for a in 0..64u32 {
        let d = backoff_delay_ms(a, seed);
        assert!(d <= BACKOFF_MAX_MS, "attempt {a} slept {d}ms, past the cap");
        assert!(d > 0, "a zero delay is not a backoff");
    }
    // Past the cap the WINDOW is flat; the draw inside it still moves, which is
    // the whole point — a flat value would put every client's tenth attempt on
    // the same millisecond again.
    for a in 6..64u32 {
        let d = backoff_delay_ms(a, seed);
        assert!(
            (BACKOFF_MAX_MS / 2..=BACKOFF_MAX_MS).contains(&d),
            "attempt {a} left the cap"
        );
    }

    // The property that matters: same outage, same attempt, different clients,
    // DIFFERENT instants.
    let mut s1 = Session::new(Capabilities::all(), 1);
    let mut s2 = Session::new(Capabilities::all(), 2);
    for s in [&mut s1, &mut s2] {
        s.connect().unwrap();
        s.send_client_hello(false).unwrap();
        s.on_server_hello(hello(Capabilities::all(), false), 0)
            .unwrap();
    }
    let mut woke = Vec::new();
    for _ in 0..5 {
        for (s, out) in [(&mut s1, 0usize), (&mut s2, 1usize)] {
            if let Recovery::Retry { at_ms } = s.on_disconnect(ErrorClass::Retryable, 1_000) {
                woke.push((out, at_ms));
            } else {
                panic!("a retryable disconnect did not schedule a retry");
            }
            s.connect().unwrap();
            s.send_client_hello(false).unwrap();
        }
    }
    for pair in woke.chunks(2) {
        assert_ne!(
            pair[0].1, pair[1].1,
            "two clients woke at the same instant: {pair:?}"
        );
    }
}

/// A successful handshake means the outage is over. Not resetting is how a
/// client that flaps once sleeps for 30s on every subsequent blip.
#[test]
fn a_completed_handshake_resets_the_backoff() {
    let mut s = ready(Capabilities::all(), 0);
    s.on_disconnect(ErrorClass::Retryable, 0);
    s.on_disconnect(ErrorClass::Retryable, 0);
    assert_eq!(s.attempt(), 2);
    s.connect().unwrap();
    s.send_client_hello(false).unwrap();
    s.on_server_hello(hello(Capabilities::all(), false), 100)
        .unwrap();
    assert_eq!(s.attempt(), 0);
}

/// Retrying an expired credential forever is how a client hammers a server it
/// can never satisfy. No amount of waiting renews a token.
#[test]
fn an_auth_error_does_not_schedule_a_retry() {
    let mut s = Session::new(Capabilities::all(), 1);
    s.connect().unwrap();
    s.send_client_hello(false).unwrap();
    s.on_server_hello(
        ServerHello {
            resume_token: Some(ResumeToken::new("tok-auth")),
            ..hello(Capabilities::all(), false)
        },
        0,
    )
    .unwrap();

    assert_eq!(s.on_disconnect(ErrorClass::Auth, 5_000), Recovery::ReAuth);
    assert_eq!(s.state(), State::Closed);
    assert_eq!(
        s.attempt(),
        0,
        "an auth failure must not advance the retry schedule"
    );
    assert!(
        !s.can_resume(),
        "the token outlived the credential that authorised it"
    );

    // Fatal likewise, and a class we cannot name is Stop by choice.
    let mut f = ready(Capabilities::all(), 0);
    assert_eq!(f.on_disconnect(ErrorClass::Fatal, 0), Recovery::Stop);
    let mut u = ready(Capabilities::all(), 0);
    assert_eq!(u.on_disconnect(ErrorClass::Unspecified, 0), Recovery::Stop);
}

/// A dead connection is REPORTED. A session that never connected has not
/// failed, and must not be able to say it did.
#[test]
fn an_unconnected_session_is_never_declared_dead() {
    let mut s = Session::new(Capabilities::all(), 1);
    assert_eq!(s.poll(u64::MAX), Beat::Idle);
    s.close();
    assert_eq!(s.poll(u64::MAX), Beat::Idle);
}

/// The token is a CREDENTIAL. `#[derive(Debug)]` on anything holding it would
/// put it in every log line that ever formats the holder.
#[test]
fn the_resume_token_never_appears_in_debug_output() {
    let secret = "s3cr3t-resume-material";
    let tok = ResumeToken::new(secret);
    assert_eq!(tok.expose(), secret);
    assert!(!format!("{tok:?}").contains(secret));

    let h = ServerHello {
        resume_token: Some(ResumeToken::new(secret)),
        ..hello(Capabilities::all(), true)
    };
    assert!(
        !format!("{h:?}").contains(secret),
        "ServerHello leaked the token"
    );

    let mut s = Session::new(Capabilities::all(), 1);
    s.connect().unwrap();
    s.send_client_hello(false).unwrap();
    s.on_server_hello(h, 0).unwrap();
    assert!(s.can_resume());
    assert!(
        !format!("{s:?}").contains(secret),
        "Session leaked the token"
    );

    s.close();
    assert!(
        !s.can_resume(),
        "clearing the session must clear the credential"
    );
}

// ── positions: the half of resume that was never put on the wire ────
//
// `Session` held a token and exposed `can_resume()`, and `body::client_hello`
// had no way to encode either — so the state machine was complete and its
// output was discarded. These pin the part that makes it reachable.

#[test]
fn positions_track_the_highest_seq_per_stream() {
    let mut s = Session::new(Capabilities::all(), 1);
    s.note_delivered(2, 5);
    s.note_delivered(2, 3); // older: must not regress
    s.note_delivered(3, 9);
    let mut got: Vec<(u32, u64)> = s.positions().collect();
    got.sort_unstable();
    assert_eq!(got, vec![(2, 5), (3, 9)]);
}

#[test]
fn unsequenced_and_out_of_range_frames_move_nothing() {
    // seq 0 is the whole control plane and every EPHEMERAL frame — lossy by
    // design, and never sequenced by the server. A stream outside StreamId is
    // untrusted input off the network, so it is ignored rather than panicking.
    let mut s = Session::new(Capabilities::all(), 1);
    s.note_delivered(2, 0);
    s.note_delivered(0, 4);
    s.note_delivered(99, 4);
    assert_eq!(s.positions().count(), 0);
}

#[test]
fn a_refused_resume_clears_the_positions_with_the_token() {
    // They belong to the session that produced them. A server answering
    // resumed=false has started a NEW session numbering from 1, so carrying
    // them forward would make the next reconnect claim a position far ahead of
    // anything that session sent — which the server refuses as a future cursor.
    // One un-resumed connection would poison every resume after it.
    let mut s = Session::new(Capabilities::all(), 1);
    s.connect().unwrap();
    s.send_client_hello(false).unwrap();
    s.on_server_hello(
        ServerHello {
            capabilities: Capabilities::all(),
            limits: Default::default(),
            heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
            heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
            resumed: false,
            resume_token: Some(ResumeToken::new("tok-1")),
        },
        0,
    )
    .unwrap();
    s.note_delivered(2, 42);
    assert_eq!(s.positions().count(), 1);

    // A second connection that the server refuses to resume.
    s.on_disconnect(ErrorClass::Retryable, 1_000);
    s.connect().unwrap();
    s.send_client_hello(true).unwrap();
    s.on_server_hello(
        ServerHello {
            capabilities: Capabilities::all(),
            limits: Default::default(),
            heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
            heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
            resumed: false,
            resume_token: Some(ResumeToken::new("tok-2")),
        },
        2_000,
    )
    .unwrap();
    assert_eq!(
        s.positions().count(),
        0,
        "positions survived a session the server refused"
    );
}

#[test]
fn clearing_the_session_clears_the_positions() {
    // A position is a claim about a session. Outliving it makes it a claim
    // about nothing, offered to whoever connects next.
    let mut s = Session::new(Capabilities::all(), 1);
    s.note_delivered(2, 7);
    s.close();
    assert_eq!(s.positions().count(), 0);
}
