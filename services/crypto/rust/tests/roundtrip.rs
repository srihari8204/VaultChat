//! Randomized-path semantics tests (keygen, X3DH initiator, DH-ratchet steps,
//! splitSecret): round-trip within Rust. Cross-implementation interop with the
//! TS core is Step 5 (parity.selftest.ts).

use crypto_core::e2ee::*;
use crypto_core::sender_key as sk;
use crypto_core::shamir;

#[test]
fn full_conversation_with_dh_ratchets() {
    // X3DH bootstrap.
    let bob_id = generate_dh();
    let bob_sign = generate_signing_key();
    let bob_spk = generate_dh();
    let bob_otk = generate_dh();
    let alice_id = generate_dh();
    let bundle = PreKeyBundle {
        identity_key: bob_id.public,
        signing_key: bob_sign.public,
        signed_pre_key: bob_spk.public,
        signed_pre_key_sig: sign(&bob_spk.public, &bob_sign.secret).to_vec(),
        one_time_pre_key: Some(bob_otk.public),
        one_time_pre_key_id: Some(7),
    };
    let (sk_a, _eph, header) = x3dh_initiator(&alice_id, &bundle).unwrap();
    let sk_b = x3dh_responder(&bob_id, &bob_spk, Some(&bob_otk), &header);
    assert_eq!(sk_a, sk_b, "X3DH must agree");

    // Ratchet both ways, with a serialize/deserialize hop mid-conversation.
    let mut alice = ratchet_init_alice(&sk_a, &bob_spk.public);
    let mut bob = ratchet_init_bob(&sk_b, &bob_spk);

    let e1 = ratchet_encrypt(&mut alice, b"hello bob").unwrap();
    assert_eq!(ratchet_decrypt(&mut bob, &e1).unwrap(), b"hello bob");

    let e2 = ratchet_encrypt(&mut bob, b"hello alice").unwrap();
    let mut alice = deserialize_state(&serialize_state(&alice)).unwrap();
    assert_eq!(ratchet_decrypt(&mut alice, &e2).unwrap(), b"hello alice");

    // Out-of-order across a DH ratchet.
    let e3 = ratchet_encrypt(&mut alice, b"m3").unwrap();
    let e4 = ratchet_encrypt(&mut alice, b"m4").unwrap();
    assert_eq!(ratchet_decrypt(&mut bob, &e4).unwrap(), b"m4");
    assert_eq!(ratchet_decrypt(&mut bob, &e3).unwrap(), b"m3");

    // Envelope wire round-trip.
    let e5 = ratchet_encrypt(&mut bob, b"wire").unwrap();
    let e5 = decode_envelope(&encode_envelope(&e5)).unwrap();
    assert_eq!(ratchet_decrypt(&mut alice, &e5).unwrap(), b"wire");

    // Tamper detection.
    let mut e6 = ratchet_encrypt(&mut alice, b"tamper").unwrap();
    e6.ciphertext[0] ^= 1;
    assert!(ratchet_decrypt(&mut bob, &e6).is_err());
}

#[test]
fn sender_key_rotation() {
    let own = sk::create_sender_key();
    let peer = sk::process_distribution(&sk::distribution_message(&own));
    let (c1, own) = sk::group_encrypt(&own, "msg one ✓").unwrap();
    let (p1, peer) = sk::group_decrypt(&peer, &c1).unwrap();
    assert_eq!(p1, "msg one ✓");

    // Rotation: a fresh sender key — the stale record must reject new messages.
    let rotated = sk::create_sender_key();
    let (c2, _) = sk::group_encrypt(&rotated, "post-rotation").unwrap();
    assert!(sk::group_decrypt(&peer, &c2).is_err(), "stale record must fail");
    let _ = own;
}

#[test]
fn shamir_split_combine() {
    let secret = b"correct horse battery staple #32".to_vec();
    let shares = shamir::split_secret(&secret, 5, 3).unwrap();
    assert_eq!(shares.len(), 5);
    assert!(shares.iter().all(|s| s.starts_with("VCSS1-3-")));

    assert_eq!(shamir::combine_shares(&shares).unwrap(), secret);
    assert_eq!(shamir::combine_shares(&shares[..3]).unwrap(), secret);
    assert_eq!(shamir::combine_shares(&shares[2..]).unwrap(), secret);
    assert!(shamir::combine_shares(&shares[..2]).is_err(), "k-1 must fail");

    // Mixed sets rejected.
    let other = shamir::split_secret(&secret, 5, 3).unwrap();
    let mixed = vec![shares[0].clone(), shares[1].clone(), other[2].clone()];
    assert!(shamir::combine_shares(&mixed).is_err());
}
