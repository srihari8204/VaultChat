//! The socket. One connection, many logical streams.
//!
//! THE DIVISION OF LABOUR, which is the whole reason this crate is separate:
//!
//! ```text
//!   bytes off the socket ──▶ Conn::on_bytes ──▶ Vec<Event>   (core decides)
//!   Conn::poll_out       ──▶ bytes to the socket             (core decides)
//!   Session::poll(now)   ──▶ SendPing | Dead | Idle          (core decides)
//!   Session::on_disconnect ─▶ Retry{at_ms} | ReAuth | Stop   (core decides)
//! ```
//!
//! This file contains no length prefix, no backoff arithmetic and no heartbeat
//! arithmetic. It owns a TCP connection, a clock and a `select!`, and that is
//! all it is allowed to own.
//!
//! ONE CONNECTION, MANY STREAMS. There is deliberately no `Connection::for_chat`
//! and no way to spawn one of these per conversation — `transport-core`'s crate
//! docs forbid a runtime, connection or task per conversation, and the cheapest
//! enforcement is an API that cannot express it. Logical multiplexing is the
//! `stream` field inside the frame, which `send` takes as a parameter.
//!
//! THE CLOCK. `transport-core` takes `now_ms: u64` everywhere and reads no
//! clock of its own, which is what makes "is a dead connection noticed in 15
//! seconds" a unit test over there. Here, where a clock is unavoidable, it is a
//! single monotonic `Instant` captured at connect: monotonic so a phone's NTP
//! correction or a user changing the date cannot make the heartbeat believe a
//! connection has been silent for a decade.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use transport_core::conn::{CloseReason, Conn, Event, SendError};
use transport_core::parse::{decode_frame, encode_frame, CodecError, Frame};
use transport_core::sched::Class;
use transport_core::session::{
    Accepted, Beat, Capabilities, ErrorClass, Recovery, Session, SessionError,
};

use crate::body;
use crate::bodies;
use crate::TRAFFIC_CLASS_CONTROL;

/// How often liveness is re-evaluated while the socket is quiet.
///
/// A POLL granularity, not a timeout: the actual interval and deadline are
/// `Session`'s (10 s / 5 s from `capabilities.proto`, tightened by whatever the
/// server sent). 250 ms is fine enough that the 5 s deadline is honoured to
/// within a rounding error and coarse enough to be free.
const POLL_TICK: Duration = Duration::from_millis(250);

/// Why an operation failed.
///
/// Deliberately small, and deliberately keeping "the socket broke" separate
/// from "the peer broke the protocol": the first reconnects, the second must
/// not be retried into a loop.
#[derive(Debug)]
pub enum NetError {
    /// The WebSocket or TCP layer failed — DNS, TLS, refused, reset, 401.
    Ws(tokio_tungstenite::tungstenite::Error),
    /// `Session` refused the state transition.
    Session(SessionError),
    /// `Conn` refused the send: not open, too large, or backpressure.
    Send(SendError),
    /// The routing header did not decode.
    Codec(CodecError),
    /// The connection ended before the operation completed.
    Closed(CloseReason),
    /// The peer did something the protocol does not allow.
    Protocol(&'static str),
}

impl From<tokio_tungstenite::tungstenite::Error> for NetError {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        NetError::Ws(e)
    }
}
impl From<SessionError> for NetError {
    fn from(e: SessionError) -> Self {
        NetError::Session(e)
    }
}
impl From<SendError> for NetError {
    fn from(e: SendError) -> Self {
        NetError::Send(e)
    }
}
impl From<CodecError> for NetError {
    fn from(e: CodecError) -> Self {
        NetError::Codec(e)
    }
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetError::Ws(e) => write!(f, "websocket: {e}"),
            NetError::Session(e) => write!(f, "session: {e:?}"),
            NetError::Send(e) => write!(f, "send: {e:?}"),
            NetError::Codec(e) => write!(f, "codec: {}", e.as_str()),
            NetError::Closed(r) => write!(f, "closed: {r:?}"),
            NetError::Protocol(m) => write!(f, "protocol: {m}"),
        }
    }
}

impl std::error::Error for NetError {}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// One live CC-Wire connection.
///
/// Borrows the [`Session`] rather than owning it, because the session OUTLIVES
/// the socket: the reconnect attempt counter and the resume credential have to
/// survive the connection that failed, or every reconnect is attempt 0 and the
/// backoff never grows.
#[derive(Debug)]
pub struct Connection<'a> {
    ws: Ws,
    conn: Conn,
    session: &'a mut Session,
    clock: Instant,
    /// Events produced but not yet handed to the caller. `on_bytes` can finish
    /// several frames from one read and the caller takes them one at a time.
    pending: VecDeque<Event>,
    /// Monotonic ping nonce. Not a secret and not random: it exists so a Pong
    /// can be matched to the Ping that caused it, and a counter does that.
    nonce: u64,
}

impl<'a> Connection<'a> {
    /// Open a socket and complete the WebSocket upgrade.
    ///
    /// The Bearer header goes on the UPGRADE REQUEST, not into a first frame,
    /// because the Go peer wraps its handler in `httpx.RequireAuth` *before*
    /// `Upgrade` — an unauthenticated request gets a 401 and never becomes a
    /// socket at all. Sending the token after the upgrade would therefore be
    /// sending it to a connection that was never going to exist.
    pub async fn open(
        url: &str,
        token: &str,
        session: &'a mut Session,
    ) -> Result<Connection<'a>, NetError> {
        // Idle → Connecting. Refused from Ready, which is what stops a second
        // connect from leaving two sockets behind one state machine.
        session.connect()?;

        let mut req = url.into_client_request().map_err(NetError::Ws)?;
        let value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| NetError::Protocol("token is not a legal header value"))?;
        req.headers_mut().insert("Authorization", value);

        let (ws, _resp) = connect_async(req).await?;

        let mut conn = Conn::new();
        let pending = conn.on_open().into();
        Ok(Connection { ws, conn, session, clock: Instant::now(), pending, nonce: 0 })
    }

    /// Wrap an ALREADY-UPGRADED stream. The integration tests use this to drive
    /// both ends of a real socket; `open` is the path a client takes.
    pub fn from_ws(ws: Ws, session: &'a mut Session) -> Result<Connection<'a>, NetError> {
        session.connect()?;
        let mut conn = Conn::new();
        let pending = conn.on_open().into();
        Ok(Connection { ws, conn, session, clock: Instant::now(), pending, nonce: 0 })
    }

    /// Milliseconds since this connection opened, from a MONOTONIC source.
    pub fn now_ms(&self) -> u64 {
        self.clock.elapsed().as_millis() as u64
    }

    pub fn session(&self) -> &Session {
        self.session
    }

    /// Frames queued for the socket but not yet written.
    pub fn queued(&self) -> usize {
        self.conn.queued()
    }

    pub fn is_open(&self) -> bool {
        self.conn.is_open()
    }

    /// ClientHello → ServerHello.
    ///
    /// Returns [`Accepted`], which is the ONLY way to learn whether the stream
    /// resumed: `transport-core` deliberately provides no `is_resumed()` getter
    /// to forget to call, and `Accepted::FullResync` is a COMMAND to resync,
    /// not a hint.
    pub async fn handshake(
        &mut self,
        device_id: &str,
        credential: &[u8],
    ) -> Result<Accepted, NetError> {
        // Offer resume when we actually can: a token survived the last
        // ServerHello AND `resumption` survived the capability intersection.
        // Both halves go out together — a token with no positions leaves the
        // server nothing to replay from, so it refuses and the reconnect costs
        // a full resync anyway.
        let offer = self.session.can_resume();
        self.session.send_client_hello(offer)?;
        let from: Vec<(u32, u64)> = self.session.positions().collect();
        let resume = if offer {
            self.session
                .resume_token()
                .map(|token| body::Resume { token, from: &from })
        } else {
            None
        };
        let hello = body::client_hello(
            device_id,
            credential,
            &Capabilities::all(),
            self.session.limits(),
            resume,
        );
        self.send(Class::Control, TRAFFIC_CLASS_CONTROL, 1, bodies::CLIENT_HELLO, 0, &hello)?;

        loop {
            match self.next_event().await {
                Some(Event::Open) => continue,
                Some(Event::Closed(r)) => return Err(NetError::Closed(r)),
                Some(Event::Frame(payload)) => {
                    let f = decode_frame(&payload, self.session.limits(), 0, 0)?;
                    if f.body_field != Some(bodies::SERVER_HELLO) {
                        // The handshake is mandatory and comes FIRST. Anything
                        // else here is the server disagreeing about the
                        // protocol, and continuing would mean sending
                        // application frames to a peer that agreed to nothing.
                        return Err(NetError::Protocol("expected ServerHello"));
                    }
                    let hello = body::parse_server_hello(f.body)
                        .ok_or(NetError::Protocol("malformed ServerHello"))?;
                    let now = self.now_ms();
                    let accepted = self.session.on_server_hello(hello, now)?;
                    // The negotiated ceiling applies to the FRAMER from here on.
                    // `Conn::set_max_frame` can only tighten — `frame.rs` clamps
                    // to the hard max regardless — so a server proposing
                    // something absurd cannot widen anything.
                    self.conn.set_max_frame(self.session.limits().max_frame_bytes);
                    return Ok(accepted);
                }
                None => return Err(NetError::Closed(CloseReason::Transport)),
            }
        }
    }

    /// Queue one frame. Encoding is `transport-core`'s, both layers of it:
    /// `encode_frame` builds the routing header, `Conn::send` adds the length
    /// prefix. Nothing in this crate writes a byte of either.
    ///
    /// `stream` is the logical multiplexing channel — this is how many
    /// conversations share ONE socket, and why there is no per-chat connection.
    #[allow(clippy::too_many_arguments)]
    pub fn send(
        &mut self,
        class: Class,
        traffic_class: u32,
        stream: u32,
        body_field: u32,
        depends_on: u64,
        payload: &[u8],
    ) -> Result<(), NetError> {
        let frame = Frame {
            request_id: "",
            traffic_class,
            stream,
            seq: 0,
            depends_on,
            body_field: Some(body_field),
            body: payload,
            unknown: Vec::new(),
        };
        let encoded = encode_frame(&frame, self.session.limits(), 0)?;
        self.conn.send(class, depends_on, &encoded)?;
        Ok(())
    }

    /// Queue an ALREADY-ENCODED frame payload — the length prefix is still
    /// `transport-core`'s, only the routing header is the caller's.
    ///
    /// Exists for the parity test, which has to put a fixture's exact bytes on
    /// the wire and compare them to `frame.json`, and for a caller that already
    /// holds an encoded `ccwire.v1.Frame`. It cannot be used to skip framing:
    /// `Conn::send` is still the only path to the socket.
    pub fn send_encoded(
        &mut self,
        class: Class,
        depends_on: u64,
        payload: &[u8],
    ) -> Result<(), SendError> {
        self.conn.send(class, depends_on, payload)
    }

    /// Write everything `Conn` will give us.
    ///
    /// `poll_out` returning `None` does NOT mean idle — frames may be queued
    /// but held by an unmet causal dependency. That is `Conn`'s decision and
    /// this loop simply stops asking, which is the correct behaviour: writing a
    /// frame whose dependency has not been applied is the ordering bug the
    /// scheduler exists to prevent.
    pub async fn flush(&mut self) -> Result<(), NetError> {
        while let Some(bytes) = self.conn.poll_out() {
            // One CC-Wire frame per BINARY WebSocket message. The Go peer
            // decodes strictly (a trailing byte is a framing disagreement, not
            // a second frame) and refuses text outright.
            self.ws.send(Message::Binary(bytes.into())).await?;
        }
        self.ws.flush().await?;
        Ok(())
    }

    /// The next thing the caller must react to, or `None` once closed.
    ///
    /// Drives the socket AND the heartbeat. Ping and Pong are handled here and
    /// never surfaced: keepalive is the transport's job, and a caller that has
    /// to remember to answer a Ping is a caller that will one day forget.
    pub async fn next_event(&mut self) -> Option<Event> {
        loop {
            if let Some(e) = self.pending.pop_front() {
                // Record the position HERE, as the frame is handed over — not
                // when it was queued. `pending` can still be holding frames
                // when the socket drops, and a position reported for a frame
                // the caller never received would let the server release it
                // from its replay window: the message is then gone, and the
                // resume that should have recovered it reports success.
                if let Event::Frame(payload) = &e {
                    if let Ok(f) = decode_frame(payload, self.session.limits(), 0, 0) {
                        self.session.note_delivered(f.stream, f.seq);
                    }
                }
                return Some(e);
            }
            if !self.conn.is_open() {
                return None;
            }
            // Anything the heartbeat or a handler queued goes out before we
            // block. A write failure IS the connection ending.
            if self.flush().await.is_err() {
                self.pending.extend(self.conn.on_transport_close());
                continue;
            }

            // The borrow of `self.ws` is scoped to the select so the arms below
            // can touch `self` again.
            let tick = {
                let ws = &mut self.ws;
                tokio::select! {
                    m = ws.next() => Tick::Msg(m),
                    _ = tokio::time::sleep(POLL_TICK) => Tick::Beat,
                }
            };

            match tick {
                Tick::Msg(Some(Ok(Message::Binary(b)))) => {
                    let now = self.now_ms();
                    // ANY traffic proves liveness — a ping is only needed
                    // because nothing else arrived.
                    self.session.on_traffic(now);
                    let events = self.conn.on_bytes(&b);
                    self.absorb(events);
                }
                Tick::Msg(Some(Ok(Message::Text(_)))) => {
                    // CC-Wire is binary. A text message is not a lenient
                    // encoding of it, it is a different protocol — the same
                    // judgement `ccwire.go` makes in the other direction.
                    self.pending
                        .extend(self.conn.on_transport_close());
                }
                // WebSocket-level Ping/Pong/frame are the library's business and
                // are NOT the CC-Wire heartbeat. Ignored deliberately: treating
                // them as liveness would mean a proxy keeping the socket warm
                // could hide a dead server.
                Tick::Msg(Some(Ok(_))) => {}
                // A clean Close, a stream error, or end-of-stream are all the
                // same thing to the layer above: TRANSPORT close, which
                // reconnects. Never a protocol error, which does not.
                Tick::Msg(Some(Err(_))) | Tick::Msg(None) => {
                    self.pending.extend(self.conn.on_transport_close());
                }
                Tick::Beat => {
                    let now = self.now_ms();
                    match self.session.poll(now) {
                        Beat::Idle => {}
                        Beat::SendPing => {
                            self.nonce = self.nonce.wrapping_add(1);
                            // Progress rides the heartbeat. It is what lets the
                            // server release what it retained for us; without
                            // it the replay window fills to its ceiling and
                            // stays there for the life of the connection.
                            let progress: Vec<(u32, u64)> =
                                self.session.positions().collect();
                            let ping = body::ping(self.nonce, &progress);
                            let _ = self.send(
                                Class::Control,
                                TRAFFIC_CLASS_CONTROL,
                                1,
                                bodies::PING,
                                0,
                                &ping,
                            );
                        }
                        // REPORTED by core, acted on here: a ping unanswered
                        // past the deadline means dead, not slow. Waiting
                        // forever for the answer is the exact failure a
                        // liveness probe exists to end.
                        Beat::Dead => {
                            self.pending.extend(self.conn.on_transport_close());
                        }
                    }
                }
            }
        }
    }

    /// Route what `Conn` produced: answer keepalive, surface the rest.
    fn absorb(&mut self, events: Vec<Event>) {
        for e in events {
            let Event::Frame(payload) = &e else {
                self.pending.push_back(e);
                continue;
            };
            // The routing header only. The BODY stays opaque — this decodes far
            // enough to know whether the frame is keepalive, and not one byte
            // further.
            match decode_frame(payload, self.session.limits(), 0, 0) {
                Ok(f) if f.body_field == Some(bodies::PING) => {
                    // Pong mirrors Ping field for field, so the body is echoed
                    // VERBATIM rather than re-encoded. Bytes never parsed are
                    // bytes that cannot be corrupted.
                    let body = f.body.to_vec();
                    let _ = self.send(
                        Class::Control,
                        TRAFFIC_CLASS_CONTROL,
                        f.stream,
                        bodies::PONG,
                        0,
                        &body,
                    );
                }
                // The Pong we were waiting for. `on_traffic` already cleared the
                // outstanding ping when the bytes arrived; nothing to surface.
                Ok(f) if f.body_field == Some(bodies::PONG) => {}
                // Anything else — including a header this build cannot decode —
                // is the caller's. A frame we refuse to interpret is not a frame
                // we may silently drop.
                _ => self.pending.push_back(e),
            }
        }
    }

    /// Close deliberately: CC-Wire first, then the WebSocket.
    pub async fn close(&mut self) {
        self.conn.close();
        let _ = self.ws.close(None).await;
    }
}

enum Tick {
    Msg(Option<Result<Message, tokio_tungstenite::tungstenite::Error>>),
    Beat,
}

/// Sleep out the reconnect delay, then say whether to try again.
///
/// THE BACKOFF IS NOT HERE. `Session::on_disconnect` computes it — exponential
/// with equal jitter, capped, seeded by the caller — and this function's entire
/// job is to convert the absolute instant it returns into a `sleep`. A second
/// backoff in this crate would be a second policy to drift out of step with the
/// first, and the jitter is what stops ten thousand clients disconnected by one
/// blip from returning in the same millisecond and causing the second outage
/// themselves.
///
/// `false` means STOP TRYING: `ErrorClass::Auth` needs a fresh credential, and
/// no amount of waiting renews a token. Retrying one forever is how a client
/// hammers a server it can never satisfy.
pub async fn wait_for_retry(session: &mut Session, class: ErrorClass, now_ms: u64) -> bool {
    match session.on_disconnect(class, now_ms) {
        Recovery::Retry { at_ms } => {
            tokio::time::sleep(Duration::from_millis(at_ms.saturating_sub(now_ms))).await;
            true
        }
        Recovery::ReAuth | Recovery::Stop => false,
    }
}
