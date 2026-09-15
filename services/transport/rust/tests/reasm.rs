//! Fragment reassembly bounds.
//!
//! Each bound is violated ALONE. A test that trips two at once proves neither:
//! it passes just as happily against an implementation that dropped one of the
//! checks, which is precisely the regression these tests exist to catch.

use transport_core::parse::Limits;
use transport_core::reasm::{Accepted, Fragment, ReasmError, ReasmLimits, Reassembler};

const ID: &str = "frag-1";

/// A well-formed fragment of a two-part set, so each test can perturb exactly
/// one field and leave everything else legal.
fn frag<'a>(
    id: &'a str,
    index: u32,
    total: u32,
    total_bytes: u64,
    chunk: &'a [u8],
) -> Fragment<'a> {
    Fragment {
        fragment_id: id,
        index,
        total,
        total_bytes,
        chunk,
        last: index == total - 1,
    }
}

/// The reassembly limits and the codec's limits copy the same two numbers out of
/// capabilities.proto. If they ever drift, that is a bound one of them is no
/// longer enforcing.
#[test]
fn the_shared_limits_match_the_codec_limits() {
    let r = ReasmLimits::default();
    let c = Limits::default();
    assert_eq!(r.max_fragments_per_message, c.max_fragments_per_message);
    assert_eq!(r.max_message_body_bytes, c.max_message_body_bytes as u64);
    assert_eq!(r.reassembly_lifetime_ms, 30_000);
    assert_eq!(r.max_concurrent_reassemblies, 8);
}

#[test]
fn a_complete_set_reassembles_in_index_order_whatever_the_arrival_order() {
    let mut r = Reassembler::default();
    assert_eq!(
        r.accept(&frag(ID, 2, 3, 6, b"ff"), 0),
        Ok(Accepted::Pending)
    );
    assert_eq!(
        r.accept(&frag(ID, 0, 3, 6, b"aa"), 0),
        Ok(Accepted::Pending)
    );
    assert_eq!(
        r.accept(&frag(ID, 1, 3, 6, b"bb"), 0),
        Ok(Accepted::Complete(b"aabbff".to_vec()))
    );
    assert!(
        r.is_empty(),
        "a completed set must free its slot immediately"
    );
    assert_eq!(r.buffered_bytes(), 0);
}

// ── bound 1: total > max_fragments_per_message ───────────────────────────

#[test]
fn a_total_above_max_fragments_per_message_is_refused() {
    let mut r = Reassembler::default();
    let over = r.limits().max_fragments_per_message + 1;
    assert_eq!(
        r.accept(&frag(ID, 0, over, 1024, b"a"), 0),
        Err(ReasmError::TooManyFragments)
    );
    assert!(
        r.is_empty(),
        "a refused fragment must not have opened a set"
    );
}

#[test]
fn a_total_exactly_at_max_fragments_per_message_is_allowed() {
    let mut r = Reassembler::default();
    let at = r.limits().max_fragments_per_message;
    assert_eq!(
        r.accept(&frag(ID, 0, at, 1024, b"a"), 0),
        Ok(Accepted::Pending)
    );
}

// ── bound 2: total_bytes > max_message_body_bytes ────────────────────────

/// The declaration is checked against the limit BEFORE anything is allocated on
/// the strength of it. The chunk here is one byte: only the declared size is
/// hostile, so nothing but that bound can be what refuses it.
#[test]
fn a_declared_total_bytes_above_the_body_limit_is_refused_before_allocation() {
    let mut r = Reassembler::default();
    let over = r.limits().max_message_body_bytes + 1;
    assert_eq!(
        r.accept(&frag(ID, 0, 2, over, b"a"), 0),
        Err(ReasmError::TotalBytesOverMax)
    );
    assert!(r.is_empty());
    assert_eq!(r.buffered_bytes(), 0);
}

/// The bound that says a peer's claim never becomes a capacity: a declaration
/// of the full 1 MiB accompanied by one byte must cost one byte of memory.
#[test]
fn a_large_declaration_holds_only_the_bytes_that_actually_arrived() {
    let mut r = Reassembler::default();
    let max = r.limits().max_message_body_bytes;
    r.accept(&frag(ID, 0, 2, max, b"a"), 0).unwrap();
    assert_eq!(
        r.buffered_bytes(),
        1,
        "memory tracked the claim, not the arrival"
    );
}

// ── bound 3: an index repeats ────────────────────────────────────────────

#[test]
fn a_repeated_index_is_refused_and_drops_the_set() {
    let mut r = Reassembler::default();
    r.accept(&frag(ID, 0, 3, 6, b"aa"), 0).unwrap();
    assert_eq!(
        r.accept(&frag(ID, 0, 3, 6, b"zz"), 0),
        Err(ReasmError::DuplicateIndex)
    );
    assert!(
        r.is_empty(),
        "a set fed a duplicate index must not stay resident"
    );
}

// ── bound 4: the summed chunk length would exceed total_bytes ────────────

/// Every declared field is legal here; only the bytes that actually arrive
/// overrun. This is the bound that has to hold when the declaration does not.
#[test]
fn chunks_summing_past_total_bytes_are_refused() {
    let mut r = Reassembler::default();
    r.accept(&frag(ID, 0, 2, 4, b"aa"), 0).unwrap();
    assert_eq!(
        r.accept(&frag(ID, 1, 2, 4, b"bbb"), 0),
        Err(ReasmError::LengthExceedsTotal)
    );
    assert!(r.is_empty());
}

#[test]
fn a_single_chunk_larger_than_the_whole_declaration_is_refused() {
    let mut r = Reassembler::default();
    assert_eq!(
        r.accept(&frag(ID, 0, 2, 2, b"aaaa"), 0),
        Err(ReasmError::LengthExceedsTotal)
    );
    assert!(r.is_empty());
}

#[test]
fn a_completed_set_short_of_its_declaration_is_refused_not_delivered_truncated() {
    let mut r = Reassembler::default();
    r.accept(&frag(ID, 0, 2, 8, b"aa"), 0).unwrap();
    assert_eq!(
        r.accept(&frag(ID, 1, 2, 8, b"bb"), 0),
        Err(ReasmError::TotalMismatch)
    );
    assert!(r.is_empty());
}

#[test]
fn a_completed_set_matching_its_declaration_exactly_is_delivered() {
    let mut r = Reassembler::default();
    r.accept(&frag(ID, 0, 2, 4, b"aa"), 0).unwrap();
    assert_eq!(
        r.accept(&frag(ID, 1, 2, 4, b"bb"), 0),
        Ok(Accepted::Complete(b"aabb".to_vec()))
    );
}

// ── bound 5: the set exceeds reassembly_lifetime_ms ──────────────────────

#[test]
fn a_set_older_than_the_reassembly_lifetime_is_refused_on_the_next_fragment() {
    let mut r = Reassembler::default();
    let life = r.limits().reassembly_lifetime_ms;
    r.accept(&frag(ID, 0, 2, 4, b"aa"), 1_000).unwrap();
    assert_eq!(
        r.accept(&frag(ID, 1, 2, 4, b"bb"), 1_000 + life + 1),
        Err(ReasmError::Expired)
    );
    assert!(
        r.is_empty(),
        "an expired set must be dropped, not merely reported"
    );
}

#[test]
fn a_set_exactly_at_the_reassembly_lifetime_is_still_inside_it() {
    let mut r = Reassembler::default();
    let life = r.limits().reassembly_lifetime_ms;
    r.accept(&frag(ID, 0, 2, 4, b"aa"), 1_000).unwrap();
    assert_eq!(
        r.accept(&frag(ID, 1, 2, 4, b"bb"), 1_000 + life),
        Ok(Accepted::Complete(b"aabb".to_vec()))
    );
}

/// Expiry is driven entirely by the `now_ms` the host passes in — there is no
/// clock in here to read, so a sweep at the same instant must change nothing.
#[test]
fn sweeping_drops_expired_sets_and_only_expired_sets() {
    let mut r = Reassembler::default();
    let life = r.limits().reassembly_lifetime_ms;
    r.accept(&frag("old", 0, 2, 4, b"aa"), 0).unwrap();
    r.accept(&frag("new", 0, 2, 4, b"aa"), life).unwrap();

    assert_eq!(r.sweep(life), 0, "time only advances when the host says so");
    assert_eq!(r.len(), 2);

    assert_eq!(r.sweep(life + 1), 1);
    assert_eq!(r.len(), 1);
}

// ── bound 6: concurrent sets exceed max_concurrent_reassemblies ──────────

/// THE ANTI-EVICTION RULE. At the cap the NEW set is refused; an attacker must
/// not be able to destroy other peers' in-progress transfers by starting sets.
#[test]
fn at_the_concurrency_cap_the_new_set_is_refused_and_no_existing_set_is_evicted() {
    let mut r = Reassembler::default();
    let cap = r.limits().max_concurrent_reassemblies;
    for i in 0..cap {
        let id = format!("set-{i}");
        r.accept(&frag(&id, 0, 2, 4, b"aa"), 0).unwrap();
    }
    assert_eq!(
        r.accept(&frag("attacker", 0, 2, 4, b"aa"), 0),
        Err(ReasmError::TooManyConcurrent)
    );
    assert_eq!(
        r.len(),
        cap,
        "an existing transfer was evicted to admit a new one"
    );

    // Every victim can still finish.
    for i in 0..cap {
        let id = format!("set-{i}");
        assert_eq!(
            r.accept(&frag(&id, 1, 2, 4, b"bb"), 0),
            Ok(Accepted::Complete(b"aabb".to_vec()))
        );
    }
}

/// The cap must not be held closed by sets nobody is going to finish.
#[test]
fn expired_sets_release_their_concurrency_slot() {
    let mut r = Reassembler::default();
    let life = r.limits().reassembly_lifetime_ms;
    let cap = r.limits().max_concurrent_reassemblies;
    for i in 0..cap {
        r.accept(&frag(&format!("set-{i}"), 0, 2, 4, b"aa"), 0)
            .unwrap();
    }
    assert_eq!(
        r.accept(&frag("late", 0, 2, 4, b"aa"), life + 1),
        Ok(Accepted::Pending)
    );
    assert_eq!(r.len(), 1);
}

#[test]
fn dropping_a_set_frees_its_slot_immediately() {
    let mut r = Reassembler::default();
    r.accept(&frag(ID, 0, 2, 4, b"aa"), 0).unwrap();
    assert!(r.drop_set(ID));
    assert!(!r.drop_set(ID));
    assert!(r.is_empty());
}

// ── structural checks on the fragment's own fields ───────────────────────

#[test]
fn an_index_at_or_above_total_is_refused() {
    let mut r = Reassembler::default();
    assert_eq!(
        r.accept(
            &Fragment {
                fragment_id: ID,
                index: 2,
                total: 2,
                total_bytes: 4,
                chunk: b"aa",
                last: true
            },
            0
        ),
        Err(ReasmError::IndexOutOfRange)
    );
    assert!(r.is_empty());
}

#[test]
fn a_total_of_zero_is_refused() {
    let mut r = Reassembler::default();
    assert_eq!(
        r.accept(
            &Fragment {
                fragment_id: ID,
                index: 0,
                total: 0,
                total_bytes: 4,
                chunk: b"aa",
                last: true
            },
            0
        ),
        Err(ReasmError::TotalZero)
    );
}

/// `last` is redundant with index/total. A redundant field allowed to disagree
/// is a parser differential: one side completes on the flag, another on the
/// count, and both call the frame valid.
#[test]
fn a_last_flag_disagreeing_with_index_and_total_is_refused() {
    let mut r = Reassembler::default();
    let claims_last = Fragment {
        fragment_id: ID,
        index: 0,
        total: 3,
        total_bytes: 6,
        chunk: b"aa",
        last: true,
    };
    assert_eq!(
        r.accept(&claims_last, 0),
        Err(ReasmError::LastFlagInconsistent)
    );

    let denies_last = Fragment {
        fragment_id: ID,
        index: 2,
        total: 3,
        total_bytes: 6,
        chunk: b"aa",
        last: false,
    };
    assert_eq!(
        r.accept(&denies_last, 0),
        Err(ReasmError::LastFlagInconsistent)
    );
    assert!(r.is_empty());
}

/// Re-declaring a set's shape mid-flight would let a peer raise `total_bytes`
/// after the check that bounded it had already passed.
#[test]
fn a_fragment_redeclaring_the_sets_shape_is_refused() {
    let mut r = Reassembler::default();
    r.accept(&frag(ID, 0, 2, 4, b"aa"), 0).unwrap();
    assert_eq!(
        r.accept(&frag(ID, 1, 2, 1024, b"bb"), 0),
        Err(ReasmError::DeclarationChanged)
    );
    assert!(r.is_empty());
}

/// The peer is told one thing — FRAGMENT_INVALID — whichever bound bound. The
/// variant is for our log, not the peer's search space.
#[test]
fn every_refusal_maps_to_fragment_invalid() {
    for e in [
        ReasmError::TotalZero,
        ReasmError::TooManyFragments,
        ReasmError::TotalBytesOverMax,
        ReasmError::IndexOutOfRange,
        ReasmError::LastFlagInconsistent,
        ReasmError::DuplicateIndex,
        ReasmError::LengthExceedsTotal,
        ReasmError::TotalMismatch,
        ReasmError::DeclarationChanged,
        ReasmError::Expired,
        ReasmError::TooManyConcurrent,
    ] {
        assert_eq!(e.error_code(), 9, "{} is not FRAGMENT_INVALID", e.as_str());
    }
}

/// Sets are independent: one peer's abuse must not disturb another's transfer.
#[test]
fn a_refused_fragment_does_not_disturb_other_sets() {
    let mut r = Reassembler::default();
    r.accept(&frag("good", 0, 2, 4, b"aa"), 0).unwrap();
    let _ = r.accept(&frag("bad", 0, 2, 2, b"aaaa"), 0);
    assert_eq!(
        r.accept(&frag("good", 1, 2, 4, b"bb"), 0),
        Ok(Accepted::Complete(b"aabb".to_vec()))
    );
}

// ── bounds the Go server advertises, which Rust did not enforce ─────────────

/// The session-wide budget. `buffered_bytes()` existed and nothing consulted
/// it, so the real ceiling was max_concurrent_reassemblies x
/// max_message_body_bytes = 8 MiB — four times the 2 MiB the Go server puts in
/// ServerHello (capabilities.proto Limits field 6), reachable with fragments
/// that are individually legal on both sides. Go enforced it; Rust did not, so
/// a client accepted by one server was refused by the other.
#[test]
fn session_budget_is_enforced_not_just_advertised() {
    let mut r = Reassembler::default();
    let chunk = vec![0u8; 524_288]; // 512 KiB
    let mut accepted = 0usize;
    let mut refused = false;

    for n in 0..8 {
        let id = format!("s{}", n);
        let f = frag(&id, 0, 2, 1_048_576, &chunk);
        match r.accept(&f, 0) {
            Ok(_) => accepted += 1,
            Err(ReasmError::SessionBudget) => {
                refused = true;
                break;
            }
            Err(e) => panic!("unexpected refusal: {:?}", e),
        }
    }

    assert!(
        refused,
        "eight 512 KiB chunks were all accepted — that is 4 MiB held \
        against an advertised budget of 2 MiB, and nothing refused it"
    );
    assert!(
        r.buffered_bytes() <= 2_097_152,
        "session holds {} bytes, over the advertised max_reassembly_bytes",
        r.buffered_bytes()
    );
    assert!(
        accepted > 0,
        "the budget must admit work, not refuse everything"
    );
}

/// Sets are keyed by id, so an empty id merges unrelated transfers into one
/// set: fragment 0 of transfer A and fragment 0 of transfer B collide. Go
/// refuses it as "a correctness bug before it is a security one"; Rust accepted
/// it and did the merge.
#[test]
fn empty_fragment_id_is_refused() {
    let mut r = Reassembler::default();
    assert!(matches!(
        r.accept(&frag("", 0, 2, 8, b"aaaa"), 0),
        Err(ReasmError::IdRequired)
    ));
    assert_eq!(r.len(), 0, "a refused fragment must not open a set");
}

/// A zero-byte message is not a message. Nothing downstream refused it: an
/// empty chunk passes the length check, received(0) == total_bytes(0) completes
/// the set, and the empty payload reaches the frame decoder having already
/// consumed one of the eight slots.
#[test]
fn zero_total_bytes_is_refused_before_a_slot_is_taken() {
    let mut r = Reassembler::default();
    let f = Fragment {
        fragment_id: "z",
        index: 0,
        total: 1,
        total_bytes: 0,
        chunk: b"",
        last: true,
    };
    assert!(matches!(r.accept(&f, 0), Err(ReasmError::TotalZero)));
    assert_eq!(
        r.len(),
        0,
        "the refused set still consumed a concurrency slot"
    );
}
