package realtime

// Covers the replay window (ccwire_replay.go).
//
// The bound tests are here for the same reason the parked-session bound tests
// are: this is memory held on behalf of clients that are NOT connected. A
// window that is bounded on paper and unbounded in practice turns a commuter
// train into a gateway outage.
//
// The refusal tests matter more. Serving a partial replay would deliver a
// sequence with a gap the client does not know about — silent message loss
// wearing the costume of a successful resume. Every test below that asserts
// `ok == false` is guarding that.

import (
	"testing"
	"time"

	"vaultchat/backend-go/internal/ccwire"
)

// replayMsg, not msg: the package already has one.
func replayMsg(stream uint32, seq uint64) ccwire.Message {
	return ccwire.Message{Stream: stream, Seq: seq, TrafficClass: ccwire.TrafficClassMessaging}
}

func frameOf(n int) []byte { return make([]byte, n) }

// ── bounds ──────────────────────────────────────────────────────────

func TestReplayByteCeiling(t *testing.T) {
	w := newReplayWindow()
	now := time.Now()
	// Each frame is 1/8 of the budget, so well past it after 16.
	for i := uint64(1); i <= 16; i++ {
		w.retain(replayMsg(2, i), frameOf(replayMaxBytes/8), now)
	}
	if w.size() > replayMaxBytes {
		t.Fatalf("window holds %d bytes, budget is %d", w.size(), replayMaxBytes)
	}
}

func TestReplayCountCeiling(t *testing.T) {
	w := newReplayWindow()
	now := time.Now()
	// Tiny frames: the byte budget would never trigger, so only the count
	// bound can stop this. That is the point of having both.
	for i := uint64(1); i <= replayMaxFrames+100; i++ {
		w.retain(replayMsg(2, i), frameOf(4), now)
	}
	if w.len() > replayMaxFrames {
		t.Fatalf("window holds %d frames, cap is %d", w.len(), replayMaxFrames)
	}
}

func TestReplayAgeCeiling(t *testing.T) {
	w := newReplayWindow()
	old := time.Now()
	for i := uint64(1); i <= 5; i++ {
		w.retain(replayMsg(2, i), frameOf(16), old)
	}
	// One fresh frame, long after the others expired. Age must evict them even
	// though neither the byte nor count budget is close.
	w.retain(replayMsg(2, 6), frameOf(16), old.Add(replayMaxAge+time.Second))
	if w.len() != 1 {
		t.Fatalf("window holds %d frames, want only the fresh one", w.len())
	}
}

func TestReplayByteAccountingStaysConsistent(t *testing.T) {
	// The accounting bug this guards: bytes decremented in two places, drifting
	// until the byte budget silently stops binding.
	w := newReplayWindow()
	now := time.Now()
	for i := uint64(1); i <= 50; i++ {
		w.retain(replayMsg(2, i), frameOf(100), now)
	}
	sum := 0
	for _, f := range w.frames {
		sum += len(f.bytes)
	}
	if w.size() != sum {
		t.Fatalf("bytes counter = %d, actual retained = %d", w.size(), sum)
	}
}

// ── what must never be retained ─────────────────────────────────────

func TestBulkIsNeverRetained(t *testing.T) {
	w := newReplayWindow()
	m := replayMsg(4, 1)
	m.TrafficClass = ccwire.TrafficClassBulk
	w.retain(m, frameOf(64), time.Now())
	if w.len() != 0 {
		t.Fatal("a BULK frame entered the replay window")
	}
}

func TestOversizedFrameIsNotRetained(t *testing.T) {
	w := newReplayWindow()
	w.retain(replayMsg(2, 1), frameOf(replayMaxFrameBytes+1), time.Now())
	if w.len() != 0 {
		t.Fatal("an oversized frame entered the replay window")
	}
}

func TestUnsequencedFrameIsNotRetained(t *testing.T) {
	w := newReplayWindow()
	w.retain(replayMsg(1, 0), frameOf(32), time.Now())
	if w.len() != 0 {
		t.Fatal("an unsequenced control frame was retained")
	}
}

func TestRetainCopiesTheBuffer(t *testing.T) {
	// The caller reuses its encode buffer. Retaining a slice of it would replay
	// whatever happened to be there later — a frame that silently becomes a
	// different frame.
	w := newReplayWindow()
	buf := []byte{1, 2, 3, 4}
	w.retain(replayMsg(2, 1), buf, time.Now())
	buf[0] = 0xFF
	if w.frames[0].bytes[0] == 0xFF {
		t.Fatal("the window aliased the caller's buffer")
	}
}

// ── refusal, not partial service ────────────────────────────────────

func TestSkippedFrameHolesTheWindow(t *testing.T) {
	// An oversized frame is not retained. A later resume across that point must
	// REFUSE, not silently skip it.
	w := newReplayWindow()
	now := time.Now()
	w.retain(replayMsg(2, 1), frameOf(16), now)
	w.retain(replayMsg(2, 2), frameOf(replayMaxFrameBytes+1), now) // holed
	w.retain(replayMsg(2, 3), frameOf(16), now)

	if _, ok := w.since(map[uint32]uint64{2: 1}, map[uint32]uint64{2: 3}); ok {
		t.Fatal("a resume across a hole was served instead of refused")
	}
}

func TestEvictedFrameHolesTheWindow(t *testing.T) {
	// Eviction is indistinguishable from never-retained, and must refuse the
	// same way.
	w := newReplayWindow()
	now := time.Now()
	for i := uint64(1); i <= replayMaxFrames+10; i++ {
		w.retain(replayMsg(2, i), frameOf(8), now)
	}
	if _, ok := w.since(map[uint32]uint64{2: 1}, map[uint32]uint64{2: replayMaxFrames + 10}); ok {
		t.Fatal("a resume from before the evicted range was served")
	}
}

func TestUntrackedStreamRefuses(t *testing.T) {
	// The client reported no position for this stream, so we cannot know what
	// it has. Guessing would be the one unrecoverable mistake here.
	w := newReplayWindow()
	w.retain(replayMsg(2, 1), frameOf(16), time.Now())
	if _, ok := w.since(map[uint32]uint64{}, map[uint32]uint64{2: 1}); ok {
		t.Fatal("a resume with no reported position for a live stream was served")
	}
}

// ── the happy path ──────────────────────────────────────────────────

func TestReplayReturnsOnlyWhatIsMissing(t *testing.T) {
	w := newReplayWindow()
	now := time.Now()
	for i := uint64(1); i <= 5; i++ {
		w.retain(replayMsg(2, i), frameOf(16), now)
	}
	out, ok := w.since(map[uint32]uint64{2: 3}, map[uint32]uint64{2: 5})
	if !ok {
		t.Fatal("a servable gap was refused")
	}
	if len(out) != 2 {
		t.Fatalf("replayed %d frames, want 2 (4 and 5)", len(out))
	}
	if out[0].seq != 4 || out[1].seq != 5 {
		t.Fatalf("replay out of order: %d then %d", out[0].seq, out[1].seq)
	}
}

func TestReplayOrderIsAscendingPerStream(t *testing.T) {
	w := newReplayWindow()
	now := time.Now()
	// Interleaved streams, as a real session produces.
	for i := uint64(1); i <= 4; i++ {
		w.retain(replayMsg(2, i), frameOf(8), now)
		w.retain(replayMsg(3, i), frameOf(8), now)
	}
	out, ok := w.since(map[uint32]uint64{2: 0, 3: 0}, map[uint32]uint64{2: 4, 3: 4})
	if !ok {
		t.Fatal("refused a servable gap")
	}
	last := map[uint32]uint64{}
	for _, f := range out {
		if f.seq <= last[f.stream] {
			t.Fatalf("stream %d replayed %d after %d", f.stream, f.seq, last[f.stream])
		}
		last[f.stream] = f.seq
	}
}

func TestAcknowledgedFramesAreReleased(t *testing.T) {
	// A healthy connection must retain almost nothing: the window is sized for
	// the unhealthy case.
	w := newReplayWindow()
	now := time.Now()
	for i := uint64(1); i <= 10; i++ {
		w.retain(replayMsg(2, i), frameOf(32), now)
	}
	before := w.size()
	w.release(2, 8)
	if w.len() != 2 {
		t.Fatalf("after acking 8 of 10, window holds %d", w.len())
	}
	if w.size() >= before {
		t.Fatalf("byte counter did not shrink on release: %d -> %d", before, w.size())
	}
}

func TestNilWindowIsSafe(t *testing.T) {
	// A session with the feature off has no window. Every entry point must
	// tolerate that rather than making callers check.
	var w *replayWindow
	w.retain(replayMsg(2, 1), frameOf(8), time.Now())
	w.release(2, 1)
	if _, ok := w.since(map[uint32]uint64{2: 0}, map[uint32]uint64{2: 1}); ok {
		t.Fatal("a nil window claimed it could serve a replay")
	}
}
