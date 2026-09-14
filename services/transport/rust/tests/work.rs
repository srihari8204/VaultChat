//! Durable work bookkeeping.
//!
//! The question here — "can a frame be lost between the socket and the disk" —
//! is normally answered by pulling a power cable. `Outbox` is pure and takes its
//! store from the caller precisely so it can be answered by assertions.
//!
//! The test double lives HERE, not in `src`, because a crate that ships an
//! implementation of `DurableWork` is a crate that has to be reviewed as though
//! it were the message store.

use transport_core::config::REPLAY_BATCH;
use transport_core::work::{DurableWork, Outbox, StoredWork, WorkError};

/// An in-memory stand-in for the host's store. `persisted` is what would
/// survive a crash; `confirmed` records what the host was told to forget.
#[derive(Debug, Default)]
struct FakeStore {
    persisted: Vec<StoredWork>,
    confirmed: Vec<Vec<u8>>,
    /// Set to make the next call fail, so the failure paths are reachable.
    fail_persist: bool,
    fail_confirm: bool,
}

impl FakeStore {
    fn holds(&self, key: &[u8]) -> bool {
        self.persisted.iter().any(|(k, _)| k == key)
    }
}

impl DurableWork for FakeStore {
    fn persist(&mut self, key: &[u8], payload: &[u8]) -> Result<(), WorkError> {
        if self.fail_persist {
            return Err(WorkError::HostFailed);
        }
        self.persisted.push((key.to_vec(), payload.to_vec()));
        Ok(())
    }

    fn confirm(&mut self, key: &[u8]) -> Result<(), WorkError> {
        if self.fail_confirm {
            return Err(WorkError::HostFailed);
        }
        self.persisted.retain(|(k, _)| k != key);
        self.confirmed.push(key.to_vec());
        Ok(())
    }

    fn replay(&mut self, limit: usize) -> Result<Vec<StoredWork>, WorkError> {
        Ok(self.persisted.iter().take(limit).cloned().collect())
    }
}

fn outbox() -> Outbox<FakeStore> {
    Outbox::new(FakeStore::default())
}

/// THE INVARIANT. Writing a frame to a connection is not sending it: only the
/// peer's acknowledgement may remove it from the queue.
#[test]
fn writing_a_frame_does_not_remove_it_only_acknowledgement_does() {
    let mut o = outbox();
    o.submit(b"k1", b"frame").unwrap();

    let next = o.next().expect("a submitted frame must be writable");
    assert_eq!(next.payload, b"frame");
    o.mark_written(b"k1", 1_000).unwrap();

    assert_eq!(o.len(), 1, "a written frame left the queue — a crash now loses it");
    assert!(o.next().is_none(), "an in-flight frame must not be handed out twice");

    o.ack(b"k1").unwrap();
    assert!(o.is_empty());
}

/// The API must make the mistake unspellable, not merely discouraged: there is
/// no method that yields an owned record, so "send and forget" cannot be
/// written by accident. This test pins the shape `next()` returns.
#[test]
fn the_only_view_of_a_pending_frame_is_a_borrow() {
    let mut o = outbox();
    o.submit(b"k1", b"frame").unwrap();
    let r: &transport_core::work::Record = o.next().unwrap();
    assert_eq!(r.key, b"k1");
    assert!(!r.written);
    assert_eq!(o.pending().len(), 1);
}

/// A connection died mid-write. The frame becomes writable again — the
/// transport never has to guess whether it arrived, and the peer deduplicates.
#[test]
fn a_dropped_connection_makes_written_frames_writable_again() {
    let mut o = outbox();
    o.submit(b"k1", b"a").unwrap();
    o.submit(b"k2", b"b").unwrap();
    o.mark_written(b"k1", 10).unwrap();
    o.mark_written(b"k2", 20).unwrap();
    assert!(o.next().is_none());

    o.reset_written();
    assert_eq!(o.next().unwrap().key, b"k1", "oldest first after a reconnect");
    assert_eq!(o.pending()[0].written_ms, 0);
}

/// The host commits first. A frame the transport believes is durable but the
/// store has never seen is exactly the state a crash turns into a lost message.
#[test]
fn a_frame_the_host_could_not_persist_is_never_queued() {
    let mut o = Outbox::new(FakeStore { fail_persist: true, ..Default::default() });
    assert_eq!(o.submit(b"k1", b"a"), Err(WorkError::HostFailed));
    assert!(o.is_empty(), "an unpersisted frame was queued as though it were durable");
    assert!(o.next().is_none());
}

/// A failed confirm keeps the frame pending. Duplicates are recoverable; a
/// frame dropped from both the queue and the store is not.
#[test]
fn a_failed_confirm_leaves_the_frame_pending() {
    let mut o = Outbox::new(FakeStore { fail_confirm: true, ..Default::default() });
    o.submit(b"k1", b"a").unwrap();
    assert_eq!(o.ack(b"k1"), Err(WorkError::HostFailed));
    assert_eq!(o.len(), 1);
}

/// Overwriting a key would erase an unconfirmed frame — the loss the invariant
/// exists to forbid.
#[test]
fn a_duplicate_key_is_refused_rather_than_overwriting_unconfirmed_work() {
    let mut o = outbox();
    o.submit(b"k1", b"first").unwrap();
    assert_eq!(o.submit(b"k1", b"second"), Err(WorkError::DuplicateKey));
    assert_eq!(o.pending()[0].payload, b"first");
}

#[test]
fn acknowledging_an_unknown_key_is_reported_not_ignored() {
    let mut o = outbox();
    assert_eq!(o.ack(b"nope"), Err(WorkError::UnknownKey));
    assert_eq!(o.mark_written(b"nope", 1), Err(WorkError::UnknownKey));
}

/// Restart: the host still holds what was never acknowledged, and it comes back.
#[test]
fn unconfirmed_work_survives_a_restart_and_replays() {
    let mut store = FakeStore::default();
    store.persist(b"k1", b"a").unwrap();
    store.persist(b"k2", b"b").unwrap();

    let mut o = Outbox::new(store);
    assert_eq!(o.replay(REPLAY_BATCH).unwrap(), 2);
    assert_eq!(o.next().unwrap().key, b"k1");

    // Replaying twice must not duplicate work already held.
    assert_eq!(o.replay(REPLAY_BATCH).unwrap(), 0);
    assert_eq!(o.len(), 2);
}

/// A host with a large backlog must not be able to hand this crate more than it
/// agreed to hold in one pass.
#[test]
fn replay_is_bounded_by_the_batch_size_however_much_the_host_offers() {
    let mut store = FakeStore::default();
    for i in 0..(REPLAY_BATCH * 3) {
        store.persist(format!("k{i}").as_bytes(), b"x").unwrap();
    }
    let mut o = Outbox::new(store);
    assert_eq!(o.replay(usize::MAX).unwrap(), REPLAY_BATCH);
    assert_eq!(o.len(), REPLAY_BATCH);
}

/// End to end: what the host is left holding is exactly what was never
/// acknowledged, and nothing the transport merely wrote.
#[test]
fn the_store_holds_exactly_the_unacknowledged_frames() {
    let mut o = outbox();
    for i in 0..5u8 {
        o.submit(&[i], b"frame").unwrap();
    }
    // Write all five, acknowledge two.
    let keys: Vec<Vec<u8>> = o.pending().iter().map(|r| r.key.clone()).collect();
    for k in &keys {
        o.mark_written(k, 1).unwrap();
    }
    o.ack(&keys[0]).unwrap();
    o.ack(&keys[3]).unwrap();

    assert_eq!(o.len(), 3);
    for (i, k) in keys.iter().enumerate() {
        let unacked = i != 0 && i != 3;
        assert_eq!(o.pending().iter().any(|r| &r.key == k), unacked);
        assert_eq!(o.host().holds(k), unacked, "the store disagrees with the queue");
    }
    assert_eq!(o.host().confirmed, vec![keys[0].clone(), keys[3].clone()]);
}
