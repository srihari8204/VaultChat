//! Byte-compatible port of `services/crypto/senderKey.ts` — Signal-style group
//! sender keys (Ed25519 sign + hash ratchet + AES-256-GCM).
//!
//! State structs serialize to the SAME JSON field names as the TS interfaces
//! (chainKeyHex / iteration / signPrivHex / signPubHex / skipped …) so records
//! persisted by either backend load in the other.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use crate::e2ee::{ed25519_public, sign, verify};
use crate::{err, hex32, os_random32, Bytes32, CryptoError, Res};

const INFO_MSG: &[u8] = b"VaultChat-SenderKey-Msg-v1";
const MAX_SKIP: usize = 2000;

// ── state (field names match the TS interfaces exactly) ────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct OwnSenderKey {
    #[serde(rename = "chainKeyHex")]
    pub chain_key_hex: String,
    pub iteration: u32,
    #[serde(rename = "signPrivHex")]
    pub sign_priv_hex: String,
    #[serde(rename = "signPubHex")]
    pub sign_pub_hex: String,
}
impl Drop for OwnSenderKey {
    fn drop(&mut self) {
        self.chain_key_hex.zeroize();
        self.sign_priv_hex.zeroize();
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PeerSenderKey {
    #[serde(rename = "chainKeyHex")]
    pub chain_key_hex: String,
    pub iteration: u32,
    #[serde(rename = "signPubHex")]
    pub sign_pub_hex: String,
    /// iteration → messageKey hex; insertion order mirrors the TS object
    /// (ascending iteration — see the trim rule in `group_decrypt`).
    #[serde(default)]
    pub skipped: IndexMap<String, String>,
}
impl Drop for PeerSenderKey {
    fn drop(&mut self) {
        self.chain_key_hex.zeroize();
        for v in self.skipped.values_mut() {
            v.zeroize();
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SenderKeyDistribution {
    #[serde(rename = "chainKeyHex")]
    pub chain_key_hex: String,
    pub iteration: u32,
    #[serde(rename = "signPubHex")]
    pub sign_pub_hex: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GroupCipher {
    pub iteration: u32,
    /// base64
    pub ciphertext: String,
    /// base64 Ed25519 over (u32be(iteration) || ciphertext)
    pub signature: String,
}

// ── chain ratchet ──────────────────────────────────────────────────────

fn derive_message_key(chain_key: &Bytes32) -> Bytes32 {
    hmac1(chain_key, 0x01)
}
fn next_chain_key(chain_key: &Bytes32) -> Bytes32 {
    hmac1(chain_key, 0x02)
}
fn hmac1(key: &Bytes32, b: u8) -> Bytes32 {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("hmac key");
    m.update(&[b]);
    m.finalize().into_bytes().into()
}

fn msg_key_material(mk: &Bytes32) -> (Bytes32, [u8; 12]) {
    let hk = Hkdf::<Sha256>::new(Some(&[0u8; 32]), mk);
    let mut out = Zeroizing::new([0u8; 44]);
    hk.expand(INFO_MSG, out.as_mut()).expect("hkdf-44");
    let mut key = [0u8; 32];
    key.copy_from_slice(&out[..32]);
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&out[32..]);
    (key, nonce)
}

fn u32be(n: u32) -> [u8; 4] {
    n.to_be_bytes()
}

fn open_with(mk_hex: &str, ct: &[u8], ad: &[u8]) -> Res<String> {
    let mk = Zeroizing::new(hex32(mk_hex)?);
    let (key, nonce) = msg_key_material(&mk);
    let key = Zeroizing::new(key);
    let pt = Aes256Gcm::new_from_slice(key.as_ref())
        .expect("aes key")
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: ct, aad: ad })
        .map_err(|_| CryptoError("aes-gcm: authentication failed".into()))?;
    // TS uses TextDecoder (non-fatal) → lossy, never throws on bad UTF-8.
    Ok(String::from_utf8_lossy(&pt).into_owned())
}

// ── API ────────────────────────────────────────────────────────────────

/// Create a fresh sender key for a group (first send / rotation). Randomized.
pub fn create_sender_key() -> OwnSenderKey {
    let sign_secret = Zeroizing::new(os_random32());
    let chain = Zeroizing::new(os_random32());
    OwnSenderKey {
        chain_key_hex: hex::encode(chain.as_ref() as &[u8]),
        iteration: 0,
        sign_pub_hex: hex::encode(ed25519_public(&sign_secret)),
        sign_priv_hex: hex::encode(sign_secret.as_ref() as &[u8]),
    }
}

pub fn distribution_message(own: &OwnSenderKey) -> SenderKeyDistribution {
    SenderKeyDistribution {
        chain_key_hex: own.chain_key_hex.clone(),
        iteration: own.iteration,
        sign_pub_hex: own.sign_pub_hex.clone(),
    }
}

pub fn process_distribution(skdm: &SenderKeyDistribution) -> PeerSenderKey {
    PeerSenderKey {
        chain_key_hex: skdm.chain_key_hex.clone(),
        iteration: skdm.iteration,
        sign_pub_hex: skdm.sign_pub_hex.clone(),
        skipped: IndexMap::new(),
    }
}

/// Encrypt with the owner's chain. Returns (cipher, advanced own state).
pub fn group_encrypt(own: &OwnSenderKey, plaintext: &str) -> Res<(GroupCipher, OwnSenderKey)> {
    let ck = Zeroizing::new(hex32(&own.chain_key_hex)?);
    let mk = Zeroizing::new(derive_message_key(&ck));
    let (key, nonce) = msg_key_material(&mk);
    let key = Zeroizing::new(key);
    let ad = u32be(own.iteration);
    let ct = Aes256Gcm::new_from_slice(key.as_ref())
        .expect("aes key")
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext.as_bytes(), aad: &ad })
        .expect("aes-gcm encrypt");
    let mut signed = Vec::with_capacity(4 + ct.len());
    signed.extend_from_slice(&ad);
    signed.extend_from_slice(&ct);
    let signature = sign(&signed, &hex32(&own.sign_priv_hex)?);
    Ok((
        GroupCipher {
            iteration: own.iteration,
            ciphertext: B64.encode(&ct),
            signature: B64.encode(signature),
        },
        OwnSenderKey {
            chain_key_hex: hex::encode(next_chain_key(&ck)),
            iteration: own.iteration + 1,
            sign_priv_hex: own.sign_priv_hex.clone(),
            sign_pub_hex: own.sign_pub_hex.clone(),
        },
    ))
}

/// Decrypt against a peer's record. Returns (plaintext, advanced record).
pub fn group_decrypt(rec: &PeerSenderKey, cipher: &GroupCipher) -> Res<(String, PeerSenderKey)> {
    let ct = B64
        .decode(&cipher.ciphertext)
        .map_err(|_| CryptoError("senderKey: bad ciphertext base64".into()))?;
    let sig = B64
        .decode(&cipher.signature)
        .map_err(|_| CryptoError("senderKey: bad signature base64".into()))?;
    let ad = u32be(cipher.iteration);

    // Authenticate the sender BEFORE doing key work.
    let mut signed = Vec::with_capacity(4 + ct.len());
    signed.extend_from_slice(&ad);
    signed.extend_from_slice(&ct);
    if !verify(&sig, &signed, &hex32(&rec.sign_pub_hex)?) {
        return err("senderKey: signature verification failed");
    }

    let mut skipped = rec.skipped.clone();

    if cipher.iteration < rec.iteration {
        // Older than our chain head — must be a cached skipped key.
        let Some(mk_hex) = skipped.shift_remove(&cipher.iteration.to_string()) else {
            return err("senderKey: message key unavailable (too old / already used)");
        };
        let mk_hex = Zeroizing::new(mk_hex);
        let plaintext = open_with(&mk_hex, &ct, &ad)?;
        return Ok((
            plaintext,
            PeerSenderKey {
                chain_key_hex: rec.chain_key_hex.clone(),
                iteration: rec.iteration,
                sign_pub_hex: rec.sign_pub_hex.clone(),
                skipped,
            },
        ));
    }

    // Ratchet forward from our head to the target, caching keys we pass.
    if (cipher.iteration - rec.iteration) as usize > MAX_SKIP {
        return err("senderKey: iteration gap too large");
    }
    let mut ck = Zeroizing::new(hex32(&rec.chain_key_hex)?);
    let mut iter = rec.iteration;
    while iter < cipher.iteration {
        skipped.insert(iter.to_string(), hex::encode(derive_message_key(&ck)));
        *ck = next_chain_key(&ck);
        iter += 1;
    }
    let mk_hex = Zeroizing::new(hex::encode(derive_message_key(&ck)));
    let nck = next_chain_key(&ck);
    let plaintext = open_with(&mk_hex, &ct, &ad)?;

    // Bound the skipped cache. TS drops via Object.keys(...).slice(0, len-MAX),
    // and integer-like JS keys enumerate in ascending numeric order — replicate
    // by removing the numerically-smallest iterations.
    if skipped.len() > MAX_SKIP {
        let mut keys: Vec<u32> = skipped.keys().filter_map(|k| k.parse().ok()).collect();
        keys.sort_unstable();
        let excess = skipped.len() - MAX_SKIP;
        for k in keys.into_iter().take(excess) {
            skipped.shift_remove(&k.to_string());
        }
    }

    Ok((
        plaintext,
        PeerSenderKey {
            chain_key_hex: hex::encode(nck),
            iteration: cipher.iteration + 1,
            sign_pub_hex: rec.sign_pub_hex.clone(),
            skipped,
        },
    ))
}
