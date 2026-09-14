//! Durable work: what the transport asks the HOST to persist.
//!
//! This crate cannot open a database — that is stated at the crate root and
//! enforced by the absence of any DB dependency in Cargo.toml. So durable work
//! is REQUESTED through a narrow interface the host implements, and this module
//! defines that interface plus the pure bookkeeping around it.
//!
//! WHY A TRAIT AND NOT A DB HANDLE: the message store holds plaintext. A
//! transport that can read it is a transport that has to be reviewed as though
//! it were the message store. Requesting "persist these bytes under this key"
//! keeps that review boundary intact. Nothing in this file implements the
//! trait — there is no in-crate store, not even a "temporary" one, because the
//! first implementation that touches a disk is the one that moves the review
//! boundary. The test double lives in `tests/work.rs`, on the far side of the
//! crate wall, where it cannot be linked into a shipped artifact.
//!
//! THE INVARIANT: a frame is not "sent" until the host confirms it durable.
//! An outbound frame that was handed to a socket and then lost to a crash must
//! still be in the queue on restart — which means acknowledgement is the ONLY
//! thing that may remove it, never the act of writing it to a connection.
//!
//! That invariant is STRUCTURAL here, not documentary: `Outbox` exposes no
//! method that yields an owned record. Writing a frame goes through `next()`,
//! which hands back a shared borrow the caller cannot take the payload out of,
//! and `mark_written()`, which only sets a flag. The single code path that
//! removes anything is `ack()`, and `ack()` cannot run without the host's
//! `confirm` returning Ok. There is no way to spell "send and forget".
//!
//! PURE: no I/O of its own, no async, no clock — `now_ms` arrives from the host.

use crate::config::{MAX_QUEUED_MESSAGE, REPLAY_BATCH};

/// Why a durable-work request failed.
///
/// The host's own failure is one variant, opaque on purpose: this crate must
/// not learn the shape of the host's storage errors, because a transport that
/// can pattern-match on "row locked" is a transport that has opinions about a
/// database it is not allowed to open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkError {
    /// The host could not satisfy the request. Not retried here; the host owns
    /// its own retry policy along with its storage.
    HostFailed,
    /// The in-memory record is at its bound. Reported, never a silent drop —
    /// a dropped outbound frame is the data loss this module exists to prevent.
    Full,
    /// No pending record under that key.
    UnknownKey,
    /// A key already pending. Refused rather than overwritten: overwriting
    /// would erase an unconfirmed frame, which is exactly the loss the
    /// invariant forbids.
    DuplicateKey,
}

impl WorkError {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkError::HostFailed => "HOST_FAILED",
            WorkError::Full => "FULL",
            WorkError::UnknownKey => "UNKNOWN_KEY",
            WorkError::DuplicateKey => "DUPLICATE_KEY",
        }
    }
}

/// One replayed record as the host hands it over: `(key, payload)`, both
/// opaque. Named so the trait signature stays readable.
pub type StoredWork = (Vec<u8>, Vec<u8>);

/// The narrow interface the HOST implements.
///
/// Keys and payloads are opaque bytes in both directions. This crate never
/// interprets either — a key is whatever the host can index on, and a payload
/// is an already-framed, already-sealed frame. There is no method to read a
/// message, list a conversation, or query anything: the only reads are
/// `replay`, which returns work this transport itself asked to have persisted.
///
/// `Debug` is a supertrait so the bookkeeping that owns an implementation can
/// derive `Debug` under the crate's `deny(missing_debug_implementations)`.
pub trait DurableWork: core::fmt::Debug {
    /// Persist `payload` under `key`. Returning `Ok` is the host's statement
    /// that the bytes will survive a crash — the whole invariant rests on it.
    fn persist(&mut self, key: &[u8], payload: &[u8]) -> Result<(), WorkError>;

    /// Forget `key`. Called only after the peer acknowledged the frame, so the
    /// window in which a frame exists nowhere is never opened.
    fn confirm(&mut self, key: &[u8]) -> Result<(), WorkError>;

    /// Up to `limit` records that were persisted and never confirmed, oldest
    /// first. Bounded by the caller so a long offline period drains in steady
    /// passes rather than one unbounded read.
    fn replay(&mut self, limit: usize) -> Result<Vec<StoredWork>, WorkError>;
}

/// One frame that is durable and not yet acknowledged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub key: Vec<u8>,
    pub payload: Vec<u8>,
    /// Written to a connection at least once. A hint for scheduling ONLY: it
    /// never removes the record and is cleared wholesale on reconnect, because
    /// "written" and "received" are different claims and only the peer can make
    /// the second one.
    pub written: bool,
    /// When it was last written, from the host's clock. Zero means never.
    pub written_ms: u64,
}

/// The in-memory record of what has been persisted and not yet confirmed.
///
/// One per connection, matching `sched`: a per-conversation outbox would mean N
/// independent depth bounds and therefore no bound.
#[derive(Debug)]
pub struct Outbox<W: DurableWork> {
    host: W,
    pending: Vec<Record>,
}

impl<W: DurableWork> Outbox<W> {
    pub fn new(host: W) -> Self {
        Outbox { host, pending: Vec::new() }
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Read-only view of everything still awaiting acknowledgement.
    pub fn pending(&self) -> &[Record] {
        &self.pending
    }

    /// Shared borrow of the host adapter. Shared, not mutable: every write to
    /// the store goes through the methods above, so the queue and the store
    /// cannot be made to disagree from outside.
    pub fn host(&self) -> &W {
        &self.host
    }

    /// Ask the host to persist a frame, then record it.
    ///
    /// ORDER IS LOAD-BEARING: the host commits FIRST. Recording it locally
    /// first and persisting after would leave a frame the transport believes is
    /// durable and the disk has never seen — the exact state a crash turns into
    /// a lost message.
    pub fn submit(&mut self, key: &[u8], payload: &[u8]) -> Result<(), WorkError> {
        if self.pending.iter().any(|r| r.key == key) {
            return Err(WorkError::DuplicateKey);
        }
        if self.pending.len() >= MAX_QUEUED_MESSAGE {
            return Err(WorkError::Full);
        }
        self.host.persist(key, payload)?;
        self.pending.push(Record {
            key: key.to_vec(),
            payload: payload.to_vec(),
            written: false,
            written_ms: 0,
        });
        Ok(())
    }

    /// The next frame to write, oldest first, skipping ones already in flight.
    ///
    /// Returns a SHARED BORROW. That is the structural half of the invariant:
    /// there is no `pop`, no `take`, no `drain` — the caller can copy the bytes
    /// onto a socket but cannot remove the record while doing so.
    pub fn next(&self) -> Option<&Record> {
        self.pending.iter().find(|r| !r.written)
    }

    /// Note that a frame went to a connection.
    ///
    /// THIS DOES NOT SEND ANYTHING AND IT DOES NOT REMOVE ANYTHING. It moves a
    /// record out of `next()`'s view so the same frame is not written twice in
    /// one connection, and nothing else.
    pub fn mark_written(&mut self, key: &[u8], now_ms: u64) -> Result<(), WorkError> {
        let r = self
            .pending
            .iter_mut()
            .find(|r| r.key == key)
            .ok_or(WorkError::UnknownKey)?;
        r.written = true;
        r.written_ms = now_ms;
        Ok(())
    }

    /// The peer acknowledged the frame: release it.
    ///
    /// The ONLY path that removes a record, and it removes nothing unless the
    /// host's `confirm` succeeds — a failed confirm leaves the frame pending so
    /// the next pass retries it, which is a duplicate at worst. A lost message
    /// is not recoverable; a duplicate is.
    pub fn ack(&mut self, key: &[u8]) -> Result<(), WorkError> {
        let i = self
            .pending
            .iter()
            .position(|r| r.key == key)
            .ok_or(WorkError::UnknownKey)?;
        self.host.confirm(key)?;
        self.pending.remove(i);
        Ok(())
    }

    /// A connection died. Everything written but unacknowledged becomes
    /// writable again.
    ///
    /// This is what makes `written` safe to be a hint: the transport never has
    /// to decide whether a frame made it: on reconnect the answer is assumed to
    /// be no, and the peer deduplicates.
    pub fn reset_written(&mut self) {
        for r in &mut self.pending {
            r.written = false;
            r.written_ms = 0;
        }
    }

    /// Reload unconfirmed work from the host after a restart.
    ///
    /// `limit` is clamped to `REPLAY_BATCH` and to the remaining in-memory
    /// budget, so a host with a large backlog cannot hand this crate more than
    /// it agreed to hold. Returns how many records were taken up; the caller
    /// loops until it returns zero.
    pub fn replay(&mut self, limit: usize) -> Result<usize, WorkError> {
        let room = MAX_QUEUED_MESSAGE.saturating_sub(self.pending.len());
        let n = limit.min(REPLAY_BATCH).min(room);
        if n == 0 {
            return Ok(0);
        }
        let mut taken = 0usize;
        for (key, payload) in self.host.replay(n)? {
            if self.pending.iter().any(|r| r.key == key) {
                continue;
            }
            self.pending.push(Record { key, payload, written: false, written_ms: 0 });
            taken += 1;
        }
        Ok(taken)
    }
}
