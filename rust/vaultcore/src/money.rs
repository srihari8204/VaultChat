//! Exact money arithmetic in integer paise — a port of `utils/money.ts`.
//!
//! WHY THIS IS THE FIRST REAL PAYLOAD FOR THE RUST CORE.
//!
//! The dice verifier next door is blocked on a protocol the games server does
//! not publish. This is not: the algorithm is ours, it is pure, it has no I/O
//! and no threads, and it already carries a documented money bug in its
//! history — `round2((bid - commission) / members)` rounded each share, so
//! ₹1000 across 7 members paid out ₹1000.02. That is the worst class of bug
//! this app can have, and it is exactly the kind of thing worth having ONE
//! implementation of rather than one per platform.
//!
//! PARITY IS THE WHOLE POINT. This must agree with `utils/money.ts` bit for
//! bit, because until the app actually calls it the TypeScript is still the
//! live implementation and a divergence would be invisible. `tests/parity.rs`
//! pins the vectors from `utils/money.selftest.ts` plus the exhaustive
//! property that selftest checks.
//!
//! THE ROUNDING TRAP, which is the one real hazard in this port:
//!
//!   JS  `Math.round(x)` is defined as `floor(x + 0.5)` — it rounds half UP,
//!       toward +∞. `Math.round(-2.5)` is `-2`.
//!   Rust `f64::round()` rounds half AWAY FROM ZERO. `(-2.5f64).round()` is
//!       `-3.0`.
//!
//! Money can be negative here (reports subtract, `sum_rupees` is documented as
//! handling negatives), so using `f64::round` would silently disagree with the
//! shipped behaviour on every negative half-paise. `js_round` below is the JS
//! definition, and `parity.rs` checks it against the divergent cases directly.

/// `Math.round` as JavaScript defines it: `floor(x + 0.5)`.
///
/// NOT `f64::round`. See the module note — they disagree on negative halves,
/// and this code has to match the TypeScript that is still live.
#[inline]
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Rupees → integer paise. Rounds half-up at the paise boundary.
///
/// Non-finite input is 0, matching `toPaise`'s guard. The `as i64` cast
/// saturates rather than wrapping, so an absurd input cannot produce a
/// negative balance out of nowhere.
#[uniffi::export]
pub fn to_paise(rupees: f64) -> i64 {
    if !rupees.is_finite() {
        return 0;
    }
    js_round(rupees * 100.0) as i64
}

/// Integer paise → rupees, exact to 2 decimals.
#[uniffi::export]
pub fn from_paise(paise: i64) -> f64 {
    paise as f64 / 100.0
}

/// The result of dividing a pot into shares.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Split {
    /// What each part receives (rupees, 2-decimal exact).
    pub each: f64,
    /// Left over after giving every part `each` (rupees).
    pub remainder: f64,
    /// How many parts the remainder can top up by one paise each.
    pub remainder_paise: i64,
}

/// Divide `total_rupees` into `parts` shares that NEVER exceed the total.
///
/// Floors rather than rounds, so the sum of the shares is always ≤ the pot —
/// an organizer must never be told to pay out more than they hold. The
/// shortfall comes back as `remainder` instead of being absorbed, so
/// `each * parts + remainder == total` exactly.
///
/// `parts` below 1 is clamped to 1, matching `Math.max(1, Math.floor(parts) || 1)`:
/// a zero or negative member count is a caller bug, and dividing by it would
/// be worse than treating the pot as a single share.
#[uniffi::export]
pub fn split_evenly(total_rupees: f64, parts: i64) -> Split {
    let n = parts.max(1);
    let total = to_paise(total_rupees).max(0);
    let each = total / n; // both non-negative, so this is a floor
    let remainder_paise = total - each * n;
    Split {
        each: from_paise(each),
        remainder: from_paise(remainder_paise),
        remainder_paise,
    }
}

/// Sum rupee amounts without float drift.
///
/// Converts each value to paise FIRST and adds integers, which is the whole
/// reason this exists: `0.1 + 0.2` is not `0.3` in f64, and a thousand
/// repayments of ₹0.07 do not land on ₹70.
#[uniffi::export]
pub fn sum_rupees(values: Vec<f64>) -> f64 {
    let mut acc: i64 = 0;
    for v in values {
        acc = acc.saturating_add(to_paise(v));
    }
    from_paise(acc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_disagrees_with_rust_round_on_negative_halves() {
        // The trap this port exists to avoid. If these ever match, someone has
        // swapped js_round for f64::round and every negative half-paise has
        // silently moved.
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!((-2.5f64).round(), -3.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!((2.5f64).round(), 3.0);
    }

    #[test]
    fn non_finite_is_zero() {
        assert_eq!(to_paise(f64::NAN), 0);
        assert_eq!(to_paise(f64::INFINITY), 0);
        assert_eq!(to_paise(f64::NEG_INFINITY), 0);
    }

    #[test]
    fn parts_below_one_is_clamped_not_a_division_by_zero() {
        assert_eq!(split_evenly(100.0, 0).each, 100.0);
        assert_eq!(split_evenly(100.0, -5).each, 100.0);
    }
}
