//! The handshake bodies — the ONLY protobuf this crate speaks.
//!
//! `transport-core`'s `parse` module states its own boundary: it reads the
//! routing header and "does not decode the 27 body types", because a transport
//! that parses a body is a transport that can be attacked through one. That
//! rule is kept. What a CLIENT additionally needs, and a router does not, is to
//! say hello: `ClientHello` must be built and `ServerHello` must be read, or
//! there is no session to route anything over.
//!
//! So exactly two bodies are handled here and no others. `Ping`/`Pong` are NOT
//! in this file on purpose — `Pong` mirrors `Ping` field for field, so the body
//! is echoed verbatim, which is both faster and unable to corrupt a nonce.
//!
//! Field numbers come from `proto/ccwire/v1/envelope.proto` and
//! `proto/ccwire/v1/capabilities.proto`; the encoder mirrors
//! `serverHello()`/`encodeLimits()` in `internal/realtime/ccwire.go` so the two
//! sides agree about which defaults are omitted.
//!
//! EVERY DECODE PATH TAKES UNTRUSTED INPUT. It allocates nothing from a
//! peer-declared length, never panics, and answers `None` rather than
//! part-filling a struct: a half-parsed ServerHello is a session that believes
//! it negotiated something it did not.

use transport_core::parse::Limits;
use transport_core::session::{Capabilities, ResumeToken, ServerHello};

// ── writer ───────────────────────────────────────────────────────────────

fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn f_varint(out: &mut Vec<u8>, field: u32, v: u64) {
    varint(out, (field as u64) * 8);
    varint(out, v);
}

fn f_bytes(out: &mut Vec<u8>, field: u32, b: &[u8]) {
    varint(out, (field as u64) * 8 + 2);
    varint(out, b.len() as u64);
    out.extend_from_slice(b);
}

/// `Capabilities`, proto3 rules: a `false` bool is its default and is NOT
/// written. `experimental` (15) is echoed back unmodified — a capability this
/// build cannot name is one it cannot implement, so carrying the string is the
/// only safe thing to do with it.
pub fn capabilities(c: &Capabilities) -> Vec<u8> {
    let mut b = Vec::new();
    for (field, on) in [
        (1u32, c.fragmentation),
        (2, c.resumption),
        (3, c.batch_cursor_sync),
        (4, c.datagrams),
        (5, c.reauth_in_place),
        (6, c.causal_epochs),
        (7, c.structured_errors),
    ] {
        if on {
            f_varint(&mut b, field, 1);
        }
    }
    for e in &c.experimental {
        f_bytes(&mut b, 15, e.as_bytes());
    }
    b
}

/// `Limits` as a client PROPOSAL. Advisory by contract — "the server's values
/// bind" — so this exists to propose something SMALLER, never to claim more.
pub fn limits(l: &Limits) -> Vec<u8> {
    let mut b = Vec::new();
    f_varint(&mut b, 1, l.max_frame_bytes as u64);
    f_varint(&mut b, 2, l.max_opaque_bytes as u64);
    f_varint(&mut b, 3, l.max_message_body_bytes as u64);
    f_varint(&mut b, 4, l.max_fragments_per_message as u64);
    f_varint(&mut b, 8, l.max_nesting_depth as u64);
    f_varint(&mut b, 9, l.max_repeated_elements as u64);
    f_varint(&mut b, 10, l.max_string_field_bytes as u64);
    b
}

/// `ClientHello`.
///
/// `credential` (6) is carried because the wire has the field, but the Go
/// server deliberately does not read it: the connection was already
/// authenticated by `httpx.RequireAuth` at the upgrade. Passing an empty slice
/// is therefore correct against that peer, and is what the example binary does
/// — the Bearer header is the credential that matters.
pub fn client_hello(
    device_id: &str,
    credential: &[u8],
    caps: &Capabilities,
    lim: &Limits,
) -> Vec<u8> {
    let mut b = Vec::new();
    f_varint(&mut b, 1, 1); // protocol_major. minor (2) is 0 ⇒ not written.
    f_bytes(&mut b, 3, &capabilities(caps));
    f_bytes(&mut b, 4, &limits(lim));
    if !device_id.is_empty() {
        f_bytes(&mut b, 5, device_id.as_bytes());
    }
    if !credential.is_empty() {
        f_bytes(&mut b, 6, credential);
    }
    // resume_token (7) is empty: the Go peer does not implement resumption and
    // an unusable token is worse than none.
    b
}

// ── reader ───────────────────────────────────────────────────────────────

struct R<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> R<'a> {
    fn varint(&mut self) -> Option<u64> {
        let mut out = 0u64;
        let mut shift = 0u32;
        for _ in 0..10 {
            let byte = *self.b.get(self.p)?;
            self.p += 1;
            if shift < 64 {
                out |= ((byte & 0x7f) as u64) << shift;
            }
            if byte & 0x80 == 0 {
                return Some(out);
            }
            shift += 7;
        }
        None
    }

    /// A length-delimited span as a VIEW, bounds-checked before it is produced,
    /// so a peer-declared length never sizes an allocation.
    fn span(&mut self) -> Option<&'a [u8]> {
        let n = usize::try_from(self.varint()?).ok()?;
        let end = self.p.checked_add(n)?;
        let s = self.b.get(self.p..end)?;
        self.p = end;
        Some(s)
    }

    fn skip(&mut self, wire: u8) -> Option<()> {
        match wire {
            0 => self.varint().map(|_| ()),
            1 => self.take(8),
            2 => self.span().map(|_| ()),
            5 => self.take(4),
            // Wire types 3/4 are proto2 groups: not representable in proto3 and
            // a known source of parser-differential bugs. Refused, not skipped.
            _ => None,
        }
    }

    fn take(&mut self, n: usize) -> Option<()> {
        let end = self.p.checked_add(n)?;
        if end > self.b.len() {
            return None;
        }
        self.p = end;
        Some(())
    }

    /// Yields `(field, wire)` pairs. Field 0 is not representable in protobuf,
    /// so its presence is not a mistake — it is an attack.
    fn tag(&mut self) -> Option<(u32, u8)> {
        let t = self.varint()?;
        let field = u32::try_from(t >> 3).ok()?;
        if field == 0 {
            return None;
        }
        Some((field, (t & 7) as u8))
    }
}

fn parse_capabilities(b: &[u8]) -> Option<Capabilities> {
    let mut r = R { b, p: 0 };
    let mut c = Capabilities::default();
    while r.p < b.len() {
        let (field, wire) = r.tag()?;
        match (field, wire) {
            (1, 0) => c.fragmentation = r.varint()? != 0,
            (2, 0) => c.resumption = r.varint()? != 0,
            (3, 0) => c.batch_cursor_sync = r.varint()? != 0,
            (4, 0) => c.datagrams = r.varint()? != 0,
            (5, 0) => c.reauth_in_place = r.varint()? != 0,
            (6, 0) => c.causal_epochs = r.varint()? != 0,
            (7, 0) => c.structured_errors = r.varint()? != 0,
            (15, 2) => {
                // Bounded: an unbounded repeated field is a memory-exhaustion
                // primitive dressed as forward compatibility.
                if c.experimental.len() >= Limits::default().max_repeated_elements {
                    return None;
                }
                c.experimental.push(core::str::from_utf8(r.span()?).ok()?.to_owned());
            }
            _ => r.skip(wire)?,
        }
    }
    Some(c)
}

/// Returns the `Limits` plus the two heartbeat values, which live inside
/// `Limits` on the wire (13, 14) but belong to the session up here.
fn parse_limits(b: &[u8]) -> Option<(Limits, u64, u64)> {
    let mut r = R { b, p: 0 };
    // Start from THIS BUILD's limits, not from zero: every field a server omits
    // must keep our compiled value, and `Limits::tighten` reads 0 as "not
    // proposed". Starting from zero would silently propose nothing at all.
    let mut l = Limits::default();
    let (mut hb_i, mut hb_t) = (0u64, 0u64);
    let usz = |v: u64| usize::try_from(v).unwrap_or(usize::MAX);
    while r.p < b.len() {
        let (field, wire) = r.tag()?;
        match (field, wire) {
            (1, 0) => l.max_frame_bytes = usz(r.varint()?),
            (2, 0) => l.max_opaque_bytes = usz(r.varint()?),
            (3, 0) => l.max_message_body_bytes = usz(r.varint()?),
            (4, 0) => l.max_fragments_per_message = (r.varint()? & 0xffff_ffff) as u32,
            (8, 0) => l.max_nesting_depth = (r.varint()? & 0xffff_ffff) as u32,
            (9, 0) => l.max_repeated_elements = usz(r.varint()?),
            (10, 0) => l.max_string_field_bytes = usz(r.varint()?),
            (13, 0) => hb_i = r.varint()?,
            (14, 0) => hb_t = r.varint()?,
            _ => r.skip(wire)?,
        }
    }
    Some((l, hb_i, hb_t))
}

/// Decode a `ServerHello` body.
///
/// `None` on ANY malformed input, never a part-filled struct: the caller feeds
/// this straight into `Session::on_server_hello`, which treats the values as
/// binding, and a struct half-built from garbage would bind garbage.
pub fn parse_server_hello(b: &[u8]) -> Option<ServerHello> {
    let mut r = R { b, p: 0 };
    let mut caps = Capabilities::default();
    let mut lim = Limits::default();
    let (mut hb_i, mut hb_t) = (0u64, 0u64);
    let mut resumed = false;
    let mut token: Option<ResumeToken> = None;

    while r.p < b.len() {
        let (field, wire) = r.tag()?;
        match (field, wire) {
            (3, 2) => caps = parse_capabilities(r.span()?)?,
            (4, 2) => {
                let (l, i, t) = parse_limits(r.span()?)?;
                lim = l;
                hb_i = i;
                hb_t = t;
            }
            (6, 2) => {
                let t = r.span()?;
                // Empty means "no token", never "the empty token". The Go peer
                // omits it entirely; a zero-length one from anywhere else must
                // not become a credential we then offer back.
                if !t.is_empty() {
                    token = Some(ResumeToken::new(String::from_utf8(t.to_vec()).ok()?));
                }
            }
            (8, 0) => resumed = r.varint()? != 0,
            _ => r.skip(wire)?,
        }
    }

    Some(ServerHello {
        capabilities: caps,
        limits: lim,
        heartbeat_interval_ms: hb_i,
        heartbeat_timeout_ms: hb_t,
        resumed,
        resume_token: token,
    })
}
