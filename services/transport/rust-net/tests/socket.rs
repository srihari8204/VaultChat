//! REAL SOCKETS. Every test in this file binds `127.0.0.1:0`, accepts a real
//! TCP connection, completes a real WebSocket upgrade and exchanges real
//! CC-Wire frames.
//!
//! WHY NOT IN-MEMORY. `transport-core` already has 107 tests that drive the
//! state machine with no network at all, and those are the right tests for
//! "does the logic decide correctly". They cannot answer "does the networking
//! work", because the bugs that live in a networking layer are exactly the ones
//! an in-memory harness deletes: a frame arriving in two pieces because the
//! path MTU said so, two frames coalescing into one read, a peer vanishing
//! between the header and the body, a writer that queues faster than a socket
//! drains. Each of those is a test below, against a socket the OS actually
//! allocated.
//!
//! The port is always EPHEMERAL (`:0`, assigned by the kernel) so the suite
//! runs in parallel, runs in CI, and cannot collide with a developer's server.
//!
//! WHAT THE SERVER HERE IS. A minimal stand-in for
//! `vaultchat-backend-go/internal/realtime/ccwire.go`, matching it where the
//! client can tell the difference: it checks the `Authorization` header at the
//! upgrade, speaks binary messages only, and answers ClientHello with a
//! ServerHello carrying the same limits `encodeLimits` sends. It is NOT a
//! second implementation of the protocol — the framing it uses is
//! `transport_core::frame`, the same functions the client uses, and the bytes
//! those produce are pinned against the shared Go/TypeScript fixture by
//! `wire_bytes_match_the_shared_fixture` below.

use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use transport_core::conn::{CloseReason, Event, SendError};
use transport_core::frame::{decode, encode, FrameError};
use transport_core::parse::{decode_frame, encode_frame, Frame, Limits};
use transport_core::sched::{Class, Reject};
use transport_core::session::{Accepted, Capabilities, ErrorClass, Session, State};
use transport_net::{bodies, wait_for_retry, Connection, NetError, TRAFFIC_CLASS_CONTROL};

const TRAFFIC_CLASS_BULK: u32 = 4;
/// `Frame.message_send` — an ordinary application body, chosen because it is
/// neither handshake nor keepalive, so the client must surface it untouched.
const BODY_APP: u32 = 80;
/// Long enough that a loaded CI box is not the thing that fails; short enough
/// that a genuine hang is a failed test rather than a stuck job.
const PATIENCE: Duration = Duration::from_secs(5);

// ── the server side of a real socket ─────────────────────────────────────

struct Peer {
    ws: WebSocketStream<TcpStream>,
    /// The `Authorization` header exactly as it arrived on the UPGRADE request.
    auth: String,
}

impl Peer {
    /// Send one CC-Wire frame as one binary message, framed by `transport-core`.
    async fn send_frame(&mut self, payload: &[u8]) {
        let bytes = encode(payload, 0).expect("encode");
        self.send_raw(&bytes).await;
    }

    /// Send arbitrary bytes as one binary message — used to put a MALFORMED
    /// frame, or half of a good one, on the wire.
    async fn send_raw(&mut self, bytes: &[u8]) {
        self.ws.send(Message::Binary(bytes.to_vec().into())).await.expect("server send");
        self.ws.flush().await.expect("server flush");
    }

    /// The raw bytes of the next binary message, as they came off the socket.
    async fn recv_raw(&mut self) -> Vec<u8> {
        loop {
            match timeout(PATIENCE, self.ws.next()).await.expect("server read timed out") {
                Some(Ok(Message::Binary(b))) => return b.to_vec(),
                Some(Ok(_)) => continue, // ws-level ping/pong housekeeping
                other => panic!("server expected a binary message, got {other:?}"),
            }
        }
    }

    /// The next frame's payload, with the length prefix stripped by the same
    /// decoder the client uses.
    async fn recv_frame(&mut self) -> Vec<u8> {
        let raw = self.recv_raw().await;
        decode(&raw, 0, true).expect("server: peer sent an unframeable message").payload.to_vec()
    }

    /// Read one ClientHello and answer it, exactly as `ccwire.go` does: the
    /// credential inside is NOT read, because the connection was authenticated
    /// at the upgrade.
    async fn expect_client_hello_and_reply(&mut self, hb_interval: u64, hb_timeout: u64) {
        let payload = self.recv_frame().await;
        let f = decode_frame(&payload, &Limits::default(), 0, 0).expect("ClientHello decodes");
        assert_eq!(f.body_field, Some(bodies::CLIENT_HELLO), "handshake must come first");
        assert_eq!(f.traffic_class, TRAFFIC_CLASS_CONTROL);
        self.send_body(bodies::SERVER_HELLO, &server_hello_body(hb_interval, hb_timeout)).await;
    }

    async fn send_body(&mut self, body_field: u32, body: &[u8]) {
        self.send_frame(&frame_bytes(body_field, body)).await;
    }
}

/// Bind an ephemeral port and accept exactly one upgrade.
///
/// Returns the URL to point a client at and a handle that yields the server
/// side once the handshake completes. Nothing is mocked: this is a listening
/// TCP socket the kernel assigned a port to.
// The `Err` shape of the upgrade callback is tungstenite's `ErrorResponse`, not
// ours; it is never constructed here and cannot be made smaller from this side.
#[allow(clippy::result_large_err)]
async fn listen() -> (String, JoinHandle<Peer>) {
    let l = TcpListener::bind("127.0.0.1:0").await.expect("bind ephemeral port");
    let port = l.local_addr().expect("local_addr").port();
    let handle = tokio::spawn(async move {
        let (sock, _) = l.accept().await.expect("accept");
        let mut auth = String::new();
        let ws = tokio_tungstenite::accept_hdr_async(sock, |req: &Request, resp: Response| {
            auth = req
                .headers()
                .get("Authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            Ok(resp)
        })
        .await
        .expect("server upgrade");
        Peer { ws, auth }
    });
    (format!("ws://127.0.0.1:{port}/ccwire/v1"), handle)
}

/// Connect a client and complete the handshake against a live `Peer`, with the
/// heartbeat contract from `capabilities.proto`.
async fn connected(session: &mut Session) -> (Connection<'_>, Peer) {
    connected_hb(session, 10_000, 5_000).await
}

/// The same, with the server proposing a TIGHTER heartbeat — which is the only
/// direction a peer may move a bound. Lets the keepalive tests run in
/// milliseconds instead of in ten-second sleeps.
async fn connected_hb(session: &mut Session, interval: u64, tmo: u64) -> (Connection<'_>, Peer) {
    let (url, server) = listen().await;
    let mut c = Connection::open(&url, "test-token", session).await.expect("client connect");
    let mut peer = server.await.expect("server task");
    let (accepted, ()) = tokio::join!(
        c.handshake("test-device", &[]),
        peer.expect_client_hello_and_reply(interval, tmo)
    );
    assert_eq!(accepted.expect("handshake"), Accepted::FullResync);
    (c, peer)
}

// ── minimal protobuf, for the server's half only ─────────────────────────

fn pb_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn pb_field_varint(out: &mut Vec<u8>, field: u32, v: u64) {
    pb_varint(out, (field as u64) * 8);
    pb_varint(out, v);
}

fn pb_field_bytes(out: &mut Vec<u8>, field: u32, b: &[u8]) {
    pb_varint(out, (field as u64) * 8 + 2);
    pb_varint(out, b.len() as u64);
    out.extend_from_slice(b);
}

/// `serverHello()` from `ccwire.go`, field for field — including the limits
/// (13, 14) that carry the heartbeat contract from `capabilities.proto`.
fn server_hello_body(hb_interval: u64, hb_timeout: u64) -> Vec<u8> {
    let mut caps = Vec::new();
    pb_field_varint(&mut caps, 7, 1); // structured_errors, the only one Go offers

    let mut lim = Vec::new();
    pb_field_varint(&mut lim, 1, 262_144); // max_frame_bytes
    pb_field_varint(&mut lim, 2, 196_608);
    pb_field_varint(&mut lim, 3, 1_048_576);
    pb_field_varint(&mut lim, 4, 16);
    pb_field_varint(&mut lim, 8, 6);
    pb_field_varint(&mut lim, 9, 1024);
    pb_field_varint(&mut lim, 10, 4096);
    pb_field_varint(&mut lim, 13, hb_interval); // heartbeat_interval_ms
    pb_field_varint(&mut lim, 14, hb_timeout); // heartbeat_timeout_ms

    let mut b = Vec::new();
    pb_field_varint(&mut b, 1, 1); // protocol_major
    pb_field_bytes(&mut b, 3, &caps);
    pb_field_bytes(&mut b, 4, &lim);
    pb_field_bytes(&mut b, 5, b"session-1");
    pb_field_varint(&mut b, 7, 1_700_000_000_000);
    // resumed (8) is false — a proto3 default, therefore not written.
    b
}

/// One `ccwire.v1.Frame`, encoded by `transport-core` rather than by hand.
fn frame_bytes(body_field: u32, body: &[u8]) -> Vec<u8> {
    encode_frame(
        &Frame {
            request_id: "",
            traffic_class: TRAFFIC_CLASS_CONTROL,
            stream: 1,
            seq: 0,
            depends_on: 0,
            body_field: Some(body_field),
            body,
            unknown: Vec::new(),
        },
        &Limits::default(),
        0,
    )
    .expect("encode_frame")
}

fn session() -> Session {
    Session::new(Capabilities::all(), 0xfeed_face_dead_beef)
}

async fn next(c: &mut Connection<'_>) -> Option<Event> {
    timeout(PATIENCE, c.next_event()).await.expect("client event timed out")
}

// ── the tests ────────────────────────────────────────────────────────────

/// The upgrade carries the Bearer token, and the handshake completes over a
/// socket the kernel assigned.
///
/// The header assertion is the one that matters: `ccwire.go` wraps its handler
/// in `httpx.RequireAuth` BEFORE `Upgrade`, so a client that sends the token in
/// a first frame instead never gets a socket at all — it gets a 401.
#[tokio::test]
async fn bearer_token_rides_the_upgrade_and_the_handshake_completes() {
    let mut s = session();
    let (c, peer) = connected(&mut s).await;

    assert_eq!(peer.auth, "Bearer test-token", "token must be on the UPGRADE request");
    assert_eq!(c.session().state(), State::Ready);

    // Capabilities negotiate by INTERSECTION: the stand-in server offers only
    // structured_errors, so only structured_errors survives even though this
    // client offered all seven.
    let neg = c.session().negotiated().expect("negotiated");
    assert!(neg.structured_errors);
    assert!(!neg.fragmentation && !neg.resumption && !neg.datagrams);

    // The SERVER's limits bind, and they tightened ours from the 2 MiB hard max.
    assert_eq!(c.session().limits().max_frame_bytes, 262_144);
    assert_eq!(c.session().heartbeat_interval_ms(), 10_000);
    assert_eq!(c.session().heartbeat_timeout_ms(), 5_000);
}

/// ONE frame, TWO writes. The bug this catches is the one every hand-rolled
/// client has shipped at least once: treating a read as a message.
#[tokio::test]
async fn a_frame_split_across_two_writes_reassembles() {
    let mut s = session();
    let (mut c, mut peer) = connected(&mut s).await;

    let body = b"a payload that arrives in two pieces".to_vec();
    let full = encode(&frame_bytes(BODY_APP, &body), 0).expect("encode");
    let cut = full.len() / 2;

    // Two separate writes, each flushed, so they are genuinely two segments on
    // the wire and not one buffer the library happened to coalesce.
    peer.send_raw(&full[..cut]).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    peer.send_raw(&full[cut..]).await;

    let got = match next(&mut c).await {
        Some(Event::Frame(p)) => p,
        other => panic!("expected one reassembled frame, got {other:?}"),
    };
    let f = decode_frame(&got, &Limits::default(), 0, 0).expect("decodes");
    assert_eq!(f.body, &body[..], "the two halves must rejoin byte for byte");
}

/// TWO frames, ONE write. The mirror-image bug: stopping after the first frame
/// and silently discarding the rest of the buffer.
#[tokio::test]
async fn two_frames_in_one_write_both_arrive() {
    let mut s = session();
    let (mut c, mut peer) = connected(&mut s).await;

    let mut both = encode(&frame_bytes(BODY_APP, b"first"), 0).unwrap();
    both.extend_from_slice(&encode(&frame_bytes(BODY_APP, b"second"), 0).unwrap());
    peer.send_raw(&both).await;

    let mut seen = Vec::new();
    for _ in 0..2 {
        match next(&mut c).await {
            Some(Event::Frame(p)) => {
                let f = decode_frame(&p, &Limits::default(), 0, 0).expect("decodes");
                seen.push(String::from_utf8(f.body.to_vec()).unwrap());
            }
            other => panic!("expected a frame, got {other:?}"),
        }
    }
    assert_eq!(seen, vec!["first".to_string(), "second".to_string()]);
    assert!(c.is_open(), "two valid frames in one read is not an error");
}

/// A framing version we do not speak ends the connection, and ends it as a
/// PROTOCOL error.
///
/// The distinction is the point: a length-prefixed stream has no
/// resynchronisation point, so there is nothing to recover to — but it must
/// also not be reported as a transport failure, because that would put the
/// client on the reconnect timer, straight back into the same disagreement.
#[tokio::test]
async fn a_malformed_frame_closes_the_connection_as_a_protocol_error() {
    let mut s = session();
    let (mut c, mut peer) = connected(&mut s).await;

    // Framing version 9. Everything after it is unreadable by construction.
    peer.send_raw(&[9, 0, 0, 0, 4, 1, 2, 3, 4]).await;

    assert_eq!(
        next(&mut c).await,
        Some(Event::Closed(CloseReason::Protocol(FrameError::BadVersion))),
    );
    assert!(!c.is_open());
    assert_eq!(next(&mut c).await, None, "no events may follow a close");
}

/// The server going away mid-stream is a TRANSPORT close, which reconnects —
/// not a protocol error, which does not.
///
/// Half a frame is deliberately left on the wire: a peer that vanishes between
/// the header and the body is the ordinary case (a phone losing signal), and
/// misclassifying it as a protocol violation is how a client gives up on a
/// network that is merely flaky.
#[tokio::test]
async fn the_server_closing_mid_stream_is_a_transport_close() {
    let mut s = session();
    let (mut c, mut peer) = connected(&mut s).await;

    let full = encode(&frame_bytes(BODY_APP, b"never finished"), 0).unwrap();
    peer.send_raw(&full[..6]).await;
    drop(peer); // the socket really closes

    assert_eq!(next(&mut c).await, Some(Event::Closed(CloseReason::Transport)));
}

/// A Ping is answered with a Pong whose body is the Ping's, byte for byte.
///
/// The echo is not laziness: `Pong` mirrors `Ping` field for field, and bytes
/// that are never parsed are bytes that cannot be corrupted. The reply is also
/// never surfaced to the caller — keepalive is the transport's job, and a
/// caller that has to remember to answer a Ping will one day forget.
#[tokio::test]
async fn a_server_ping_is_answered_with_a_pong_over_the_socket() {
    let mut s = session();
    let (mut c, mut peer) = connected(&mut s).await;

    let ping_body = [0x0a, 0x08, 1, 2, 3, 4, 5, 6, 7, 8]; // Ping.nonce = 8 bytes
    peer.send_body(bodies::PING, &ping_body).await;

    // The client is driven only long enough to see the Ping and write the Pong;
    // the Ping itself must NOT appear as an event.
    let (client_saw, raw) = tokio::join!(
        async { timeout(Duration::from_millis(750), c.next_event()).await },
        peer.recv_frame(),
    );
    assert!(client_saw.is_err(), "keepalive must not surface to the caller");

    let f = decode_frame(&raw, &Limits::default(), 0, 0).expect("Pong decodes");
    assert_eq!(f.body_field, Some(bodies::PONG));
    assert_eq!(f.body, &ping_body[..], "the nonce must be echoed verbatim");
}

/// Silence makes the CLIENT prove the path, and a Pong makes it stop asking.
///
/// The server tightens the interval to 5 ms so this runs in milliseconds. That
/// is not a test hack — it is the negotiation rule from `capabilities.proto`
/// being exercised: a peer may propose a SMALLER bound and never a larger one,
/// and the heartbeat the client actually uses is the tightened one.
#[tokio::test]
async fn silence_makes_the_client_ping_and_a_pong_settles_it() {
    let mut s = session();
    let (mut c, mut peer) = connected_hb(&mut s, 5, 2_000).await;
    assert_eq!(c.session().heartbeat_interval_ms(), 5, "the server's tighter value binds");

    // Drive the client until it decides silence has gone on long enough.
    let (_, raw) = tokio::join!(
        async { timeout(Duration::from_millis(1_500), c.next_event()).await },
        peer.recv_frame(),
    );
    let f = decode_frame(&raw, &Limits::default(), 0, 0).expect("Ping decodes");
    assert_eq!(f.body_field, Some(bodies::PING), "the client must probe the path itself");
    assert!(!f.body.is_empty(), "a Ping carries a nonce to match its Pong against");

    // Answer it. The connection must stay up, and nothing may surface: the
    // caller never sees keepalive in either direction.
    peer.send_body(bodies::PONG, f.body).await;
    let after = timeout(Duration::from_millis(300), c.next_event()).await;
    assert!(after.is_err(), "a Pong is not an event");
    assert!(c.is_open(), "an answered ping must not end the connection");
}

/// An UNANSWERED ping ends the connection — as a transport close, on the
/// deadline, not eventually.
///
/// This is the failure a liveness probe exists to end: a socket that is open at
/// the TCP level, whose peer is gone. Nothing in the OS will tell us, so the
/// only evidence is a probe that went unanswered past its deadline. Waiting
/// forever for the answer IS the bug.
#[tokio::test]
async fn an_unanswered_ping_is_reported_dead_and_closes_the_socket() {
    let mut s = session();
    // 5 ms interval, 300 ms deadline: the server deliberately never answers.
    let (mut c, _peer) = connected_hb(&mut s, 5, 300).await;
    assert_eq!(c.session().heartbeat_timeout_ms(), 300);

    let started = std::time::Instant::now();
    let ev = timeout(PATIENCE, c.next_event()).await.expect("must not hang");
    // TRANSPORT, never protocol: the peer did not break the rules, it vanished.
    // Misclassifying this would keep the client off the reconnect path.
    assert_eq!(ev, Some(Event::Closed(CloseReason::Transport)));
    assert!(started.elapsed() < Duration::from_secs(3), "dead must be noticed on the deadline");
}

/// The outbound queue refuses work rather than growing, and everything it
/// ACCEPTED still reaches the peer in order once the socket is drained.
///
/// Both halves matter. A queue that only refuses is a queue that drops
/// messages; a queue that only grows is a slower crash.
#[tokio::test]
async fn backpressure_is_reported_and_the_accepted_frames_all_arrive() {
    let mut s = session();
    let (mut c, mut peer) = connected(&mut s).await;

    // MAX_QUEUED_BULK is 64: bulk is kept small on purpose so an attachment
    // upload can never starve control or messaging.
    let mut accepted = 0usize;
    let mut refused = None;
    for i in 0..200u32 {
        let payload = encode_frame(
            &Frame {
                request_id: "",
                traffic_class: TRAFFIC_CLASS_BULK,
                stream: 9,
                seq: 0,
                depends_on: 0,
                body_field: Some(96), // attachment_chunk
                body: &i.to_be_bytes(),
                unknown: Vec::new(),
            },
            &Limits::default(),
            0,
        )
        .unwrap();
        match c.send_encoded(Class::Bulk, 0, &payload) {
            Ok(()) => accepted += 1,
            Err(e) => {
                refused = Some(e);
                break;
            }
        }
    }

    assert_eq!(accepted, 64, "the bulk class bound is what must bind");
    assert_eq!(refused, Some(SendError::Backpressure(Reject::ClassFull)));
    assert_eq!(c.queued(), 64, "refused work must not have been silently dropped");

    c.flush().await.expect("drain to the socket");
    assert_eq!(c.queued(), 0);

    // Every accepted frame arrives, in order, over the real socket.
    for i in 0..accepted as u32 {
        let payload = peer.recv_frame().await;
        let f = decode_frame(&payload, &Limits::default(), 0, 0).expect("decodes");
        assert_eq!(f.body, &i.to_be_bytes()[..], "frame {i} arrived out of order or mangled");
    }
}

/// THE PARITY TEST. The bytes this client puts on a real socket are compared,
/// byte for byte, against the SAME committed fixture that
/// `vaultchat-backend-go/internal/ccwire/frame_test.go` and
/// `lib/ccwire/parity.selftest.ts` assert.
///
/// `transport-core` already checks its encoder against this fixture in memory.
/// What this adds is the only thing that test cannot cover: that the bytes
/// survive the WebSocket layer unaltered — not re-chunked, not re-framed, not
/// sent as text, not "helpfully" prefixed by anything in this crate.
#[tokio::test]
async fn wire_bytes_match_the_shared_fixture() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..");
    let path = root.join("lib").join("ccwire").join("__vectors__").join("frame.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read shared vectors at {}: {e}", path.display()));
    let v: serde_json::Value = serde_json::from_str(&raw).expect("vectors are valid JSON");

    let unhex = |s: &str| -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    };
    let hex = |b: &[u8]| -> String { b.iter().map(|x| format!("{x:02x}")).collect() };

    let mut s = session();
    let (mut c, mut peer) = connected(&mut s).await;

    let cases = v["encode"].as_array().expect("encode vectors");
    assert!(!cases.is_empty(), "the fixture must not be empty");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let payload = unhex(case["payloadHex"].as_str().unwrap());
        c.send_encoded(Class::Control, 0, &payload).expect("queue");
        c.flush().await.expect("flush");

        let on_the_wire = peer.recv_raw().await;
        assert_eq!(
            hex(&on_the_wire),
            case["frameHex"].as_str().unwrap(),
            "{name}: the bytes this client put on a real socket differ from the \
             fixture Go and TypeScript assert",
        );
    }
}

/// Two clients that were disconnected by the same blip do not come back in the
/// same millisecond.
///
/// There is NO backoff arithmetic in `transport-net` — `Session::on_disconnect`
/// computes the jittered, capped delay and this crate only sleeps until it. The
/// assertion is therefore that the policy is core's and that it still holds
/// after passing through the async wrapper: it grows, and two seeds disagree.
#[tokio::test(start_paused = true)]
async fn reconnect_backoff_comes_from_transport_core_and_is_jittered() {
    let mut a = Session::new(Capabilities::all(), 1);
    let mut b = Session::new(Capabilities::all(), 99);

    let mut delays_a = Vec::new();
    for _ in 0..5 {
        let before = tokio::time::Instant::now();
        assert!(wait_for_retry(&mut a, ErrorClass::Retryable, 0).await, "retryable must retry");
        delays_a.push(before.elapsed().as_millis() as u64);
        a.connect().expect("back to Idle after a retryable disconnect");
        a.on_disconnect(ErrorClass::Retryable, 0);
    }
    // Equal jitter: the fixed half means the delay genuinely grows, so the last
    // attempt must be meaningfully longer than the first.
    assert!(delays_a[4] > delays_a[0] * 2, "backoff must grow: {delays_a:?}");
    assert!(delays_a.iter().all(|d| *d <= 30_000), "capped at BACKOFF_MAX_MS: {delays_a:?}");

    let before = tokio::time::Instant::now();
    assert!(wait_for_retry(&mut b, ErrorClass::Retryable, 0).await);
    let first_b = before.elapsed().as_millis() as u64;
    assert_ne!(delays_a[0], first_b, "two clients must not wake in the same millisecond");

    // AUTH never reaches the backoff path. Waiting does not renew a token.
    let mut auth = Session::new(Capabilities::all(), 7);
    assert!(!wait_for_retry(&mut auth, ErrorClass::Auth, 0).await);
    assert!(!wait_for_retry(&mut auth, ErrorClass::Fatal, 0).await);
}

/// A refused upgrade is an error, not a socket. The server here closes the TCP
/// connection without upgrading at all, which is the shape of every failure
/// that happens BEFORE the WebSocket exists — a 401 from `httpx.RequireAuth`
/// included.
#[tokio::test]
async fn a_refused_upgrade_surfaces_as_an_error_and_not_a_connection() {
    let l = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (sock, _) = l.accept().await.expect("accept");
        drop(sock); // refuse without upgrading
    });

    let mut s = session();
    let url = format!("ws://127.0.0.1:{port}/ccwire/v1");
    let err = Connection::open(&url, "token", &mut s).await.expect_err("must not connect");
    assert!(matches!(err, NetError::Ws(_)), "got {err:?}");

    // And the session is still usable for a retry — a failed connect must not
    // leave the state machine wedged.
    assert!(wait_for_retry(&mut s, ErrorClass::Retryable, 0).await);
    assert_eq!(s.state(), State::Idle);
}
