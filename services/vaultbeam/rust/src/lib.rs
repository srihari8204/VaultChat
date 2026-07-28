//! vaultbeam-core — the shared Rust transport core for VaultBeam (Phase 3).
//!
//! Owns: chunk crypto (via the Phase 1 `crypto-core` GCM), geometry/framing,
//! positional file IO, sha256, and blocking LAN TCP. Does NOT own: WebRTC,
//! `vaultbeam_*` signaling, negotiation, or op-sqlite state (those stay in JS).
//!
//! The wire contract is FROZEN — `tests/vectors.rs` proves this crate reproduces
//! the committed golden vectors in `services/crypto/__vectors__/vaultbeam.json`
//! byte-for-byte, so a Kotlin peer and a Rust peer interop on every tier.

pub mod chunk;
pub mod ffi;
pub mod fileio;
pub mod lan;

/// One error type across the crate; the binding maps it to a JS Error string.
#[derive(Debug)]
pub struct VbError(pub String);

impl std::fmt::Display for VbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for VbError {}
