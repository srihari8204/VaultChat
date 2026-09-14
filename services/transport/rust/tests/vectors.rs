//! Three-way wire parity.
//!
//! This file asserts the SAME fixture that
//!   * `vaultchat-backend-go/internal/ccwire/frame_test.go` asserts, and
//!   * `lib/ccwire/parity.selftest.ts` asserts.
//!
//! The fixture was generated once, by Go, from literal expectations — never
//! computed by an implementation, so none of the three can be "right" merely by
//! agreeing with itself. If Rust, Go and TypeScript ever disagree about a byte,
//! a test fails here rather than a message failing on someone's phone.
//!
//! The fixture is read at the path it actually lives at, next to the TypeScript
//! that owns it. Copying it into this crate would create a second copy to drift.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use transport_core::config::{HEADER_BYTES, MAX_FRAME_BYTES};
use transport_core::frame::{decode, decode_stream, encode, FrameError, FRAMING_VERSION};

fn vectors() -> Value {
    // services/transport/rust/tests/ -> repo root
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..").join("..").join("..");
    let p = root.join("lib").join("ccwire").join("__vectors__").join("frame.json");
    let raw = fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("cannot read shared vectors at {}: {e}", p.display()));
    serde_json::from_str(&raw).expect("vectors are not valid JSON")
}

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd-length hex: {s:?}");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("bad hex"))
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The constants themselves must agree, or every byte-level vector below is
/// comparing two different protocols that happen to look alike.
#[test]
fn constants_match_the_fixture() {
    let v = vectors();
    assert_eq!(v["framingVersion"].as_u64().unwrap(), FRAMING_VERSION as u64);
    assert_eq!(v["headerBytes"].as_u64().unwrap(), HEADER_BYTES as u64);
    assert_eq!(v["maxFrameBytes"].as_u64().unwrap(), MAX_FRAME_BYTES as u64);
}

#[test]
fn encode_matches_go_byte_for_byte() {
    let v = vectors();
    for case in v["encode"].as_array().expect("encode vectors") {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let payload = unhex(case["payloadHex"].as_str().unwrap());
        let want = case["frameHex"].as_str().unwrap();
        let got = encode(&payload, 0).unwrap_or_else(|e| panic!("{name}: encode refused: {e:?}"));
        assert_eq!(hex(&got), want, "{name}: encoded bytes differ from the fixture");
    }
}

#[test]
fn decode_matches_the_fixture_including_every_rejection() {
    let v = vectors();
    for case in v["decode"].as_array().expect("decode vectors") {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = unhex(case["inputHex"].as_str().unwrap());
        let max = case["maxBytes"].as_u64().unwrap_or(0) as usize;
        let strict = case["strict"].as_bool().unwrap_or(false);
        let want_ok = case["ok"].as_bool().unwrap_or(false);

        match decode(&input, max, strict) {
            Ok(f) => {
                assert!(want_ok, "{name}: accepted a frame the fixture rejects");
                assert_eq!(f.version as u64, case["version"].as_u64().unwrap(), "{name}: version");
                assert_eq!(hex(f.payload), case["payloadHex"].as_str().unwrap(), "{name}: payload");
                assert_eq!(f.consumed as u64, case["consumed"].as_u64().unwrap(), "{name}: consumed");
            }
            Err(e) => {
                assert!(!want_ok, "{name}: rejected a frame the fixture accepts ({e:?})");
                assert_eq!(
                    e.as_str(),
                    case["error"].as_str().unwrap(),
                    "{name}: rejected for a DIFFERENT reason than Go and TypeScript",
                );
            }
        }
    }
}

#[test]
fn stream_framing_matches_the_fixture() {
    let v = vectors();
    for case in v["stream"].as_array().expect("stream vectors") {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = unhex(case["inputHex"].as_str().unwrap());
        let (frames, consumed, err) = decode_stream(&input, 0);

        let want: Vec<String> = case["framesHex"]
            .as_array()
            .map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect())
            .unwrap_or_default();
        let got: Vec<String> = frames.iter().map(|f| hex(f)).collect();
        assert_eq!(got, want, "{name}: frames differ");
        assert_eq!(consumed as u64, case["consumed"].as_u64().unwrap(), "{name}: consumed");

        let want_err = case["error"].as_str().unwrap_or("");
        match err {
            Some(e) => assert_eq!(e.as_str(), want_err, "{name}: stream error differs"),
            None => assert_eq!("", want_err, "{name}: expected error {want_err}, got none"),
        }
    }
}

/// The hazard that forces `>>> 0` in TypeScript. Rust's `u32::from_be_bytes` is
/// unsigned by construction so the bug cannot occur here — but the OUTCOME must
/// still match, which is what this pins.
#[test]
fn a_length_with_the_sign_bit_set_is_refused() {
    let buf = [FRAMING_VERSION, 0x80, 0x00, 0x00, 0x00];
    assert_eq!(decode(&buf, 0, false).unwrap_err(), FrameError::LengthOverMax);
    let buf = [FRAMING_VERSION, 0xff, 0xff, 0xff, 0xff];
    assert_eq!(decode(&buf, 0, false).unwrap_err(), FrameError::LengthOverMax);
}

/// A negotiated ceiling may tighten. It may never loosen.
#[test]
fn a_negotiated_max_cannot_raise_the_hard_max() {
    let payload = vec![0u8; 2000];
    let framed = encode(&payload, 0).unwrap();
    assert_eq!(decode(&framed, 1024, false).unwrap_err(), FrameError::LengthOverMax);
    assert!(decode(&framed, 0, false).is_ok());
    // Proposing a larger max than the build compiled with must not grant it.
    assert!(encode(&vec![0u8; MAX_FRAME_BYTES + 1], usize::MAX).is_err());
}

/// The payload borrows the input — no copy, so a 2 MiB frame is not 4 MiB
/// resident. Rust proves this at compile time via the lifetime, but the test
/// documents the intent and pins the pointer identity.
#[test]
fn payload_borrows_and_does_not_copy() {
    let framed = encode(&[7, 8, 9], 0).unwrap();
    let f = decode(&framed, 0, false).unwrap();
    assert_eq!(f.payload, &[7, 8, 9]);
    assert_eq!(f.payload.as_ptr(), framed[HEADER_BYTES..].as_ptr());
}
