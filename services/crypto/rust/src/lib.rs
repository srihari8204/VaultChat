//! crypto-core — native port of VaultChat's TS crypto core (`services/crypto`).
//!
//! Every wire/serialization format (ratchet state JSON, envelope JSON,
//! sender-key records, VCSS1 shares) is FROZEN: `tests/vectors.rs` proves this
//! crate reproduces the committed golden vectors in
//! `services/crypto/__vectors__/*.json` byte-for-byte. Any change that alters
//! those formats is a bug, not a refactor — the TS core stays the reference.

pub mod aead;
pub mod e2ee;
pub mod ffi;
pub mod sender_key;
pub mod shamir;

pub type Bytes32 = [u8; 32];

#[derive(Debug)]
pub struct CryptoError(pub String);
impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CryptoError {}

pub type Res<T> = Result<T, CryptoError>;

pub(crate) fn err<T>(m: impl Into<String>) -> Res<T> {
    Err(CryptoError(m.into()))
}

pub(crate) fn hex32(s: &str) -> Res<Bytes32> {
    let v = hex::decode(s).map_err(|_| CryptoError("bad hex".into()))?;
    v.try_into().map_err(|_| CryptoError("bad hex length".into()))
}

pub(crate) fn os_random32() -> Bytes32 {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).expect("OS RNG unavailable");
    b
}
