//! FFI boundary: a single C-ABI entrypoint + JSON dispatcher.
//!
//! Every op takes/returns JSON; state crosses in the exact persisted formats
//! (serializeState JSON, sender-key records, envelope wire, VCSS1 strings),
//! so the boundary format IS the interop format. Bytes travel as hex.
//!
//! Response envelope: `{"ok":true,"result":...}` | `{"ok":false,"error":"..."}`.
//! The same dispatcher backs the Nitro C++ wrapper (vc_crypto_call) and the
//! host-side CLI (src/bin/vc-crypto-cli.rs) used by the Node parity suite.

use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use zeroize::Zeroizing;

use crate::e2ee::{self, KeyPair};
use crate::sender_key as sk;
use crate::shamir;
use crate::{Bytes32, CryptoError, Res};

// ── arg helpers ────────────────────────────────────────────────────────

fn want<'a>(args: &'a Value, key: &str) -> Res<&'a Value> {
    args.get(key)
        .ok_or_else(|| CryptoError(format!("crypto-core: missing arg '{key}'")))
}
fn want_str<'a>(args: &'a Value, key: &str) -> Res<&'a str> {
    want(args, key)?
        .as_str()
        .ok_or_else(|| CryptoError(format!("crypto-core: arg '{key}' must be a string")))
}
fn want_hex(args: &Value, key: &str) -> Res<Vec<u8>> {
    hex::decode(want_str(args, key)?)
        .map_err(|_| CryptoError(format!("crypto-core: arg '{key}' must be hex")))
}
fn h32_of(v: &Value, what: &str) -> Res<Bytes32> {
    let s = v
        .as_str()
        .ok_or_else(|| CryptoError(format!("crypto-core: {what} must be a hex string")))?;
    hex::decode(s)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| CryptoError(format!("crypto-core: {what} must be 32-byte hex")))
}
fn want_h32(args: &Value, key: &str) -> Res<Bytes32> {
    h32_of(want(args, key)?, &format!("arg '{key}'"))
}
fn want_u32(args: &Value, key: &str) -> Res<u32> {
    want(args, key)?
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| CryptoError(format!("crypto-core: arg '{key}' must be a u32")))
}
fn opt<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.get(key).filter(|v| !v.is_null())
}
fn kp_of(v: &Value, what: &str) -> Res<KeyPair> {
    Ok(KeyPair {
        secret: h32_of(
            v.get("priv").ok_or_else(|| CryptoError(format!("crypto-core: {what}.priv missing")))?,
            &format!("{what}.priv"),
        )?,
        public: h32_of(
            v.get("pub").ok_or_else(|| CryptoError(format!("crypto-core: {what}.pub missing")))?,
            &format!("{what}.pub"),
        )?,
    })
}
fn want_kp(args: &Value, key: &str) -> Res<KeyPair> {
    kp_of(want(args, key)?, key)
}
fn kp_json(k: &KeyPair) -> Value {
    json!({ "priv": hex::encode(k.secret), "pub": hex::encode(k.public) })
}
fn from_value<T: serde::de::DeserializeOwned>(v: &Value, what: &str) -> Res<T> {
    serde_json::from_value(v.clone())
        .map_err(|e| CryptoError(format!("crypto-core: bad {what}: {e}")))
}

// ── dispatcher ─────────────────────────────────────────────────────────

pub fn dispatch(op: &str, args: &Value) -> Res<Value> {
    match op {
        // e2ee — primitives
        "generateDH" => Ok(kp_json(&e2ee::generate_dh())),
        "generateSigningKey" => Ok(kp_json(&e2ee::generate_signing_key())),
        "sign" => {
            let msg = want_hex(args, "msg")?;
            let secret = Zeroizing::new(want_h32(args, "priv")?);
            Ok(json!(hex::encode(e2ee::sign(&msg, &secret))))
        }
        "verify" => {
            let sig = want_hex(args, "sig")?;
            let msg = want_hex(args, "msg")?;
            Ok(json!(e2ee::verify(&sig, &msg, &want_h32(args, "pub")?)))
        }

        // e2ee — X3DH
        "x3dhInitiator" => {
            let me = want_kp(args, "myIdentity")?;
            let b = want(args, "bundle")?;
            let bundle = e2ee::PreKeyBundle {
                identity_key: h32_of(want(b, "identityKey")?, "bundle.identityKey")?,
                signing_key: h32_of(want(b, "signingKey")?, "bundle.signingKey")?,
                signed_pre_key: h32_of(want(b, "signedPreKey")?, "bundle.signedPreKey")?,
                signed_pre_key_sig: want_hex(b, "signedPreKeySig")?,
                one_time_pre_key: match opt(b, "oneTimePreKey") {
                    Some(v) => Some(h32_of(v, "bundle.oneTimePreKey")?),
                    None => None,
                },
                one_time_pre_key_id: opt(b, "oneTimePreKeyId").and_then(|v| v.as_i64()),
            };
            let (sk_bytes, ephemeral, header) = e2ee::x3dh_initiator(&me, &bundle)?;
            Ok(json!({
                "sk": hex::encode(sk_bytes),
                "ephemeral": kp_json(&ephemeral),
                "header": {
                    "identityKey": hex::encode(header.identity_key),
                    "ephemeralKey": hex::encode(header.ephemeral_key),
                    "oneTimePreKeyId": header.one_time_pre_key_id,
                },
            }))
        }
        "x3dhResponder" => {
            let h = want(args, "header")?;
            let header = e2ee::InitialHeader {
                identity_key: h32_of(want(h, "identityKey")?, "header.identityKey")?,
                ephemeral_key: h32_of(want(h, "ephemeralKey")?, "header.ephemeralKey")?,
                one_time_pre_key_id: None,
            };
            let otk = match opt(args, "myOneTimePreKey") {
                Some(v) => Some(kp_of(v, "myOneTimePreKey")?),
                None => None,
            };
            let sk_bytes = e2ee::x3dh_responder(
                &want_kp(args, "myIdentity")?,
                &want_kp(args, "mySignedPreKey")?,
                otk.as_ref(),
                &header,
            );
            Ok(json!(hex::encode(sk_bytes)))
        }

        // e2ee — Double Ratchet (state travels as the canonical serialized JSON)
        "ratchetInitAlice" => {
            let sk_bytes = Zeroizing::new(want_h32(args, "sk")?);
            let state = e2ee::ratchet_init_alice(&sk_bytes, &want_h32(args, "bobSignedPreKeyPub")?);
            Ok(json!(e2ee::serialize_state(&state)))
        }
        "ratchetInitBob" => {
            let sk_bytes = Zeroizing::new(want_h32(args, "sk")?);
            let state = e2ee::ratchet_init_bob(&sk_bytes, &want_kp(args, "bobSignedPreKey")?);
            Ok(json!(e2ee::serialize_state(&state)))
        }
        "ratchetEncrypt" => {
            let mut state = e2ee::deserialize_state(want_str(args, "state")?)?;
            let plaintext = Zeroizing::new(want_hex(args, "plaintext")?);
            let env = e2ee::ratchet_encrypt(&mut state, &plaintext)?;
            Ok(json!({
                "state": e2ee::serialize_state(&state),
                "envelope": e2ee::encode_envelope(&env),
            }))
        }
        "ratchetDecrypt" => {
            let mut state = e2ee::deserialize_state(want_str(args, "state")?)?;
            let env = e2ee::decode_envelope(want_str(args, "envelope")?)?;
            let plaintext = Zeroizing::new(e2ee::ratchet_decrypt(&mut state, &env)?);
            Ok(json!({
                "state": e2ee::serialize_state(&state),
                "plaintext": hex::encode(plaintext.as_slice()),
            }))
        }

        // sender keys (records are the TS-shaped JSON objects)
        "createSenderKey" => Ok(serde_json::to_value(sk::create_sender_key()).expect("json")),
        "distributionMessage" => {
            let own: sk::OwnSenderKey = from_value(want(args, "own")?, "own sender key")?;
            Ok(serde_json::to_value(sk::distribution_message(&own)).expect("json"))
        }
        "processDistribution" => {
            let skdm: sk::SenderKeyDistribution = from_value(want(args, "skdm")?, "distribution")?;
            Ok(serde_json::to_value(sk::process_distribution(&skdm)).expect("json"))
        }
        "groupEncrypt" => {
            let own: sk::OwnSenderKey = from_value(want(args, "own")?, "own sender key")?;
            let (cipher, next) = sk::group_encrypt(&own, want_str(args, "plaintext")?)?;
            Ok(json!({
                "cipher": serde_json::to_value(cipher).expect("json"),
                "next": serde_json::to_value(next).expect("json"),
            }))
        }
        "groupDecrypt" => {
            let rec: sk::PeerSenderKey = from_value(want(args, "rec")?, "peer sender key")?;
            let cipher: sk::GroupCipher = from_value(want(args, "cipher")?, "group cipher")?;
            let (plaintext, next) = sk::group_decrypt(&rec, &cipher)?;
            Ok(json!({
                "plaintext": plaintext,
                "next": serde_json::to_value(next).expect("json"),
            }))
        }

        // shamir
        "splitSecret" => {
            let secret = Zeroizing::new(want_hex(args, "secret")?);
            let shares = shamir::split_secret(&secret, want_u32(args, "n")?, want_u32(args, "k")?)?;
            Ok(json!(shares))
        }
        "combineShares" => {
            let shares: Vec<String> = from_value(want(args, "shares")?, "shares")?;
            let secret = Zeroizing::new(shamir::combine_shares(&shares)?);
            Ok(json!(hex::encode(secret.as_slice())))
        }
        "shareThreshold" => Ok(json!(shamir::share_threshold(want_str(args, "share")?)?)),

        // facade init probe: quick end-to-end sanity across all three modules
        "selfCheck" => self_check(),

        _ => Err(CryptoError(format!("crypto-core: unknown op '{op}'"))),
    }
}

fn self_check() -> Res<Value> {
    // Ratchet: Alice→Bob round-trip from a shared SK.
    let sk0 = Zeroizing::new(crate::os_random32());
    let bob_spk = e2ee::generate_dh();
    let mut alice = e2ee::ratchet_init_alice(&sk0, &bob_spk.public);
    let mut bob = e2ee::ratchet_init_bob(&sk0, &bob_spk);
    let env = e2ee::ratchet_encrypt(&mut alice, b"vc-selfcheck")?;
    if e2ee::ratchet_decrypt(&mut bob, &env)? != b"vc-selfcheck" {
        return Err(CryptoError("crypto-core: self-check failed (ratchet)".into()));
    }
    // Sender key round-trip.
    let own = sk::create_sender_key();
    let peer = sk::process_distribution(&sk::distribution_message(&own));
    let (cipher, _next) = sk::group_encrypt(&own, "vc-selfcheck")?;
    if sk::group_decrypt(&peer, &cipher)?.0 != "vc-selfcheck" {
        return Err(CryptoError("crypto-core: self-check failed (senderKey)".into()));
    }
    // Shamir 2-of-2.
    let shares = shamir::split_secret(b"vc-selfcheck", 2, 2)?;
    if shamir::combine_shares(&shares)? != b"vc-selfcheck" {
        return Err(CryptoError("crypto-core: self-check failed (shamir)".into()));
    }
    Ok(json!(true))
}

// ── response plumbing ──────────────────────────────────────────────────

fn error_json(msg: &str) -> String {
    json!({ "ok": false, "error": msg }).to_string()
}

fn respond(op: &str, args_json: &str) -> String {
    let args: Value = match serde_json::from_str(args_json) {
        Ok(v) => v,
        Err(e) => return error_json(&format!("crypto-core: bad args JSON: {e}")),
    };
    match dispatch(op, &args) {
        Ok(v) => json!({ "ok": true, "result": v }).to_string(),
        Err(e) => error_json(&e.0),
    }
}

/// One request line `{"op":"...","args":{...}}` → one response JSON string.
/// Used by the host CLI (parity tests); never panics.
pub fn handle_line(line: &str) -> String {
    std::panic::catch_unwind(|| {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => return error_json(&format!("crypto-core: bad request JSON: {e}")),
        };
        let op = match v.get("op").and_then(|o| o.as_str()) {
            Some(o) => o,
            None => return error_json("crypto-core: request missing 'op'"),
        };
        let args = v.get("args").cloned().unwrap_or_else(|| json!({}));
        match dispatch(op, &args) {
            Ok(r) => json!({ "ok": true, "result": r }).to_string(),
            Err(e) => error_json(&e.0),
        }
    })
    .unwrap_or_else(|_| error_json("crypto-core: internal panic"))
}

/// C ABI entrypoint for the Nitro wrapper. Returns a heap JSON string the
/// caller must release with `vc_crypto_free`. Never panics across the boundary.
///
/// # Safety
/// `op` and `args_json` must be NUL-terminated C strings (or null, which
/// yields an error response).
#[no_mangle]
pub extern "C" fn vc_crypto_call(op: *const c_char, args_json: *const c_char) -> *mut c_char {
    let out = std::panic::catch_unwind(|| {
        if op.is_null() || args_json.is_null() {
            return error_json("crypto-core: null argument");
        }
        let op = unsafe { CStr::from_ptr(op) }.to_string_lossy().into_owned();
        let args = unsafe { CStr::from_ptr(args_json) }.to_string_lossy().into_owned();
        respond(&op, &args)
    })
    .unwrap_or_else(|_| error_json("crypto-core: internal panic"));
    // serde_json escapes control chars (incl. NUL) so CString::new cannot fail
    // on real output; belt-and-braces null on the impossible path.
    CString::new(out).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

/// Release a string returned by `vc_crypto_call`.
///
/// # Safety
/// `ptr` must be a pointer previously returned by `vc_crypto_call` (or null).
#[no_mangle]
pub extern "C" fn vc_crypto_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe { drop(CString::from_raw(ptr)) };
    }
}

// ── tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn call(op: &str, args: Value) -> Value {
        let resp: Value =
            serde_json::from_str(&handle_line(&json!({ "op": op, "args": args }).to_string()))
                .unwrap();
        assert_eq!(resp["ok"], json!(true), "op {op} failed: {resp}");
        resp["result"].clone()
    }

    #[test]
    fn dispatcher_full_flow() {
        // X3DH bootstrap through the JSON boundary.
        let bob_id = call("generateDH", json!({}));
        let bob_sign = call("generateSigningKey", json!({}));
        let bob_spk = call("generateDH", json!({}));
        let alice_id = call("generateDH", json!({}));
        let spk_sig = call(
            "sign",
            json!({ "msg": bob_spk["pub"], "priv": bob_sign["priv"] }),
        );
        let init = call(
            "x3dhInitiator",
            json!({
                "myIdentity": alice_id,
                "bundle": {
                    "identityKey": bob_id["pub"], "signingKey": bob_sign["pub"],
                    "signedPreKey": bob_spk["pub"], "signedPreKeySig": spk_sig,
                    "oneTimePreKey": null, "oneTimePreKeyId": null,
                },
            }),
        );
        let sk_bob = call(
            "x3dhResponder",
            json!({
                "myIdentity": bob_id, "mySignedPreKey": bob_spk, "myOneTimePreKey": null,
                "header": init["header"],
            }),
        );
        assert_eq!(init["sk"], sk_bob, "X3DH must agree across the boundary");

        // Ratchet round-trip, state as serialized JSON strings.
        let alice_state = call(
            "ratchetInitAlice",
            json!({ "sk": init["sk"], "bobSignedPreKeyPub": bob_spk["pub"] }),
        );
        let bob_state = call(
            "ratchetInitBob",
            json!({ "sk": sk_bob, "bobSignedPreKey": bob_spk }),
        );
        let enc = call(
            "ratchetEncrypt",
            json!({ "state": alice_state, "plaintext": hex::encode(b"over the wire") }),
        );
        let dec = call(
            "ratchetDecrypt",
            json!({ "state": bob_state, "envelope": enc["envelope"] }),
        );
        assert_eq!(dec["plaintext"].as_str().unwrap(), hex::encode(b"over the wire"));

        // Sender-key round-trip.
        let own = call("createSenderKey", json!({}));
        let dist = call("distributionMessage", json!({ "own": own }));
        let peer = call("processDistribution", json!({ "skdm": dist }));
        let genc = call("groupEncrypt", json!({ "own": own, "plaintext": "hi group" }));
        let gdec = call("groupDecrypt", json!({ "rec": peer, "cipher": genc["cipher"] }));
        assert_eq!(gdec["plaintext"], json!("hi group"));

        // Shamir.
        let shares = call("splitSecret", json!({ "secret": hex::encode(b"tiny"), "n": 3, "k": 2 }));
        let combined = call("combineShares", json!({ "shares": shares }));
        assert_eq!(combined.as_str().unwrap(), hex::encode(b"tiny"));
        assert_eq!(call("shareThreshold", json!({ "share": shares[0] })), json!(2));

        assert_eq!(call("selfCheck", json!({})), json!(true));
    }

    #[test]
    fn c_abi_round_trip() {
        let op = std::ffi::CString::new("selfCheck").unwrap();
        let args = std::ffi::CString::new("{}").unwrap();
        let ptr = vc_crypto_call(op.as_ptr(), args.as_ptr());
        assert!(!ptr.is_null());
        let resp = unsafe { CStr::from_ptr(ptr) }.to_str().unwrap().to_string();
        vc_crypto_free(ptr);
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["ok"], json!(true));
    }

    #[test]
    fn errors_are_structured() {
        let resp: Value = serde_json::from_str(&handle_line(r#"{"op":"nope","args":{}}"#)).unwrap();
        assert_eq!(resp["ok"], json!(false));
        assert!(resp["error"].as_str().unwrap().contains("unknown op"));
    }
}
