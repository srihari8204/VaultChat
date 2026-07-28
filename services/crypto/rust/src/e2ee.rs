//! Byte-compatible port of `services/crypto/e2ee.ts` — X3DH + Double Ratchet.
//!
//! Semantics, formats, and error messages mirror the TS reference. The
//! serialized state JSON and envelope JSON must stay byte-identical to
//! `serializeState` / `encodeEnvelope` (frozen by the golden vectors).

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signer, Verifier};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use crate::{err, hex32, os_random32, Bytes32, CryptoError, Res};

const INFO_RK: &[u8] = b"VaultChat-RootKDF-v1";
const INFO_X3DH: &[u8] = b"VaultChat-X3DH-v1";
const INFO_MSG: &[u8] = b"VaultChat-MsgKey-v1";
const ZERO32: Bytes32 = [0u8; 32];
const MAX_SKIP: u32 = 1000;

// ── primitives ─────────────────────────────────────────────────────────

pub struct KeyPair {
    pub secret: Bytes32,
    pub public: Bytes32,
}
impl Clone for KeyPair {
    fn clone(&self) -> Self {
        KeyPair { secret: self.secret, public: self.public }
    }
}
impl Drop for KeyPair {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

pub fn x25519_public(secret: &Bytes32) -> Bytes32 {
    x25519_dalek::x25519(*secret, x25519_dalek::X25519_BASEPOINT_BYTES)
}

pub fn generate_dh() -> KeyPair {
    let secret = os_random32();
    KeyPair { public: x25519_public(&secret), secret }
}

fn dh(secret: &Bytes32, public: &Bytes32) -> Bytes32 {
    // Like the TS core (@noble x25519.getSharedSecret): no contributory /
    // zero-output check. Do not add one — semantics must match exactly.
    x25519_dalek::x25519(*secret, *public)
}

pub fn ed25519_public(seed: &Bytes32) -> Bytes32 {
    ed25519_dalek::SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

pub fn generate_signing_key() -> KeyPair {
    let secret = os_random32();
    KeyPair { public: ed25519_public(&secret), secret }
}

pub fn sign(msg: &[u8], signing_secret: &Bytes32) -> [u8; 64] {
    ed25519_dalek::SigningKey::from_bytes(signing_secret).sign(msg).to_bytes()
}

pub fn verify(sig: &[u8], msg: &[u8], signing_public: &Bytes32) -> bool {
    let Ok(vk) = ed25519_dalek::VerifyingKey::from_bytes(signing_public) else {
        return false;
    };
    let Ok(sig) = ed25519_dalek::Signature::from_slice(sig) else {
        return false;
    };
    vk.verify(msg, &sig).is_ok()
}

// ── KDFs (public: pinned directly by the golden vectors) ───────────────

/// (RK', CK) = HKDF-SHA256(ikm = DH output, salt = RK, info = RootKDF-v1, 64B).
pub fn kdf_rk(rk: &Bytes32, dh_out: &Bytes32) -> (Bytes32, Bytes32) {
    let hk = Hkdf::<Sha256>::new(Some(rk), dh_out);
    let mut out = Zeroizing::new([0u8; 64]);
    hk.expand(INFO_RK, out.as_mut()).expect("hkdf-64");
    let mut nrk = ZERO32;
    nrk.copy_from_slice(&out[..32]);
    let mut ck = ZERO32;
    ck.copy_from_slice(&out[32..]);
    (nrk, ck)
}

/// (CK', mk): mk = HMAC(CK, 0x01), CK' = HMAC(CK, 0x02).
pub fn kdf_ck(ck: &Bytes32) -> (Bytes32, Bytes32) {
    fn mac1(ck: &Bytes32, b: u8) -> Bytes32 {
        let mut m = <Hmac<Sha256> as Mac>::new_from_slice(ck).expect("hmac key");
        m.update(&[b]);
        m.finalize().into_bytes().into()
    }
    (mac1(ck, 0x02), mac1(ck, 0x01))
}

/// AEAD key(32) + nonce(12) = HKDF(mk, salt = 0^32, info = MsgKey-v1, 44B).
pub fn msg_key_material(mk: &Bytes32) -> (Bytes32, [u8; 12]) {
    let hk = Hkdf::<Sha256>::new(Some(&ZERO32), mk);
    let mut out = Zeroizing::new([0u8; 44]);
    hk.expand(INFO_MSG, out.as_mut()).expect("hkdf-44");
    let mut key = ZERO32;
    key.copy_from_slice(&out[..32]);
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&out[32..]);
    (key, nonce)
}

fn aead_seal(mk: &Bytes32, plaintext: &[u8], ad: &[u8]) -> Vec<u8> {
    let (key, nonce) = msg_key_material(mk);
    let key = Zeroizing::new(key);
    Aes256Gcm::new_from_slice(key.as_ref())
        .expect("aes key")
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: ad })
        .expect("aes-gcm encrypt")
}

fn aead_open(mk: &Bytes32, ciphertext: &[u8], ad: &[u8]) -> Res<Vec<u8>> {
    let (key, nonce) = msg_key_material(mk);
    let key = Zeroizing::new(key);
    Aes256Gcm::new_from_slice(key.as_ref())
        .expect("aes key")
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: ciphertext, aad: ad })
        .map_err(|_| CryptoError("aes-gcm: authentication failed".into()))
}

// ── X3DH ───────────────────────────────────────────────────────────────

pub struct PreKeyBundle {
    pub identity_key: Bytes32,
    pub signing_key: Bytes32,
    pub signed_pre_key: Bytes32,
    pub signed_pre_key_sig: Vec<u8>,
    pub one_time_pre_key: Option<Bytes32>,
    pub one_time_pre_key_id: Option<i64>,
}

pub struct InitialHeader {
    pub identity_key: Bytes32,
    pub ephemeral_key: Bytes32,
    pub one_time_pre_key_id: Option<i64>,
}

fn hkdf32(ikm: &[u8], salt: &Bytes32, info: &[u8]) -> Bytes32 {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut out = ZERO32;
    hk.expand(info, &mut out).expect("hkdf-32");
    out
}

/// Initiator (Alice): verify the bundle, derive SK, return the header Bob needs.
pub fn x3dh_initiator(
    my_identity: &KeyPair,
    bundle: &PreKeyBundle,
) -> Res<(Bytes32, KeyPair, InitialHeader)> {
    if !verify(&bundle.signed_pre_key_sig, &bundle.signed_pre_key, &bundle.signing_key) {
        return err("X3DH: signed-prekey signature failed verification");
    }
    let ek = generate_dh();
    let mut ikm = Zeroizing::new(Vec::with_capacity(128));
    ikm.extend_from_slice(&dh(&my_identity.secret, &bundle.signed_pre_key)); // DH1
    ikm.extend_from_slice(&dh(&ek.secret, &bundle.identity_key)); // DH2
    ikm.extend_from_slice(&dh(&ek.secret, &bundle.signed_pre_key)); // DH3
    if let Some(opk) = &bundle.one_time_pre_key {
        ikm.extend_from_slice(&dh(&ek.secret, opk)); // DH4
    }
    let sk = hkdf32(&ikm, &ZERO32, INFO_X3DH);
    let header = InitialHeader {
        identity_key: my_identity.public,
        ephemeral_key: ek.public,
        one_time_pre_key_id: bundle.one_time_pre_key_id,
    };
    Ok((sk, ek, header))
}

/// Responder (Bob): derive the same SK from Alice's header + Bob's private keys.
pub fn x3dh_responder(
    my_identity: &KeyPair,
    my_signed_pre_key: &KeyPair,
    my_one_time_pre_key: Option<&KeyPair>,
    header: &InitialHeader,
) -> Bytes32 {
    let mut ikm = Zeroizing::new(Vec::with_capacity(128));
    ikm.extend_from_slice(&dh(&my_signed_pre_key.secret, &header.identity_key)); // DH1
    ikm.extend_from_slice(&dh(&my_identity.secret, &header.ephemeral_key)); // DH2
    ikm.extend_from_slice(&dh(&my_signed_pre_key.secret, &header.ephemeral_key)); // DH3
    if let Some(opk) = my_one_time_pre_key {
        ikm.extend_from_slice(&dh(&opk.secret, &header.ephemeral_key)); // DH4
    }
    hkdf32(&ikm, &ZERO32, INFO_X3DH)
}

// ── Double Ratchet ─────────────────────────────────────────────────────

pub struct RatchetState {
    pub dhs: KeyPair,
    pub dhr: Option<Bytes32>,
    pub rk: Bytes32,
    pub cks: Option<Bytes32>,
    pub ckr: Option<Bytes32>,
    pub ns: u32,
    pub nr: u32,
    pub pn: u32,
    /// "{dhrHex}:{n}" → message key, in INSERTION order (mirrors the JS Map —
    /// serialization order depends on it, so never replace with a sorted map).
    pub mkskipped: Vec<(String, Zeroizing<Bytes32>)>,
}
impl Drop for RatchetState {
    fn drop(&mut self) {
        self.rk.zeroize();
        if let Some(k) = self.cks.as_mut() {
            k.zeroize();
        }
        if let Some(k) = self.ckr.as_mut() {
            k.zeroize();
        }
        // dhs (KeyPair) and mkskipped values (Zeroizing) wipe themselves.
    }
}

pub struct RatchetHeader {
    pub dh: Bytes32,
    pub pn: u32,
    pub n: u32,
}

pub struct Envelope {
    pub header: RatchetHeader,
    pub ciphertext: Vec<u8>,
}

/// Alice initialises from the X3DH SK + Bob's signed-prekey public.
pub fn ratchet_init_alice(sk: &Bytes32, bob_signed_pre_key_pub: &Bytes32) -> RatchetState {
    let dhs = generate_dh();
    let (rk, ck) = kdf_rk(sk, &dh(&dhs.secret, bob_signed_pre_key_pub));
    RatchetState {
        dhs,
        dhr: Some(*bob_signed_pre_key_pub),
        rk,
        cks: Some(ck),
        ckr: None,
        ns: 0,
        nr: 0,
        pn: 0,
        mkskipped: Vec::new(),
    }
}

/// Bob initialises from the X3DH SK + his own signed-prekey keypair.
pub fn ratchet_init_bob(sk: &Bytes32, bob_signed_pre_key: &KeyPair) -> RatchetState {
    RatchetState {
        dhs: bob_signed_pre_key.clone(),
        dhr: None,
        rk: *sk,
        cks: None,
        ckr: None,
        ns: 0,
        nr: 0,
        pn: 0,
        mkskipped: Vec::new(),
    }
}

fn header_ad(h: &RatchetHeader) -> Vec<u8> {
    format!("{}|{}|{}", hex::encode(h.dh), h.pn, h.n).into_bytes()
}

pub fn ratchet_encrypt(state: &mut RatchetState, plaintext: &[u8]) -> Res<Envelope> {
    let Some(cks) = state.cks else {
        return err("ratchet: no sending chain yet (responder must receive a message first)");
    };
    let (nck, mk) = kdf_ck(&cks);
    let mk = Zeroizing::new(mk);
    state.cks = Some(nck);
    let header = RatchetHeader { dh: state.dhs.public, pn: state.pn, n: state.ns };
    state.ns += 1;
    let ciphertext = aead_seal(&mk, plaintext, &header_ad(&header));
    Ok(Envelope { header, ciphertext })
}

fn skip_message_keys(state: &mut RatchetState, until: u32) -> Res<()> {
    let Some(mut ckr) = state.ckr else {
        if until > 0 {
            return err("ratchet: cannot skip messages without a receiving chain");
        }
        return Ok(());
    };
    if until > state.nr.saturating_add(MAX_SKIP) {
        return err("ratchet: too many skipped messages");
    }
    let dhr_hex = hex::encode(state.dhr.expect("receiving chain implies DHr"));
    while state.nr < until {
        let (nck, mk) = kdf_ck(&ckr);
        ckr = nck;
        state
            .mkskipped
            .push((format!("{}:{}", dhr_hex, state.nr), Zeroizing::new(mk)));
        state.nr += 1;
    }
    state.ckr = Some(ckr);
    Ok(())
}

fn dh_ratchet(state: &mut RatchetState, header: &RatchetHeader) {
    state.pn = state.ns;
    state.ns = 0;
    state.nr = 0;
    state.dhr = Some(header.dh);
    let (rk, ckr) = kdf_rk(&state.rk, &dh(&state.dhs.secret, &header.dh));
    state.rk = rk;
    state.ckr = Some(ckr);
    state.dhs = generate_dh();
    let (rk, cks) = kdf_rk(&state.rk, &dh(&state.dhs.secret, &header.dh));
    state.rk = rk;
    state.cks = Some(cks);
}

pub fn ratchet_decrypt(state: &mut RatchetState, env: &Envelope) -> Res<Vec<u8>> {
    let header = &env.header;
    let sk_key = format!("{}:{}", hex::encode(header.dh), header.n);
    if let Some(pos) = state.mkskipped.iter().position(|(k, _)| k == &sk_key) {
        let (_, mk) = state.mkskipped.remove(pos);
        return aead_open(&mk, &env.ciphertext, &header_ad(header));
    }
    let is_new_ratchet = match &state.dhr {
        None => true,
        Some(dhr) => !bool::from(header.dh.ct_eq(dhr)),
    };
    if is_new_ratchet {
        if state.dhr.is_some() {
            skip_message_keys(state, header.pn)?;
        }
        dh_ratchet(state, header);
    }
    skip_message_keys(state, header.n)?;
    let ckr = state.ckr.expect("receiving chain after DH ratchet");
    let (nck, mk) = kdf_ck(&ckr);
    let mk = Zeroizing::new(mk);
    state.ckr = Some(nck);
    state.nr += 1;
    aead_open(&mk, &env.ciphertext, &header_ad(header))
}

// ── serialization (must stay byte-identical to the TS output) ──────────

#[derive(Serialize, Deserialize)]
struct KeyPairJson {
    #[serde(rename = "priv")]
    secret: String,
    #[serde(rename = "pub")]
    public: String,
}

#[derive(Serialize, Deserialize)]
struct StateJson {
    #[serde(rename = "DHs")]
    dhs: KeyPairJson,
    #[serde(rename = "DHr")]
    dhr: Option<String>,
    #[serde(rename = "RK")]
    rk: String,
    #[serde(rename = "CKs")]
    cks: Option<String>,
    #[serde(rename = "CKr")]
    ckr: Option<String>,
    #[serde(rename = "Ns")]
    ns: u32,
    #[serde(rename = "Nr")]
    nr: u32,
    #[serde(rename = "PN")]
    pn: u32,
    #[serde(default)]
    skipped: indexmap::IndexMap<String, String>,
}

pub fn serialize_state(s: &RatchetState) -> String {
    let mut skipped = indexmap::IndexMap::new();
    for (k, v) in &s.mkskipped {
        skipped.insert(k.clone(), hex::encode(v.as_ref() as &[u8]));
    }
    serde_json::to_string(&StateJson {
        dhs: KeyPairJson {
            secret: hex::encode(s.dhs.secret),
            public: hex::encode(s.dhs.public),
        },
        dhr: s.dhr.map(hex::encode),
        rk: hex::encode(s.rk),
        cks: s.cks.map(hex::encode),
        ckr: s.ckr.map(hex::encode),
        ns: s.ns,
        nr: s.nr,
        pn: s.pn,
        skipped,
    })
    .expect("state json")
}

pub fn deserialize_state(json: &str) -> Res<RatchetState> {
    let o: StateJson =
        serde_json::from_str(json).map_err(|e| CryptoError(format!("ratchet: bad state JSON: {e}")))?;
    let mut mkskipped = Vec::with_capacity(o.skipped.len());
    for (k, v) in o.skipped {
        mkskipped.push((k, Zeroizing::new(hex32(&v)?)));
    }
    Ok(RatchetState {
        dhs: KeyPair { secret: hex32(&o.dhs.secret)?, public: hex32(&o.dhs.public)? },
        dhr: o.dhr.as_deref().map(hex32).transpose()?,
        rk: hex32(&o.rk)?,
        cks: o.cks.as_deref().map(hex32).transpose()?,
        ckr: o.ckr.as_deref().map(hex32).transpose()?,
        ns: o.ns,
        nr: o.nr,
        pn: o.pn,
        mkskipped,
    })
}

#[derive(Serialize, Deserialize)]
struct EnvelopeJson {
    dh: String,
    pn: u32,
    n: u32,
    ct: String,
}

pub fn encode_envelope(e: &Envelope) -> String {
    serde_json::to_string(&EnvelopeJson {
        dh: B64.encode(e.header.dh),
        pn: e.header.pn,
        n: e.header.n,
        ct: B64.encode(&e.ciphertext),
    })
    .expect("envelope json")
}

pub fn decode_envelope(s: &str) -> Res<Envelope> {
    let o: EnvelopeJson =
        serde_json::from_str(s).map_err(|e| CryptoError(format!("ratchet: bad envelope JSON: {e}")))?;
    let dh: Bytes32 = B64
        .decode(&o.dh)
        .map_err(|_| CryptoError("ratchet: bad envelope base64".into()))?
        .try_into()
        .map_err(|_| CryptoError("ratchet: bad envelope key length".into()))?;
    let ciphertext = B64
        .decode(&o.ct)
        .map_err(|_| CryptoError("ratchet: bad envelope base64".into()))?;
    Ok(Envelope { header: RatchetHeader { dh, pn: o.pn, n: o.n }, ciphertext })
}
