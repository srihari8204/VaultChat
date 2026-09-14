// CC-Wire application-level fragment reassembly (body field 112, Fragment).
//
// WHAT THIS IS NOT. Three different things in this codebase split bytes, and
// conflating them is how a bound gets applied to the wrong axis:
//
//   - TRANSPORT FRAMING (internal/ccwire/frame.go) splits a byte stream into
//     length-prefixed frames. One WebSocket message is exactly one frame.
//   - FILE CHUNKING (uploads) splits a file across HTTP requests, is persisted,
//     and is resumable across connections.
//   - APPLICATION FRAGMENTS (this file) split ONE CC-Wire message payload that
//     is larger than max_frame_bytes across several frames on ONE live session.
//     Nothing here is persisted, nothing survives the session, and a set that
//     is not finished inside reassembly_lifetime_ms is dropped, not resumed.
//
// BOUNDED ON FOUR AXES AT ONCE, mirroring services/transport/rust/src/reasm.rs
// so the two implementations refuse the same fragments for the same reasons.
// Any single bound alone is evadable: bound only the count and each chunk is
// huge; bound only bytes and a thousand one-byte sets sit in memory forever;
// bound only concurrency and one set never completes; bound only time and a
// burst exhausts memory inside the window.
//
// total_bytes is a PEER CLAIM, never a capacity. Nothing here ever reserves
// total_bytes; only bytes that actually arrived are held, and the running sum
// is bounded against the declaration as it grows.
//
// ORDER OF CHECKS IS LOAD-BEARING: every bound decidable from the fragment's
// own declared fields is decided before the set table is touched, before a slot
// is taken and before a single chunk byte is copied. A rejected fragment must
// cost nothing but the compares.
//
// PER-SESSION, NOT GLOBAL: the reassembler is owned by one *ccwireSession, so
// one client can neither read nor evict another's partial sets, and the
// concurrency cap is charged to the peer that consumed it.
package realtime

import (
	"sort"
	"time"

	"vaultchat/backend-go/internal/ccwire"
)

// The three reassembly-only limits from proto/ccwire/v1/capabilities.proto.
// These are the numbers ccwire.go's encodeLimits() advertises in fields 5, 6
// and 7; see the patch note in this file's companion report — encodeLimits must
// reference these constants rather than repeat the literals, which is the only
// way the advertisement and the enforcement cannot drift apart.
//
// The other two bounds are NOT duplicated here: max_fragments_per_message and
// max_message_body_bytes come from the session's own ccwire.Limits, which is
// what encodeLimits writes into fields 4 and 3 and what the Fragment decoder in
// internal/ccwire/typedbody.go already checks against.
const (
	// ReassemblyLifetimeMS is capabilities.proto Limits field 5 (30000).
	ReassemblyLifetimeMS = 30000
	// MaxReassemblyBytes is capabilities.proto Limits field 6 (2097152): the
	// total bytes one session may hold across ALL of its in-progress sets.
	// Distinct from max_message_body_bytes, which bounds a single set.
	MaxReassemblyBytes = 2097152
	// MaxConcurrentReassemblies is capabilities.proto Limits field 7 (8).
	MaxConcurrentReassemblies = 8
)

// errFragmentInvalid is ERROR_CODE_FRAGMENT_INVALID (proto/ccwire/v1/errors.proto).
const errFragmentInvalid uint32 = 9

// fragmentError says which bound bound. A value, not a string: the caller
// decides between dropping the fragment and dropping the connection, and that
// decision must not depend on parsing prose. Every variant is
// ERROR_CODE_FRAGMENT_INVALID on the wire — the variant exists so the local log
// is specific, not so the peer learns more.
type fragmentError uint8

const (
	fragTotalZero fragmentError = iota + 1
	fragTooManyFragments
	fragIndexOutOfRange
	fragLastFlagInconsistent
	fragTotalBytesOverMax
	fragLengthExceedsTotal
	fragDuplicateIndex
	fragTotalMismatch
	fragDeclarationChanged
	fragExpired
	fragTooManyConcurrent
	fragSessionBudget
	fragIDRequired
)

var fragmentErrorNames = [...]string{
	fragTotalZero:            "TOTAL_ZERO",
	fragTooManyFragments:     "TOO_MANY_FRAGMENTS",
	fragIndexOutOfRange:      "INDEX_OUT_OF_RANGE",
	fragLastFlagInconsistent: "LAST_FLAG_INCONSISTENT",
	fragTotalBytesOverMax:    "TOTAL_BYTES_OVER_MAX",
	fragLengthExceedsTotal:   "LENGTH_EXCEEDS_TOTAL",
	fragDuplicateIndex:       "DUPLICATE_INDEX",
	fragTotalMismatch:        "TOTAL_MISMATCH",
	fragDeclarationChanged:   "DECLARATION_CHANGED",
	fragExpired:              "EXPIRED",
	fragTooManyConcurrent:    "TOO_MANY_CONCURRENT",
	fragSessionBudget:        "REASSEMBLY_BUDGET_EXCEEDED",
	fragIDRequired:           "FRAGMENT_ID_REQUIRED",
}

func (e fragmentError) Error() string {
	if int(e) < len(fragmentErrorNames) && fragmentErrorNames[e] != "" {
		return fragmentErrorNames[e]
	}
	return "FRAGMENT_INVALID"
}

// ErrorCode is ERROR_CODE_FRAGMENT_INVALID for every variant, kept beside the
// variant rather than in a second switch that could disagree with this one.
func (e fragmentError) ErrorCode() uint32 { return errFragmentInvalid }

// fragmentSet is one in-progress reassembly.
type fragmentSet struct {
	id         string
	total      uint32
	totalBytes uint64
	startedMS  int64
	// received counts bytes that ACTUALLY arrived — never totalBytes.
	received uint64
	// chunks in arrival order, sorted only on completion. At most `total`
	// entries, and `total` was bounded before this slice existed.
	chunks []fragmentChunk
}

type fragmentChunk struct {
	index uint32
	data  []byte
}

// fragmentReassembler is ONE session's reassembly state.
//
// Not safe for concurrent use, and deliberately so: a CC-Wire session reads and
// dispatches on a single goroutine (see ccwireSession.run), so a mutex here
// would guard nothing and imply a concurrency that does not exist.
type fragmentReassembler struct {
	lim ccwire.Limits
	// Linear slice keyed by fragment_id. At most MaxConcurrentReassemblies (8)
	// entries, so a scan beats a map and brings no hash-collision surface.
	sets []*fragmentSet
}

func newFragmentReassembler(lim ccwire.Limits) *fragmentReassembler {
	return &fragmentReassembler{lim: lim}
}

// len is the number of sets in progress.
func (r *fragmentReassembler) len() int { return len(r.sets) }

// bufferedBytes is what this session is holding right now, across all sets.
func (r *fragmentReassembler) bufferedBytes() uint64 {
	var n uint64
	for _, s := range r.sets {
		n += s.received
	}
	return n
}

// expired is strictly greater: a set exactly at the lifetime is still inside
// it. Subtraction is clamped so a host clock that jumps backwards does not
// expire everything at once.
func expiredAt(startedMS, nowMS int64) bool {
	if nowMS < startedMS {
		return false
	}
	return nowMS-startedMS > ReassemblyLifetimeMS
}

// sweep drops every set past its lifetime and returns how many went. Called on
// every accept; a host with an idle timer may call it directly so an abandoned
// set is reclaimed even when the peer sends nothing further.
func (r *fragmentReassembler) sweep(nowMS int64) int {
	kept := r.sets[:0]
	dropped := 0
	for _, s := range r.sets {
		if expiredAt(s.startedMS, nowMS) {
			dropped++
			continue
		}
		kept = append(kept, s)
	}
	for i := len(kept); i < len(r.sets); i++ {
		r.sets[i] = nil // let the chunks go
	}
	r.sets = kept
	return dropped
}

func (r *fragmentReassembler) find(id string) int {
	for i, s := range r.sets {
		if s.id == id {
			return i
		}
	}
	return -1
}

func (r *fragmentReassembler) remove(i int) {
	// Release the tail, exactly as sweep() does. append(sets[:i], sets[i+1:]...)
	// leaves a live *fragmentSet at the old last index of the backing array, so
	// up to MaxMessageBodyBytes of chunk data stayed reachable after a set had
	// completed or been refused - above the session budget this file insists is
	// the number actually enforced.
	copy(r.sets[i:], r.sets[i+1:])
	r.sets[len(r.sets)-1] = nil
	r.sets = r.sets[:len(r.sets)-1]
}

// drop abandons one set by id — a peer that resets a stream should not leave a
// slot held until it times out. Reports whether anything was there.
func (r *fragmentReassembler) drop(id string) bool {
	i := r.find(id)
	if i < 0 {
		return false
	}
	r.remove(i)
	return true
}

// accept offers one decoded Fragment.
//
// Returns (body, true, nil) when the set completed — body is the concatenated
// payload and the reassembler no longer holds it, so the slot is free the
// moment the payload leaves. Returns (nil, false, nil) while the set is still
// incomplete. Returns (nil, false, err) on refusal, where err is a
// fragmentError carrying ERROR_CODE_FRAGMENT_INVALID.
//
// A refusal that concerns an existing set also DESTROYS that set: a peer that
// contradicts its own declaration has lost the right to the slot, and keeping
// the partial around would let it retry the probe for free.
//
// nowMS is passed in rather than read from a clock so the bounds are testable
// and so one dispatch sees one consistent instant.
func (r *fragmentReassembler) accept(f ccwire.Fragment, nowMS int64) ([]byte, bool, error) {
	// ── decidable from the fragment alone, before the table is touched ──
	if f.FragmentID == "" {
		// Sets are keyed by id; an empty key would merge unrelated transfers
		// into one, which is a correctness bug before it is a security one.
		return nil, false, fragIDRequired
	}
	if f.Total == 0 {
		return nil, false, fragTotalZero
	}
	// A zero-byte message is not a message. Nothing else refuses it: an empty
	// chunk passes the len(chunk) > TotalBytes check, received(0) == 0 passes the
	// short-set check, and the empty payload reaches DecodeMessage which rejects
	// it one frame later - having already consumed one of the eight slots. Every
	// bound decidable from the fragment's own fields is decided before the table
	// is touched; this one was not decided at all.
	if f.TotalBytes == 0 {
		return nil, false, fragTotalZero
	}
	if f.Total > r.lim.MaxFragmentsPerMessage {
		return nil, false, fragTooManyFragments
	}
	if f.Index >= f.Total {
		return nil, false, fragIndexOutOfRange
	}
	// `last` is redundant with index/total, and a redundant field allowed to
	// disagree is a parser differential waiting to happen: one implementation
	// completes on the flag, another on the count.
	if f.Last != (f.Index == f.Total-1) {
		return nil, false, fragLastFlagInconsistent
	}
	if f.TotalBytes > uint64(r.lim.MaxMessageBodyBytes) {
		return nil, false, fragTotalBytesOverMax
	}
	// This one chunk already overruns the declaration — refusable without
	// knowing anything about a set, so refuse before opening one.
	if uint64(len(f.Chunk)) > f.TotalBytes {
		return nil, false, fragLengthExceedsTotal
	}

	// ── the addressed set: expiry is REPORTED, not silently restarted ──
	i := r.find(f.FragmentID)
	if i >= 0 && expiredAt(r.sets[i].startedMS, nowMS) {
		r.remove(i)
		return nil, false, fragExpired
	}

	if i < 0 {
		// Opening a set is the only path that consumes a slot, so stale sets
		// are reclaimed here rather than holding the cap closed against honest
		// peers.
		r.sweep(nowMS)
		if len(r.sets) >= MaxConcurrentReassemblies {
			// AT THE CAP THE NEW SET LOSES, ALWAYS. Evicting the oldest to make
			// room would hand an attacker a way to destroy other transfers on
			// this session for the price of starting new ones, with no error the
			// victim could tell from a network fault. Refusing the newcomer costs
			// the attacker their own transfer, and the cap drains via expiry.
			return nil, false, fragTooManyConcurrent
		}
		r.sets = append(r.sets, &fragmentSet{
			id:         f.FragmentID,
			total:      f.Total,
			totalBytes: f.TotalBytes,
			startedMS:  nowMS,
			// Capacity from a CHECKED count (<= 16), never from a declared
			// byte length.
			chunks: make([]fragmentChunk, 0, f.Total),
		})
		i = len(r.sets) - 1
	}

	set := r.sets[i]

	// The set's shape is fixed by whoever opened it. A peer that re-declares it
	// is either buggy or probing for a check that runs only once — accepting a
	// re-declaration would let it raise total_bytes after the first check passed.
	if set.total != f.Total || set.totalBytes != f.TotalBytes {
		r.remove(i)
		return nil, false, fragDeclarationChanged
	}
	for _, c := range set.chunks {
		if c.index == f.Index {
			// Re-sending an index is how a peer grows a set past its declared
			// size while every individual fragment looks legal.
			r.remove(i)
			return nil, false, fragDuplicateIndex
		}
	}
	// The running sum, bounded against the declaration as it grows. This is the
	// bound that replaces reserving totalBytes up front.
	grown := set.received + uint64(len(f.Chunk))
	if grown > set.totalBytes {
		r.remove(i)
		return nil, false, fragLengthExceedsTotal
	}
	// max_reassembly_bytes: the whole session's held bytes, not one set's. The
	// per-set bound alone permits 8 x 1 MiB; this is the number actually
	// advertised, so it is the number actually enforced.
	if r.bufferedBytes()+uint64(len(f.Chunk)) > MaxReassemblyBytes {
		r.remove(i)
		return nil, false, fragSessionBudget
	}

	set.received = grown
	// Copied: f.Chunk is a span into the frame buffer, which the caller is free
	// to reuse the moment dispatch returns.
	set.chunks = append(set.chunks, fragmentChunk{index: f.Index, data: append([]byte(nil), f.Chunk...)})

	if len(set.chunks) < int(set.total) {
		return nil, false, nil
	}

	// Complete. The slot is released before the payload is built, so a refusal
	// below cannot leave the set behind.
	r.remove(i)
	if set.received != set.totalBytes {
		// A short set is refused rather than delivered truncated: the caller
		// must never have to ask whether what it got is all of it.
		return nil, false, fragTotalMismatch
	}
	sort.Slice(set.chunks, func(a, b int) bool { return set.chunks[a].index < set.chunks[b].index })
	out := make([]byte, 0, set.received)
	for _, c := range set.chunks {
		out = append(out, c.data...)
	}
	return out, true, nil
}

// ── session wiring ──────────────────────────────────────────────────────
//
// serveFragment is what the dispatch switch in ccwire.go calls for
// BodyFragment. It is a free function taking the reassembler explicitly so this
// file owns no field on ccwireSession; the lead adds the field and the one
// switch case (see the report).
//
// Contract, identical to serveBody's: (handled, alive).
func serveFragment(s *ccwireSession, r *fragmentReassembler, m ccwire.Message) (handled, alive bool) {
	// The Fragment decoder is internal/ccwire/typedbody.go's, not a second one.
	// depth 1 because codec.go already charged one level entering the body.
	v, err := ccwire.DecodeBody(ccwire.BodyFragment, m.Body, s.lim, 1)
	if err != nil {
		return true, s.sendError(m.RequestID, errFragmentInvalid, "fragment")
	}
	f, ok := v.(ccwire.Fragment)
	if !ok {
		return true, s.sendError(m.RequestID, errFragmentInvalid, "fragment")
	}

	body, done, ferr := r.accept(f, time.Now().UnixMilli())
	if ferr != nil {
		return true, s.sendError(m.RequestID, errFragmentInvalid, "fragment")
	}
	if !done {
		// Held. Acked so the peer knows the fragment landed — a silent accept
		// is indistinguishable from a silent drop.
		return true, s.sendAck(m)
	}

	// The reassembled payload is one CC-Wire Message, which is why it is
	// re-decoded rather than handed to serveBody as raw bytes.
	//
	// maxBytes is len(body) rather than 0: the whole point of fragmenting is
	// that the payload legitimately exceeds max_frame_bytes. It is still
	// bounded — accept() proved len(body) <= max_message_body_bytes.
	//
	// depth 1, so a Fragment nested inside a reassembled payload is refused by
	// the SAME nesting bound as any other body. This is what stops a
	// Fragment-in-Fragment bomb (see lib/ccwire/__vectors__/codec.json, "a frame
	// already past the recursion limit is refused").
	inner, err := ccwire.DecodeMessage(body, s.lim, len(body), 1)
	if err != nil {
		return true, s.sendError(m.RequestID, errFragmentInvalid, "reassembled")
	}
	if inner.BodyField == ccwire.BodyFragment || inner.BodyField == ccwire.BodyClientHello {
		// A reassembled payload may not be another fragment (an unbounded
		// recursion the depth check alone would not catch, since each level is
		// a fresh frame) nor a second handshake.
		return true, s.sendError(m.RequestID, errFragmentInvalid, "reassembled body")
	}
	if inner.RequestID == "" {
		inner.RequestID = m.RequestID
	}
	return s.serveBody(inner)
}
