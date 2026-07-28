//! Golden-vector tests: prove crypto-core reproduces the frozen TS behavior in
//! services/crypto/__vectors__/*.json byte-for-byte. These are the SAME files
//! `npm run test:crypto:vectors` checks the TS side against.

use crypto_core::e2ee::{
    self, decode_envelope, deserialize_state, encode_envelope, kdf_ck, kdf_rk, msg_key_material,
    ratchet_decrypt, ratchet_encrypt, serialize_state, x25519_public, x3dh_responder, InitialHeader,
    KeyPair,
};
use crypto_core::sender_key as sk;
use crypto_core::shamir;
use serde_json::Value;

fn h32(v: &Value) -> [u8; 32] {
    let b = hex::decode(v.as_str().expect("hex string")).expect("hex");
    b.try_into().expect("32 bytes")
}
fn s<'a>(v: &'a Value) -> &'a str {
    v.as_str().expect("string")
}
fn xkp(priv_hex: &Value) -> KeyPair {
    let secret = h32(priv_hex);
    KeyPair { public: x25519_public(&secret), secret }
}

fn e2ee_doc() -> Value {
    serde_json::from_str(include_str!("../../__vectors__/e2ee.json")).unwrap()
}

#[test]
fn e2ee_kdf_vectors() {
    let v = e2ee_doc();
    let (inp, exp) = (&v["inputs"], &v["expected"]);

    let (rk, ck) = kdf_rk(&h32(&inp["kdfRk"]["rk"]), &h32(&inp["kdfRk"]["dhOut"]));
    assert_eq!(hex::encode(rk), s(&exp["kdfRk"]["rk"]));
    assert_eq!(hex::encode(ck), s(&exp["kdfRk"]["ck"]));

    let (nck, mk) = kdf_ck(&h32(&inp["kdfCk"]["ck"]));
    assert_eq!(hex::encode(mk), s(&exp["kdfCk"]["mk"]));
    assert_eq!(hex::encode(nck), s(&exp["kdfCk"]["ck"]));

    let (key, nonce) = msg_key_material(&h32(&inp["msgKey"]["mk"]));
    assert_eq!(hex::encode(key), s(&exp["msgKey"]["key"]));
    assert_eq!(hex::encode(nonce), s(&exp["msgKey"]["nonce"]));
}

#[test]
fn e2ee_sign_vector() {
    let v = e2ee_doc();
    let (inp, exp) = (&v["inputs"], &v["expected"]);
    let secret = h32(&inp["sign"]["priv"]);
    let msg = s(&inp["sign"]["msgUtf8"]).as_bytes();
    assert_eq!(hex::encode(e2ee::ed25519_public(&secret)), s(&exp["sign"]["pub"]));
    let sig = e2ee::sign(msg, &secret);
    assert_eq!(hex::encode(sig), s(&exp["sign"]["signature"]));
    assert!(e2ee::verify(&sig, msg, &h32(&exp["sign"]["pub"])));
}

#[test]
fn e2ee_x3dh_responder_vector() {
    let v = e2ee_doc();
    let (inp, exp) = (&v["inputs"], &v["expected"]);
    let bob_id = xkp(&inp["x3dh"]["bobIdentityPriv"]);
    let bob_spk = xkp(&inp["x3dh"]["bobSpkPriv"]);
    let bob_otk = xkp(&inp["x3dh"]["bobOtkPriv"]);
    let alice_id = xkp(&inp["x3dh"]["aliceIdentityPriv"]);
    let alice_eph = xkp(&inp["x3dh"]["aliceEphPriv"]);

    // Public-key derivation matches noble's getPublicKey.
    assert_eq!(hex::encode(bob_id.public), s(&exp["x3dh"]["bundlePubs"]["identityKey"]));
    assert_eq!(hex::encode(bob_spk.public), s(&exp["x3dh"]["bundlePubs"]["signedPreKey"]));
    assert_eq!(hex::encode(bob_otk.public), s(&exp["x3dh"]["bundlePubs"]["oneTimePreKey"]));
    assert_eq!(hex::encode(alice_id.public), s(&exp["x3dh"]["header"]["identityKey"]));
    assert_eq!(hex::encode(alice_eph.public), s(&exp["x3dh"]["header"]["ephemeralKey"]));

    let header = InitialHeader {
        identity_key: alice_id.public,
        ephemeral_key: alice_eph.public,
        one_time_pre_key_id: Some(1),
    };
    let sk_with = x3dh_responder(&bob_id, &bob_spk, Some(&bob_otk), &header);
    let sk_without = x3dh_responder(&bob_id, &bob_spk, None, &header);
    assert_eq!(hex::encode(sk_with), s(&exp["x3dh"]["skWithOtk"]));
    assert_eq!(hex::encode(sk_without), s(&exp["x3dh"]["skNoOtk"]));
}

#[test]
fn e2ee_ratchet_encrypt_vectors() {
    let v = e2ee_doc();
    let (inp, exp) = (&v["inputs"], &v["expected"]);
    let sender_json = s(&exp["ratchet"]["senderStateJson"]);

    // serialize(deserialize(x)) must be byte-identical.
    let state0 = deserialize_state(sender_json).unwrap();
    assert_eq!(serialize_state(&state0), sender_json);

    let mut state = deserialize_state(sender_json).unwrap();
    let plaintexts = inp["ratchet"]["plaintexts"].as_array().unwrap();
    for (i, p) in plaintexts.iter().enumerate() {
        let env = ratchet_encrypt(&mut state, s(p).as_bytes()).unwrap();
        assert_eq!(
            encode_envelope(&env),
            s(&exp["ratchet"]["envelopes"][i]),
            "envelope {i} must be byte-identical"
        );
    }
    assert_eq!(serialize_state(&state), s(&exp["ratchet"]["senderStateAfterJson"]));
}

#[test]
fn e2ee_ratchet_decrypt_vectors() {
    let v = e2ee_doc();
    let (inp, exp) = (&v["inputs"], &v["expected"]);
    let recv_json = s(&exp["ratchet"]["recvStateJson"]);
    let envs = exp["ratchet"]["envelopes"].as_array().unwrap();
    let plaintexts = inp["ratchet"]["plaintexts"].as_array().unwrap();

    // In-order decrypt of message 0.
    let mut r1 = deserialize_state(recv_json).unwrap();
    let p0 = ratchet_decrypt(&mut r1, &decode_envelope(s(&envs[0])).unwrap()).unwrap();
    assert_eq!(String::from_utf8(p0).unwrap(), s(&plaintexts[0]));
    assert_eq!(serialize_state(&r1), s(&exp["ratchet"]["recvInOrder"]["stateJson"]));

    // Out-of-order: message 2 first (skipped-key cache), then 0 from the cache.
    let mut r2 = deserialize_state(recv_json).unwrap();
    let p2 = ratchet_decrypt(&mut r2, &decode_envelope(s(&envs[2])).unwrap()).unwrap();
    assert_eq!(String::from_utf8(p2).unwrap(), s(&plaintexts[2]));
    assert_eq!(
        serialize_state(&r2),
        s(&exp["ratchet"]["recvOutOfOrder"]["stateJsonAfterSkip"]),
        "skipped-key cache serialization (incl. insertion order) must match"
    );
    let p0b = ratchet_decrypt(&mut r2, &decode_envelope(s(&envs[0])).unwrap()).unwrap();
    assert_eq!(String::from_utf8(p0b).unwrap(), s(&plaintexts[0]));
    assert_eq!(
        serialize_state(&r2),
        s(&exp["ratchet"]["recvOutOfOrder"]["stateJsonAfterCacheHit"])
    );
}

#[test]
fn sender_key_vectors() {
    let v: Value = serde_json::from_str(include_str!("../../__vectors__/senderKey.json")).unwrap();
    let (inp, exp) = (&v["inputs"], &v["expected"]);

    let own0 = sk::OwnSenderKey {
        chain_key_hex: s(&inp["chainKey"]).into(),
        iteration: 0,
        sign_pub_hex: hex::encode(e2ee::ed25519_public(&h32(&inp["signPriv"]))),
        sign_priv_hex: s(&inp["signPriv"]).into(),
    };
    assert_eq!(serde_json::to_value(&own0).unwrap(), exp["own0"]);

    let dist = sk::distribution_message(&own0);
    assert_eq!(serde_json::to_value(&dist).unwrap(), exp["distribution"]);

    let plaintexts = inp["plaintexts"].as_array().unwrap();
    let mut own = own0;
    let mut ciphers = Vec::new();
    for (i, p) in plaintexts.iter().enumerate() {
        let (cipher, next) = sk::group_encrypt(&own, s(p)).unwrap();
        assert_eq!(
            serde_json::to_value(&cipher).unwrap(),
            exp["ciphers"][i],
            "group cipher {i} must be byte-identical"
        );
        ciphers.push(cipher);
        own = next;
    }
    assert_eq!(serde_json::to_value(&own).unwrap(), exp["ownAfter"]);

    // In-order decrypt of message 0 from a fresh peer record.
    let (p0, rec1) = sk::group_decrypt(&sk::process_distribution(&dist), &ciphers[0]).unwrap();
    assert_eq!(p0, s(&plaintexts[0]));
    assert_eq!(serde_json::to_value(&rec1).unwrap(), exp["decInOrder"]["next"]);

    // Out-of-order: message 2 first (caches 0,1), then 0 from the cache.
    let (p2, rec2) = sk::group_decrypt(&sk::process_distribution(&dist), &ciphers[2]).unwrap();
    assert_eq!(p2, s(&plaintexts[2]));
    assert_eq!(serde_json::to_value(&rec2).unwrap(), exp["decOutOfOrder"]["next"]);
    let (p0b, rec3) = sk::group_decrypt(&rec2, &ciphers[0]).unwrap();
    assert_eq!(p0b, s(&plaintexts[0]));
    assert_eq!(serde_json::to_value(&rec3).unwrap(), exp["decOutOfOrder"]["nextAfterCacheHit"]);
}

#[test]
fn shamir_vectors() {
    let v: Value = serde_json::from_str(include_str!("../../__vectors__/shamir.json")).unwrap();
    let (inp, exp) = (&v["inputs"], &v["expected"]);
    let shares: Vec<String> =
        inp["shares"].as_array().unwrap().iter().map(|x| s(x).to_string()).collect();
    let k = inp["k"].as_u64().unwrap() as usize;

    assert_eq!(shamir::share_threshold(&shares[0]).unwrap() as u64, exp["threshold"].as_u64().unwrap());
    assert_eq!(hex::encode(shamir::combine_shares(&shares).unwrap()), s(&exp["combinedAll"]));
    assert_eq!(
        hex::encode(shamir::combine_shares(&shares[..k]).unwrap()),
        s(&exp["combinedFirstK"])
    );
    assert_eq!(
        hex::encode(shamir::combine_shares(&shares[shares.len() - k..]).unwrap()),
        s(&exp["combinedLastK"])
    );
}
