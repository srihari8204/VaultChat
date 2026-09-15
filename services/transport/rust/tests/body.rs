//! The six typed bodies — Rust against the hand-written wire vectors.
//!
//! The companion assertion is the "typed bodies" section of
//! `lib/ccwire/codecParity.selftest.ts`, which reads the SAME `bodies` array out
//! of the SAME file. The fixture was written by hand from the protobuf wire
//! specification rather than dumped from either implementation, so neither can
//! pass merely by agreeing with itself.
//!
//! Decoded bodies are compared as JSON, in codec.ts's surfaced shape: bytes as
//! hex, 64-bit fields as DECIMAL STRINGS. The string is the meeting point —
//! TypeScript hands out a string because a double rounds 2^53+1 away, Rust
//! holds a native u64, and rendering it here is what makes "both agree on the
//! VALUE" an assertion rather than a hope.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Map, Value};
use transport_core::body::{decode_body, Body, Envelope, PublicMeta, TYPED_BODIES};
use transport_core::parse::{CodecError, Limits};

fn vectors() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..");
    let p = root
        .join("lib")
        .join("ccwire")
        .join("__vectors__")
        .join("codec.json");
    let raw = fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("cannot read shared vectors at {}: {e}", p.display()));
    serde_json::from_str(&raw).expect("vectors are not valid JSON")
}

/// Whitespace is stripped so the fixture can group bytes for a human reader.
fn unhex(s: &str) -> Vec<u8> {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(s.len().is_multiple_of(2), "odd-length hex: {s:?}");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("bad hex"))
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unknown_hex(u: &[&[u8]]) -> Value {
    json!(u.iter().map(|x| hex(x)).collect::<Vec<_>>())
}

/// A negotiated limit may only TIGHTEN, which is what `tighten` enforces; zero
/// means "not proposed", never "unlimited".
fn limits_from(case: &Value, base: Limits) -> Limits {
    let Some(o) = case.get("limits").and_then(|v| v.as_object()) else {
        return base;
    };
    let mut p = Limits {
        max_frame_bytes: 0,
        max_opaque_bytes: 0,
        max_message_body_bytes: 0,
        max_fragments_per_message: 0,
        max_nesting_depth: 0,
        max_repeated_elements: 0,
        max_string_field_bytes: 0,
    };
    for (k, v) in o {
        let n = v.as_u64().expect("limit must be a number") as usize;
        match k.as_str() {
            "max_frame_bytes" => p.max_frame_bytes = n,
            "max_opaque_bytes" => p.max_opaque_bytes = n,
            "max_message_body_bytes" => p.max_message_body_bytes = n,
            "max_fragments_per_message" => p.max_fragments_per_message = n as u32,
            "max_nesting_depth" => p.max_nesting_depth = n as u32,
            "max_repeated_elements" => p.max_repeated_elements = n,
            "max_string_field_bytes" => p.max_string_field_bytes = n,
            other => panic!("unknown limit in fixture: {other}"),
        }
    }
    base.tighten(&p)
}

fn public_meta_json(m: &PublicMeta) -> Value {
    json!({
        "attachment_id": m.attachment_id,
        "view_once": m.view_once,
        "revoked": m.revoked,
        "announcement": m.announcement,
        "audience": m.audience,
        "silent": m.silent,
        "group_id": m.group_id,
        "gif_url": m.gif_url,
        "allow_multiple": m.allow_multiple,
        "option_count": m.option_count,
        "mention_user_ids": m.mention_user_ids,
        "encrypted": m.encrypted,
        "game": m.game,
        "room": m.room,
        "unknown": unknown_hex(&m.unknown),
    })
}

fn envelope_json(e: &Envelope) -> Value {
    let mut o = Map::new();
    o.insert("chat_id".into(), json!(e.chat_id));
    o.insert("message_id".into(), json!(e.message_id));
    o.insert("client_msg_id".into(), json!(e.client_msg_id));
    o.insert("server_ts_ms".into(), json!(e.server_ts_ms.to_string()));
    o.insert("msg_class".into(), json!(e.msg_class));
    o.insert("msg_class_name".into(), json!(e.msg_class_name()));
    o.insert("causal_epoch".into(), json!(e.causal_epoch.to_string()));
    // ABSENT, not defaulted: submessage presence is meaningful in proto3, and
    // codec.ts leaves the key off entirely when there is none.
    if let Some(p) = &e.public_meta {
        o.insert("public_meta".into(), public_meta_json(p));
    }
    o.insert("unknown".into(), unknown_hex(&e.unknown));
    Value::Object(o)
}

/// The decoded body in codec.ts's surfaced shape, so one fixture serves both.
fn body_json(b: &Body) -> Value {
    match b {
        Body::TypingState(m) => json!({
            "chat_id": m.chat_id, "typing": m.typing, "sender_uid": m.sender_uid,
            "unknown": unknown_hex(&m.unknown),
        }),
        Body::ViewerState(m) => json!({
            "chat_id": m.chat_id, "activity": m.activity, "activity_name": m.activity_name(),
            "leaving": m.leaving, "resync": m.resync, "unknown": unknown_hex(&m.unknown),
        }),
        Body::GeoRelay(m) => json!({
            "scope_kind": m.scope_kind, "scope_kind_name": m.scope_kind_name(),
            "scope_id": m.scope_id, "subject_id": m.subject_id, "sealed": hex(m.sealed),
            "ended": m.ended, "until_ms": m.until_ms.to_string(), "sender_uid": m.sender_uid,
            "unknown": unknown_hex(&m.unknown),
        }),
        Body::CryptoControl(m) => json!({
            "kind": m.kind, "kind_name": m.kind_name(), "chat_id": m.chat_id,
            "to_uid": m.to_uid, "payload": hex(m.payload), "epoch": m.epoch.to_string(),
            "payload_format": m.payload_format, "unknown": unknown_hex(&m.unknown),
        }),
        Body::SubmitMessage(m) => {
            let mut o = Map::new();
            if let Some(e) = &m.envelope {
                o.insert("envelope".into(), envelope_json(e));
            }
            o.insert("sealed".into(), json!(hex(m.sealed)));
            o.insert("unknown".into(), unknown_hex(&m.unknown));
            Value::Object(o)
        }
        Body::Fragment(m) => json!({
            "fragment_id": m.fragment_id, "index": m.index, "total": m.total,
            "total_bytes": m.total_bytes.to_string(), "chunk": hex(m.chunk),
            "last": m.last, "unknown": unknown_hex(&m.unknown),
        }),
    }
}

#[test]
fn bodies_match_the_fixture() {
    let v = vectors();
    let base = Limits::default();
    let cases = v["bodies"].as_array().expect("body vectors");
    assert!(cases.len() >= 30, "the body fixture lost vectors");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let field = case["field"].as_u64().expect("field") as u32;
        let buf = unhex(case["bodyHex"].as_str().unwrap());
        let lim = limits_from(case, base);
        let want_ok = case["ok"].as_bool().unwrap_or(false);

        // depth 1: the frame layer already charged one level for entering the
        // body, exactly as codec.ts's `dec(nest(r, depth + 1), depth + 1)` does.
        match decode_body(field, &buf, &lim, 1) {
            Ok(Some(b)) => {
                assert!(want_ok, "{name}: accepted a body the fixture refuses");
                assert_eq!(
                    body_json(&b),
                    case["value"],
                    "{name}: decoded to a different message"
                );
            }
            Ok(None) => panic!("{name}: field {field} is not typed, so this vector proves nothing"),
            Err(e) => {
                assert!(
                    !want_ok,
                    "{name}: refused a body the fixture accepts ({e:?})"
                );
                assert_eq!(
                    e.as_str(),
                    case["error"].as_str().unwrap(),
                    "{name}: refused for a DIFFERENT reason than the fixture says"
                );
                assert_eq!(
                    e.error_code() as u64,
                    case["errorCode"].as_u64().unwrap(),
                    "{name}: wrong errors.proto ErrorCode - the peer would be told the wrong thing"
                );
            }
        }
    }
}

/// Every typed body must be exercised, or a decoder could rot untested behind a
/// fixture that happens not to mention it.
#[test]
fn every_typed_body_has_vectors() {
    let v = vectors();
    for f in TYPED_BODIES {
        let n = v["bodies"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["field"].as_u64() == Some(f as u64))
            .count();
        assert!(n >= 4, "body {f} has only {n} vectors; canonical, empty, over-bound and malformed are the minimum");
    }
    // The exclusion the fixture used to carry is gone, and the prose says so.
    assert!(
        v["bodiesTypedByTypescriptOnly"]
            .as_array()
            .unwrap()
            .is_empty(),
        "a body type is typed on one side only again"
    );
}

/// The other 21 bodies stay OPAQUE. Returning `None` rather than guessing is the
/// contract: an unimplemented body is never lost and never reinterpreted.
#[test]
fn an_untyped_body_is_left_alone() {
    let lim = Limits::default();
    for f in [19u32, 22, 49, 83, 97, 99] {
        assert!(!TYPED_BODIES.contains(&f));
        // Bytes that are not valid protobuf at all: an untyped body is never
        // parsed, so they are returned unexamined rather than refused.
        assert_eq!(
            decode_body(f, &[0x0b, 0xff], &lim, 1),
            Ok(None),
            "body {f} was parsed"
        );
    }
}

/// A length a peer declares must never size an allocation. The fixture covers
/// the truncated case; this covers the absurd one, which no fixture should have
/// to carry as literal bytes.
#[test]
fn an_absurd_declared_length_in_a_body_is_refused_without_allocating() {
    let lim = Limits::default();
    // typing_state field 1, wire 2, length = the largest a 5-byte varint holds.
    let mut buf = vec![0x0a];
    buf.extend_from_slice(&[0xff, 0xff, 0xff, 0xff, 0x0f]);
    assert_eq!(
        decode_body(81, &buf, &lim, 1).unwrap_err(),
        CodecError::Truncated
    );
}

/// A body already at the recursion limit is refused before it is read, so a
/// reassembler re-decoding a reassembled payload cannot walk deeper by calling
/// in here directly.
#[test]
fn a_body_past_the_recursion_limit_is_refused() {
    let lim = Limits::default();
    assert_eq!(
        decode_body(81, &[], &lim, lim.max_nesting_depth + 1).unwrap_err(),
        CodecError::NestingTooDeep
    );
}
