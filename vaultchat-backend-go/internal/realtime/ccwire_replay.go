package realtime

// ccwire_replay.go — the bounded transport replay window.
//
// WHY
//
// ccwire_resume.go restores a session's POSITION: identity, subscriptions, and
// how far each stream got. It does not resend what was missed, so a resumed
// client still reconciles content through the full application sync — most of
// the cost resume exists to avoid. This is the other half: keep the last few
// frames so a two-second tunnel costs a handful of retransmits instead of a
// full resync against PostgreSQL.
//
// WHAT THIS IS NOT
//
// Not durable. Not a message store. Not a source of truth. The window is
// memory, dies with the process, and is only ever an optimisation over the
// existing resync. PostgreSQL stays authoritative, and every uncertain branch
// here refuses and lets the client resync — the same conservative rule resume
// follows.
//
// THE RULE THAT MATTERS: REFUSE, NEVER PARTIALLY SERVE
//
// If the client's position predates the oldest frame retained, or the window
// has a hole, the resume is refused. Serving what we happen to hold would
// deliver a sequence with a gap in it, and a gap the client does NOT KNOW
// ABOUT is worse than an honest resync — it is silent message loss wearing the
// costume of a successful resume.
//
// BOUNDS
//
// Bytes, count and age, all three, per session, enforced ON INSERT. Any one
// alone is unbounded in practice: a count bound says nothing about large
// frames, a byte bound says nothing about a session that parks and is never
// reclaimed, and a sweep-based bound is unbounded between sweeps — during
// exactly the burst that overran it.
//
// DUPLICATES
//
// Replay may deliver a frame the client already has. That is accepted and
// stated rather than hidden: the guarantee is exactly-once VISIBLE EFFECT,
// which the application layer already provides by deduplicating durable
// messages on (chat_id, sender_id, client_id). Exactly-once delivery is not
// offered and must not be claimed.

import (
	"time"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/metrics"
)

const (
	// replayMaxBytes is the per-session byte budget. Sized for the unhealthy
	// case: a healthy connection acknowledges and the window empties itself.
	replayMaxBytes = 256 * 1024

	// replayMaxFrames caps the count independently of size, so a burst of tiny
	// frames cannot consume the ring.
	replayMaxFrames = 512

	// replayMaxAge bounds how stale a retained frame may be. Deliberately
	// shorter than resumeLifetime: a session may still be resumable after its
	// frames have aged out, in which case the resume is refused and the client
	// resyncs — correct, and cheaper than holding bytes nobody will ask for.
	replayMaxAge = 90 * time.Second

	// replayMaxFrameBytes is the per-frame ceiling. Above this a frame is not
	// retained and the window is holed, because holding large payloads is how
	// a transport optimisation turns into a file cache.
	replayMaxFrameBytes = 32 * 1024
)

// retainedFrame is one already-encoded outbound frame.
//
// The ENCODED bytes, not the Message: replay must reproduce exactly what was
// sent. Re-encoding at replay time invites a subtly different frame, which is
// the hardest class of bug to find — it only appears after a reconnect, on
// someone else's phone.
type retainedFrame struct {
	stream uint32
	seq    uint64
	at     time.Time
	bytes  []byte
}

// replayWindow is one session's ring of recent outbound frames.
//
// Ordered by insertion, which is ascending seq within a stream because
// noteSent is called on the single outbound path and streams are per-stream
// FIFO.
type replayWindow struct {
	frames []retainedFrame
	bytes  int

	// holedFrom is the lowest sequence, per stream, at which a frame was NOT
	// retained. A resume that would have to cross this point must be refused:
	// replaying around a hole silently skips exactly the frames that were too
	// big to keep, which is the failure this field exists to make impossible.
	holedFrom map[uint32]uint64

	// releasedUpTo is how far each stream has been ACKNOWLEDGED and therefore
	// dropped. It is the window's FLOOR, and without it the window has none.
	//
	// The bug it closes: since() decided "too old" by comparing against the
	// oldest frame it still held, inside the loop over those frames. With no
	// frames left for a stream — the normal state of a healthy connection,
	// because release() empties it — that loop body never ran, nothing refused,
	// and the function answered "resumed, nothing missing" to a client asking
	// from a position well behind what the server had sent. resumed=true with a
	// silent gap: the one outcome this file exists to make impossible.
	releasedUpTo map[uint32]uint64
}

func newReplayWindow() *replayWindow {
	return &replayWindow{
		holedFrom:    map[uint32]uint64{},
		releasedUpTo: map[uint32]uint64{},
	}
}

// retain records a sent frame, or records a hole if it may not be kept.
func (w *replayWindow) retain(m ccwire.Message, encoded []byte, now time.Time) {
	if w == nil || m.Seq == 0 {
		// Unsequenced control traffic is not replayable and needs no hole: a
		// resume cannot ask for it, because nothing tracks a position for it.
		return
	}

	// BULK never enters the window. It is resumable by its own mechanism, and
	// replaying it would put file bytes in gateway memory.
	if m.TrafficClass == ccwire.TrafficClassBulk || len(encoded) > replayMaxFrameBytes {
		w.hole(m.Stream, m.Seq)
		metrics.Inc("ccwire_replay_not_retained")
		return
	}

	// Copy: the caller's buffer is reused for the next frame, and retaining a
	// slice of it would replay whatever happens to be there later.
	cp := make([]byte, len(encoded))
	copy(cp, encoded)

	w.frames = append(w.frames, retainedFrame{
		stream: m.Stream,
		seq:    m.Seq,
		at:     now,
		bytes:  cp,
	})
	w.bytes += len(cp)
	w.enforce(now)
}

// hole records that a stream lost a frame at seq.
//
// Keeps the HIGHEST holed sequence per stream, because a resume is refused when
// its position is below any hole: the highest hole is the strictest bound, and
// remembering a lower one would let a resume through that needed a frame we no
// longer have.
func (w *replayWindow) hole(stream uint32, seq uint64) {
	// retain, release and since all tolerate a nil receiver; this one did not,
	// which made it the single entry point that would panic the fan-out
	// goroutine after any change that can nil a window out from under a caller
	// — and revokeLiveResume is exactly such a change.
	if w == nil {
		return
	}
	if w.holedFrom == nil {
		w.holedFrom = map[uint32]uint64{}
	}
	if seq > w.holedFrom[stream] {
		w.holedFrom[stream] = seq
	}
}

// enforce applies all three bounds. On insert, never on a sweep.
func (w *replayWindow) enforce(now time.Time) {
	// Age first: an old frame is worthless regardless of the other budgets.
	cut := 0
	for cut < len(w.frames) && now.Sub(w.frames[cut].at) > replayMaxAge {
		cut++
	}
	w.dropOldest(cut)

	for len(w.frames) > 0 && (len(w.frames) > replayMaxFrames || w.bytes > replayMaxBytes) {
		w.dropOldest(1)
	}
}

// dropOldest removes the n oldest frames and holes the streams they belonged
// to: an evicted frame is indistinguishable from one that was never retained,
// and both must refuse a resume that would need it.
func (w *replayWindow) dropOldest(n int) {
	if n <= 0 {
		return
	}
	if n > len(w.frames) {
		n = len(w.frames)
	}
	// Byte accounting lives HERE and nowhere else. It was briefly split between
	// this function and its caller, which is exactly how a double-decrement gets
	// introduced: two places that must agree, and no way to tell when they stop.
	for i := 0; i < n; i++ {
		f := w.frames[i]
		w.bytes -= len(f.bytes)
		w.hole(f.stream, f.seq)
		metrics.Inc("ccwire_replay_evicted")
	}
	w.frames = w.frames[n:]
}

// release drops frames at or before an acknowledged position. A healthy
// connection therefore retains almost nothing — the window is sized for the
// unhealthy case, not the normal one.
func (w *replayWindow) release(stream uint32, upTo uint64) {
	if w == nil {
		return
	}
	// Record the floor BEFORE dropping anything. Frames gone without a record
	// of how far they went are frames the window cannot reason about later.
	if w.releasedUpTo == nil {
		w.releasedUpTo = map[uint32]uint64{}
	}
	if upTo > w.releasedUpTo[stream] {
		w.releasedUpTo[stream] = upTo
	}
	kept := w.frames[:0]
	for _, f := range w.frames {
		if f.stream == stream && f.seq <= upTo {
			w.bytes -= len(f.bytes)
			continue
		}
		kept = append(kept, f)
	}
	w.frames = kept
}

// since returns the frames a client at `from` is missing, in ascending order
// per stream, and whether the window can serve the gap IN FULL.
//
// ok=false means refuse the resume. It is returned when the requested position
// predates what is retained or crosses a hole — never a partial answer.
func (w *replayWindow) since(from map[uint32]uint64, sent map[uint32]uint64) ([]retainedFrame, bool) {
	if w == nil {
		return nil, false
	}
	// A hole at or above the resume point means the gap cannot be served.
	for stream, at := range from {
		if h, holed := w.holedFrom[stream]; holed && h > at {
			metrics.Inc("ccwire_replay_refused_hole")
			return nil, false
		}
	}

	// Every stream the session actually SENT on must be accounted for, and the
	// authority for that is the session's cursors — not whatever happens to be
	// left in the ring.
	//
	// Checking only the retained frames was the hole: a stream whose frames had
	// all been acknowledged and released had nothing left to iterate, so a
	// client that reported no position for it, or a position below the released
	// floor, was answered "nothing missing" instead of being refused.
	for stream, high := range sent {
		if high == 0 {
			continue
		}
		at, tracked := from[stream]
		if !tracked {
			// Silence about a stream is not a claim to have everything on it.
			metrics.Inc("ccwire_replay_refused_untracked")
			return nil, false
		}
		if at < w.releasedUpTo[stream] {
			// Behind the floor: the frames between are released and gone.
			metrics.Inc("ccwire_replay_refused_too_old")
			return nil, false
		}
	}

	// Oldest retained per stream: if the client is behind that, frames it needs
	// are already gone.
	oldest := map[uint32]uint64{}
	for _, f := range w.frames {
		if cur, ok := oldest[f.stream]; !ok || f.seq < cur {
			oldest[f.stream] = f.seq
		}
	}
	var out []retainedFrame
	for _, f := range w.frames {
		at, tracked := from[f.stream]
		if !tracked {
			// Belt and braces: the loop above already refuses any stream the
			// session sent on that the client did not report. A retained frame
			// for an unreported stream would mean the two disagree about what
			// was sent, and that is not a disagreement to resolve in the
			// client's favour.
			metrics.Inc("ccwire_replay_refused_untracked")
			return nil, false
		}
		if f.seq <= at {
			continue // already has it
		}
		if o, ok := oldest[f.stream]; ok && o > at+1 {
			// The first frame we still hold is not the next one the client
			// needs: the ones between were evicted.
			metrics.Inc("ccwire_replay_refused_too_old")
			return nil, false
		}
		out = append(out, f)
	}
	return out, true
}

// len and size are for tests and the gauge.
func (w *replayWindow) len() int  { return len(w.frames) }
func (w *replayWindow) size() int { return w.bytes }

// flushReplay writes the frames a resumed session missed.
//
// The RETAINED bytes go out verbatim — not a re-encode. Re-encoding would risk
// a frame that is subtly not the one the client's peers already saw, which is
// the hardest class of bug to find: it only shows up after a reconnect, on
// someone else's phone.
//
// Cursors are NOT advanced here. These frames were counted when they were first
// sent; counting them twice would push the session's position past what the
// client has actually confirmed.
func (s *ccwireSession) flushReplay() bool {
	frames := s.pendingReplay
	s.pendingReplay = nil
	for i := range frames {
		if s.write(frames[i].bytes) != nil {
			return false
		}
		metrics.Inc("ccwire_replay_frame_sent")
	}
	if len(frames) > 0 {
		metrics.Inc("ccwire_replay_served")
	}
	return true
}
