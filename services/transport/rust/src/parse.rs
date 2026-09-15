//! ccwire.v1.Frame — the top-level routing decode, with bounds.
//!
//! This is the SECOND implementation of the CC-Wire codec. The first is
//! `lib/ccwire/codec.ts`. As with `frame.rs`, both assert one committed fixture
//! (`lib/ccwire/__vectors__/codec.json`) so a divergence fails a test rather
//! than being discovered on the wire.
//!
//! WHAT THIS MODULE DELIBERATELY DOES NOT DO
//! -----------------------------------------
//! It does not decode the body types. It reads the routing header —
//! request_id, traffic_class, stream, seq, depends_on — establishes WHICH body
//! is set, and hands the body up as opaque bytes.
//!
//! That is not laziness, it is the same rule `frame.rs` states one layer down:
//! the transport routes, the application interprets. A transport that parses
//! CryptoControl is a transport that can be attacked through CryptoControl, and
//! `envelope.proto` is explicit that the crypto payload is "OPAQUE
//! authenticated bytes" that must survive BYTE FOR BYTE. Bytes you never parse
//! are bytes you cannot corrupt.
//!
//! The EPHEMERAL invariant is still enforced here in full, because `codec.ts`
//! enforces it "on the FIELD NUMBER, before and independently of decoding the
//! body, so it holds for all bodies including the ones this build does not
//! type". Field numbers are all this module needs.
//!
//! ORDER OF CHECKS IS LOAD-BEARING, exactly as in `frame.rs`: total size →
//! depth → per-field bound → allocate. Nothing is allocated from a length a
//! peer declared until that length has been checked against a limit we chose.

use crate::config::MAX_FRAME_BYTES;

/// Negotiated bounds. Every value mirrors `LIMITS` in `lib/ccwire/codec.ts`,
/// which in turn copies `proto/ccwire/v1/capabilities.proto`'s `Limits`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_frame_bytes: usize,
    pub max_opaque_bytes: usize,
    pub max_message_body_bytes: usize,
    pub max_fragments_per_message: u32,
    pub max_nesting_depth: u32,
    pub max_repeated_elements: usize,
    pub max_string_field_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_frame_bytes: 262_144,
            max_opaque_bytes: 196_608,
            max_message_body_bytes: 1_048_576,
            max_fragments_per_message: 16,
            max_nesting_depth: 6,
            max_repeated_elements: 1024,
            max_string_field_bytes: 4096,
        }
    }
}

impl Limits {
    /// Apply a peer's proposal. A negotiated limit may only TIGHTEN.
    ///
    /// Mirrors `resolveLimits` in codec.ts: "A peer proposing a LARGER bound
    /// than this build compiled with does not get it — negotiation is not
    /// authority." Zero means "not proposed", never "unlimited".
    pub fn tighten(self, p: &Limits) -> Limits {
        fn lo(cur: usize, prop: usize) -> usize {
            if prop > 0 && prop < cur {
                prop
            } else {
                cur
            }
        }
        fn lo32(cur: u32, prop: u32) -> u32 {
            if prop > 0 && prop < cur {
                prop
            } else {
                cur
            }
        }
        Limits {
            max_frame_bytes: lo(self.max_frame_bytes, p.max_frame_bytes),
            max_opaque_bytes: lo(self.max_opaque_bytes, p.max_opaque_bytes),
            max_message_body_bytes: lo(self.max_message_body_bytes, p.max_message_body_bytes),
            max_fragments_per_message: lo32(
                self.max_fragments_per_message,
                p.max_fragments_per_message,
            ),
            max_nesting_depth: lo32(self.max_nesting_depth, p.max_nesting_depth),
            max_repeated_elements: lo(self.max_repeated_elements, p.max_repeated_elements),
            max_string_field_bytes: lo(self.max_string_field_bytes, p.max_string_field_bytes),
        }
    }
}

/// Why input was refused. A value, never a string to parse.
///
/// Spellings match the `CodecError` union in codec.ts so one fixture serves both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodecError {
    Truncated,
    BadWireType,
    VarintOverflow,
    FieldZero,
    InvalidUtf8,
    StringTooLong,
    BytesTooLong,
    TooManyElements,
    NestingTooDeep,
    SizeOverMax,
    DuplicateBody,
    ProtocolViolation,
}

impl CodecError {
    pub fn as_str(self) -> &'static str {
        use CodecError::*;
        match self {
            Truncated => "TRUNCATED",
            BadWireType => "BAD_WIRE_TYPE",
            VarintOverflow => "VARINT_OVERFLOW",
            FieldZero => "FIELD_ZERO",
            InvalidUtf8 => "INVALID_UTF8",
            StringTooLong => "STRING_TOO_LONG",
            BytesTooLong => "BYTES_TOO_LONG",
            TooManyElements => "TOO_MANY_ELEMENTS",
            NestingTooDeep => "NESTING_TOO_DEEP",
            SizeOverMax => "SIZE_OVER_MAX",
            DuplicateBody => "DUPLICATE_BODY",
            ProtocolViolation => "PROTOCOL_VIOLATION",
        }
    }

    /// The `errors.proto` ErrorCode to put in an Error frame. Kept beside the
    /// variant rather than in a second switch that could disagree with this one.
    pub fn error_code(self) -> u32 {
        use CodecError::*;
        match self {
            SizeOverMax => 7,                        // ERROR_CODE_FRAME_TOO_LARGE
            DuplicateBody | ProtocolViolation => 11, // ERROR_CODE_PROTOCOL_VIOLATION
            _ => 8,                                  // ERROR_CODE_PAYLOAD_INVALID
        }
    }
}

pub const TRAFFIC_CLASS_EPHEMERAL: u32 = 5;

/// Every `Frame.body` field number, from envelope.proto.
pub const BODY_FIELDS: [u32; 28] = [
    16, 17, 18, 19, 20, 21, 22, 23, //
    32, 33, //
    48, 49, 50, 51, 52, //
    64, 65, //
    80, 81, 82, 83, 84, //
    96, 97, 98, 99, 100, //
    112,
];

/// THE INVARIANT, from envelope.proto: an EPHEMERAL frame may carry ONLY
/// typing_state (81), viewer_state (82) or geo_relay (84).
pub const EPHEMERAL_BODIES: [u32; 3] = [81, 82, 84];

pub fn is_body_field(f: u32) -> bool {
    BODY_FIELDS.contains(&f)
}

/// A decoded Frame. Everything borrows the input — a 256 KiB frame does not
/// become 512 KiB resident.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Frame<'a> {
    pub request_id: &'a str,
    pub traffic_class: u32,
    pub stream: u32,
    /// uint64. Native here — Rust has no 2^53 cliff, so the JS_STRING dance
    /// codec.ts needs has no purpose on this side. The fixture stores decimal
    /// strings and the test parses them, so both agree on the VALUE.
    pub seq: u64,
    pub depends_on: u64,
    pub body_field: Option<u32>,
    /// Opaque body bytes. Empty is meaningful: a bare Ping is a zero-byte
    /// submessage, and `body_field` is what says a body was present.
    pub body: &'a [u8],
    /// Unrecognised top-level fields, tag+value, in wire order. NEVER dropped —
    /// envelope.proto requires unknown fields be PRESERVED.
    pub unknown: Vec<&'a [u8]>,
}

// ── reader ───────────────────────────────────────────────────────────────

struct R<'a> {
    b: &'a [u8],
    p: usize,
}

type Res<T> = Result<T, CodecError>;

impl<'a> R<'a> {
    fn varint64(&mut self) -> Res<u64> {
        let mut out: u64 = 0;
        let mut shift: u32 = 0;
        for _ in 0..10 {
            if self.p >= self.b.len() {
                return Err(CodecError::Truncated);
            }
            let byte = self.b[self.p];
            self.p += 1;
            // Bits shifted past 64 are DISCARDED, matching codec.ts's
            // `out & (TWO64 - 1n)`. A plain `<<` would panic in debug and a
            // wrapping shift would rotate bits back in; neither is the contract.
            if shift < 64 {
                out |= ((byte & 0x7f) as u64) << shift;
            }
            if byte & 0x80 == 0 {
                return Ok(out);
            }
            shift += 7;
        }
        Err(CodecError::VarintOverflow)
    }

    /// A varint in TAG or LENGTH position, capped at FIVE bytes.
    ///
    /// This is codec.ts's `varint32`, and it is the rule for the whole protocol:
    /// a varint longer than five bytes in a tag or a length is not a large
    /// number, it is an over-long encoding probing for a mismatch. Reading it as
    /// a full 64-bit varint here refused the same bytes for a DIFFERENT reason
    /// (`TRUNCATED`) — and for an over-long LENGTH, ACCEPTED a frame codec.ts
    /// refuses. That is the parser differential this module exists to prevent,
    /// and the fixture now pins it.
    fn varint32(&mut self) -> Res<u64> {
        let mut out: u64 = 0;
        let mut shift: u32 = 0;
        for _ in 0..5 {
            if self.p >= self.b.len() {
                return Err(CodecError::Truncated);
            }
            let byte = self.b[self.p];
            self.p += 1;
            out |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                return Ok(out);
            }
            shift += 7;
        }
        Err(CodecError::VarintOverflow)
    }

    fn skip_varint(&mut self) -> Res<()> {
        for _ in 0..10 {
            if self.p >= self.b.len() {
                return Err(CodecError::Truncated);
            }
            let byte = self.b[self.p];
            self.p += 1;
            if byte & 0x80 == 0 {
                return Ok(());
            }
        }
        Err(CodecError::VarintOverflow)
    }

    /// A length-delimited span, as a VIEW. Bounds-checked BEFORE it is produced,
    /// so a declared length never sizes an allocation.
    fn len_span(&mut self) -> Res<&'a [u8]> {
        let n = self.varint32()?;
        let n = usize::try_from(n).map_err(|_| CodecError::Truncated)?;
        let end = self.p.checked_add(n).ok_or(CodecError::Truncated)?;
        if end > self.b.len() {
            return Err(CodecError::Truncated);
        }
        let s = &self.b[self.p..end];
        self.p = end;
        Ok(s)
    }

    /// One field header. Field number 0 is not representable, so its presence is
    /// not a mistake — it is an attack.
    fn tag(&mut self) -> Res<(u32, u8)> {
        let t = self.varint32()?;
        let field = u32::try_from(t >> 3).map_err(|_| CodecError::VarintOverflow)?;
        let wire = (t & 7) as u8;
        if field == 0 {
            return Err(CodecError::FieldZero);
        }
        Ok((field, wire))
    }

    /// Wire types 3 and 4 are proto2 groups: not representable in proto3, and
    /// historically a source of parser-differential bugs. Refused, not skipped.
    fn skip_field(&mut self, wire: u8) -> Res<()> {
        let fixed = |r: &mut Self, n: usize| -> Res<()> {
            let end = r.p.checked_add(n).ok_or(CodecError::Truncated)?;
            if end > r.b.len() {
                return Err(CodecError::Truncated);
            }
            r.p = end;
            Ok(())
        };
        match wire {
            0 => self.skip_varint(),
            1 => fixed(self, 8),
            2 => self.len_span().map(|_| ()),
            5 => fixed(self, 4),
            _ => Err(CodecError::BadWireType),
        }
    }
}

/// Decode one `ccwire.v1.Frame`.
///
/// `depth` is the nesting level this frame already sits at — 0 off the wire, and
/// depth+1 when a fragment reassembler re-decodes a reassembled payload. That is
/// what stops a Fragment-in-Fragment bomb from recursing forever.
///
/// `max_bytes` of 0 means "use the negotiated frame limit", matching the
/// zero-value convention `frame.rs` and the Go `Options` already use.
pub fn decode_frame<'a>(
    buf: &'a [u8],
    lim: &Limits,
    max_bytes: usize,
    depth: u32,
) -> Res<Frame<'a>> {
    let cap = if max_bytes == 0 {
        lim.max_frame_bytes
    } else {
        max_bytes
    };
    let cap = cap.min(MAX_FRAME_BYTES);

    // Whole-payload size FIRST, so every bound below it bounds something already
    // known to be small.
    if buf.len() > cap {
        return Err(CodecError::SizeOverMax);
    }
    if depth > lim.max_nesting_depth {
        return Err(CodecError::NestingTooDeep);
    }

    let mut r = R { b: buf, p: 0 };
    let mut f = Frame::default();

    while r.p < r.b.len() {
        let start = r.p;
        let (field, wire) = r.tag()?;

        match (field, wire) {
            (1, 2) => {
                let span = r.len_span()?;
                if span.len() > lim.max_string_field_bytes {
                    return Err(CodecError::StringTooLong);
                }
                f.request_id = core::str::from_utf8(span).map_err(|_| CodecError::InvalidUtf8)?;
            }
            // Duplicate scalars are LAST-WINS — proto3's rule, and what the
            // TypeScript side does. Deviating here is how a parser differential
            // is born.
            (2, 0) => f.traffic_class = (r.varint64()? & 0xffff_ffff) as u32,
            (3, 0) => f.stream = (r.varint64()? & 0xffff_ffff) as u32,
            (4, 0) => f.seq = r.varint64()?,
            (5, 0) => f.depends_on = r.varint64()?,
            (n, 2) if is_body_field(n) => {
                // A oneof is ONE field. proto3 says last-wins; this REFUSES,
                // because two bodies is a smuggling primitive: if one side takes
                // the last and another takes the first, they disagree about what
                // the peer said while both call it valid.
                if f.body_field.is_some() {
                    return Err(CodecError::DuplicateBody);
                }
                // The body is a nested message, so entering it costs depth even
                // though this module does not parse what is inside.
                if depth + 1 > lim.max_nesting_depth {
                    return Err(CodecError::NestingTooDeep);
                }
                f.body_field = Some(n);
                f.body = r.len_span()?;
            }
            _ => {
                if f.unknown.len() >= lim.max_repeated_elements {
                    return Err(CodecError::TooManyElements);
                }
                r.skip_field(wire)?;
                f.unknown.push(&buf[start..r.p]);
            }
        }
    }

    check_invariants(f.traffic_class, f.body_field)?;
    Ok(f)
}

/// envelope.proto: TRAFFIC_CLASS_UNSPECIFIED is "never valid on the wire;
/// refuse", and EPHEMERAL may carry only typing_state/viewer_state/geo_relay.
fn check_invariants(traffic_class: u32, body_field: Option<u32>) -> Res<()> {
    if traffic_class == 0 {
        return Err(CodecError::ProtocolViolation);
    }
    if traffic_class == TRAFFIC_CLASS_EPHEMERAL {
        if let Some(b) = body_field {
            if !EPHEMERAL_BODIES.contains(&b) {
                return Err(CodecError::ProtocolViolation);
            }
        }
    }
    Ok(())
}

// ── writer ───────────────────────────────────────────────────────────────

fn w_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn w_tag(out: &mut Vec<u8>, field: u32, wire: u8) {
    w_varint(out, (field as u64) * 8 + wire as u64);
}

/// Encode a `ccwire.v1.Frame`.
///
/// The invariant is checked HERE TOO, not only on decode — envelope.proto says
/// "enforced at both encode and decode". A bug that produces a CryptoControl on
/// EPHEMERAL should fail on the machine that has the stack trace, not on the
/// peer that only has bytes.
///
/// Field order and proto3 default-skipping mirror `encodeFrameMessage` exactly,
/// which is what makes decode→encode byte-identical across both languages.
pub fn encode_frame(f: &Frame, lim: &Limits, max_bytes: usize) -> Res<Vec<u8>> {
    check_invariants(f.traffic_class, f.body_field)?;

    let cap = if max_bytes == 0 {
        lim.max_frame_bytes
    } else {
        max_bytes
    };
    let cap = cap.min(MAX_FRAME_BYTES);

    let mut out = Vec::new();

    // proto3: a field at its default value is not written.
    if !f.request_id.is_empty() {
        let b = f.request_id.as_bytes();
        if b.len() > lim.max_string_field_bytes {
            return Err(CodecError::StringTooLong);
        }
        w_tag(&mut out, 1, 2);
        w_varint(&mut out, b.len() as u64);
        out.extend_from_slice(b);
    }
    if f.traffic_class != 0 {
        w_tag(&mut out, 2, 0);
        w_varint(&mut out, f.traffic_class as u64);
    }
    if f.stream != 0 {
        w_tag(&mut out, 3, 0);
        w_varint(&mut out, f.stream as u64);
    }
    if f.seq != 0 {
        w_tag(&mut out, 4, 0);
        w_varint(&mut out, f.seq);
    }
    if f.depends_on != 0 {
        w_tag(&mut out, 5, 0);
        w_varint(&mut out, f.depends_on);
    }
    if let Some(n) = f.body_field {
        if !is_body_field(n) {
            return Err(CodecError::ProtocolViolation);
        }
        if f.body.len() > lim.max_message_body_bytes {
            return Err(CodecError::BytesTooLong);
        }
        // Unlike every other field, an EMPTY body is written: a bare Ping is a
        // zero-byte submessage and dropping it would erase which body was set.
        w_tag(&mut out, n, 2);
        w_varint(&mut out, f.body.len() as u64);
        out.extend_from_slice(f.body);
    }
    for u in &f.unknown {
        out.extend_from_slice(u);
    }

    if out.len() > cap {
        return Err(CodecError::SizeOverMax);
    }
    Ok(out)
}
