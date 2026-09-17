package realtime

// ccwire_seq.go — per-session sequence numbers on the fan-out path.
//
// WHY THIS EXISTS
//
// Session resume and the replay window are both built on `seq`: cursors record
// it, `resume_from` reports it, the replay window is indexed by it. None of it
// does anything without a sequence number on the wire — and until this file,
// nothing in the gateway ever set one. Every outbound frame carried seq = 0,
// `noteSent` returned early on all of them, and every window stayed empty. The
// machinery was correct, tested, and connected to a stream of unsequenced
// frames.
//
// WHY IT WAS MISSING
//
// The fan-out encodes ONCE and shares the bytes with every recipient — that is
// the whole reason a chat message to fifty devices is one encode and not fifty.
// A per-session sequence number cannot be stamped on a shared buffer. So the
// two requirements are genuinely in tension, and this file resolves it by
// paying the cost only where it buys something:
//
//   - a session that did NOT negotiate resumption takes the shared bytes,
//     byte-for-byte as before, with no extra encode and no sequence number;
//   - a session that DID gets its own encode with its own seq, and its frames
//     retained for replay.
//
// With CCWIRE_RESUME unset — which is every deployment today, the flag appears
// in no compose file — no session has a window, so nothing takes the second
// path and the fan-out is exactly what it was.
//
// WHAT IS NOT SEQUENCED
//
//   - EPHEMERAL (typing, presence): lossy by design. Sequencing it would make a
//     stale typing indicator able to refuse a resume.
//   - BULK: resumable by its own mechanism, and never retained.
//   - Control-plane replies sent through send() (ServerHello, Pong, Ack, Error):
//     they answer a request rather than carrying a position, and a replayed
//     ServerHello from a previous connection would be actively wrong.

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/metrics"
)

// sequenced reports whether a frame's class takes a sequence number.
func sequenced(tc uint32) bool {
	return tc != ccwire.TrafficClassEphemeral && tc != ccwire.TrafficClassBulk
}

// position guards everything that answers "where is this session".
//
// One mutex for cursors, acks, the next-seq counters and the replay window,
// because they are one fact. Delivery runs on the fan-out goroutines while
// Ping.progress arrives on the reader goroutine, and allocating a sequence
// number is only meaningful if the frame that got it is also the next one
// ENQUEUED — so the allocation and the enqueue happen under the same lock.
type position struct {
	mu   sync.Mutex
	next map[uint32]uint64
}

func (p *position) allocLocked(stream uint32) uint64 {
	if p.next == nil {
		p.next = map[uint32]uint64{}
	}
	p.next[stream]++
	return p.next[stream]
}

// deliver sends one logical event to this session.
//
// shared is the fan-out's single encode; msgs is what it was encoded from. A
// session without a replay window takes shared unchanged — the pre-existing
// path, unmeasurably different from before this file existed.
func (s *ccwireSession) deliver(msgs []ccwire.Message, shared [][]byte) {
	if s == nil {
		return
	}
	now := time.Now()
	s.pos.mu.Lock()
	defer s.pos.mu.Unlock()

	if s.replay == nil || len(msgs) != len(shared) {
		// A length mismatch should be impossible — the builders return the two
		// in step — but falling back to the shared bytes is the safe answer
		// either way: a worse resume, never a wrong frame.
		for _, raw := range shared {
			s.enqueue(raw)
		}
		return
	}

	for i, m := range msgs {
		if !sequenced(m.TrafficClass) {
			s.enqueue(shared[i])
			continue
		}
		seq := s.pos.allocLocked(m.Stream)
		m.Seq = seq
		raw := ccwireFrame(m)
		if raw == nil {
			// The re-encode adds a seq field, so a frame sitting just under the
			// ceiling fits for every other session and fails here. Dropping it
			// would mean a resuming session silently misses a message everyone
			// else received — the one outcome this whole change exists to
			// prevent, reintroduced by the optimisation meant to prevent it.
			//
			// So: send the shared bytes, unsequenced, and hole the window. The
			// client gets the message; the next resume refuses and resyncs.
			// Degrading to today's behaviour is always available and always
			// correct.
			metrics.Inc("ccwire_seq_encode_refused")
			s.replay.hole(m.Stream, seq)
			s.enqueue(shared[i])
			continue
		}
		s.enqueue(raw)
		s.noteSentLocked(m)
		s.replay.retain(m, raw, now)
	}
}

// deliverOne is deliver for the single-frame case, which is most of them.
func (s *ccwireSession) deliverOne(m ccwire.Message, shared []byte) {
	if len(shared) == 0 {
		return
	}
	s.deliver([]ccwire.Message{m}, [][]byte{shared})
}

// newSessionID returns an identifier that is unique for the life of the
// process, and beyond it.
//
// It used to be fmt.Sprintf("cw:%s:%p", nodeID, s) — the session's HEAP
// ADDRESS. Go reuses freed addresses, and sessionID is not a debug label: it
// survives a resume (tryResume restores it), it is the sole match key for the
// supersede logic in ccwireRegister, and it is the exclude key for room
// fan-out. A collision therefore means closeOnce() on a healthy, unrelated
// connection of the same user, and fan-out suppressed to the wrong socket.
//
// Random, not a counter: a counter would collide across a restart, and parked
// sessions are matched by sessionID across exactly that boundary.
func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// The RNG failing is not a reason to hand out an ambiguous identity.
		// A session without an id is simply not registered for fan-out —
		// handle() already treats an empty sessionID that way.
		metrics.Inc("ccwire_session_id_rng_failed")
		return ""
	}
	return "cw:" + nodeID + ":" + hex.EncodeToString(b[:])
}
