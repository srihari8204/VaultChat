//! Scheduling policy.
//!
//! The questions here — "can bulk starve control", "can a message overtake the
//! key update it depends on" — are normally answered by a soak run and a shrug.
//! `sched` is pure and takes its clock from the caller precisely so they can be
//! answered by assertions instead.

use transport_core::config::{MAX_FRAME_BYTES, MAX_QUEUED_BULK, MAX_QUEUED_CONTROL};
use transport_core::sched::{Class, Item, Reject, Sched};

fn item(class: Class, depends_on: u64, n: usize) -> Item {
    Item { class, depends_on, bytes: vec![0u8; n] }
}

/// The reason the module exists. A control frame queued last goes first.
#[test]
fn control_is_not_starved_by_bulk() {
    let mut s = Sched::new();
    for _ in 0..MAX_QUEUED_BULK {
        s.push(item(Class::Bulk, 0, 8)).unwrap();
    }
    s.push(item(Class::Message, 0, 8)).unwrap();
    s.push(item(Class::Control, 0, 8)).unwrap();

    assert_eq!(s.pop().unwrap().class, Class::Control);
    assert_eq!(s.pop().unwrap().class, Class::Message);
    assert_eq!(s.pop().unwrap().class, Class::Bulk);
}

/// THE INVARIANT. Priority must not be the mechanism that lets a frame overtake
/// its own prerequisite — an unmet dependency is NOT ELIGIBLE, not merely late.
#[test]
fn a_dependency_outranks_priority() {
    let mut s = Sched::new();
    s.push(item(Class::Control, 7, 8)).unwrap();   // urgent, but depends on epoch 7
    s.push(item(Class::Bulk, 0, 8)).unwrap();      // lowly, but ready

    assert_eq!(s.pop().unwrap().class, Class::Bulk, "a blocked control frame was sent anyway");
    assert!(s.pop().is_none(), "the blocked frame was released without its epoch");
    assert_eq!(s.blocked(), 1);
    assert!(!s.is_empty(), "None must not be mistaken for empty");

    s.set_applied_epoch(7);
    assert_eq!(s.pop().unwrap().class, Class::Control);
    assert_eq!(s.blocked(), 0);
}

/// Rewinding would re-block frames that have already gone out.
#[test]
fn the_applied_epoch_only_moves_forward() {
    let mut s = Sched::new();
    s.set_applied_epoch(9);
    s.set_applied_epoch(4);
    assert_eq!(s.applied_epoch(), 9);
}

/// Backpressure is reported, never silent — except for ephemeral, where the
/// newest typing state is the only one with any value.
#[test]
fn full_lanes_reject_but_ephemeral_sheds() {
    let mut s = Sched::new();
    for _ in 0..MAX_QUEUED_CONTROL {
        s.push(item(Class::Control, 0, 8)).unwrap();
    }
    assert_eq!(s.push(item(Class::Control, 0, 8)), Err(Reject::ClassFull));

    let mut e = Sched::new();
    for i in 0..200 {
        e.push(Item { class: Class::Ephemeral, depends_on: 0, bytes: vec![i as u8] })
            .expect("ephemeral must shed, never refuse");
    }
    assert!(e.shed > 0, "a shallow lane that never sheds is just a deep lane");
    assert_eq!(e.pop().unwrap().bytes[0], (200 - 64) as u8, "the OLDEST must be the one dropped");
}

/// Depth bounds alone let many shallow lanes add up to unbounded memory.
#[test]
fn the_global_byte_budget_binds_across_lanes() {
    let mut s = Sched::new();
    let mut pushed = 0usize;
    loop {
        match s.push(item(Class::Message, 0, 64 * 1024)) {
            Ok(()) => pushed += 1,
            Err(r) => {
                assert_eq!(r, Reject::BytesFull, "depth ran out before bytes did");
                break;
            }
        }
        assert!(pushed < 10_000, "the byte budget never bound");
    }
    assert!(s.queued_bytes() <= transport_core::config::MAX_QUEUED_BYTES);
}

/// Oversized is a caller bug, not congestion, and must not read as backpressure.
#[test]
fn an_oversized_item_is_distinguishable_from_a_full_queue() {
    let mut s = Sched::new();
    assert_eq!(s.push(item(Class::Message, 0, MAX_FRAME_BYTES + 1)), Err(Reject::TooLarge));
    assert!(s.is_empty());
}

/// A rejected push must not have charged the budget on its way out.
#[test]
fn a_rejected_push_leaks_no_bytes() {
    let mut s = Sched::new();
    for _ in 0..MAX_QUEUED_BULK {
        s.push(item(Class::Bulk, 0, 100)).unwrap();
    }
    let before = s.queued_bytes();
    let _ = s.push(item(Class::Bulk, 0, 100));
    let _ = s.push(item(Class::Message, 0, MAX_FRAME_BYTES + 1));
    assert_eq!(s.queued_bytes(), before);

    while s.pop().is_some() {}
    assert_eq!(s.queued_bytes(), 0, "the byte counter drifts — the budget would shrink over time");
}
