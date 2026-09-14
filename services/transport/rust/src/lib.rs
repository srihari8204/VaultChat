//! transport-core — the Rust transport coordinator for CrazzyChat.
//!
//! STATUS: NOT WIRED. No Gradle module includes this crate, no FFI is exposed
//! yet, and nothing in the app or the Go backend imports it. It is Stage 1 of
//! the rollout plan — "shared transport interface and conformance harness, with
//! behaviour unchanged". The live transport is Socket.IO v4 over WebSocket with
//! JSON payloads and stays that way until a parity soak says otherwise.
//!
//! WHAT THIS CRATE IS FORBIDDEN FROM DOING, and why it has no dependencies yet:
//!
//!   * It must not encrypt. Crypto stays behind the reviewed `crypto-core`.
//!     A transport crate that CAN encrypt is a transport crate that has to be
//!     reviewed as crypto. This crate only ever holds opaque bytes, and the
//!     absence of `aes-gcm` / `x25519-dalek` from Cargo.toml is the enforcement
//!     — a fact you can check by reading the manifest, not by trusting a comment.
//!   * It must not open a database. Durable work is REQUESTED through a narrow
//!     host-implemented adapter; this crate cannot read the message store.
//!   * It must never run one runtime, connection or task per conversation.
//!
//! WHAT EXISTS TODAY — all of it pure, none of it reachable from the app:
//!
//!   `config`   every bound, with the existing limit it was derived from
//!   `frame`    CC-Wire framing. Third implementation; asserts the same fixture
//!              as Go and TypeScript.
//!   `parse`    the ccwire.v1.Frame routing header and its bounds. Second
//!              implementation; asserts a hand-written wire fixture with
//!              `lib/ccwire/codec.ts`.
//!   `body`     the six typed bodies, decoded from the opaque bytes `parse`
//!              hands up — on request, off the routing path. Same fixture.
//!   `reasm`    fragment reassembly, bounded on four axes at once
//!   `sched`    outbound priority, backpressure and causal ordering
//!   `select`   which frames may travel as a droppable datagram
//!   `session`  handshake, negotiation, heartbeat, resume, reconnect backoff
//!   `work`     the narrow interface through which the HOST persists things
//!   `metrics`  connection-scoped counters that cannot describe a person
//!   `conn`     the connection state machine — sans-IO
//!   `ffi`      the safe half of the host boundary
//!
//! THERE IS NO NETWORKING CODE IN THIS CRATE, and that is deliberate rather
//! than unfinished. `conn` takes bytes and returns events; the host does the
//! I/O. React Native already owns a WebSocket that has survived years of real
//! certificate chains, proxies, captive portals and doze-mode wakeups, and a
//! second stack here would have to re-earn all of it. Owning a socket would
//! also mean owning an async runtime, and the empty `[dependencies]` above is
//! what lets a reviewer establish by reading one manifest that this crate
//! cannot encrypt and cannot reach a database.
//!
//! Every module takes time as a `now_ms: u64` parameter rather than reading a
//! clock, so "is a dead connection noticed in 15 seconds" and "does bulk starve
//! control" are unit tests rather than soak runs.

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

pub mod body;
pub mod config;
pub mod conn;
pub mod ffi;
pub mod frame;
pub mod metrics;
pub mod parse;
pub mod reasm;
pub mod sched;
pub mod select;
pub mod session;
pub mod work;

/// Errors that cross the crate boundary.
///
/// Deliberately small. A transport that can express a hundred failure modes is
/// a transport whose caller handles three of them and guesses at the rest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// Wire framing refused the bytes. Carries the typed reason.
    Frame(frame::FrameError),
    /// The framing was fine; the ccwire.v1.Frame inside it was not.
    Codec(parse::CodecError),
    /// A fragment set violated one of its four bounds.
    Fragment(reasm::ReasmError),
    /// The outbound queue refused the work.
    Backpressure(sched::Reject),
    /// Cancelled by the host — a clean shutdown, never an error condition.
    Cancelled,
}

impl From<frame::FrameError> for TransportError {
    fn from(e: frame::FrameError) -> Self {
        TransportError::Frame(e)
    }
}

impl From<parse::CodecError> for TransportError {
    fn from(e: parse::CodecError) -> Self {
        TransportError::Codec(e)
    }
}

impl From<sched::Reject> for TransportError {
    fn from(e: sched::Reject) -> Self {
        TransportError::Backpressure(e)
    }
}
