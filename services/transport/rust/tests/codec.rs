//! ccwire.v1.Frame parity — Rust against the hand-written wire vectors.
//!
//! The companion assertion is `lib/ccwire/codecParity.selftest.ts`, which reads
//! the SAME file. The fixture was written by hand from the protobuf wire
//! specification rather than dumped from either implementation, so neither can
//! pass merely by agreeing with itself.
//!
//! The fixture is read where it lives, next to the TypeScript that owns it — a
//! copy inside this crate would be a second thing to drift.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use transport_core::parse::{
    decode_frame, encode_frame, CodecError, Frame, Limits, BODY_FIELDS, EPHEMERAL_BODIES,
    TRAFFIC_CLASS_EPHEMERAL,
};

fn vectors() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..");
    let p = root.join("lib").join("ccwire").join("__vectors__").join("codec.json");
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

fn limits_from(case: &Value, base: Limits) -> Limits {
    let Some(o) = case.get("limits").and_then(|v| v.as_object()) else { return base };
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

/// The constants must agree, or every byte-level vector is comparing two
/// protocols that merely look alike.
#[test]
fn constants_match_the_fixture() {
    let v = vectors();
    let l = Limits::default();
    let f = &v["limits"];
    assert_eq!(f["max_frame_bytes"].as_u64().unwrap() as usize, l.max_frame_bytes);
    assert_eq!(f["max_opaque_bytes"].as_u64().unwrap() as usize, l.max_opaque_bytes);
    assert_eq!(
        f["max_message_body_bytes"].as_u64().unwrap() as usize,
        l.max_message_body_bytes
    );
    assert_eq!(
        f["max_fragments_per_message"].as_u64().unwrap() as u32,
        l.max_fragments_per_message
    );
    assert_eq!(f["max_nesting_depth"].as_u64().unwrap() as u32, l.max_nesting_depth);
    assert_eq!(f["max_repeated_elements"].as_u64().unwrap() as usize, l.max_repeated_elements);
    assert_eq!(f["max_string_field_bytes"].as_u64().unwrap() as usize, l.max_string_field_bytes);

    assert_eq!(v["trafficClassEphemeral"].as_u64().unwrap() as u32, TRAFFIC_CLASS_EPHEMERAL);

    let want: Vec<u32> =
        v["ephemeralBodies"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u32).collect();
    assert_eq!(want, EPHEMERAL_BODIES.to_vec(), "the EPHEMERAL allow-list drifted");

    let want: Vec<u32> =
        v["bodyFields"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u32).collect();
    assert_eq!(want, BODY_FIELDS.to_vec(), "the oneof body field numbers drifted from envelope.proto");
}

#[test]
fn decode_matches_the_fixture() {
    let v = vectors();
    let base = Limits::default();

    for case in v["decode"].as_array().expect("decode vectors") {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = unhex(case["inputHex"].as_str().unwrap());
        let lim = limits_from(case, base);
        let max = case["maxBytes"].as_u64().unwrap_or(0) as usize;
        let depth = case["depth"].as_u64().unwrap_or(0) as u32;
        let want_ok = case["ok"].as_bool().unwrap_or(false);

        match decode_frame(&input, &lim, max, depth) {
            Ok(f) => {
                assert!(want_ok, "{name}: accepted input the fixture rejects");
                assert_eq!(f.request_id, case["requestId"].as_str().unwrap(), "{name}: request_id");
                assert_eq!(
                    f.traffic_class as u64,
                    case["trafficClass"].as_u64().unwrap(),
                    "{name}: traffic_class"
                );
                assert_eq!(f.stream as u64, case["stream"].as_u64().unwrap(), "{name}: stream");
                // Compared as decimal STRINGS, which is how the fixture stores
                // them and how the TypeScript side hands them out.
                assert_eq!(f.seq.to_string(), case["seq"].as_str().unwrap(), "{name}: seq");
                assert_eq!(
                    f.depends_on.to_string(),
                    case["dependsOn"].as_str().unwrap(),
                    "{name}: depends_on"
                );
                let want_body = case["bodyField"].as_u64().map(|x| x as u32);
                assert_eq!(f.body_field, want_body, "{name}: body_field");
                assert_eq!(hex(f.body), case["bodyHex"].as_str().unwrap(), "{name}: body bytes");

                let want_unknown: Vec<String> = case["unknownHex"]
                    .as_array()
                    .map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect())
                    .unwrap_or_default();
                let got: Vec<String> = f.unknown.iter().map(|u| hex(u)).collect();
                assert_eq!(got, want_unknown, "{name}: unknown fields");
            }
            Err(e) => {
                assert!(!want_ok, "{name}: rejected input the fixture accepts ({e:?})");
                assert_eq!(
                    e.as_str(),
                    case["error"].as_str().unwrap(),
                    "{name}: rejected for a DIFFERENT reason than the fixture says"
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

#[test]
fn encode_matches_the_fixture() {
    let v = vectors();
    let lim = Limits::default();

    for case in v["encode"].as_array().expect("encode vectors") {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let spec = &case["frame"];
        let body = unhex(spec["bodyHex"].as_str().unwrap_or(""));
        let unknown: Vec<Vec<u8>> = spec["unknownHex"]
            .as_array()
            .map(|a| a.iter().map(|x| unhex(x.as_str().unwrap())).collect())
            .unwrap_or_default();

        let f = Frame {
            request_id: spec["requestId"].as_str().unwrap_or(""),
            traffic_class: spec["trafficClass"].as_u64().unwrap_or(0) as u32,
            stream: spec["stream"].as_u64().unwrap_or(0) as u32,
            seq: spec["seq"].as_str().unwrap_or("0").parse().unwrap(),
            depends_on: spec["dependsOn"].as_str().unwrap_or("0").parse().unwrap(),
            body_field: spec["bodyField"].as_u64().map(|x| x as u32),
            body: &body,
            unknown: unknown.iter().map(|u| u.as_slice()).collect(),
        };

        let want_ok = case["ok"].as_bool().unwrap_or(true);
        match encode_frame(&f, &lim, 0) {
            Ok(out) => {
                assert!(want_ok, "{name}: encoded a frame the fixture refuses");
                assert_eq!(
                    hex(&out),
                    unhex(case["outHex"].as_str().unwrap())
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>(),
                    "{name}: encoded bytes differ from the fixture"
                );
            }
            Err(e) => {
                assert!(!want_ok, "{name}: refused a frame the fixture encodes ({e:?})");
                assert_eq!(e.as_str(), case["error"].as_str().unwrap(), "{name}: wrong reason");
                assert_eq!(
                    e.error_code() as u64,
                    case["errorCode"].as_u64().unwrap(),
                    "{name}: wrong ErrorCode"
                );
            }
        }
    }
}

/// Every accepted decode vector must re-encode to the bytes it came from.
/// Preservation of unknown fields is only real if it survives a round trip.
#[test]
fn every_accepted_vector_round_trips_byte_for_byte() {
    let v = vectors();
    let base = Limits::default();

    for case in v["decode"].as_array().unwrap() {
        if !case["ok"].as_bool().unwrap_or(false) {
            continue;
        }
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = unhex(case["inputHex"].as_str().unwrap());
        let lim = limits_from(case, base);
        let f = decode_frame(&input, &lim, 0, 0).unwrap_or_else(|e| panic!("{name}: {e:?}"));

        // Last-wins genuinely loses the earlier duplicate, so this one case is
        // canonicalising rather than round-tripping. Skipping it silently would
        // hide that; naming it records it.
        if name.contains("last-wins") {
            continue;
        }

        let out = encode_frame(&f, &lim, 0).unwrap_or_else(|e| panic!("{name}: re-encode: {e:?}"));
        assert_eq!(hex(&out), hex(&input), "{name}: decode then encode changed the bytes");
    }
}

/// The fixture claims its vectors avoid the six bodies only TypeScript decodes.
/// Assert that rather than trusting the prose — the exclusion is the one place
/// the two implementations are known to differ, so it must not silently widen.
#[test]
fn no_vector_relies_on_a_body_only_typescript_decodes() {
    let v = vectors();
    let excluded: Vec<u64> = v["bodiesTypedByTypescriptOnly"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_u64().unwrap())
        .collect();

    for case in v["decode"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        // A body is only a problem if it has CONTENT: an empty submessage is
        // decoded identically by both sides whatever its type.
        let has_content = !case["bodyHex"].as_str().unwrap_or("").is_empty();
        if let Some(b) = case["bodyField"].as_u64() {
            assert!(
                !(has_content && excluded.contains(&b)),
                "{name}: uses body {b}, which only TypeScript decodes — the two sides are not \
                 required to agree on its contents, so this vector proves nothing"
            );
        }
    }
}

/// A length a peer declares must never size an allocation. The fixture covers
/// the truncated case; this covers the absurd one, which no fixture should have
/// to carry as literal bytes.
#[test]
fn an_absurd_declared_length_is_refused_without_allocating() {
    let lim = Limits::default();
    // field 1, wire 2, length = the largest a 5-byte varint holds (2^35 - 1).
    // Five bytes is the cap in LENGTH position, so this is the biggest number a
    // peer can even declare here, and it is refused on the bounds check.
    let mut buf = vec![0x0a];
    buf.extend_from_slice(&[0xff, 0xff, 0xff, 0xff, 0x0f]);
    assert_eq!(decode_frame(&buf, &lim, 0, 0).unwrap_err(), CodecError::Truncated);

    // Ten bytes in LENGTH position is not a bigger number, it is an over-long
    // encoding, and it is refused earlier and differently. The fixture pins this
    // too ("an over-long LENGTH varint is refused at the frame layer").
    let mut buf = vec![0x0a];
    buf.extend_from_slice(&[0xff; 9]);
    buf.push(0x01);
    assert_eq!(decode_frame(&buf, &lim, 0, 0).unwrap_err(), CodecError::VarintOverflow);
}

/// Negotiation is not authority.
#[test]
fn a_peer_cannot_negotiate_a_limit_upward() {
    let base = Limits::default();
    let greedy = Limits {
        max_frame_bytes: usize::MAX,
        max_opaque_bytes: usize::MAX,
        max_message_body_bytes: usize::MAX,
        max_fragments_per_message: u32::MAX,
        max_nesting_depth: u32::MAX,
        max_repeated_elements: usize::MAX,
        max_string_field_bytes: usize::MAX,
    };
    assert_eq!(base.tighten(&greedy), base, "a peer raised a bound this build compiled with");

    let tight = Limits { max_string_field_bytes: 8, ..base };
    assert_eq!(base.tighten(&tight).max_string_field_bytes, 8, "a peer could not tighten");
    // Zero means "not proposed", never "unlimited".
    let unset = Limits { max_string_field_bytes: 0, ..base };
    assert_eq!(base.tighten(&unset).max_string_field_bytes, base.max_string_field_bytes);
}
