//! Fragment reassembly, bounded on four axes at once.
//!
//! CONTRACT (proto/ccwire/v1/envelope.proto, Fragment):
//!   Refuse with ERROR_CODE_FRAGMENT_INVALID if:
//!     total > max_fragments_per_message (16)
//!     total_bytes > max_message_body_bytes (1 MiB)
//!     an index repeats
//!     the summed chunk length would exceed total_bytes
//!     the set exceeds reassembly_lifetime_ms (30 s)
//!     concurrent sets exceed max_concurrent_reassemblies (8)
//!
//! WHY FOUR BOUNDS AND NOT ONE: each alone is evadable. Bound only the count
//! and each chunk is huge. Bound only total bytes and a thousand one-byte sets
//! sit in memory forever. Bound only concurrency and one set never completes.
//! Bound only time and a burst exhausts memory inside the window. They are
//! simultaneous because the attacks are.
//!
//! `total_bytes` is DECLARED UP FRONT and checked BEFORE allocation — the same
//! rule frame.rs and parse.rs follow. A reassembler that sizes a buffer from a
//! peer's claim is the memory-exhaustion bug this whole layer exists to prevent.
//! Nothing here ever reserves `total_bytes`; only bytes that actually arrived
//! are held, and the running sum is bounded against the declaration as it grows.
//!
//! ORDER OF CHECKS IS LOAD-BEARING, as in frame.rs and parse.rs: every bound
//! that can be decided from the fragment's own declared fields is decided first,
//! before the set map is touched, before a slot is taken and before a single
//! chunk byte is copied. A rejected fragment must cost nothing but the compare.
//!
//! PURE: time is passed in as `now_ms`. Reassembly holds opaque bytes only —
//! this module has no idea what a chunk contains and must not learn.

/// Reassembly bounds, from `proto/ccwire/v1/capabilities.proto`'s `Limits`.
///
/// Separate from `parse::Limits` because the two reassembly-only values
/// (`reassembly_lifetime_ms`, `max_concurrent_reassemblies`) are not part of
/// the codec's bound set; the two shared values carry the same numbers as
/// `parse::Limits::default()` and the parity test in `tests/reasm.rs` pins them
/// equal so the two cannot drift apart silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReasmLimits {
    pub max_fragments_per_message: u32,
    pub max_message_body_bytes: u64,
    pub reassembly_lifetime_ms: u64,
    pub max_concurrent_reassemblies: usize,
}

impl Default for ReasmLimits {
    fn default() -> Self {
        ReasmLimits {
            max_fragments_per_message: 16,
            max_message_body_bytes: 1_048_576,
            reassembly_lifetime_ms: 30_000,
            max_concurrent_reassemblies: 8,
        }
    }
}

/// Why a fragment was refused. A value, never a string — the caller decides
/// between dropping the fragment and dropping the connection, and that decision
/// must not depend on parsing prose. Same shape as `parse::CodecError`.
///
/// Every variant maps to ERROR_CODE_FRAGMENT_INVALID on the wire; the variant
/// exists so the local log says which bound bound, not so the peer learns more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasmError {
    /// `total` was zero. A set with no fragments is not representable.
    TotalZero,
    /// `total` > max_fragments_per_message.
    TooManyFragments,
    /// `total_bytes` > max_message_body_bytes. Checked against the DECLARATION,
    /// before anything is allocated on the strength of it.
    TotalBytesOverMax,
    /// `index` >= `total`.
    IndexOutOfRange,
    /// `last` disagrees with `index == total - 1`.
    LastFlagInconsistent,
    /// That index already arrived. Re-sending an index is how a peer would grow
    /// a set past its declared size while every individual fragment looks legal.
    DuplicateIndex,
    /// The chunk bytes that actually arrived would exceed `total_bytes`.
    LengthExceedsTotal,
    /// The set completed, but the bytes received are fewer than `total_bytes`.
    /// A short set is refused rather than delivered: the declaration is part of
    /// what the peer said, and a payload that does not match it is not the
    /// payload that was announced.
    TotalMismatch,
    /// A later fragment declared a different `total` or `total_bytes` than the
    /// one that opened the set. Not named in the proto's refusal list; refused
    /// anyway, which is the SAFER reading — accepting a re-declaration would let
    /// a peer raise `total_bytes` after the first check had already passed.
    DeclarationChanged,
    /// The set exceeded reassembly_lifetime_ms. The partial set is dropped.
    Expired,
    /// Concurrent sets are at max_concurrent_reassemblies.
    TooManyConcurrent,
}

impl ReasmError {
    pub fn as_str(self) -> &'static str {
        use ReasmError::*;
        match self {
            TotalZero => "TOTAL_ZERO",
            TooManyFragments => "TOO_MANY_FRAGMENTS",
            TotalBytesOverMax => "TOTAL_BYTES_OVER_MAX",
            IndexOutOfRange => "INDEX_OUT_OF_RANGE",
            LastFlagInconsistent => "LAST_FLAG_INCONSISTENT",
            DuplicateIndex => "DUPLICATE_INDEX",
            LengthExceedsTotal => "LENGTH_EXCEEDS_TOTAL",
            TotalMismatch => "TOTAL_MISMATCH",
            DeclarationChanged => "DECLARATION_CHANGED",
            Expired => "EXPIRED",
            TooManyConcurrent => "TOO_MANY_CONCURRENT",
        }
    }

    /// `errors.proto`: ERROR_CODE_FRAGMENT_INVALID. Kept beside the variant
    /// rather than in a second switch that could disagree with this one.
    pub fn error_code(self) -> u32 {
        9
    }
}

/// One `ccwire.v1.Fragment`, already decoded by `parse`. Borrows its input: a
/// fragment that is about to be refused must not have been copied first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fragment<'a> {
    pub fragment_id: &'a str,
    pub index: u32,
    pub total: u32,
    /// DECLARED BY THE PEER. A claim, never a capacity.
    pub total_bytes: u64,
    pub chunk: &'a [u8],
    pub last: bool,
}

/// What accepting a fragment did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Accepted {
    /// Held; the set is not complete yet.
    Pending,
    /// The set completed and is handed over. The reassembler no longer holds
    /// it, so the slot is free the moment the payload leaves.
    Complete(Vec<u8>),
}

#[derive(Debug)]
struct Set {
    total: u32,
    total_bytes: u64,
    started_ms: u64,
    /// Bytes that ACTUALLY arrived — never `total_bytes`.
    received: u64,
    /// `(index, chunk)` in arrival order, sorted only on completion. At most
    /// `total` entries, and `total` was bounded before this Vec existed.
    chunks: Vec<(u32, Vec<u8>)>,
}

/// Bounded fragment reassembler.
///
/// One object for the whole connection, matching `sched`: per-conversation
/// reassemblers would mean N independent concurrency caps and therefore no cap.
#[derive(Debug)]
pub struct Reassembler {
    limits: ReasmLimits,
    /// Linear map keyed by fragment_id. At most `max_concurrent_reassemblies`
    /// (8) entries, so a scan beats a hash table and brings no hash-collision
    /// attack surface with it.
    sets: Vec<(String, Set)>,
}

impl Default for Reassembler {
    fn default() -> Self {
        Reassembler::new(ReasmLimits::default())
    }
}

impl Reassembler {
    pub fn new(limits: ReasmLimits) -> Self {
        Reassembler { limits, sets: Vec::new() }
    }

    pub fn limits(&self) -> ReasmLimits {
        self.limits
    }

    /// Sets currently in progress.
    pub fn len(&self) -> usize {
        self.sets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sets.is_empty()
    }

    /// Bytes held across all in-progress sets. Bounded by
    /// max_concurrent_reassemblies * max_message_body_bytes (8 MiB) by
    /// construction, because each set's running sum is bounded by its own
    /// declaration and that declaration was bounded before the set opened.
    pub fn buffered_bytes(&self) -> u64 {
        self.sets.iter().map(|(_, s)| s.received).sum()
    }

    /// Drop every set older than reassembly_lifetime_ms. The host drives this
    /// from its own timer; nothing here reads a clock.
    ///
    /// Returns how many were dropped, so a host can report abandoned transfers
    /// instead of discovering them as a memory graph.
    pub fn sweep(&mut self, now_ms: u64) -> usize {
        let lifetime = self.limits.reassembly_lifetime_ms;
        let before = self.sets.len();
        self.sets.retain(|(_, s)| !expired(s.started_ms, now_ms, lifetime));
        before - self.sets.len()
    }

    /// Offer one fragment.
    ///
    /// CHECK ORDER: declared-field bounds → set lookup and expiry → concurrency
    /// → per-set consistency → copy. Nothing is stored, and no slot is taken,
    /// until every bound decidable without storage has passed.
    pub fn accept(&mut self, f: &Fragment<'_>, now_ms: u64) -> Result<Accepted, ReasmError> {
        // ── decided from the fragment alone, before the map is touched ──
        if f.total == 0 {
            return Err(ReasmError::TotalZero);
        }
        if f.total > self.limits.max_fragments_per_message {
            return Err(ReasmError::TooManyFragments);
        }
        if f.index >= f.total {
            return Err(ReasmError::IndexOutOfRange);
        }
        // `last` is redundant with index/total, and a redundant field that is
        // allowed to disagree is a parser differential waiting to happen: one
        // implementation completes on the flag, another on the count.
        if f.last != (f.index == f.total - 1) {
            return Err(ReasmError::LastFlagInconsistent);
        }
        if f.total_bytes > self.limits.max_message_body_bytes {
            return Err(ReasmError::TotalBytesOverMax);
        }
        // This one chunk already overruns the declaration — refusable without
        // knowing anything about the set, so refuse it before opening one.
        if f.chunk.len() as u64 > f.total_bytes {
            return Err(ReasmError::LengthExceedsTotal);
        }

        let lifetime = self.limits.reassembly_lifetime_ms;

        // ── the addressed set: expiry is reported, not silently restarted ──
        let pos = self.sets.iter().position(|(id, _)| id == f.fragment_id);
        if let Some(i) = pos {
            if expired(self.sets[i].1.started_ms, now_ms, lifetime) {
                self.sets.remove(i);
                return Err(ReasmError::Expired);
            }
        }

        let i = match pos {
            Some(i) => i,
            None => {
                // Opening a set is the only path that consumes a slot, so stale
                // sets are reclaimed here rather than being allowed to hold the
                // cap closed against honest peers.
                self.sets.retain(|(_, s)| !expired(s.started_ms, now_ms, lifetime));
                if self.sets.len() >= self.limits.max_concurrent_reassemblies {
                    // AT THE CAP THE NEW SET LOSES, ALWAYS.
                    //
                    // The obvious alternative — evict the oldest to make room —
                    // hands an attacker a way to destroy other people's
                    // in-progress transfers for the price of starting new ones:
                    // eight fragment_ids per round and every legitimate set on
                    // the connection is gone, with no error the victim can
                    // distinguish from a network fault. Refusing the newcomer
                    // costs the attacker their own transfer and costs the honest
                    // peer nothing, and the cap drains on its own via expiry.
                    return Err(ReasmError::TooManyConcurrent);
                }
                self.sets.push((
                    f.fragment_id.to_string(),
                    Set {
                        total: f.total,
                        total_bytes: f.total_bytes,
                        started_ms: now_ms,
                        received: 0,
                        // Bounded by `total`, which was bounded above. This is
                        // a capacity derived from a CHECKED count (<= 16), not
                        // from a declared byte length.
                        chunks: Vec::with_capacity(f.total as usize),
                    },
                ));
                self.sets.len() - 1
            }
        };

        let set = &mut self.sets[i].1;

        // The set's shape is fixed by whoever opened it. A peer that re-declares
        // it is either buggy or probing for a check that runs only once.
        if set.total != f.total || set.total_bytes != f.total_bytes {
            self.sets.remove(i);
            return Err(ReasmError::DeclarationChanged);
        }
        if set.chunks.iter().any(|(idx, _)| *idx == f.index) {
            self.sets.remove(i);
            return Err(ReasmError::DuplicateIndex);
        }
        // The running sum, bounded against the declaration as it grows. This is
        // the bound that replaces `Vec::with_capacity(total_bytes)`.
        let grown = set.received.saturating_add(f.chunk.len() as u64);
        if grown > set.total_bytes {
            self.sets.remove(i);
            return Err(ReasmError::LengthExceedsTotal);
        }

        set.received = grown;
        set.chunks.push((f.index, f.chunk.to_vec()));

        if set.chunks.len() < set.total as usize {
            return Ok(Accepted::Pending);
        }

        // Complete. A set that is short of its declaration is refused, not
        // delivered truncated — the caller must never have to ask whether what
        // it got is all of it.
        let (_, mut set) = self.sets.remove(i);
        if set.received != set.total_bytes {
            return Err(ReasmError::TotalMismatch);
        }
        set.chunks.sort_by_key(|(idx, _)| *idx);
        // Sized from what ARRIVED, which is also, at this point, provably equal
        // to the declaration.
        let mut out = Vec::with_capacity(set.received as usize);
        for (_, c) in &set.chunks {
            out.extend_from_slice(c);
        }
        Ok(Accepted::Complete(out))
    }

    /// Abandon one set — a peer that resets a stream should not leave a slot
    /// held until it times out.
    pub fn drop_set(&mut self, fragment_id: &str) -> bool {
        let before = self.sets.len();
        self.sets.retain(|(id, _)| id != fragment_id);
        before != self.sets.len()
    }
}

/// Strictly greater: a set exactly at the lifetime is still inside it, and
/// `saturating_sub` keeps a host clock that jumps backwards from expiring
/// everything at once.
fn expired(started_ms: u64, now_ms: u64, lifetime_ms: u64) -> bool {
    now_ms.saturating_sub(started_ms) > lifetime_ms
}
