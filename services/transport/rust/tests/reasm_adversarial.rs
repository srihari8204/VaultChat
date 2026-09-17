//! Adversarial coverage of fragment reassembly.
//!
//! The companion is `vaultchat-backend-go/internal/realtime/reasm_fuzz_test.go`,
//! which fuzzes the same property on the server. This is the client half.
//!
//! WHY REASSEMBLY GETS ITS OWN FILE
//!
//! `adversarial.rs` covers decoding: bytes in, structure out, constant space. A
//! reassembler is different in kind — it HOLDS bytes across calls on a peer's
//! promise that the rest is coming. So the question is not "is this fragment
//! well formed" but "how much can a peer make me hold, and for how long, by
//! never finishing". That needs a SEQUENCE, which no single malformed buffer
//! can express.
//!
//! On the device this is the memory the app is killed for. A phone under memory
//! pressure does not report a protocol error; the OS just takes the process.

use transport_core::reasm::{Accepted, Fragment, ReasmLimits, Reassembler};

/// Deterministic, cheap, and reproducible from the seed alone — a real RNG
/// would make a failure impossible to replay from the test output.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0
    }
    fn byte(&mut self) -> u8 {
        (self.next() >> 33) as u8
    }
}

/// Bounds must hold after EVERY fragment, not merely at the end: a reassembler
/// that overshoots and then trims has already allocated what an attacker wanted.
fn assert_bounds(r: &Reassembler, lim: &ReasmLimits, ctx: &str) {
    assert!(
        r.len() <= lim.max_concurrent_reassemblies,
        "{ctx}: {} sets exceeds max_concurrent_reassemblies={}",
        r.len(),
        lim.max_concurrent_reassemblies
    );
    assert!(
        r.buffered_bytes() <= lim.max_reassembly_bytes,
        "{ctx}: {} buffered bytes exceeds max_reassembly_bytes={}",
        r.buffered_bytes(),
        lim.max_reassembly_bytes
    );
}

#[test]
fn hostile_fragment_sequences_never_breach_the_bounds() {
    let lim = ReasmLimits::default();
    // Many seeds rather than one long run: independent sequences reach shapes a
    // single walk does not.
    for seed in 0..512u64 {
        let mut rng = Lcg(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut r = Reassembler::new(lim);
        let mut now: u64 = 0;

        for step in 0..64 {
            // Tiny id alphabet on purpose: it forces COLLISIONS between sets,
            // which is where cross-set confusion would show. A wide id space
            // would mostly exercise the map.
            let id = match rng.byte() % 4 {
                0 => "a",
                1 => "b",
                2 => "c",
                _ => "d",
            };
            let chunk_len = (rng.byte() % 32) as usize;
            let chunk = vec![rng.byte(); chunk_len];

            let f = Fragment {
                fragment_id: id,
                index: rng.byte() as u32,
                total: rng.byte() as u32,
                // DECLARED BY THE PEER. Deliberately allowed to be absurd — a
                // claim must never become a capacity.
                total_bytes: rng.next(),
                chunk: &chunk,
                last: rng.byte() & 1 == 1,
            };

            // The assertion is that this RETURNS. A panic fails the test.
            let _ = r.accept(&f, now);
            assert_bounds(&r, &lim, &format!("seed {seed} step {step}"));

            if rng.byte() & 3 == 0 {
                now += 1_000;
                r.sweep(now);
            }
        }

        // A set that outlives its own expiry is a slow leak: memory a peer
        // parked and walked away from.
        r.sweep(now + lim.reassembly_lifetime_ms + 1);
        assert_eq!(r.len(), 0, "seed {seed}: sets survived the lifetime sweep");
        assert_eq!(
            r.buffered_bytes(),
            0,
            "seed {seed}: bytes still buffered after the lifetime sweep"
        );
    }
}

#[test]
fn a_peer_that_never_finishes_cannot_park_unbounded_memory() {
    // The denial-of-service shape stated plainly: open set after set, send one
    // fragment each, never send a last. Nothing here is malformed — every
    // fragment is individually legal, which is exactly why the per-fragment
    // checks cannot be what saves us.
    let lim = ReasmLimits::default();
    let mut r = Reassembler::new(lim);
    let chunk = vec![0xABu8; 1024];

    for i in 0..10_000u32 {
        let id = format!("set-{i}");
        let f = Fragment {
            fragment_id: &id,
            index: 0,
            total: 16,
            total_bytes: lim.max_message_body_bytes,
            chunk: &chunk,
            last: false,
        };
        let _ = r.accept(&f, 0);
        assert_bounds(&r, &lim, "never-finishing peer");
    }
}

#[test]
fn duplicate_and_out_of_order_indices_are_idempotent_in_space() {
    // Resending index 0 forever must not grow the set forever. Duplicate
    // delivery is ordinary on a lossy network, so this is a correctness
    // property before it is a security one.
    let lim = ReasmLimits::default();
    let mut r = Reassembler::new(lim);
    let chunk = vec![0x11u8; 512];

    for _ in 0..5_000 {
        let f = Fragment {
            fragment_id: "dup",
            index: 0,
            total: 4,
            total_bytes: 2048,
            chunk: &chunk,
            last: false,
        };
        let _ = r.accept(&f, 0);
        assert_bounds(&r, &lim, "duplicate index");
    }
}

#[test]
fn a_completed_set_releases_its_slot_immediately() {
    // Completion must free the budget at once, not at the next sweep. A
    // reassembler that holds finished payloads is a leak that looks like use.
    let lim = ReasmLimits::default();
    let mut r = Reassembler::new(lim);
    let chunk = vec![0x22u8; 16];

    for i in 0..(lim.max_concurrent_reassemblies * 4) {
        let id = format!("complete-{i}");
        let a = Fragment {
            fragment_id: &id,
            index: 0,
            total: 2,
            total_bytes: 32,
            chunk: &chunk,
            last: false,
        };
        let b = Fragment {
            fragment_id: &id,
            index: 1,
            total: 2,
            total_bytes: 32,
            chunk: &chunk,
            last: true,
        };
        let _ = r.accept(&a, 0);
        if let Ok(Accepted::Complete(_)) = r.accept(&b, 0) {
            assert_eq!(
                r.buffered_bytes(),
                0,
                "a completed set left bytes buffered behind it"
            );
        }
        assert_bounds(&r, &lim, "completion releases");
    }
}
