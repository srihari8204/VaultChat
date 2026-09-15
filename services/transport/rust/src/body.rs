//! The six typed `ccwire.v1.Frame` bodies, decoded from the opaque bytes
//! `parse.rs` hands up.
//!
//! LAYERING. `parse.rs` routes: it reads the header, says WHICH body is set and
//! gives you the body as bytes. It does not look inside, and it must not — a
//! transport that parses CryptoControl is a transport that can be attacked
//! through CryptoControl. This module is the other half: the caller that has
//! already decided it wants to interpret a body calls in here with those bytes.
//! Nothing on the routing path reaches this file.
//!
//! WHY IT EXISTS AT ALL. `lib/ccwire/codec.ts` decodes these six. Until this
//! module, a MALFORMED typing_state was refused by TypeScript and accepted by
//! Rust, because Rust never looked. Two implementations that disagree about
//! which bytes are valid are one parser differential, and the shared fixture
//! `lib/ccwire/__vectors__/codec.json` now carries the malformed cases so the
//! disagreement fails a test instead of shipping.
//!
//! MIRRORS codec.ts FIELD FOR FIELD: same field numbers and wire types, proto3
//! defaults materialised on decode, duplicate scalars LAST-WINS, unknown fields
//! PRESERVED verbatim (tag included, never walked into), the same bound on the
//! same field, and the same typed refusal for each.
//!
//! Two deliberate differences from codec.ts, neither observable on the wire:
//!   * 64-bit fields are native `u64`/`i64`. The JS_STRING dance exists because
//!     a double rounds 2^53+1 away; Rust has no such cliff. The fixture stores
//!     decimal strings and the tests parse them, so both agree on the VALUE.
//!   * Everything borrows the input, so decoding a body does not copy it.
//!
//! The reader below is a near-copy of the one in `parse.rs`, which is private
//! there. Both cap a varint in TAG OR LENGTH position at five bytes
//! (`varint32`) — a longer one there is not a large number, it is an over-long
//! encoding probing for a mismatch. `parse.rs` did not, until the fixture's
//! over-long-tag and over-long-length frame vectors caught it reading a 10-byte
//! varint and landing on `TRUNCATED` (and, for a length, ACCEPTING a frame
//! codec.ts refuses). One rule, three implementations, one fixture.

use crate::parse::{CodecError, Limits};

type Res<T> = Result<T, CodecError>;

// ── enum name surfacing ──────────────────────────────────────────────────
//
// codec.ts: "An enum value this build does not know is RETAINED AS ITS NUMBER
// and surfaced as *_UNSPECIFIED". So the number is authoritative and is what
// re-encodes; the name is what application code branches on.

const VIEWER_ACTIVITY_NAMES: [&str; 4] = [
    "VIEWER_ACTIVITY_UNSPECIFIED",
    "VIEWER_ACTIVITY_READING",
    "VIEWER_ACTIVITY_TYPING",
    "VIEWER_ACTIVITY_UPLOADING",
];
const SCOPE_KIND_NAMES: [&str; 6] = [
    "SCOPE_KIND_UNSPECIFIED",
    "SCOPE_KIND_CHAT",
    "SCOPE_KIND_CHANNEL",
    "SCOPE_KIND_CALL",
    "SCOPE_KIND_RUN",
    "SCOPE_KIND_ADMIN",
];
const CRYPTO_CONTROL_KIND_NAMES: [&str; 5] = [
    "CRYPTO_CONTROL_KIND_UNSPECIFIED",
    "CRYPTO_CONTROL_KIND_REKEY",
    "CRYPTO_CONTROL_KIND_MEDIA_KEY",
    "CRYPTO_CONTROL_KIND_PREKEY",
    "CRYPTO_CONTROL_KIND_GROUP_OP",
];
const MESSAGE_CLASS_NAMES: [&str; 5] = [
    "MESSAGE_CLASS_UNSPECIFIED",
    "MESSAGE_CLASS_NORMAL",
    "MESSAGE_CLASS_SILENT",
    "MESSAGE_CLASS_SYSTEM",
    "MESSAGE_CLASS_CONTROL",
];

fn surface(names: &[&'static str], n: u32) -> &'static str {
    names.get(n as usize).copied().unwrap_or(names[0])
}

// ── shapes ───────────────────────────────────────────────────────────────

/// `unknown` holds whole fields — tag and value — in wire order, verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TypingState<'a> {
    pub chat_id: &'a str,
    pub typing: bool,
    pub sender_uid: &'a str,
    pub unknown: Vec<&'a [u8]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ViewerState<'a> {
    pub chat_id: &'a str,
    pub activity: u32,
    pub leaving: bool,
    pub resync: bool,
    pub unknown: Vec<&'a [u8]>,
}

impl ViewerState<'_> {
    pub fn activity_name(&self) -> &'static str {
        surface(&VIEWER_ACTIVITY_NAMES, self.activity)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GeoRelay<'a> {
    pub scope_kind: u32,
    pub scope_id: &'a str,
    pub subject_id: &'a str,
    pub sealed: &'a [u8],
    pub ended: bool,
    /// int64 — signed, so an expiry before the epoch is representable.
    pub until_ms: i64,
    pub sender_uid: &'a str,
    pub unknown: Vec<&'a [u8]>,
}

impl GeoRelay<'_> {
    pub fn scope_kind_name(&self) -> &'static str {
        surface(&SCOPE_KIND_NAMES, self.scope_kind)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CryptoControl<'a> {
    pub kind: u32,
    pub chat_id: &'a str,
    pub to_uid: &'a str,
    /// OPAQUE authenticated bytes. Borrowed, never rewritten.
    pub payload: &'a [u8],
    pub epoch: u64,
    pub payload_format: &'a str,
    pub unknown: Vec<&'a [u8]>,
}

impl CryptoControl<'_> {
    pub fn kind_name(&self) -> &'static str {
        surface(&CRYPTO_CONTROL_KIND_NAMES, self.kind)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PublicMeta<'a> {
    pub attachment_id: &'a str,
    pub view_once: bool,
    pub revoked: bool,
    pub announcement: bool,
    pub audience: &'a str,
    pub silent: bool,
    pub group_id: &'a str,
    pub gif_url: &'a str,
    pub allow_multiple: bool,
    pub option_count: u32,
    pub mention_user_ids: Vec<&'a str>,
    pub encrypted: bool,
    pub game: &'a str,
    pub room: &'a str,
    pub unknown: Vec<&'a [u8]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Envelope<'a> {
    pub chat_id: &'a str,
    pub message_id: &'a str,
    pub client_msg_id: &'a str,
    pub server_ts_ms: i64,
    pub msg_class: u32,
    pub causal_epoch: u64,
    /// Presence is meaningful in proto3: `None` and an all-default `Some` are
    /// different frames and must not be collapsed.
    pub public_meta: Option<PublicMeta<'a>>,
    pub unknown: Vec<&'a [u8]>,
}

impl Envelope<'_> {
    pub fn msg_class_name(&self) -> &'static str {
        surface(&MESSAGE_CLASS_NAMES, self.msg_class)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SubmitMessage<'a> {
    pub envelope: Option<Envelope<'a>>,
    pub sealed: &'a [u8],
    pub unknown: Vec<&'a [u8]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Fragment<'a> {
    pub fragment_id: &'a str,
    pub index: u32,
    pub total: u32,
    pub total_bytes: u64,
    pub chunk: &'a [u8],
    pub last: bool,
    pub unknown: Vec<&'a [u8]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Cursor<'a> {
    pub chat_id: &'a str,
    pub kind: u32,
    pub position: u64,
    pub updated_at_ms: i64,
    pub unknown: Vec<&'a [u8]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CursorSync<'a> {
    pub cursors: Vec<Cursor<'a>>,
    pub mutation_continuation: &'a str,
    pub unknown: Vec<&'a [u8]>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CursorBatch<'a> {
    pub cursors: Vec<Cursor<'a>>,
    pub more: bool,
    pub continuation: &'a str,
    pub mutation_continuation: &'a str,
    pub unknown: Vec<&'a [u8]>,
}

/// A decoded body. `decode_body` returns `None` for the other 21 field numbers,
/// which stay opaque — never lost, never silently reinterpreted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body<'a> {
    SubmitMessage(SubmitMessage<'a>),
    TypingState(TypingState<'a>),
    ViewerState(ViewerState<'a>),
    GeoRelay(GeoRelay<'a>),
    CryptoControl(CryptoControl<'a>),
    Fragment(Fragment<'a>),
}

/// The body field numbers this module decodes. Mirrors `TYPED_BODY` in codec.ts.
pub const TYPED_BODIES: [u32; 6] = [48, 81, 82, 84, 98, 112];

// ── reader ───────────────────────────────────────────────────────────────

struct R<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> R<'a> {
    fn done(&self) -> bool {
        self.p >= self.b.len()
    }

    /// Full 64-bit varint, for VALUES. Bits past 64 are DISCARDED, matching
    /// codec.ts's `out & (TWO64 - 1n)`.
    fn varint64(&mut self) -> Res<u64> {
        let mut out: u64 = 0;
        let mut shift: u32 = 0;
        for _ in 0..10 {
            if self.done() {
                return Err(CodecError::Truncated);
            }
            let byte = self.b[self.p];
            self.p += 1;
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

    /// Varints in TAG or LENGTH position, capped at five bytes — codec.ts's
    /// `varint32`. A longer one there is an over-long encoding, not a number.
    fn varint32(&mut self) -> Res<u64> {
        let mut out: u64 = 0;
        let mut shift: u32 = 0;
        for _ in 0..5 {
            if self.done() {
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
            if self.done() {
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
        let n = usize::try_from(self.varint32()?).map_err(|_| CodecError::Truncated)?;
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
        if field == 0 {
            return Err(CodecError::FieldZero);
        }
        Ok((field, (t & 7) as u8))
    }

    /// Wire types 3 and 4 are proto2 groups: not representable in proto3, and a
    /// classic parser-differential vector. Refused, not skipped.
    fn skip_field(&mut self, wire: u8) -> Res<()> {
        let mut fixed = |n: usize| -> Res<()> {
            let end = self.p.checked_add(n).ok_or(CodecError::Truncated)?;
            if end > self.b.len() {
                return Err(CodecError::Truncated);
            }
            self.p = end;
            Ok(())
        };
        match wire {
            1 => fixed(8),
            5 => fixed(4),
            0 => self.skip_varint(),
            2 => self.len_span().map(|_| ()),
            _ => Err(CodecError::BadWireType),
        }
    }

    fn bool(&mut self) -> Res<bool> {
        Ok(self.varint64()? != 0)
    }

    fn u32(&mut self) -> Res<u32> {
        Ok((self.varint64()? & 0xffff_ffff) as u32)
    }

    /// int64: the same 64 bits, read as two's complement.
    fn i64(&mut self) -> Res<i64> {
        Ok(self.varint64()? as i64)
    }

    /// BOUND CHECKED IN BYTES, BEFORE THE UTF-8 DECODE — a cap applied to the
    /// decoded string would let a 3x multi-byte payload through the gate it
    /// exists to hold. Invalid UTF-8 is REFUSED, never replaced: substituting
    /// U+FFFD would make the two sides disagree about what the bytes said.
    fn string(&mut self, lim: &Limits) -> Res<&'a str> {
        let s = self.len_span()?;
        if s.len() > lim.max_string_field_bytes {
            return Err(CodecError::StringTooLong);
        }
        core::str::from_utf8(s).map_err(|_| CodecError::InvalidUtf8)
    }

    fn bytes(&mut self, cap: usize) -> Res<&'a [u8]> {
        let s = self.len_span()?;
        if s.len() > cap {
            return Err(CodecError::BytesTooLong);
        }
        Ok(s)
    }
}

/// The unknown-field path. Copies the WHOLE field — tag included — verbatim and
/// does NOT walk into it. Not walking is the security property: a nesting bomb
/// inside a field this build cannot interpret costs nothing to skip, and a
/// re-encode reproduces it exactly.
fn keep_unknown<'a>(
    r: &mut R<'a>,
    start: usize,
    wire: u8,
    into: &mut Vec<&'a [u8]>,
    lim: &Limits,
) -> Res<()> {
    if into.len() >= lim.max_repeated_elements {
        return Err(CodecError::TooManyElements);
    }
    r.skip_field(wire)?;
    into.push(&r.b[start..r.p]);
    Ok(())
}

/// Enter a nested message. `child_depth` is the depth of the message being
/// entered, and it is checked BEFORE the length is read — exactly as codec.ts's
/// `nest` does, and exactly as `parse.rs` charges the body itself.
fn nest<'a>(r: &mut R<'a>, child_depth: u32, lim: &Limits) -> Res<R<'a>> {
    if child_depth > lim.max_nesting_depth {
        return Err(CodecError::NestingTooDeep);
    }
    Ok(R {
        b: r.len_span()?,
        p: 0,
    })
}

// ── decoders ─────────────────────────────────────────────────────────────
//
// Each is the same skeleton: loop fields, match on (number, wire type),
// anything else goes to keep_unknown. A field number that is known but arrives
// with the WRONG wire type is therefore an unknown field, not an error — that
// is what codec.ts does, and disagreeing about it is a differential.

fn read_typing_state<'a>(r: &mut R<'a>, lim: &Limits) -> Res<TypingState<'a>> {
    let mut m = TypingState::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 2) => m.chat_id = r.string(lim)?,
            (2, 0) => m.typing = r.bool()?,
            (3, 2) => m.sender_uid = r.string(lim)?,
            (_, wire) => keep_unknown(r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

fn read_viewer_state<'a>(r: &mut R<'a>, lim: &Limits) -> Res<ViewerState<'a>> {
    let mut m = ViewerState::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 2) => m.chat_id = r.string(lim)?,
            (2, 0) => m.activity = r.u32()?,
            (3, 0) => m.leaving = r.bool()?,
            (4, 0) => m.resync = r.bool()?,
            (_, wire) => keep_unknown(r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

fn read_geo_relay<'a>(r: &mut R<'a>, lim: &Limits) -> Res<GeoRelay<'a>> {
    let mut m = GeoRelay::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 0) => m.scope_kind = r.u32()?,
            (2, 2) => m.scope_id = r.string(lim)?,
            (3, 2) => m.subject_id = r.string(lim)?,
            (4, 2) => m.sealed = r.bytes(lim.max_opaque_bytes)?,
            (5, 0) => m.ended = r.bool()?,
            (6, 0) => m.until_ms = r.i64()?,
            (7, 2) => m.sender_uid = r.string(lim)?,
            (_, wire) => keep_unknown(r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

fn read_crypto_control<'a>(r: &mut R<'a>, lim: &Limits) -> Res<CryptoControl<'a>> {
    let mut m = CryptoControl::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 0) => m.kind = r.u32()?,
            (2, 2) => m.chat_id = r.string(lim)?,
            (3, 2) => m.to_uid = r.string(lim)?,
            (4, 2) => m.payload = r.bytes(lim.max_opaque_bytes)?,
            (5, 0) => m.epoch = r.varint64()?,
            (6, 2) => m.payload_format = r.string(lim)?,
            (_, wire) => keep_unknown(r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

fn read_public_meta<'a>(r: &mut R<'a>, lim: &Limits) -> Res<PublicMeta<'a>> {
    let mut m = PublicMeta::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 2) => m.attachment_id = r.string(lim)?,
            (2, 0) => m.view_once = r.bool()?,
            (3, 0) => m.revoked = r.bool()?,
            (4, 0) => m.announcement = r.bool()?,
            (5, 2) => m.audience = r.string(lim)?,
            (6, 0) => m.silent = r.bool()?,
            (7, 2) => m.group_id = r.string(lim)?,
            (8, 2) => m.gif_url = r.string(lim)?,
            (9, 0) => m.allow_multiple = r.bool()?,
            (10, 0) => m.option_count = r.u32()?,
            (11, 2) => {
                // Checked BEFORE the element is appended, so a repeated field
                // cannot grow the heap past the cap even by one.
                if m.mention_user_ids.len() >= lim.max_repeated_elements {
                    return Err(CodecError::TooManyElements);
                }
                let s = r.string(lim)?;
                m.mention_user_ids.push(s);
            }
            (12, 0) => m.encrypted = r.bool()?,
            (13, 2) => m.game = r.string(lim)?,
            (14, 2) => m.room = r.string(lim)?,
            (_, wire) => keep_unknown(r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

fn read_envelope<'a>(r: &mut R<'a>, lim: &Limits, depth: u32) -> Res<Envelope<'a>> {
    let mut m = Envelope::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 2) => m.chat_id = r.string(lim)?,
            (2, 2) => m.message_id = r.string(lim)?,
            (3, 2) => m.client_msg_id = r.string(lim)?,
            (4, 0) => m.server_ts_ms = r.i64()?,
            (5, 0) => m.msg_class = r.u32()?,
            (6, 0) => m.causal_epoch = r.varint64()?,
            (7, 2) => {
                let mut sub = nest(r, depth + 1, lim)?;
                m.public_meta = Some(read_public_meta(&mut sub, lim)?);
            }
            (_, wire) => keep_unknown(r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

fn read_submit_message<'a>(r: &mut R<'a>, lim: &Limits, depth: u32) -> Res<SubmitMessage<'a>> {
    let mut m = SubmitMessage::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 2) => {
                let mut sub = nest(r, depth + 1, lim)?;
                m.envelope = Some(read_envelope(&mut sub, lim, depth + 1)?);
            }
            // The one field bounded at max_message_body_bytes rather than
            // max_opaque_bytes: it is the message body, and it arrives
            // reassembled from fragments, so it legitimately exceeds a frame.
            (2, 2) => m.sealed = r.bytes(lim.max_message_body_bytes)?,
            (_, wire) => keep_unknown(r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

fn read_fragment<'a>(r: &mut R<'a>, lim: &Limits) -> Res<Fragment<'a>> {
    let mut m = Fragment::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 2) => m.fragment_id = r.string(lim)?,
            (2, 0) => m.index = r.u32()?,
            (3, 0) => {
                m.total = r.u32()?;
                if m.total > lim.max_fragments_per_message {
                    return Err(CodecError::TooManyElements);
                }
            }
            (4, 0) => {
                m.total_bytes = r.varint64()?;
                // Declared up front, checked BEFORE anything is allocated from
                // it. The reassembler must not be handed a number it would
                // trust.
                if m.total_bytes > lim.max_message_body_bytes as u64 {
                    return Err(CodecError::BytesTooLong);
                }
            }
            (5, 2) => m.chunk = r.len_span()?, // bounded by the frame itself
            (6, 0) => m.last = r.bool()?,
            (_, wire) => keep_unknown(r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

fn read_cursor<'a>(r: &mut R<'a>, lim: &Limits) -> Res<Cursor<'a>> {
    let mut m = Cursor::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 2) => m.chat_id = r.string(lim)?,
            (2, 0) => m.kind = r.u32()?,
            (3, 0) => m.position = r.varint64()?,
            (4, 0) => m.updated_at_ms = r.i64()?,
            (_, wire) => keep_unknown(r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

pub fn decode_cursor_sync<'a>(buf: &'a [u8], lim: &Limits, depth: u32) -> Res<CursorSync<'a>> {
    let mut r = R { b: buf, p: 0 };
    let mut m = CursorSync::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 2) => {
                if m.cursors.len() >= lim.max_repeated_elements {
                    return Err(CodecError::TooManyElements);
                }
                let mut sub = nest(&mut r, depth + 1, lim)?;
                m.cursors.push(read_cursor(&mut sub, lim)?);
            }
            (2, 2) => m.mutation_continuation = r.string(lim)?,
            (_, wire) => keep_unknown(&mut r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

pub fn decode_cursor_batch<'a>(buf: &'a [u8], lim: &Limits, depth: u32) -> Res<CursorBatch<'a>> {
    let mut r = R { b: buf, p: 0 };
    let mut m = CursorBatch::default();
    while !r.done() {
        let start = r.p;
        match r.tag()? {
            (1, 2) => {
                if m.cursors.len() >= lim.max_repeated_elements {
                    return Err(CodecError::TooManyElements);
                }
                let mut sub = nest(&mut r, depth + 1, lim)?;
                m.cursors.push(read_cursor(&mut sub, lim)?);
            }
            (2, 0) => m.more = r.bool()?,
            (3, 2) => m.continuation = r.string(lim)?,
            (4, 2) => m.mutation_continuation = r.string(lim)?,
            (_, wire) => keep_unknown(&mut r, start, wire, &mut m.unknown, lim)?,
        }
    }
    Ok(m)
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}
fn put_bytes(out: &mut Vec<u8>, field: u32, value: &[u8]) {
    if value.is_empty() {
        return;
    }
    put_varint(out, field as u64 * 8 + 2);
    put_varint(out, value.len() as u64);
    out.extend_from_slice(value);
}
fn put_uint(out: &mut Vec<u8>, field: u32, value: u64) {
    if value == 0 {
        return;
    }
    put_varint(out, field as u64 * 8);
    put_varint(out, value);
}

pub fn encode_cursor_sync(m: &CursorSync<'_>) -> Vec<u8> {
    let mut out = Vec::new();
    for c in &m.cursors {
        let mut sub = Vec::new();
        put_bytes(&mut sub, 1, c.chat_id.as_bytes());
        put_uint(&mut sub, 2, c.kind as u64);
        put_uint(&mut sub, 3, c.position);
        put_uint(&mut sub, 4, c.updated_at_ms as u64);
        for u in &c.unknown {
            sub.extend_from_slice(u);
        }
        put_varint(&mut out, 10);
        put_varint(&mut out, sub.len() as u64);
        out.extend_from_slice(&sub);
    }
    put_bytes(&mut out, 2, m.mutation_continuation.as_bytes());
    for u in &m.unknown {
        out.extend_from_slice(u);
    }
    out
}

/// Decode one body.
///
/// `field` is `Frame.body_field`, `buf` is `Frame.body`, and `depth` is the
/// depth the body message itself sits at — 1 for a body taken from a frame read
/// off the wire, because `parse.rs` has already charged one level for entering
/// it. Returns `Ok(None)` for a body number this build does not type; those stay
/// opaque bytes, which is a decision, not a gap.
pub fn decode_body<'a>(
    field: u32,
    buf: &'a [u8],
    lim: &Limits,
    depth: u32,
) -> Res<Option<Body<'a>>> {
    if depth > lim.max_nesting_depth {
        return Err(CodecError::NestingTooDeep);
    }
    let mut r = R { b: buf, p: 0 };
    Ok(Some(match field {
        48 => Body::SubmitMessage(read_submit_message(&mut r, lim, depth)?),
        81 => Body::TypingState(read_typing_state(&mut r, lim)?),
        82 => Body::ViewerState(read_viewer_state(&mut r, lim)?),
        84 => Body::GeoRelay(read_geo_relay(&mut r, lim)?),
        98 => Body::CryptoControl(read_crypto_control(&mut r, lim)?),
        112 => Body::Fragment(read_fragment(&mut r, lim)?),
        _ => return Ok(None),
    }))
}
