//! The host boundary — the safe half.
//!
//! WHERE THE `extern "C"` ACTUALLY GOES, AND WHY NOT HERE
//! -----------------------------------------------------
//! This crate declares `#![forbid(unsafe_code)]`, and a real JSI/Nitro shim
//! needs raw pointers and `extern "C"`. Those cannot coexist, and the right
//! resolution is not to relax the crate:
//!
//! The unsafe surface of an FFI shim is small, mechanical and reviewable —
//! "this pointer is valid for this length". The logic it wraps is large and is
//! where the actual mistakes live. Keeping them in separate crates means the
//! large half can NEVER contain an unsafe block, and the small half can be read
//! in one sitting. Merging them would mean auditing 2000 lines under the same
//! suspicion the 40-line shim deserves.
//!
//! So the shim is a SEPARATE crate with `unsafe` permitted and no logic of its
//! own. That crate now exists — `services/transport/rust-net`, whose `ffi.rs`
//! carries the `#[no_mangle] extern "C"` surface and is linked through
//! `TransportJni.cpp`. (This paragraph used to say "a future crate"; it stopped
//! being future and the comment did not notice.)
//!
//! This module is what such a shim calls: handles instead of pointers, slices
//! instead of (ptr, len), and no global mutable state. Note that the SHIPPED
//! path does not currently come through here — `rust-net`'s exported symbols
//! route to its own `carrier` — so this is the boundary as designed, not as
//! deployed.
//!
//! NO GLOBAL REGISTRY, DELIBERATELY. A `static mut` or a lazily-initialised
//! global would need a lock, and every FFI call would contend on it — including
//! calls for unrelated connections. The shim owns one `Registry` and passes it
//! in. That also makes this module testable without any FFI at all.
//!
//! THE CONVENTION THIS FOLLOWS: the existing Nitro boundary in this app is
//! synchronous, hex strings in and JSON state out. Synchronous is kept — these
//! are pure state-machine calls, microseconds each, and an async boundary would
//! add a promise per WebSocket read for no gain. Hex is NOT kept for payloads:
//! it doubles the size of every message on the busiest path in the app. Hex is
//! for identifiers, which are short and which humans read in logs.

use crate::conn::{CloseReason, Conn, Event, SendError};
use crate::sched::Class;

/// A connection handle. Opaque to the host; only this module interprets it.
///
/// Generation-tagged: the low bits index a slot, the high bits count how many
/// times that slot has been reused. A host that keeps a stale handle after
/// closing gets `None`, not somebody else's connection. Without the generation
/// a slot index is a use-after-free that the type system cannot see, because
/// the "pointer" is just an integer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Handle(u64);

impl Handle {
    fn new(slot: u32, generation: u32) -> Self {
        Handle(((generation as u64) << 32) | slot as u64)
    }
    fn slot(self) -> usize {
        (self.0 & 0xffff_ffff) as usize
    }
    fn generation(self) -> u32 {
        (self.0 >> 32) as u32
    }
    /// The raw integer to hand across the boundary.
    pub fn raw(self) -> u64 {
        self.0
    }
    pub fn from_raw(v: u64) -> Self {
        Handle(v)
    }
}

#[derive(Debug)]
struct Slot {
    generation: u32,
    conn: Option<Conn>,
}

/// Owns every live connection. The shim crate holds exactly one of these.
#[derive(Debug, Default)]
pub struct Registry {
    slots: Vec<Slot>,
    free: Vec<u32>,
}

impl Registry {
    pub fn new() -> Self {
        Registry::default()
    }

    pub fn open(&mut self) -> Handle {
        // Reuse a free slot before growing, so a client that reconnects a
        // thousand times does not grow this vector a thousand entries.
        if let Some(slot) = self.free.pop() {
            let s = &mut self.slots[slot as usize];
            s.generation = s.generation.wrapping_add(1);
            s.conn = Some(Conn::new());
            return Handle::new(slot, s.generation);
        }
        let slot = self.slots.len() as u32;
        self.slots.push(Slot {
            generation: 0,
            conn: Some(Conn::new()),
        });
        Handle::new(slot, 0)
    }

    fn get(&mut self, h: Handle) -> Option<&mut Conn> {
        let s = self.slots.get_mut(h.slot())?;
        if s.generation != h.generation() {
            return None; // a stale handle: the slot was reused
        }
        s.conn.as_mut()
    }

    /// Release a handle. A second close is a no-op, not a panic — the host may
    /// legitimately race a close against a transport error.
    pub fn close(&mut self, h: Handle) -> bool {
        let slot = h.slot();
        let Some(s) = self.slots.get_mut(slot) else {
            return false;
        };
        if s.generation != h.generation() || s.conn.is_none() {
            return false;
        }
        s.conn = None;
        self.free.push(slot as u32);
        true
    }

    pub fn live(&self) -> usize {
        self.slots.iter().filter(|s| s.conn.is_some()).count()
    }

    /// Slots ever allocated, live or free. `allocated() - live()` is the pool
    /// waiting to be reused; if this climbs with reconnects, slots are leaking.
    pub fn allocated(&self) -> usize {
        self.slots.len()
    }

    // ── the calls the shim forwards ──────────────────────────────────────

    pub fn on_open(&mut self, h: Handle) -> Vec<Event> {
        self.get(h).map(|c| c.on_open()).unwrap_or_default()
    }

    pub fn on_bytes(&mut self, h: Handle, data: &[u8]) -> Vec<Event> {
        self.get(h).map(|c| c.on_bytes(data)).unwrap_or_default()
    }

    pub fn on_transport_close(&mut self, h: Handle) -> Vec<Event> {
        self.get(h)
            .map(|c| c.on_transport_close())
            .unwrap_or_default()
    }

    pub fn send(
        &mut self,
        h: Handle,
        class: Class,
        depends_on: u64,
        payload: &[u8],
    ) -> Result<(), SendError> {
        match self.get(h) {
            Some(c) => c.send(class, depends_on, payload),
            None => Err(SendError::NotOpen),
        }
    }

    pub fn poll_out(&mut self, h: Handle) -> Option<Vec<u8>> {
        self.get(h).and_then(|c| c.poll_out())
    }

    pub fn set_applied_epoch(&mut self, h: Handle, epoch: u64) {
        if let Some(c) = self.get(h) {
            c.set_applied_epoch(epoch);
        }
    }
}

/// Event kind tags for the flat encoding below. Stable numbers: the host
/// switches on these, so changing one silently re-routes events.
pub const EVENT_OPEN: u8 = 1;
pub const EVENT_FRAME: u8 = 2;
pub const EVENT_CLOSED: u8 = 3;

/// Close-reason tags. `Protocol` carries no detail here on purpose — see below.
pub const CLOSE_TRANSPORT: u8 = 1;
pub const CLOSE_PROTOCOL: u8 = 2;
pub const CLOSE_BUFFER_OVERFLOW: u8 = 3;
pub const CLOSE_LOCAL: u8 = 4;

/// Flatten events into one buffer for a single crossing.
///
/// ONE CALL, NOT ONE PER EVENT. A WebSocket read can complete many frames at
/// once, and a JSI crossing per frame is the cost that makes people abandon a
/// native module and go back to JSON.
///
/// Encoding, deliberately the same shape as CC-Wire so there is one framing
/// idea in this codebase rather than two:
///   `u8 kind` then, for EVENT_FRAME, `u32be length` + payload
///                   for EVENT_CLOSED, `u8 reason`
pub fn encode_events(events: &[Event]) -> Vec<u8> {
    let mut out = Vec::new();
    for e in events {
        match e {
            Event::Open => out.push(EVENT_OPEN),
            Event::Frame(p) => {
                out.push(EVENT_FRAME);
                out.extend_from_slice(&(p.len() as u32).to_be_bytes());
                out.extend_from_slice(p);
            }
            Event::Closed(r) => {
                out.push(EVENT_CLOSED);
                out.push(match r {
                    CloseReason::Transport => CLOSE_TRANSPORT,
                    // The specific FrameError is NOT sent across. The host's
                    // only correct response to any of them is identical — drop
                    // the connection and reconnect — and a parse-failure detail
                    // handed to application code is a detail that ends up in a
                    // log, attached to whoever was talking to us.
                    CloseReason::Protocol(_) => CLOSE_PROTOCOL,
                    CloseReason::BufferOverflow => CLOSE_BUFFER_OVERFLOW,
                    CloseReason::Local => CLOSE_LOCAL,
                });
            }
        }
    }
    out
}

/// Lowercase hex, for identifiers the host puts in logs. Not for payloads —
/// see the module header.
pub fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(char::from_digit((x >> 4) as u32, 16).unwrap_or('0'));
        s.push(char::from_digit((x & 0xf) as u32, 16).unwrap_or('0'));
    }
    s
}

/// Parse lowercase or uppercase hex. Returns None rather than a partial result:
/// a half-decoded identifier is worse than no identifier.
pub fn from_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in b.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}
