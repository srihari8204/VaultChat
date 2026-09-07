//! Parity with `utils/money.ts`, checked against the vectors in
//! `utils/money.selftest.ts`.
//!
//! The TypeScript is STILL THE LIVE IMPLEMENTATION — nothing in the app calls
//! this crate yet. So the only thing that makes the Rust port safe is proof
//! that it answers identically; a divergence today would be invisible until
//! the day someone switches the call site over, which is the worst possible
//! time to find it.
//!
//! Every case below is lifted from the selftest rather than invented, so the
//! two suites cannot drift apart without one of them going red.

use vaultcore::money::{from_paise, split_evenly, sum_rupees, to_paise};

/// The selftest compares with `Object.is`, i.e. exact equality. These are all
/// values that are exactly representable after the paise round-trip, so exact
/// comparison is right here — a tolerance would hide the drift being tested.
fn eq(actual: f64, expected: f64, what: &str) {
    assert!(
        actual == expected,
        "{what}: got {actual}, want {expected}"
    );
}

#[test]
fn paise_conversion() {
    assert_eq!(to_paise(1234.56), 123456, "rupees -> paise");
    eq(from_paise(123456), 1234.56, "paise -> rupees");
    eq(from_paise(to_paise(0.07)), 0.07, "round-trips exactly");
    assert_eq!(to_paise(f64::NAN), 0, "non-finite is 0");
}

#[test]
fn float_drift_is_gone() {
    // The classic failure: 0.1 + 0.2 != 0.3 in binary floating point.
    eq(sum_rupees(vec![0.1, 0.2]), 0.3, "0.1 + 0.2");
    eq(sum_rupees(vec![0.1; 10]), 1.0, "ten times 0.1");
}

#[test]
fn accumulation_matches_the_ledger() {
    eq(
        sum_rupees(vec![500.55, 1000.0, -500.55]),
        1000.0,
        "reports does principal - remaining, so negatives must work",
    );
    eq(sum_rupees(vec![]), 0.0, "empty sum is zero");

    // 1000 repayments of ₹0.07. The selftest asserts the naive float sum is
    // WRONG, so this asserts the same thing — otherwise the test proves nothing.
    let vals = vec![0.07f64; 1000];
    let naive: f64 = vals.iter().sum();
    eq(sum_rupees(vals), 70.0, "exact accumulation of 1000 x 0.07");
    assert!(naive != 70.0, "naive float sum should be wrong, got {naive}");
}

#[test]
fn the_documented_regression() {
    // ₹1000 across 7 members. The old code rounded each share and paid out
    // ₹1000.02 from a ₹1000 pot.
    let s = split_evenly(1000.0, 7);
    eq(s.each, 142.85, "each");
    eq(s.remainder, 0.05, "remainder");
    assert!(
        s.each * 7.0 <= 1000.0,
        "shares must never exceed the pot: {} * 7 = {}",
        s.each,
        s.each * 7.0
    );
}

/// THE PROPERTY: `each * parts + remainder == total`, exactly, in paise.
///
/// Exhaustive over the same range the TypeScript selftest sweeps — every pot
/// from ₹0 to ₹2000 in 1-paise steps, across realistic member counts.
#[test]
fn shares_always_add_back_up_to_the_pot() {
    let mut checked = 0u64;
    for cents in 0..=200_000i64 {
        let total = cents as f64 / 100.0;
        for parts in [1i64, 2, 3, 5, 7, 11, 12, 20, 25, 40, 100] {
            let s = split_evenly(total, parts);
            // Compare in PAISE. Comparing rupees would be comparing floats, and
            // the whole point of this module is that you cannot do that.
            let lhs = to_paise(s.each) * parts + s.remainder_paise;
            let rhs = to_paise(total);
            assert_eq!(lhs, rhs, "total={total} parts={parts} split={s:?}");
            assert!(
                s.remainder_paise < parts,
                "remainder must be smaller than one paise per part: {s:?}"
            );
            assert!(
                to_paise(s.each) * parts <= rhs,
                "shares exceeded the pot: total={total} parts={parts}"
            );
            checked += 1;
        }
    }
    assert!(checked > 2_000_000, "sweep did not run: {checked}");
}

/// The ONE signature difference between the two implementations.
///
/// `splitEvenly(total, parts: number)` accepts a fractional member count and
/// floors it (`Math.floor(parts) || 1`). This takes `i64`, so the floor has to
/// happen on the JS side of the binding before the call. For positive values
/// UniFFI's numeric coercion truncates, which IS floor — so the results agree —
/// but a caller must not assume the Rust side will clean up a fractional count
/// for it. Pinned here so the difference is a decision, not a surprise.
#[test]
fn fractional_member_counts_must_be_floored_by_the_caller() {
    // TS: splitEvenly(1000, 7.9) -> Math.floor(7.9) = 7 parts.
    let as_ts_would = split_evenly(1000.0, 7.9_f64.floor() as i64);
    eq(as_ts_would.each, 142.85, "floored to 7 parts");
    assert_eq!(as_ts_would.remainder_paise, 5);
    // And a count of zero clamps to one rather than dividing by zero.
    eq(split_evenly(1000.0, 0).each, 1000.0, "zero parts clamps to one");
}

/// Negative halves are where JS `Math.round` and Rust `f64::round` disagree.
/// The port must follow JavaScript, because JavaScript is what ships today.
#[test]
fn negative_rounding_follows_javascript_not_rust() {
    // Math.round(-2.5) === -2, so -0.025 rupees is -2 paise, not -3.
    assert_eq!(to_paise(-0.025), -2, "JS rounds negative halves toward +inf");
    assert_eq!(to_paise(0.025), 3, "...and positive halves up");
    // A whole-rupee negative is unambiguous and must be exact either way.
    assert_eq!(to_paise(-12.34), -1234);
    eq(from_paise(-1234), -12.34, "negative round-trip");
}
