//! transport-net — the I/O half of the CC-Wire client. A real socket.
//!
//! STATUS: NOT WIRED. No Gradle module includes this crate, there is no FFI
//! surface, and nothing in the React Native app or the Go backend imports it.
//! It builds, it connects, it is covered by integration tests that open real
//! TCP sockets — and it is reachable only from its own test suite and from the
//! `ccwire-connect` example binary. Wiring it into a shipping client is a
//! separate decision that a parity soak has not yet earned.
//!
//! WHY A SECOND CRATE RATHER THAN A MODULE IN `transport-core`
//! ----------------------------------------------------------
//! `transport-core`'s manifest has an empty `[dependencies]`, and that emptiness
//! is an AUDIT ARTEFACT, not an accident. It is how a reviewer establishes, by
//! reading one file, that the transport coordinator cannot encrypt and cannot
//! reach a database. Owning a socket means owning an async runtime, which means
//! tokio, which would have spent that property permanently.
//!
//! So the dependency arrow points this way and only this way:
//!
//! ```text
//!     transport-net  ──depends on──▶  transport-core   (zero dependencies)
//!      tokio, TLS,                     pure decisions,
//!      WebSocket, DNS                  no I/O, no clock
//! ```
//!
//! `cargo tree -p transport-core` is still a single line. Adding this crate did
//! not change that, and nothing here may ever be moved down into the sibling.
//!
//! WHAT THIS CRATE IS FORBIDDEN FROM DOING
//! ---------------------------------------
//!   * It must not frame. Every byte that reaches the socket came out of
//!     [`transport_core::conn::Conn::poll_out`], and every byte off the socket
//!     goes into [`transport_core::conn::Conn::on_bytes`]. No length prefix is
//!     written anywhere in this crate, and no frame header is parsed: both
//!     layers — the length prefix and the `ccwire.v1.Frame` routing header —
//!     come from `transport_core::frame` and `transport_core::parse`.
//!   * It must not decide. Backoff, heartbeat timing, capability
//!     intersection and limit tightening are all `transport_core::session`.
//!     A second backoff in here would be a second policy to drift.
//!   * It must not encrypt. Same rule as the sibling: this crate carries
//!     opaque bytes and has no crypto dependency.
//!   * It must never run one runtime, connection or task per conversation.
//!     A [`Connection`] is one socket carrying many logical streams, exactly as
//!     `transport-core`'s crate docs require. There is no per-chat anything
//!     here and no API that would let a caller create one.
//!
//! THE ONE THING THIS CRATE DOES PARSE
//! -----------------------------------
//! [`body`] encodes `ClientHello` and decodes `ServerHello`. `transport-core`
//! deliberately does not decode any of the 27 body types ("the transport
//! routes, the application interprets"), so the handshake bodies — and ONLY the
//! handshake bodies — are built here. Everything else stays opaque: a Ping's
//! payload is echoed into the Pong verbatim rather than re-encoded, because
//! bytes you never parse are bytes you cannot corrupt.
//!
//! THE PEER
//! --------
//! `vaultchat-backend-go/internal/realtime/ccwire.go`, at `/ccwire/v1`, behind
//! `CCWIRE_WS=1`. It wraps the handler in `httpx.RequireAuth` BEFORE the
//! WebSocket upgrade, so the `Authorization: Bearer <token>` header goes on the
//! HTTP upgrade request and a missing one is a 401 that never becomes a socket.
//! One WebSocket BINARY message is one CC-Wire frame (the server decodes
//! strictly); a text message is refused as a protocol violation, not read
//! leniently.

#![forbid(unsafe_code)]

pub mod body;
pub mod client;

pub use client::{wait_for_retry, Connection, NetError};

/// `Frame.body` field numbers this crate names, from `envelope.proto`.
/// Only the handshake and keepalive bodies — everything else is opaque and
/// passes through as a field number the caller chose.
pub mod bodies {
    pub const CLIENT_HELLO: u32 = 16;
    pub const SERVER_HELLO: u32 = 17;
    pub const PING: u32 = 19;
    pub const PONG: u32 = 20;
}

/// `TrafficClass` from `envelope.proto`. `TRAFFIC_CLASS_UNSPECIFIED` (0) is
/// never valid on the wire and is therefore not named here.
pub const TRAFFIC_CLASS_CONTROL: u32 = 1;
