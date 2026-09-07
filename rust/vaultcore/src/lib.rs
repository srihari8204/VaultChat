//! vaultcore — a UniFFI SPIKE. Not wired into the app, and deliberately so.
//!
//! WHAT THIS IS FOR
//!
//! UniFFI generates Kotlin/Swift bindings for a Rust core. It draws nothing:
//! there is no UniFFI path to a chess board, a glass panel or a dice tray.
//! Anything visible in this app is React Native and stays React Native. What
//! UniFFI can carry is pure, deterministic LOGIC that Android and iOS would
//! otherwise implement twice.
//!
//! This crate exists to prove the pipeline compiles and is testable on this
//! machine, so the cost of adopting it is a measured number rather than a
//! guess. It is NOT referenced by gradle, by package.json, or by any JS.
//!
//! WHY IT IS NOT PLUGGED IN
//!
//! The function below verifies a commit-reveal dice roll. It is the right shape
//! for a Rust core — pure, deterministic, security-adjacent, wanted identically
//! on both platforms — and it is currently UNUSABLE IN PRODUCTION, for a reason
//! that is documented rather than accidental:
//!
//!   lib/games/fairness.ts: "the table did not reveal that half — so the roll
//!   cannot be checked independently, and we will not pretend otherwise."
//!
//!   lib/games/gamesNative.selftest.ts asserts the hub does not claim provably
//!   fair dice, because "the claim outran the server".
//!
//! The games server never publishes its seed. So a verifier can only ever
//! answer NotPublished, and shipping one would invite the UI to claim a proof
//! the player cannot perform. `Outcome::NotPublished` is therefore the honest
//! default and the whole reason this stays a spike: the blocker is the
//! protocol, not the language.

// No unsafe anywhere in this crate. UniFFI generates the only FFI
// boundary here and it is already audited; hand-written unsafe would be a
// second, unreviewed one inside a library that handles money.
#![forbid(unsafe_code)]

pub mod money;

use sha2::{Digest, Sha256};

uniffi::setup_scaffolding!();

/// What can be said about a roll, given what the table actually published.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum Outcome {
    /// commit == sha256(server_seed): the table committed to this seed first.
    Verified,
    /// The table published both halves and they do not agree. This is the only
    /// value that ever means "the dice were tampered with".
    Mismatch,
    /// One half was withheld. NOT a failure — it is the absence of evidence,
    /// and it must never be rendered as either a pass or a fault.
    NotPublished,
}

/// Verify that a revealed seed matches the commitment made before the roll.
///
/// Takes the seeds as the hex strings the wire uses, because that is what the
/// receipt already holds; an empty or malformed half is NotPublished rather
/// than an error, since a missing field is the normal case here, not a bug.
#[uniffi::export]
pub fn verify_commit(server_seed: String, commit: String) -> Outcome {
    if server_seed.trim().is_empty() || commit.trim().is_empty() {
        return Outcome::NotPublished;
    }
    let seed_bytes = match hex::decode(server_seed.trim()) {
        Ok(b) if !b.is_empty() => b,
        // A seed we cannot parse is a seed we were not really given.
        _ => return Outcome::NotPublished,
    };
    let digest = hex::encode(Sha256::digest(&seed_bytes));
    if digest.eq_ignore_ascii_case(commit.trim()) {
        Outcome::Verified
    } else {
        Outcome::Mismatch
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// sha256 of the single byte 0xab, as the reference implementation gives it.
    fn commit_for(seed_hex: &str) -> String {
        hex::encode(Sha256::digest(hex::decode(seed_hex).unwrap()))
    }

    #[test]
    fn a_matching_reveal_verifies() {
        let seed = "ab12cd34";
        assert_eq!(verify_commit(seed.into(), commit_for(seed)), Outcome::Verified);
    }

    #[test]
    fn the_commit_is_case_insensitive_because_the_wire_is_not_consistent() {
        let seed = "ab12cd34";
        assert_eq!(
            verify_commit(seed.into(), commit_for(seed).to_uppercase()),
            Outcome::Verified
        );
    }

    #[test]
    fn a_different_seed_is_a_mismatch_not_a_pass() {
        assert_eq!(
            verify_commit("ab12cd34".into(), commit_for("ffffffff")),
            Outcome::Mismatch
        );
    }

    /// The case that actually happens against this server, every single roll.
    #[test]
    fn a_withheld_half_is_not_published_never_verified() {
        assert_eq!(verify_commit("".into(), "abcd".into()), Outcome::NotPublished);
        assert_eq!(verify_commit("ab12cd34".into(), "".into()), Outcome::NotPublished);
        assert_eq!(verify_commit("nothex".into(), "abcd".into()), Outcome::NotPublished);
    }
}
