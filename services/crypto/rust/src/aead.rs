//! Raw AES-256-GCM with an EXPLICIT key/nonce/aad — the VaultBeam chunk-crypto
//! primitive (Phase 3). Same `aes-gcm` crate the Double Ratchet uses
//! (`e2ee::aead_seal`/`aead_open`), so there is ONE GCM implementation in the
//! tree. The ratchet variant HKDF-derives its key+nonce from a message key;
//! VaultBeam supplies them directly (K_t + `chunkNonce(transferId, chunkId)`).
//!
//! Wire = `ciphertext ‖ 16B tag` — the aes-gcm crate appends the tag exactly
//! like Java's `AES/GCM/NoPadding` doFinal and `@noble/ciphers`, so a chunk
//! sealed here opens in the Kotlin/JS peers (proven by the Step 0 vectors).

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};

use crate::{CryptoError, Res};

/// Seal `plaintext` → `ciphertext ‖ 16B GCM tag`.
pub fn gcm_seal(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    Aes256Gcm::new_from_slice(key)
        .expect("32-byte key")
        .encrypt(Nonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .expect("aes-gcm encrypt is infallible for valid key/nonce")
}

/// Verify + open `ct_tag` (`ciphertext ‖ 16B GCM tag`). Err on auth failure
/// (tampered/truncated) — the caller must NOT persist a chunk that fails.
pub fn gcm_open(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], ct_tag: &[u8]) -> Res<Vec<u8>> {
    Aes256Gcm::new_from_slice(key)
        .expect("32-byte key")
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct_tag, aad })
        .map_err(|_| CryptoError("vaultbeam gcm: authentication failed".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Known-answer test lifted from the Step 0 golden vectors
    // (services/crypto/__vectors__/vaultbeam.json, chunk "uniform id=0") — proves
    // this crate's GCM ≡ the Kotlin/JS oracle byte-for-byte.
    #[test]
    fn kat_matches_vaultbeam_vector() {
        let key: [u8; 32] = hex::decode("905889933a2d781100639fc38bf9e0c22442034f15c4f51b904e608693b32bba")
            .unwrap().try_into().unwrap();
        let nonce: [u8; 12] = hex::decode("545146390000000000000000").unwrap().try_into().unwrap();
        let aad = b"TQF9k2mZ7pXaLdRb|file-9d3c1f|0";
        let plaintext = hex::decode("0726456483a2c1e0ff1e3d5c7b9ab9d8").unwrap();
        let want = hex::decode("8db4dd706c28a1b6bdfa2cfc9ea9cf33ad1c24791f81de7ef3f37335751f440a").unwrap();

        let wire = gcm_seal(&key, &nonce, aad, &plaintext);
        assert_eq!(wire, want, "seal must reproduce the golden chunk wire");
        assert_eq!(gcm_open(&key, &nonce, aad, &wire).unwrap(), plaintext, "open round-trips");
    }

    #[test]
    fn open_rejects_tamper() {
        let key = [7u8; 32];
        let nonce = [3u8; 12];
        let wire = gcm_seal(&key, &nonce, b"ad", b"hello");
        let mut bad = wire.clone();
        bad[0] ^= 1;
        assert!(gcm_open(&key, &nonce, b"ad", &bad).is_err(), "flipped byte must fail auth");
        assert!(gcm_open(&key, &nonce, b"other-ad", &wire).is_err(), "wrong aad must fail auth");
    }

    #[test]
    fn empty_plaintext_is_tag_only() {
        let key = [1u8; 32];
        let nonce = [2u8; 12];
        let wire = gcm_seal(&key, &nonce, b"", b"");
        assert_eq!(wire.len(), 16, "empty plaintext → 16B tag only");
        assert_eq!(gcm_open(&key, &nonce, b"", &wire).unwrap(), Vec::<u8>::new());
    }
}
