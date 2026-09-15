//! Outbound scheduling: priority classes, bounded queues, backpressure.
//!
//! PURE DECISIONS. No I/O, no async, no clock of its own — time is passed in.
//! That is what makes the policy testable: "does bulk starve control" is a
//! question you can answer with a unit test instead of a soak run.
//!
//! THE INVARIANT THIS FILE ENFORCES, from the design:
//!   A high-priority frame must never overtake the key update or membership
//!   change it depends on.
//!
//! Priority alone does not give you that — priority is exactly the mechanism
//! that would let a message jump ahead of its own prerequisite. So ordering is
//! two-level: causal dependency is checked FIRST and is absolute, priority only
//! breaks ties among frames that are already safe to send. A frame whose
//! `depends_on` epoch has not yet been applied is not "low priority", it is
//! NOT ELIGIBLE, however urgent it claims to be.

use crate::config::{MAX_QUEUED_BULK, MAX_QUEUED_BYTES, MAX_QUEUED_CONTROL, MAX_QUEUED_MESSAGE};

/// Traffic class. Order matters: `Control` is the highest.
///
/// Mirrors `TrafficClass` in `proto/ccwire/v1/envelope.proto`. `Ephemeral` is
/// last because it is the only class that may be dropped outright — typing and
/// viewer state are worth nothing once stale, so shedding them under pressure
/// is correct behaviour rather than data loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Class {
    Control = 0,
    Message = 1,
    Sync = 2,
    Bulk = 3,
    Ephemeral = 4,
}

/// Why an enqueue was refused. Backpressure is a REPORTED condition, never a
/// silent drop — the host decides what to tell the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    /// That class is at its depth bound.
    ClassFull,
    /// The global byte budget is exhausted, whatever the class depth says.
    BytesFull,
    /// Larger than a single frame may ever be — a caller bug, not congestion.
    TooLarge,
}

/// One queued outbound item. `bytes` is already framed and sealed; this module
/// never sees plaintext and has no way to ask for any.
#[derive(Debug, Clone)]
pub struct Item {
    pub class: Class,
    /// Causal prerequisite: the epoch this frame was produced under. Zero means
    /// no dependency. See the invariant in the module header.
    pub depends_on: u64,
    pub bytes: Vec<u8>,
}

/// Bounded, priority-ordered outbound queue.
///
/// Deliberately ONE queue object for the whole connection, not one per
/// conversation: the design forbids per-conversation runtimes, connections or
/// tasks, and a per-chat queue is the same mistake wearing a different hat —
/// N chats would mean N independent depth bounds and no global byte budget.
#[derive(Debug, Default)]
pub struct Sched {
    control: Vec<Item>,
    message: Vec<Item>,
    sync: Vec<Item>,
    bulk: Vec<Item>,
    ephemeral: Vec<Item>,
    bytes: usize,
    /// Highest causal epoch the peer has confirmed applied. Frames depending on
    /// anything above this are held.
    applied_epoch: u64,
    /// Ephemeral frames shed under pressure. Reported, never hidden.
    pub shed: u64,
}

impl Sched {
    pub fn new() -> Self {
        Self::default()
    }

    fn lane(&mut self, c: Class) -> &mut Vec<Item> {
        match c {
            Class::Control => &mut self.control,
            Class::Message => &mut self.message,
            Class::Sync => &mut self.sync,
            Class::Bulk => &mut self.bulk,
            Class::Ephemeral => &mut self.ephemeral,
        }
    }

    fn cap(c: Class) -> usize {
        match c {
            Class::Control => MAX_QUEUED_CONTROL,
            Class::Message | Class::Sync => MAX_QUEUED_MESSAGE,
            Class::Bulk => MAX_QUEUED_BULK,
            // Ephemeral is intentionally shallow: stale typing state has no
            // value, so a deep queue of it is pure latency.
            Class::Ephemeral => 64,
        }
    }

    pub fn len(&self) -> usize {
        self.control.len()
            + self.message.len()
            + self.sync.len()
            + self.bulk.len()
            + self.ephemeral.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn queued_bytes(&self) -> usize {
        self.bytes
    }

    /// Record that the peer has applied everything up to `epoch`, releasing any
    /// frame that was waiting on it. Monotonic: a lower value is ignored rather
    /// than rewinding, because rewinding would re-block frames already sent.
    pub fn set_applied_epoch(&mut self, epoch: u64) {
        if epoch > self.applied_epoch {
            self.applied_epoch = epoch;
        }
    }

    pub fn applied_epoch(&self) -> u64 {
        self.applied_epoch
    }

    /// Enqueue, or report why not.
    ///
    /// Ephemeral is the one class that sheds instead of rejecting: when its lane
    /// is full the OLDEST item is dropped, because the newest typing state is
    /// the only one worth sending. Every other class refuses and lets the host
    /// decide.
    pub fn push(&mut self, item: Item) -> Result<(), Reject> {
        if item.bytes.len() > crate::config::MAX_FRAME_BYTES {
            return Err(Reject::TooLarge);
        }
        if item.class == Class::Ephemeral {
            let cap = Self::cap(Class::Ephemeral);
            let lane = self.lane(Class::Ephemeral);
            if lane.len() >= cap {
                let old = lane.remove(0);
                self.bytes -= old.bytes.len();
                self.shed += 1;
            }
        } else if self.lane(item.class).len() >= Self::cap(item.class) {
            return Err(Reject::ClassFull);
        }

        if self.bytes + item.bytes.len() > MAX_QUEUED_BYTES {
            return Err(Reject::BytesFull);
        }

        self.bytes += item.bytes.len();
        self.lane(item.class).push(item);
        Ok(())
    }

    /// Next frame to send, or None when nothing is ELIGIBLE.
    ///
    /// None does not mean empty: frames may be present but blocked on a causal
    /// dependency. `blocked()` distinguishes the two, because "idle" and
    /// "waiting on a key update" need different handling upstairs.
    pub fn pop(&mut self) -> Option<Item> {
        for c in [
            Class::Control,
            Class::Message,
            Class::Sync,
            Class::Bulk,
            Class::Ephemeral,
        ] {
            let applied = self.applied_epoch;
            let lane = self.lane(c);
            if let Some(i) = lane.iter().position(|it| it.depends_on <= applied) {
                let item = lane.remove(i);
                self.bytes -= item.bytes.len();
                return Some(item);
            }
        }
        None
    }

    /// Frames present but held by an unmet causal dependency.
    pub fn blocked(&self) -> usize {
        let a = self.applied_epoch;
        [
            &self.control,
            &self.message,
            &self.sync,
            &self.bulk,
            &self.ephemeral,
        ]
        .iter()
        .map(|l| l.iter().filter(|it| it.depends_on > a).count())
        .sum()
    }
}
