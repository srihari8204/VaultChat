//! CC-Wire v1 length-prefixed framing — the Rust implementation.
//!
//! THIS IS THE THIRD IMPLEMENTATION of one wire format. The other two are
//! `lib/ccwire/frame.ts` and `vaultchat-backend-go/internal/ccwire/frame.go`.
//! All three assert the SAME committed fixture, `lib/ccwire/__vectors__/frame.json`,
//! so a divergence fails a test instead of being discovered on the wire.
//!
//! Three implementations of the same thing is normally a smell. Here it is the
//! point: the client speaks it, the server speaks it, and the Rust transport
//! will speak it. What must never happen is three DIALECTS, which is why the
//! fixture is generated once and asserted everywhere rather than each side
//! testing itself against its own idea of the format.
//!
//! ```text
//!   u8  framing_version
//!   u32 length, big-endian
//!   ... length bytes of opaque payload
//! ```
//!
//! The payload is opaque BY DESIGN. This module cannot parse protobuf and must
//! not learn how: the length bound has to be enforced before any decoder sees
//! the input, and a decoder that allocates from a client-declared length is the
//! memory-exhaustion bug this layer exists to prevent.
//!
//! No I/O, no async, no allocation beyond what the caller provides. Pure
//! functions, fuzzable, testable without a runtime — the design's rule for a
//! leaf module.

use crate::config::{HEADER_BYTES, MAX_FRAME_BYTES};

/// Wire framing version. Bumped only for a breaking change to THIS header.
pub const FRAMING_VERSION: u8 = 1;

/// Why a frame was refused.
///
/// A value, never a string: the caller decides between dropping the frame and
/// dropping the connection, and that decision must not depend on parsing prose.
/// Spellings match the TypeScript `FrameError` union and the Go error values so
/// one fixture serves all three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// Fewer bytes than the header, or fewer than the length claims.
    /// At stream level this means "await more bytes", not "give up".
    Incomplete,
    /// A framing version we do not speak. Refused outright — never negotiated
    /// down, because capability negotiation happens INSIDE a frame we can
    /// already parse.
    BadVersion,
    /// Declared length exceeds the configured ceiling.
    LengthOverMax,
    /// Declared length cannot be represented as a usable size on this target.
    LengthOverflow,
    /// Buffer carried more than the single frame it declared (strict mode).
    TrailingBytes,
}

impl FrameError {
    /// The name used in the shared fixture, so the parity test compares
    /// like for like across three languages.
    pub fn as_str(self) -> &'static str {
        match self {
            FrameError::Incomplete => "INCOMPLETE",
            FrameError::BadVersion => "BAD_VERSION",
            FrameError::LengthOverMax => "LENGTH_OVER_MAX",
            FrameError::LengthOverflow => "LENGTH_OVERFLOW",
            FrameError::TrailingBytes => "TRAILING_BYTES",
        }
    }
}

/// A decoded frame. `payload` borrows the input — no copy, so a 2 MiB frame
/// does not become 4 MiB resident.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame<'a> {
    pub version: u8,
    pub payload: &'a [u8],
    /// Total bytes this frame occupied, so a stream reader can advance.
    pub consumed: usize,
}

/// Clamp a negotiated ceiling. A peer may propose a LOWER max; it may never
/// raise ours. Zero means "use the hard max" — matching the Go `Options`
/// zero-value convention so the fixture's `maxBytes: 0` means the same thing
/// in every implementation.
#[inline]
fn cap_of(max_bytes: usize) -> usize {
    if max_bytes == 0 { MAX_FRAME_BYTES } else { max_bytes.min(MAX_FRAME_BYTES) }
}

/// Encode one frame.
///
/// Errors only for a payload WE produced that is too large — remote input never
/// reaches this function, so this is a programming-error path, not a hostile-
/// input path.
pub fn encode(payload: &[u8], max_bytes: usize) -> Result<Vec<u8>, FrameError> {
    let cap = cap_of(max_bytes);
    if payload.len() > cap {
        return Err(FrameError::LengthOverMax);
    }
    let len = payload.len() as u32;
    let mut out = Vec::with_capacity(HEADER_BYTES + payload.len());
    out.push(FRAMING_VERSION);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Decode one frame from the head of `buf`.
///
/// NEVER ALLOCATES BEFORE VALIDATING. Order matters and is load-bearing:
/// header present → version known → length representable → length within cap →
/// bytes actually present. Reordering any of these reintroduces the bug the
/// module exists to prevent.
pub fn decode(buf: &[u8], max_bytes: usize, strict: bool) -> Result<Frame<'_>, FrameError> {
    let cap = cap_of(max_bytes);

    if buf.len() < HEADER_BYTES {
        return Err(FrameError::Incomplete);
    }

    let version = buf[0];
    if version != FRAMING_VERSION {
        return Err(FrameError::BadVersion);
    }

    // u32::from_be_bytes is unsigned by construction, so Rust does not have the
    // signed-shift hazard that forces `>>> 0` in the TypeScript implementation.
    // The OUTCOME must still match for 0x80000000 and 0xffffffff, and both are
    // vectors in the shared fixture.
    let len_u32 = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);

    // On a 16-bit or 32-bit target a u32 length may not fit a usize, and the
    // header must not be what overflows. Unreachable on 64-bit; kept so the
    // conversion is never the thing that decides the bound.
    let len = match usize::try_from(len_u32) {
        Ok(n) => n,
        Err(_) => return Err(FrameError::LengthOverflow),
    };
    if len.checked_add(HEADER_BYTES).is_none() {
        return Err(FrameError::LengthOverflow);
    }

    if len > cap {
        // THE CHECK THIS MODULE EXISTS FOR. Refused before any allocation.
        return Err(FrameError::LengthOverMax);
    }

    let end = HEADER_BYTES + len;
    if buf.len() < end {
        return Err(FrameError::Incomplete);
    }
    if strict && buf.len() > end {
        return Err(FrameError::TrailingBytes);
    }

    Ok(Frame { version, payload: &buf[HEADER_BYTES..end], consumed: end })
}

/// Whole frames currently available in a stream buffer.
///
/// Returns what was decoded plus how many bytes were consumed, so the caller
/// keeps the remainder for the next read.
///
/// `Incomplete` is NOT an error here — it means "await more bytes". Any other
/// error STOPS the scan: a length-prefixed stream has no resynchronisation
/// point, because after a bad length the next frame's offset is unknowable.
/// Skipping ahead and hoping is how a parser starts interpreting payload as
/// header.
pub fn decode_stream(
    buf: &[u8],
    max_bytes: usize,
) -> (Vec<&[u8]>, usize, Option<FrameError>) {
    let mut frames = Vec::new();
    let mut off = 0usize;
    loop {
        match decode(&buf[off..], max_bytes, false) {
            Ok(f) => {
                frames.push(f.payload);
                off += f.consumed;
                if off >= buf.len() {
                    return (frames, off, None);
                }
            }
            Err(FrameError::Incomplete) => return (frames, off, None),
            Err(e) => return (frames, off, Some(e)),
        }
    }
}
