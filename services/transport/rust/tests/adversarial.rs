//! Adversarial input coverage for the CC-Wire decoders.
//!
//! WHY THIS EXISTS
//!
//! The companion is `vaultchat-backend-go/internal/ccwire/fuzz_test.go`. Go has
//! `testing.F` in the standard library; this crate pins a stable toolchain, and
//! `cargo-fuzz` needs nightly plus a separate crate. So the same adversarial
//! classes are driven here as a table test instead — same inputs, same
//! assertion, no new dependency and no toolchain change.
//!
//! WHAT IS ASSERTED
//!
//! The decoder RETURNS. `Err` is a fine answer; `Ok` is a fine answer. A panic
//! is not, and neither is a hang. On the device side a decoder panic aborts the
//! process — the app disappears from under the user — so "refuses cleanly" is
//! the whole property.
//!
//! Specific error variants are deliberately NOT asserted. That would freeze
//! internal classification and make this brittle against honest refactors,
//! testing the taxonomy rather than the safety property.
//!
//! Reassembly is covered separately in tests/reasm_adversarial.rs — a
//! reassembler is stateful and needs a fragment sequence, not one bad buffer.
//!
//! The wire-level cases come from the SHARED corpus at
//! lib/ccwire/__vectors__/adversarial.json, which the Go targets read too, so
//! the two ends of the protocol cannot drift into disagreeing about what is
//! refusable. The generated shapes below (deep nesting, long repeats) stay in
//! code because they would be unreadable as hex literals.
//!
//! WHAT THIS IS NOT
//!
//! Not coverage-guided. It cannot discover an input nobody thought of, which is
//! exactly what the Go campaigns are for. This file's job is to keep the known
//! hostile classes permanently in the gate.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use transport_core::frame;
use transport_core::parse::{self, Limits};

/// The shared corpus, read where it lives next to the TypeScript that owns the
/// convention — a copy inside this crate would be a second thing to drift.
fn shared_corpus() -> Vec<(String, Vec<u8>, bool, String)> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("lib")
        .join("ccwire")
        .join("__vectors__")
        .join("adversarial.json");
    let raw = fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("cannot read shared corpus at {}: {e}", p.display()));
    let v: Value = serde_json::from_str(&raw).expect("shared corpus is not valid JSON");
    let cases = v["cases"].as_array().expect("corpus has no cases array");
    assert!(!cases.is_empty(), "shared corpus is empty");
    cases
        .iter()
        .map(|c| {
            let hex: String = c["hex"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .filter(|ch| !ch.is_whitespace())
                .collect();
            assert!(hex.len().is_multiple_of(2), "odd-length hex in corpus");
            let bytes = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("bad hex"))
                .collect();
            (
                c["name"].as_str().unwrap_or("?").to_string(),
                bytes,
                c["accept"].as_bool().unwrap_or(false),
                c["why"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect()
}

/// The structural classes a wire parser has to survive. Raw bytes on purpose:
/// no compliant encoder can produce most of these, which is why they matter.
fn adversarial_inputs() -> Vec<(&'static str, Vec<u8>)> {
    let mut v: Vec<(&'static str, Vec<u8>)> = vec![
        ("empty", vec![]),
        ("single zero", vec![0x00]),
        ("single high byte", vec![0xFF]),
        ("tag without value", vec![0x08]),
        ("varint truncated mid-continuation", vec![0x08, 0xFF]),
        ("length-delimited with no payload", vec![0x0A, 0x7F]),
        ("malformed length", vec![0x0A, 0xFF, 0xFF, 0xFF]),
        (
            "overlong varint (>64 bits)",
            vec![0x08, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
        ),
        ("field number 0 is illegal", vec![0x00, 0x01]),
        ("reserved wire type 6", vec![0x0E, 0x01]),
        ("reserved wire type 7", vec![0x0F, 0x01]),
        // Must be refused WITHOUT first allocating the declared size. A parser
        // that trusts a declared length is a remote OOM.
        (
            "declared length far beyond any limit",
            vec![0x0A, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F],
        ),
        ("all zeroes", vec![0u8; 1024]),
        ("all ones", vec![0xFFu8; 1024]),
    ];

    // Nesting must hit max_nesting_depth, not the stack. A stack overflow in
    // Rust aborts — no unwinding, no recovery.
    let mut deep = vec![0x08, 0x01];
    for _ in 0..200 {
        if deep.len() > 60_000 {
            break;
        }
        let mut outer = vec![0x0A, (deep.len() & 0x7F) as u8];
        outer.extend_from_slice(&deep);
        deep = outer;
    }
    v.push(("deeply nested", deep));

    // Pressure on max_repeated_elements.
    let mut many = Vec::new();
    for _ in 0..5000 {
        many.extend_from_slice(&[0x08, 0x01]);
    }
    v.push(("many repeated fields", many));

    // Numeric extremes on a varint field. seq/depends_on are u64 and travel as
    // JS_STRING precisely so JavaScript cannot truncate past 2^53 — so 2^53 is
    // a boundary worth naming, not an arbitrary number.
    for (name, val) in [
        ("seq = 0", 0u64),
        ("seq = 2^53 (JS safe-int edge)", 1u64 << 53),
        ("seq = 2^63", 1u64 << 63),
        ("seq = u64::MAX", u64::MAX),
    ] {
        let mut buf = vec![0x20]; // field 4, varint
        let mut x = val;
        loop {
            let byte = (x & 0x7F) as u8;
            x >>= 7;
            if x == 0 {
                buf.push(byte);
                break;
            }
            buf.push(byte | 0x80);
        }
        v.push((name, buf));
    }

    v
}

#[test]
fn decode_frame_never_panics_on_hostile_input() {
    let lim = Limits::default();
    for (_name, input) in adversarial_inputs() {
        // The assertion IS that this returns. A panic propagates and fails the
        // test with the offending case named.
        let _ = parse::decode_frame(&input, &lim, lim.max_frame_bytes, 0);
        // Depth at the limit must not recurse past it either.
        let _ = parse::decode_frame(&input, &lim, lim.max_frame_bytes, lim.max_nesting_depth);
    }
}

#[test]
fn frame_decode_never_panics_on_hostile_input() {
    let lim = Limits::default();
    for (_name, input) in adversarial_inputs() {
        let _ = frame::decode(&input, lim.max_frame_bytes, true);
        let _ = frame::decode(&input, lim.max_frame_bytes, false);
    }
}

#[test]
fn decode_stream_consumed_stays_inside_the_buffer() {
    let lim = Limits::default();
    for (name, input) in adversarial_inputs() {
        let (frames, consumed, _err) = frame::decode_stream(&input, lim.max_frame_bytes);
        // A consumed count past the end would advance a real reader past unread
        // bytes and desynchronise the stream — silent corruption, which is worse
        // than a clean refusal.
        assert!(
            consumed <= input.len(),
            "{name}: decode_stream consumed {consumed} of {} bytes",
            input.len()
        );
        for f in frames {
            assert!(
                f.len() <= input.len(),
                "{name}: frame of {} bytes from a {} byte buffer",
                f.len(),
                input.len()
            );
        }
    }
}

#[test]
fn truncation_at_every_offset_is_refused_cleanly() {
    // A valid frame cut at each byte. Off-by-one reads live here: the parser
    // has already seen a plausible header and is partway through trusting it.
    let lim = Limits::default();
    let valid = frame::encode(&[0x08, 0x01, 0x10, 0x02], lim.max_frame_bytes)
        .expect("encoding a small payload must succeed");
    for cut in 0..valid.len() {
        let _ = frame::decode(&valid[..cut], lim.max_frame_bytes, true);
        let _ = parse::decode_frame(&valid[..cut], &lim, lim.max_frame_bytes, 0);
    }
}

#[test]
fn single_bit_corruption_of_a_valid_frame_is_refused_cleanly() {
    // Bit flips reach states truncation cannot: a length field that is still
    // present but now wrong, a wire type that changed under a valid tag.
    let lim = Limits::default();
    let valid = frame::encode(&[0x08, 0x01, 0x10, 0x02], lim.max_frame_bytes)
        .expect("encoding a small payload must succeed");
    for byte in 0..valid.len() {
        for bit in 0..8 {
            let mut corrupt = valid.clone();
            corrupt[byte] ^= 1 << bit;
            let _ = frame::decode(&corrupt, lim.max_frame_bytes, true);
            let _ = parse::decode_frame(&corrupt, &lim, lim.max_frame_bytes, 0);
        }
    }
}

#[test]
fn declared_length_beyond_the_limit_does_not_allocate_it() {
    // The remote-OOM case, stated as a test: a 4 GiB declaration in a 6 byte
    // buffer must be refused on the declaration, not after reserving for it.
    let lim = Limits::default();
    let bomb = vec![0x0A, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F];
    let r = parse::decode_frame(&bomb, &lim, lim.max_frame_bytes, 0);
    assert!(
        r.is_err(),
        "a length declaration beyond max_frame_bytes must be refused"
    );
}

/// The Rust half of the cross-implementation check. The Go companion
/// (`TestSharedCorpusAgreesWithGo`) asserts the same `accept` column, so a
/// divergence surfaces as one of the two failing rather than as a silent
/// difference in what the two ends consider refusable.
///
/// Only the accept/reject DECISION is asserted, never the error variant: the
/// two implementations classify errors differently on purpose.
#[test]
fn shared_corpus_agrees_with_rust() {
    let lim = Limits::default();
    for (name, bytes, accept, why) in shared_corpus() {
        let r = parse::decode_frame(&bytes, &lim, lim.max_frame_bytes, 0);
        if accept {
            assert!(
                r.is_ok(),
                "{name}: corpus says acceptable, Rust refused it ({why})"
            );
        } else {
            assert!(
                r.is_err(),
                "{name}: corpus says unrepresentable, Rust accepted it ({why})"
            );
        }
    }
}

#[test]
fn every_shared_corpus_case_is_survivable() {
    // Liveness for the shared cases too, independent of the accept column.
    let lim = Limits::default();
    for (_name, bytes, _accept, _why) in shared_corpus() {
        let _ = parse::decode_frame(&bytes, &lim, lim.max_frame_bytes, 0);
        let _ = frame::decode(&bytes, lim.max_frame_bytes, true);
        let (_f, consumed, _e) = frame::decode_stream(&bytes, lim.max_frame_bytes);
        assert!(consumed <= bytes.len());
    }
}
