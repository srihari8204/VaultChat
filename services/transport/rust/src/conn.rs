//! The connection: a sans-IO state machine.
//!
//! THIS MODULE OPENS NO SOCKETS, AND THAT IS THE DESIGN, NOT A SHORTFALL.
//!
//! The crate root says `conn/` would be "the only modules allowed to touch the
//! network". On reflection it touches none, because nothing here should:
//!
//!   * The host is React Native, which ALREADY has a WebSocket, already handles
//!     the certificate chain, the proxy, the captive portal and the doze-mode
//!     wakeup. A second networking stack inside the app would have to re-earn
//!     every one of those, and would be the one without years of field use.
//!   * Owning a socket means owning an async runtime, which means tokio, which
//!     means this crate stops being auditable by reading one manifest. The
//!     empty `[dependencies]` in Cargo.toml is the enforcement that this crate
//!     cannot encrypt and cannot reach a database — a fact you verify by
//!     reading the manifest rather than by trusting a comment. Spending that
//!     property on a socket we do not need is a bad trade.
//!
//! So: bytes in, events out, bytes to write out. The host does the I/O and this
//! decides what it MEANS. Every interesting property — a partial frame across
//! two reads, a peer that sends a bad length, a close mid-frame — becomes a
//! unit test with no network and no clock.
//!
//! THE BOUND THAT MATTERS HERE
//! ---------------------------
//! `frame.rs` refuses an oversized frame, but a peer never has to finish a
//! frame at all: it can dribble a header claiming 2 MiB and then send one byte
//! a minute. The decoder correctly says "incomplete" every time, and the
//! reassembly buffer grows forever. So this module bounds the buffer ITSELF,
//! independently, and drops the connection when a peer exceeds it. A stream
//! reader without its own bound is a memory leak with a protocol attached.

use crate::config::{HEADER_BYTES, MAX_FRAME_BYTES};
use crate::frame::{decode_stream, encode, FrameError};
use crate::sched::{Class, Item, Reject, Sched};

/// The most unparsed input we will hold while waiting for a frame to complete.
///
/// One maximum frame plus its header, and not a byte more: any legitimate peer
/// completes a frame within that, so exceeding it is not slowness, it is a peer
/// that has no intention of finishing.
pub const MAX_BUFFERED_BYTES: usize = MAX_FRAME_BYTES + HEADER_BYTES;

/// Why a connection ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// The host reported the socket closed. Ordinary; reconnect applies.
    Transport,
    /// We ended it: the peer broke the protocol.
    Protocol(FrameError),
    /// The peer exceeded `MAX_BUFFERED_BYTES` without completing a frame.
    BufferOverflow,
    /// A clean, intentional shutdown. Never an error condition.
    Local,
}

/// What the host must react to. Returned in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The connection is usable.
    Open,
    /// One complete frame payload. Owned, because it crosses the host boundary
    /// and must outlive the read buffer it arrived in.
    Frame(Vec<u8>),
    /// The connection is finished. No further events follow.
    Closed(CloseReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    Open,
    Closed,
}

/// A single connection's worth of state.
///
/// Deliberately ONE object per CONNECTION, never per conversation: the design
/// forbids a runtime, connection or task per chat, and a per-chat `Conn` would
/// be that mistake wearing a different hat.
#[derive(Debug)]
pub struct Conn {
    state: State,
    /// Bytes received but not yet forming a complete frame.
    buf: Vec<u8>,
    out: Sched,
    /// Negotiated ceiling, 0 meaning "the hard max" — the same zero-value
    /// convention `frame.rs` and the Go `Options` use.
    max_frame: usize,
    pub frames_in: u64,
    pub frames_out: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
}

impl Default for Conn {
    fn default() -> Self {
        Self::new()
    }
}

impl Conn {
    pub fn new() -> Self {
        Conn {
            state: State::Idle,
            buf: Vec::new(),
            out: Sched::new(),
            max_frame: 0,
            frames_in: 0,
            frames_out: 0,
            bytes_in: 0,
            bytes_out: 0,
        }
    }

    /// Apply a negotiated frame ceiling. May only TIGHTEN — `frame.rs` clamps
    /// to the hard max regardless, so this cannot widen anything even if a
    /// caller passes something absurd.
    pub fn set_max_frame(&mut self, n: usize) {
        self.max_frame = n;
    }

    pub fn is_open(&self) -> bool {
        self.state == State::Open
    }

    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    pub fn queued(&self) -> usize {
        self.out.len()
    }

    pub fn queued_bytes(&self) -> usize {
        self.out.queued_bytes()
    }

    pub fn shed(&self) -> u64 {
        self.out.shed
    }

    /// The host reports the socket is up.
    ///
    /// Idempotent by refusal, not by pretending: opening an already-open
    /// connection yields nothing rather than a second `Open` the host would
    /// handle twice.
    pub fn on_open(&mut self) -> Vec<Event> {
        if self.state != State::Idle {
            return Vec::new();
        }
        self.state = State::Open;
        vec![Event::Open]
    }

    /// The host delivers bytes off the socket.
    ///
    /// Returns every complete frame these bytes finished, and a `Closed` if the
    /// peer broke the protocol. After a `Closed` the connection stays closed —
    /// there is no resynchronisation point in a length-prefixed stream, so
    /// continuing to parse after a bad length means interpreting payload as
    /// header.
    pub fn on_bytes(&mut self, data: &[u8]) -> Vec<Event> {
        if self.state != State::Open {
            return Vec::new();
        }
        self.bytes_in = self.bytes_in.saturating_add(data.len() as u64);
        self.buf.extend_from_slice(data);

        let (frames, consumed, err) = decode_stream(&self.buf, self.max_frame);

        let mut events: Vec<Event> = Vec::with_capacity(frames.len() + 1);
        for f in frames {
            events.push(Event::Frame(f.to_vec()));
        }
        self.frames_in = self.frames_in.saturating_add(events.len() as u64);

        // Drop what was consumed and keep the tail. `drain` rather than a fresh
        // allocation so a busy connection is not reallocating on every read.
        self.buf.drain(..consumed);

        if let Some(e) = err {
            events.extend(self.close_with(CloseReason::Protocol(e)));
            return events;
        }

        // The backstop, checked on the RESIDUE — what is left after every
        // complete frame has been taken out.
        //
        // It is checked here and not before appending, because before appending
        // it is WRONG: a peer legitimately sending a maximum-size frame leaves
        // ~2 MiB buffered, and the read that finally completes it usually also
        // carries the start of the next frame. A pre-check sees "2 MiB + this
        // read > bound" and drops a peer that was behaving perfectly. Two
        // back-to-back maximum frames would disconnect an ordinary user.
        //
        // On the residue it is a true backstop: a declared length over the
        // maximum is already refused by `frame.rs` as LengthOverMax, so a
        // residue this large means an invariant broke somewhere upstream. It
        // should be unreachable, which is exactly why it is cheap to keep — an
        // unbounded read buffer is a memory leak with a protocol attached.
        if self.buf.len() > MAX_BUFFERED_BYTES {
            events.extend(self.close_with(CloseReason::BufferOverflow));
        }
        events
    }

    /// The host reports the socket closed under it.
    pub fn on_transport_close(&mut self) -> Vec<Event> {
        self.close_with(CloseReason::Transport)
    }

    /// End it deliberately.
    pub fn close(&mut self) -> Vec<Event> {
        self.close_with(CloseReason::Local)
    }

    fn close_with(&mut self, why: CloseReason) -> Vec<Event> {
        if self.state == State::Closed {
            return Vec::new();
        }
        self.state = State::Closed;
        // The read buffer is released immediately. Holding a peer's partial
        // frame after the connection is gone is memory retained for nothing.
        self.buf = Vec::new();
        self.buf.shrink_to_fit();
        vec![Event::Closed(why)]
    }

    /// Queue a payload for sending. Framing happens here so a caller cannot
    /// enqueue something unframed and discover it on the wire.
    ///
    /// `depends_on` is the causal epoch this payload was produced under — see
    /// `sched.rs`. Zero means no dependency.
    pub fn send(&mut self, class: Class, depends_on: u64, payload: &[u8]) -> Result<(), SendError> {
        if self.state != State::Open {
            return Err(SendError::NotOpen);
        }
        let bytes = encode(payload, self.max_frame).map_err(SendError::Frame)?;
        self.out
            .push(Item {
                class,
                depends_on,
                bytes,
            })
            .map_err(SendError::Backpressure)
    }

    /// Record that the peer has applied everything up to `epoch`, releasing any
    /// frame waiting on it.
    pub fn set_applied_epoch(&mut self, epoch: u64) {
        self.out.set_applied_epoch(epoch);
    }

    /// Frames queued but held by an unmet causal dependency.
    pub fn blocked(&self) -> usize {
        self.out.blocked()
    }

    /// The next bytes the host should write, or None.
    ///
    /// None does not mean idle: frames may be queued but blocked on a causal
    /// dependency. `blocked()` distinguishes them, because "nothing to do" and
    /// "waiting on a key update" need different handling upstairs.
    pub fn poll_out(&mut self) -> Option<Vec<u8>> {
        if self.state != State::Open {
            return None;
        }
        let item = self.out.pop()?;
        self.frames_out = self.frames_out.saturating_add(1);
        self.bytes_out = self.bytes_out.saturating_add(item.bytes.len() as u64);
        Some(item.bytes)
    }
}

/// Why a send was refused. Backpressure and a protocol error are different
/// problems with different responses, so they are different variants rather
/// than one "failed".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    NotOpen,
    Frame(FrameError),
    Backpressure(Reject),
}
