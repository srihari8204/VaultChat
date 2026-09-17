package realtime

// Covers the replay window WIRED into the live paths, which is a different
// claim from ccwire_replay_test.go.
//
// That file proves the ring is correct in isolation. This one proves the ring
// is actually on the send path, actually survives the park, and actually
// reaches the socket after a resume — the three places a data structure that
// works perfectly can still be connected to nothing.

import (
	"bytes"
	"fmt"
	"sync"
	"testing"
	"time"

	"vaultchat/backend-go/internal/ccwire"
)

// capture gives a session a socket that records instead of writing.
func capture(s *ccwireSession) *[][]byte {
	var out [][]byte
	s.w = func(b []byte) error {
		cp := make([]byte, len(b))
		copy(cp, b)
		out = append(out, cp)
		return nil
	}
	return &out
}

func sendN(t *testing.T, s *ccwireSession, stream uint32, n int) {
	t.Helper()
	for i := 1; i <= n; i++ {
		ok := s.send(ccwire.Message{
			TrafficClass: ccwire.TrafficClassMessaging,
			Stream:       stream,
			Seq:          uint64(i),
			BodyField:    ccwire.BodyTypingState,
			Body:         []byte{},
		})
		if !ok {
			t.Fatalf("send %d failed", i)
		}
	}
}

// ── retention is on the send path ───────────────────────────────────

func TestSendRetainsIntoTheWindow(t *testing.T) {
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(s)

	sendN(t, s, 2, 3)

	if s.replay.len() != 3 {
		t.Fatalf("window holds %d frames after 3 sends, want 3", s.replay.len())
	}
}

func TestSendRetainsNothingWithoutAWindow(t *testing.T) {
	// The CCWIRE_RESUME=unset shape: no token, no window, and send must not
	// care. This is the "off by default" requirement at the call site rather
	// than at the flag.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	s.replay = nil
	s.resumeToken = ""
	capture(s)

	sendN(t, s, 2, 3)

	if s.replay != nil {
		t.Fatal("a window appeared on a session that never negotiated resumption")
	}
}

func TestAckReleasesThroughNoteAcked(t *testing.T) {
	// noteAcked is the production path Ping.progress lands on. Releasing only
	// through the window's own method would leave the wired path retaining
	// forever: the bound failing while every unit test still passes.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(s)
	sendN(t, s, 2, 6)

	s.noteAcked(2, 4)

	if s.replay.len() != 2 {
		t.Fatalf("after acking 4 of 6, window holds %d", s.replay.len())
	}
}

// ── the window survives the park ────────────────────────────────────

func TestReplayedFramesAreTheExactBytesSent(t *testing.T) {
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	sent := capture(first)
	sendN(t, first, 2, 4)
	first.noteAcked(2, 2)

	tok := first.parkForResume()
	if tok == "" {
		t.Fatal("park produced no token")
	}

	second := sessionOn(h, "u1", "dev-1", "")
	got := capture(second)
	second.tryResume(clientHello{
		deviceID:    "dev-1",
		resumeToken: tok,
		resumeFrom:  map[uint32]uint64{2: 2},
	})
	if !second.resumed {
		t.Fatal("a resume with a servable gap was refused")
	}
	if !second.flushReplay() {
		t.Fatal("flushReplay failed")
	}

	if len(*got) != 2 {
		t.Fatalf("replayed %d frames, want 3 and 4", len(*got))
	}
	// Byte-identical, not merely equivalent. A re-encode could produce a frame
	// with the same meaning and different bytes — and depends_on, seq and
	// traffic class all ride in those bytes. Identity is what keeps causal
	// ordering intact across a replay without re-deriving it.
	for i, want := range (*sent)[2:4] {
		if !bytes.Equal((*got)[i], want) {
			t.Fatalf("replayed frame %d differs from what was sent", i+3)
		}
	}
}

func TestReplayIsWrittenBeforeAnyNewTraffic(t *testing.T) {
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	sendN(t, first, 2, 3)
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	got := capture(second)
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok, resumeFrom: map[uint32]uint64{2: 0}})
	if !second.resumed {
		t.Fatal("resume refused")
	}
	second.flushReplay()
	// New traffic only after the flush, as the handshake orders it.
	second.send(ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2, Seq: 4, BodyField: ccwire.BodyTypingState, Body: []byte{}})

	if len(*got) != 4 {
		t.Fatalf("wrote %d frames, want 3 replayed + 1 new", len(*got))
	}
	// Decoding is the only honest check here: asserting on write order alone
	// would still pass if the frames themselves were scrambled.
	for i, w := range *got {
		// Through the real outer framing: what send() writes is a framed
		// envelope, and what replay writes must be indistinguishable from it.
		// Decoding only the inner message would not prove that.
		f, err := ccwire.Decode(w, ccwire.Options{MaxBytes: ccwire.DefaultLimits().MaxFrameBytes})
		if err != nil {
			t.Fatalf("frame %d did not decode: %v", i, err)
		}
		m, err := ccwire.DecodeMessage(f.Payload, ccwire.DefaultLimits(), 1<<20, 0)
		if err != nil {
			t.Fatalf("frame %d body did not decode: %v", i, err)
		}
		if m.Seq != uint64(i+1) {
			t.Fatalf("frame %d carries seq %d, want %d", i, m.Seq, i+1)
		}
	}
}

func TestDuplicateReplayCarriesTheSameIdentity(t *testing.T) {
	// Exactly-once VISIBLE EFFECT, never exactly-once delivery. The transport
	// makes no attempt to suppress a duplicate; what it guarantees is that a
	// replayed frame is byte-identical to the original, so the application
	// dedup on (chat_id, sender_id, client_id) sees the same row twice rather
	// than two rows that merely resemble each other.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	sent := capture(first)
	sendN(t, first, 2, 2)
	tok := first.parkForResume()

	// The client received both but reports only 1 — the ack was lost with the
	// connection. Frame 2 is therefore replayed as a duplicate.
	second := sessionOn(h, "u1", "dev-1", "")
	got := capture(second)
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok, resumeFrom: map[uint32]uint64{2: 1}})
	second.flushReplay()

	if len(*got) != 1 {
		t.Fatalf("replayed %d frames, want the one duplicate", len(*got))
	}
	if !bytes.Equal((*got)[0], (*sent)[1]) {
		t.Fatal("the duplicate is not byte-identical to the original")
	}
}

func TestResumeRefusedWhenTheParkedWindowIsHoled(t *testing.T) {
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	sendN(t, first, 2, 2)
	// A frame too large to retain: the window is holed at 3.
	first.replay.retain(replayMsg(2, 3), frameOf(replayMaxFrameBytes+1), time.Now())
	first.send(ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2, Seq: 4, BodyField: ccwire.BodyTypingState, Body: []byte{}})
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok, resumeFrom: map[uint32]uint64{2: 1}})

	if second.resumed {
		t.Fatal("a resume across a hole was accepted instead of refused")
	}
	if second.sessionID != "" {
		t.Fatal("a refused resume adopted the parked session anyway")
	}
}

// ── the bound that actually holds ───────────────────────────────────

func TestParkedReplayBytesStayWithinTheGatewayBudget(t *testing.T) {
	// maxParkedSessions × replayMaxBytes is 5 GB. The per-session bound is not
	// the bound that keeps the process alive; this one is.
	r := newResumeStore()
	now := time.Now()
	for i := 0; i < 600; i++ {
		s := testSession("u1", "d1", "s1")
		s.replay = newReplayWindow()
		for j := uint64(1); j <= 8; j++ {
			s.replay.retain(replayMsg(2, j), frameOf(replayMaxFrameBytes), now)
		}
		parkTest(r, s, map[uint32]uint64{2: 0}, 1)
	}
	if r.replayBytes > replayParkedBudget {
		t.Fatalf("parked replay holds %d bytes, budget is %d", r.replayBytes, replayParkedBudget)
	}
}

func TestBudgetReturnsWhenAParkedSessionIsTaken(t *testing.T) {
	// A budget that only ever goes up is a budget that fills once and then
	// refuses every window for the life of the process.
	r := newResumeStore()
	s := testSession("u1", "d1", "s1")
	s.replay = newReplayWindow()
	s.replay.retain(replayMsg(2, 1), frameOf(1024), time.Now())
	tok, _ := parkTest(r, s, map[uint32]uint64{2: 0}, 1)

	if r.replayBytes == 0 {
		t.Fatal("park charged nothing to the budget")
	}
	if _, ok := r.take(tok, "u1", "d1"); !ok {
		t.Fatal("take failed")
	}
	if r.replayBytes != 0 {
		t.Fatalf("budget still holds %d bytes after the session was taken", r.replayBytes)
	}
}

func TestBudgetReturnsWhenAParkedSessionExpires(t *testing.T) {
	r := newResumeStore()
	s := testSession("u1", "d1", "s1")
	s.replay = newReplayWindow()
	s.replay.retain(replayMsg(2, 1), frameOf(1024), time.Now())
	parkTest(r, s, map[uint32]uint64{2: 0}, 1)

	r.sweep(time.Now().Add(resumeLifetime + time.Minute))

	if r.replayBytes != 0 {
		t.Fatalf("budget still holds %d bytes after the sweep", r.replayBytes)
	}
}

func TestBudgetReturnsOnLogoutInvalidation(t *testing.T) {
	r := newResumeStore()
	s := testSession("u1", "d1", "s1")
	s.replay = newReplayWindow()
	s.replay.retain(replayMsg(2, 1), frameOf(2048), time.Now())
	parkTest(r, s, map[uint32]uint64{2: 0}, 1)

	r.forgetUID("u1")

	if r.replayBytes != 0 {
		t.Fatalf("budget still holds %d bytes after logout", r.replayBytes)
	}
}

func TestOverBudgetParkStillResumesIdentityButRefusesReplay(t *testing.T) {
	// Shedding the optimisation must not shed the correctness. Over budget the
	// window is dropped, and the resume is then refused rather than claiming a
	// completeness it cannot deliver.
	r := newResumeStore()
	r.replayBytes = replayParkedBudget

	s := testSession("u1", "d1", "s1")
	s.replay = newReplayWindow()
	s.replay.retain(replayMsg(2, 1), frameOf(4096), time.Now())
	tok, ok := parkTest(r, s, map[uint32]uint64{2: 1}, 1)
	if !ok {
		t.Fatal("an over-budget session failed to park at all")
	}

	p, ok := r.take(tok, "u1", "d1")
	if !ok {
		t.Fatal("an over-budget parked session could not be taken")
	}
	if p.replay != nil {
		t.Fatal("a window was parked past the gateway budget")
	}
	if _, ok := p.replay.since(map[uint32]uint64{2: 1}, map[uint32]uint64{2: 1}); ok {
		t.Fatal("a nil window claimed it could serve the gap")
	}
}

// ── idle sessions must not be punished ──────────────────────────────

func TestIdleSessionResumesWithAnEmptyWindow(t *testing.T) {
	// nil means "cannot answer", empty means "had nothing outstanding". Folding
	// the two together would make every idle reconnect a full resync — the most
	// common case paying for the rarest.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	got := capture(second)
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok, resumeFrom: map[uint32]uint64{}})

	if !second.resumed {
		t.Fatal("an idle session with nothing outstanding was refused")
	}
	if !second.flushReplay() || len(*got) != 0 {
		t.Fatalf("an idle resume replayed %d frames", len(*got))
	}
}

// ── causality survives a replay ─────────────────────────────────────

func TestDependsOnSurvivesReplay(t *testing.T) {
	// Replay must not let a message overtake the key rotation or membership
	// change it depends on. Two things make that true and both are checked
	// here: the dependency is INSIDE the replayed range (since() refuses any
	// gap it cannot serve contiguously), and the bytes carrying depends_on are
	// the originals rather than a re-encode.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	first.send(ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2, Seq: 1,
		BodyField: ccwire.BodyTypingState, Body: []byte{}})
	first.send(ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2, Seq: 2,
		DependsOn: 1, BodyField: ccwire.BodyTypingState, Body: []byte{}})
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	got := capture(second)
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok, resumeFrom: map[uint32]uint64{2: 0}})
	if !second.resumed {
		t.Fatal("resume refused")
	}
	second.flushReplay()

	if len(*got) != 2 {
		t.Fatalf("replayed %d frames, want the dependency and the dependent", len(*got))
	}
	var seqs, deps []uint64
	for i, w := range *got {
		f, err := ccwire.Decode(w, ccwire.Options{MaxBytes: ccwire.DefaultLimits().MaxFrameBytes})
		if err != nil {
			t.Fatalf("frame %d did not decode: %v", i, err)
		}
		m, err := ccwire.DecodeMessage(f.Payload, ccwire.DefaultLimits(), 1<<20, 0)
		if err != nil {
			t.Fatalf("frame %d body did not decode: %v", i, err)
		}
		seqs = append(seqs, m.Seq)
		deps = append(deps, m.DependsOn)
	}
	if seqs[0] != 1 || seqs[1] != 2 {
		t.Fatalf("replay order %v, want the dependency first", seqs)
	}
	if deps[1] != 1 {
		t.Fatalf("depends_on came back as %d, want 1", deps[1])
	}
}

func TestReplayRefusesWhenTheDependencyWasNotRetained(t *testing.T) {
	// The dependency itself evicted. Serving only the dependent would deliver a
	// frame whose causal predecessor the client never sees — the exact ordering
	// break depends_on exists to prevent, arrived at through replay instead of
	// through the network.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	first.send(ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2, Seq: 1,
		BodyField: ccwire.BodyTypingState, Body: []byte{}})
	// Evict everything retained so far, then send the dependent.
	first.replay.dropOldest(first.replay.len())
	first.send(ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2, Seq: 2,
		DependsOn: 1, BodyField: ccwire.BodyTypingState, Body: []byte{}})
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok, resumeFrom: map[uint32]uint64{2: 0}})

	if second.resumed {
		t.Fatal("a replay missing the dependency was served instead of refused")
	}
}

// ── off by default ──────────────────────────────────────────────────

func TestNothingIsRetainedWithResumeDisabled(t *testing.T) {
	// The handshake creates the window only under `resumptionEnabled() &&
	// helloWantsResumption`. Both halves are asserted, because a gate that is
	// only half true is a feature that is on.
	t.Setenv("CCWIRE_RESUME", "")
	if resumptionEnabled() {
		t.Fatal("resumption is enabled with CCWIRE_RESUME unset")
	}
	// A client asking for it changes nothing while the flag is off.
	body := helloBytes("dev-1", "", nil)
	if resumptionEnabled() && helloWantsResumption(body, ccwire.DefaultLimits()) {
		t.Fatal("a client request enabled resumption past the flag")
	}

	t.Setenv("CCWIRE_RESUME", "1")
	if !resumptionEnabled() {
		t.Fatal("CCWIRE_RESUME=1 did not enable resumption")
	}
}

// ── the fan-out actually produces sequence numbers ──────────────────
//
// Everything above is built on `seq`. Until deliver() existed, no outbound
// frame carried one: cursors stayed empty, windows stayed empty, and the whole
// feature was correct machinery attached to an unsequenced stream. These tests
// are the ones that would have caught that.

func TestFanOutSequencesFramesForAResumingSession(t *testing.T) {
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	got := capture(s)

	msg := ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: ccwireStreamMessaging,
		BodyField: ccwire.BodyTypingState, Body: []byte{}}
	shared := ccwireFrame(msg)
	s.deliverOne(msg, shared)
	s.deliverOne(msg, shared)

	if len(*got) != 2 {
		t.Fatalf("delivered %d frames, want 2", len(*got))
	}
	for i, w := range *got {
		f, err := ccwire.Decode(w, ccwire.Options{MaxBytes: ccwire.DefaultLimits().MaxFrameBytes})
		if err != nil {
			t.Fatalf("frame %d did not decode: %v", i, err)
		}
		m, err := ccwire.DecodeMessage(f.Payload, ccwire.DefaultLimits(), 1<<20, 0)
		if err != nil {
			t.Fatalf("frame %d body did not decode: %v", i, err)
		}
		if m.Seq != uint64(i+1) {
			t.Fatalf("frame %d carries seq %d, want %d", i, m.Seq, i+1)
		}
	}
	if s.cursors[ccwireStreamMessaging] != 2 {
		t.Fatalf("cursor = %d, want 2", s.cursors[ccwireStreamMessaging])
	}
	if s.replay.len() != 2 {
		t.Fatalf("window holds %d frames, want 2", s.replay.len())
	}
}

func TestFanOutIsUnchangedForASessionWithoutAWindow(t *testing.T) {
	// The path every deployment is on today: CCWIRE_RESUME unset, no window,
	// and the shared encode handed over byte-for-byte. One extra encode per
	// recipient would be a real regression on the busiest path in the gateway.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	s.replay = nil
	got := capture(s)

	msg := ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: ccwireStreamMessaging,
		BodyField: ccwire.BodyTypingState, Body: []byte{}}
	shared := ccwireFrame(msg)
	s.deliverOne(msg, shared)

	if len(*got) != 1 || !bytes.Equal((*got)[0], shared) {
		t.Fatal("a session without a window did not get the shared bytes verbatim")
	}
	if len(s.cursors) != 0 {
		t.Fatalf("cursors moved for a session that cannot resume: %v", s.cursors)
	}
}

func TestEphemeralFramesAreNeverSequenced(t *testing.T) {
	// Typing and presence are lossy by design. Sequencing them would let a
	// stale typing indicator hole a window and refuse an otherwise fine resume.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	got := capture(s)

	msg := ccwire.Message{TrafficClass: ccwire.TrafficClassEphemeral, Stream: ccwireStreamEphemeral,
		BodyField: ccwire.BodyTypingState, Body: []byte{}}
	shared := ccwireFrame(msg)
	s.deliverOne(msg, shared)

	if len(*got) != 1 || !bytes.Equal((*got)[0], shared) {
		t.Fatal("an EPHEMERAL frame was re-encoded instead of shared")
	}
	if len(s.cursors) != 0 || s.replay.len() != 0 {
		t.Fatalf("EPHEMERAL moved a cursor (%v) or entered the window (%d)", s.cursors, s.replay.len())
	}
}

func TestSequencesAreIndependentPerSession(t *testing.T) {
	// Two devices of the same user are at different positions. A shared counter
	// would hand each of them a stream with gaps in it.
	h := hubWithResume()
	a := sessionOn(h, "u1", "dev-a", "sess-a")
	b := sessionOn(h, "u1", "dev-b", "sess-b")
	capture(a)
	capture(b)

	msg := ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: ccwireStreamMessaging,
		BodyField: ccwire.BodyTypingState, Body: []byte{}}
	shared := ccwireFrame(msg)
	a.deliverOne(msg, shared)
	a.deliverOne(msg, shared)
	b.deliverOne(msg, shared)

	if a.cursors[ccwireStreamMessaging] != 2 {
		t.Fatalf("session A cursor = %d, want 2", a.cursors[ccwireStreamMessaging])
	}
	if b.cursors[ccwireStreamMessaging] != 1 {
		t.Fatalf("session B cursor = %d, want 1 — counters are shared", b.cursors[ccwireStreamMessaging])
	}
}

func TestFragmentedAppEventSequencesEveryFragment(t *testing.T) {
	// A fragmented event is several frames on the wire, and a client tracking
	// positions has to be able to name any of them. Sequencing only the first
	// would make a resume mid-event unserviceable.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	s.appEvents = true
	got := capture(s)

	big := make([]byte, 0, 900_000)
	for len(big) < 900_000 {
		big = append(big, 'x')
	}
	msgs, frames := appEventBuild("echo", map[string]any{"blob": string(big)})
	if len(frames) < 2 {
		t.Skipf("payload did not fragment (%d frame(s)); nothing to prove here", len(frames))
	}
	s.deliver(msgs, frames)

	if len(*got) != len(frames) {
		t.Fatalf("delivered %d of %d fragments", len(*got), len(frames))
	}
	for i, w := range *got {
		f, err := ccwire.Decode(w, ccwire.Options{MaxBytes: ccwire.DefaultLimits().MaxFrameBytes})
		if err != nil {
			t.Fatalf("fragment %d did not decode: %v", i, err)
		}
		m, err := ccwire.DecodeMessage(f.Payload, ccwire.DefaultLimits(), 1<<20, 0)
		if err != nil {
			t.Fatalf("fragment %d body did not decode: %v", i, err)
		}
		if m.Seq != uint64(i+1) {
			t.Fatalf("fragment %d carries seq %d, want %d", i, m.Seq, i+1)
		}
	}
}

// ── the two halves agree on the bytes ───────────────────────────────

func TestGoParsesTheBytesTheTSClientEncodes(t *testing.T) {
	// These byte arrays are asserted on the other side too, in
	// lib/ccwire/resume.selftest.ts checks 7 and 9. Pinning the same literals in
	// both places is what makes this a parity test rather than two independent
	// implementations that each believe themselves.
	//
	// Encoding the expectation with our own encoder would only prove
	// self-consistency, which is exactly the bug a cross-language protocol has.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(s)
	sendN(t, s, 2, 300)

	// Ping.progress: 12 05 08 02 10 AC 02 — progress{stream: 2, seq: 300}.
	s.noteProgress([]byte{0x12, 0x05, 0x08, 0x02, 0x10, 0xac, 0x02})
	if s.acked[2] != 300 {
		t.Fatalf("acked = %d, want 300 from the TS-encoded progress", s.acked[2])
	}

	// ClientHello.resume_from StreamCursor: 08 02 10 07.
	stream, seq, ok := parseStreamCursor([]byte{0x08, 0x02, 0x10, 0x07}, ccwire.DefaultLimits())
	if !ok || stream != 2 || seq != 7 {
		t.Fatalf("parsed StreamCursor(%d, %d, ok=%v), want (2, 7, true)", stream, seq, ok)
	}
}

func TestProgressDrainsTheWindowOnTheLiveSession(t *testing.T) {
	// The end of the loop: the client reports, the window releases. Without it
	// every window fills to its ceiling and parks there.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(s)
	sendN(t, s, 2, 10)
	if s.replay.len() != 10 {
		t.Fatalf("window holds %d before any progress", s.replay.len())
	}

	// progress{stream: 2, seq: 7}
	s.noteProgress([]byte{0x12, 0x04, 0x08, 0x02, 0x10, 0x07})

	if s.replay.len() != 3 {
		t.Fatalf("window holds %d after acking 7 of 10, want 3", s.replay.len())
	}
}

// ── the remaining acceptance cases from the resume plan ─────────────

func TestReceiptFramesReplayLikeAnyOther(t *testing.T) {
	// Acceptance 7.4. The window holds encoded bytes and never looks inside
	// them, so body type cannot matter — but "cannot matter" is the kind of
	// claim that is worth one test rather than one sentence.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	sent := capture(first)
	body := ccwire.AppendStringField(nil, 1, "chat-1")
	body = ccwire.AppendVarintField(body, 2, uint64(ccwire.ReceiptKindRead))
	first.send(ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: ccwireStreamMessaging,
		Seq: 1, BodyField: ccwire.BodyReceipt, Body: body})
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	got := capture(second)
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok, resumeFrom: map[uint32]uint64{ccwireStreamMessaging: 0}})
	if !second.resumed {
		t.Fatal("a receipt gap was refused")
	}
	second.flushReplay()

	if len(*got) != 1 || !bytes.Equal((*got)[0], (*sent)[0]) {
		t.Fatal("the replayed receipt is not the frame that was sent")
	}
}

func TestResumeRefusedAfterTheWindowAgesOut(t *testing.T) {
	// Acceptance 7.10. replayMaxAge is shorter than resumeLifetime on purpose:
	// a session can still be resumable after its frames have expired, and that
	// case must refuse rather than serve what is left.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	sendN(t, first, 2, 3)
	// Age every retained frame out, then retain one fresh frame so the ring is
	// not simply empty — a stale window and an empty one must both refuse.
	first.replay.retain(replayMsg(2, 4), frameOf(16), time.Now().Add(replayMaxAge+time.Minute))
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok, resumeFrom: map[uint32]uint64{2: 0}})

	if second.resumed {
		t.Fatal("a resume whose frames had aged out was served instead of refused")
	}
}

func TestResumeRefusedWhenTheCursorIsBehindTheWindow(t *testing.T) {
	// Acceptance 7.12. The client is further behind than the ring reaches. The
	// frames between its position and the oldest retained one are simply gone,
	// and serving from the oldest would hand it a stream with a hole.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	for i := uint64(1); i <= replayMaxFrames+50; i++ {
		first.send(ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2, Seq: i,
			BodyField: ccwire.BodyTypingState, Body: []byte{}})
	}
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok, resumeFrom: map[uint32]uint64{2: 1}})

	if second.resumed {
		t.Fatal("a cursor behind the window was served instead of refused")
	}
}

// ── defects found in the re-audit ───────────────────────────────────

// ceilingMessage returns the largest frame that encodes WITHOUT a seq.
//
// Found by bisection rather than by arithmetic on purpose: hard-coding the
// field overhead would make the test agree with today's encoder rather than
// with the actual ceiling, and quietly stop testing anything the day a field
// is added.
func ceilingMessage(t *testing.T) ccwire.Message {
	t.Helper()
	build := func(n int) ccwire.Message {
		return ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2,
			BodyField: ccwire.BodyTypingState, Body: make([]byte, n)}
	}
	lo, hi := 0, ccwire.DefaultLimits().MaxFrameBytes
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if ccwireFrame(build(mid)) != nil {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	m := build(lo)
	if ccwireFrame(m) == nil {
		t.Fatalf("bisection produced an unencodable body at %d bytes", lo)
	}
	// The same message WITH a seq must not fit — otherwise this test proves
	// nothing about the boundary it was written for.
	seqd := m
	seqd.Seq = 1
	if ccwireFrame(seqd) != nil {
		t.Fatalf("a seq at the %d-byte ceiling still fits; the boundary moved", lo)
	}
	return m
}

func TestSequenceContinuesAfterAResume(t *testing.T) {
	// The resumed session MUST keep counting from where the parked one stopped.
	//
	// Restarting at 1 is not a cosmetic problem. noteSent is monotonic, so every
	// new frame after a resume would be below the restored cursor and move
	// nothing; the cursor would freeze at its parked value for the life of the
	// session, the client's reported position would never be reachable again,
	// the window would never release, and the next resume would refuse. One
	// missing line, and resume works exactly once per client.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	sendN(t, first, 2, 5)
	first.noteAcked(2, 5)
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	got := capture(second)
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok, resumeFrom: map[uint32]uint64{2: 5}})
	if !second.resumed {
		t.Fatal("resume refused")
	}
	second.flushReplay()

	msg := ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2,
		BodyField: ccwire.BodyTypingState, Body: []byte{}}
	second.deliverOne(msg, ccwireFrame(msg))

	if len(*got) != 1 {
		t.Fatalf("wrote %d frames, want the one new frame", len(*got))
	}
	f, err := ccwire.Decode((*got)[0], ccwire.Options{MaxBytes: ccwire.DefaultLimits().MaxFrameBytes})
	if err != nil {
		t.Fatalf("frame did not decode: %v", err)
	}
	m, err := ccwire.DecodeMessage(f.Payload, ccwire.DefaultLimits(), 1<<20, 0)
	if err != nil {
		t.Fatalf("body did not decode: %v", err)
	}
	if m.Seq != 6 {
		t.Fatalf("first frame after resume carries seq %d, want 6", m.Seq)
	}
	if second.cursors[2] != 6 {
		t.Fatalf("cursor = %d after the first post-resume frame, want 6", second.cursors[2])
	}
}

func TestOversizedPerSessionEncodeDoesNotLoseTheFrame(t *testing.T) {
	// deliver() re-encodes with a seq, which makes the frame a few bytes larger
	// than the shared one the fragmentation decision was made against. A frame
	// sitting just under the ceiling therefore encodes fine for everyone else
	// and fails here — and dropping it would mean a resuming session silently
	// misses a message every other session receives.
	//
	// The rule is the same as everywhere else in this change: degrade to
	// today's behaviour. Send the shared bytes, hole the window, let the next
	// resume refuse.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	got := capture(s)

	msg := ceilingMessage(t)
	shared := ccwireFrame(msg)
	s.deliverOne(msg, shared)

	if len(*got) != 1 {
		t.Fatalf("a frame that could not be sequenced was DROPPED (%d written)", len(*got))
	}
	if !bytes.Equal((*got)[0], shared) {
		t.Fatal("the fallback did not send the shared bytes")
	}
	// And the window must know it cannot serve that point.
	if _, ok := s.replay.since(map[uint32]uint64{2: 0}, map[uint32]uint64{2: 1}); ok {
		t.Fatal("the window claimed it could serve a gap across an unsequenced frame")
	}
}

func TestPartialFailureDoesNotAbandonTheRestOfAnEvent(t *testing.T) {
	// A fragmented event is several frames. Returning on the first failure
	// would deliver a prefix of an event the client then waits forever to
	// reassemble.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	got := capture(s)

	ok1 := ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2,
		BodyField: ccwire.BodyTypingState, Body: []byte{}}
	bad := ceilingMessage(t)
	msgs := []ccwire.Message{bad, ok1}
	shared := [][]byte{ccwireFrame(bad), ccwireFrame(ok1)}
	s.deliver(msgs, shared)

	if len(*got) != 2 {
		t.Fatalf("delivered %d of 2 frames — a failure abandoned the rest", len(*got))
	}
}

func TestParkHandsTheWindowOverRatherThanSharingIt(t *testing.T) {
	// A fan-out that snapshotted its targets just before this session
	// unregistered can still call deliver() afterwards. If the session were
	// still holding the window, that late call would mutate memory the store
	// now owns and has already charged to its byte budget — a data race and a
	// wrong number at the same time.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(s)
	sendN(t, s, 2, 3)

	tok := s.parkForResume()
	if tok == "" {
		t.Fatal("park produced no token")
	}
	if s.replay != nil {
		t.Fatal("the session still holds the window it parked")
	}
	charged := h.resume.replayBytes
	if charged == 0 {
		t.Fatal("park charged nothing to the budget")
	}

	// The late fan-out. It must touch nothing.
	msg := ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: 2,
		BodyField: ccwire.BodyTypingState, Body: []byte{}}
	s.deliverOne(msg, ccwireFrame(msg))

	if h.resume.replayBytes != charged {
		t.Fatalf("a late delivery changed the parked budget: %d -> %d", charged, h.resume.replayBytes)
	}
	p, ok := h.resume.take(tok, "u1", "dev-1")
	if !ok {
		t.Fatal("take failed")
	}
	if p.replay.len() != 3 {
		t.Fatalf("the parked window holds %d frames, want the 3 it was parked with", p.replay.len())
	}
}

func TestParkSnapshotsCursorsRatherThanSharingTheMap(t *testing.T) {
	// The parked entry must not alias the live session's cursor map: a late
	// send would then move a position the resume is about to be validated
	// against.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(s)
	sendN(t, s, 2, 2)
	tok := s.parkForResume()

	s.noteSent(ccwire.Message{Stream: 2, Seq: 99})

	p, ok := h.resume.take(tok, "u1", "dev-1")
	if !ok {
		t.Fatal("take failed")
	}
	if p.cursors[2] != 2 {
		t.Fatalf("parked cursor moved to %d after parking", p.cursors[2])
	}
}

func TestDrainAnnouncesItselfAsDrainingNotAsAFault(t *testing.T) {
	// errors.proto has SERVER_DRAINING (14) and INTERNAL (15) and the
	// difference is the whole message: draining means "planned shutdown, come
	// back", internal means "something broke". A client that cannot tell them
	// apart treats every rolling deploy as a fault — and the clients that back
	// off hardest on faults are slowest to return exactly when the fleet needs
	// them to.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	got := capture(s)

	if !s.sendGoAway(errServerDraining, 2000) {
		t.Fatal("GoAway was not sent")
	}
	if len(*got) != 1 {
		t.Fatalf("wrote %d frames, want 1", len(*got))
	}
	f, err := ccwire.Decode((*got)[0], ccwire.Options{MaxBytes: ccwire.DefaultLimits().MaxFrameBytes})
	if err != nil {
		t.Fatalf("GoAway did not decode: %v", err)
	}
	m, err := ccwire.DecodeMessage(f.Payload, ccwire.DefaultLimits(), 1<<20, 0)
	if err != nil {
		t.Fatalf("GoAway body did not decode: %v", err)
	}
	if m.BodyField != ccwire.BodyGoAway {
		t.Fatalf("body field %d, want GoAway", m.BodyField)
	}
	// reason = 1, drain_deadline_ms = 3. No resume_token (4): parked state dies
	// with the process, so offering one would promise a restore this server
	// will not be alive to perform.
	r := pbr{b: m.Body}
	var reason, drain uint64
	sawToken := false
	for r.p < len(r.b) {
		tag, ok := r.varint()
		if !ok {
			t.Fatal("malformed GoAway body")
		}
		switch field, wire := uint32(tag>>3), uint8(tag&7); {
		case field == 1 && wire == 0:
			reason, _ = r.varint()
		case field == 3 && wire == 0:
			drain, _ = r.varint()
		case field == 4:
			sawToken = true
			if !r.skip(wire, ccwire.DefaultLimits()) {
				t.Fatal("malformed GoAway body")
			}
		default:
			if !r.skip(wire, ccwire.DefaultLimits()) {
				t.Fatal("malformed GoAway body")
			}
		}
	}
	if reason != uint64(errServerDraining) {
		t.Fatalf("GoAway reason = %d, want SERVER_DRAINING (%d)", reason, errServerDraining)
	}
	if drain != 2000 {
		t.Fatalf("drain_deadline_ms = %d, want 2000", drain)
	}
	if sawToken {
		t.Fatal("GoAway offered a resume token this process will not outlive")
	}
}

// ── the window's floor ──────────────────────────────────────────────

func TestAnEmptyWindowDoesNotClaimCompleteness(t *testing.T) {
	// The most dangerous shape this file has held: resumed=true with a silent
	// gap.
	//
	// A healthy connection acknowledges, release() empties the window, and the
	// "too old" check lived INSIDE the loop over retained frames. With no
	// frames left that loop never ran, nothing refused, and a client asking
	// from a position below what was acknowledged was told it had missed
	// nothing. The frames between were already released and unrecoverable.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	sendN(t, first, 2, 12)
	first.noteAcked(2, 12) // healthy: the window is now empty
	if first.replay.len() != 0 {
		t.Fatalf("window holds %d after a full ack", first.replay.len())
	}
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok,
		resumeFrom: map[uint32]uint64{2: 10}})

	if second.resumed {
		t.Fatal("a resume from below the released floor was served as complete")
	}
}

func TestSilenceAboutAStreamIsNotAClaimToHaveIt(t *testing.T) {
	// A client that reports nothing for a stream the session sent on has told
	// us nothing about it. Reading that as completeness is the same silent gap
	// arrived at from the other direction.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	sendN(t, first, 2, 3)
	first.noteAcked(2, 3)
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok,
		resumeFrom: map[uint32]uint64{}})

	if second.resumed {
		t.Fatal("a resume reporting no position for a live stream was served")
	}
}

func TestAFullyAcknowledgedSessionStillResumes(t *testing.T) {
	// The other half of the floor: a client that HAS everything must not be
	// punished. An empty window plus an honest report equals nothing to replay,
	// which is a successful resume with zero frames — the commonest case there
	// is, and the one a too-eager refusal would turn into a full resync.
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(first)
	sendN(t, first, 2, 12)
	first.noteAcked(2, 12)
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	got := capture(second)
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok,
		resumeFrom: map[uint32]uint64{2: 12}})

	if !second.resumed {
		t.Fatal("a client that had everything was refused")
	}
	if !second.flushReplay() || len(*got) != 0 {
		t.Fatalf("replayed %d frames to a client that was already current", len(*got))
	}
}

// ── revocation, and what the parked table holds ─────────────────────

func TestLogoutTakesTheTokenFromALiveSession(t *testing.T) {
	// forgetUID only walks the PARKED table, and a live session's token is not
	// in it — the token is minted at ServerHello and only reaches the store
	// when the session parks. So revocation was a no-op against exactly the
	// sessions still running: log out, stay connected, drop later, and the
	// connection parks under the credential the logout was meant to destroy.
	h := &Hub{resume: newResumeStore()}
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(s)
	h.cwmu.Lock()
	if h.cwSessions == nil {
		h.cwSessions = map[string]map[*ccwireSession]struct{}{}
	}
	h.cwSessions["u1"] = map[*ccwireSession]struct{}{s: {}}
	h.cwmu.Unlock()

	if n := h.InvalidateResume("u1"); n != 1 {
		t.Fatalf("InvalidateResume reported %d revocations, want 1", n)
	}
	if s.resumeToken != "" {
		t.Fatal("a live session kept its resume token through a revocation")
	}
	// And with no token it cannot park, so nothing can resume it later.
	if tok := s.parkForResume(); tok != "" {
		t.Fatalf("a revoked session parked anyway, under %q", tok)
	}
}

func TestRevocationLeavesOtherUsersAlone(t *testing.T) {
	h := &Hub{resume: newResumeStore()}
	mine := sessionOn(h, "u1", "dev-1", "sess-1")
	theirs := sessionOn(h, "u2", "dev-2", "sess-2")
	h.cwmu.Lock()
	h.cwSessions = map[string]map[*ccwireSession]struct{}{
		"u1": {mine: {}},
		"u2": {theirs: {}},
	}
	h.cwmu.Unlock()

	h.InvalidateResume("u1")

	if theirs.resumeToken == "" {
		t.Fatal("revoking one user took another user's token")
	}
}

func TestTheParkedTableHoldsNoPlaintextToken(t *testing.T) {
	// tokenHash is documented as existing so a memory dump yields nothing
	// usable. The table was then KEYED by the plaintext token, which put every
	// live credential in memory in the clear for the whole resume lifetime —
	// and made the constant-time compare dead code, because a map[string]
	// lookup had already proven exact equality.
	r := newResumeStore()
	s := testSession("u1", "d1", "s1")
	tok, ok := parkTest(r, s, map[uint32]uint64{2: 1}, 1)
	if !ok {
		t.Fatal("park failed")
	}
	r.mu.Lock()
	_, plaintext := r.byToken[tok]
	r.mu.Unlock()
	if plaintext {
		t.Fatal("the parked table is keyed by the plaintext token")
	}
	// And it still resolves, so the hashing did not break the lookup.
	if _, ok := r.take(tok, "u1", "d1"); !ok {
		t.Fatal("a valid token no longer resolves")
	}
}

// ── the lock cycle ──────────────────────────────────────────────────

func TestSubscribeRefusalDoesNotDeadlockAgainstDelivery(t *testing.T) {
	// Two acquisition orders on one session is a deadlock, and this one was
	// created by adding the position lock to send():
	//
	//   deliver()        pos.mu  -> closeMu   (enqueue reads s.closed)
	//   joinEventRoom()  closeMu -> pos.mu    (sendError writes to the socket)
	//
	// One Subscribe past the limit, concurrent with a fan-out to the same
	// session, wedges both goroutines permanently — and closeOnce() needs
	// closeMu too, so the socket is never closed, drain() never exits, and the
	// session leaks with pos.mu held forever. Nothing times out; the connection
	// simply stops.
	//
	// The test is a race by construction, so it hammers rather than trying once.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(s)
	s.subs = map[string]struct{}{}
	for i := 0; i < ccwireMaxSubscriptions; i++ {
		s.subs[fmt.Sprintf("chat:%d", i)] = struct{}{}
	}

	msg := ccwire.Message{TrafficClass: ccwire.TrafficClassMessaging, Stream: ccwireStreamMessaging,
		BodyField: ccwire.BodyTypingState, Body: []byte{}}
	shared := ccwireFrame(msg)

	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		for i := 0; i < 200; i++ {
			wg.Add(2)
			go func() { defer wg.Done(); s.joinEventRoom("chat:one-too-many") }()
			go func() { defer wg.Done(); s.deliverOne(msg, shared) }()
			wg.Wait()
		}
	}()

	select {
	case <-done:
	case <-time.After(20 * time.Second):
		// Deliberately a timeout and not a lock-order assertion: the failure
		// being guarded against is that the goroutines never return at all.
		t.Fatal("deadlock: a refused Subscribe and a delivery wedged each other")
	}
}

// ── traffic that happened while the session was parked ──────────────

func TestResumeRefusedWhenTrafficArrivedWhileParked(t *testing.T) {
	// The hole the replay window cannot see. A parked session is not in
	// h.cwSessions, so a fan-out never reaches it: no seq is allocated, nothing
	// is retained, and no hole is recorded. since() therefore has nothing to
	// refuse on and answers "nothing missing" — for the message the client
	// missed during exactly the tunnel this feature exists to cover.
	h := &Hub{resume: newResumeStore()}
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(s)
	sendN(t, s, 2, 3)
	s.noteAcked(2, 3)
	tok := s.parkForResume()
	if tok == "" {
		t.Fatal("park produced no token")
	}

	// A message for this user while nobody is connected.
	h.resume.noteTraffic("u1")

	second := sessionOn(h, "u1", "dev-1", "")
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok,
		resumeFrom: map[uint32]uint64{2: 3}})

	if second.resumed {
		t.Fatal("resumed a session that missed a fan-out while parked")
	}
}

func TestTrafficBeforeParkingDoesNotRefuseTheResume(t *testing.T) {
	// The counter must not blame a park for a fan-out that preceded it, or
	// every reconnect on a busy account becomes a resync.
	h := &Hub{resume: newResumeStore()}
	h.resume.noteTraffic("u1") // nobody parked: recorded nowhere
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	capture(s)
	sendN(t, s, 2, 2)
	s.noteAcked(2, 2)
	tok := s.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	second.tryResume(clientHello{deviceID: "dev-1", resumeToken: tok,
		resumeFrom: map[uint32]uint64{2: 2}})

	if !second.resumed {
		t.Fatal("a resume was refused for traffic that predated the park")
	}
}

func TestTheMissedTrafficCounterIsPrunedWithTheLastParkedSession(t *testing.T) {
	// A per-uid counter that outlives the sessions it shadows is a slow leak
	// wearing a bound's clothes.
	r := newResumeStore()
	s := testSession("u1", "d1", "s1")
	s.replay = newReplayWindow()
	tok, _ := parkTest(r, s, map[uint32]uint64{2: 1}, 1)
	r.noteTraffic("u1")

	r.mu.Lock()
	tracked := len(r.missedByUID) + len(r.parkedByUID)
	r.mu.Unlock()
	if tracked == 0 {
		t.Fatal("nothing was tracked while a session was parked")
	}

	if _, ok := r.take(tok, "u1", "d1"); ok {
		t.Fatal("a session that missed traffic resumed")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.missedByUID) != 0 || len(r.parkedByUID) != 0 {
		t.Fatalf("counters survived the last parked session: missed=%v parked=%v",
			r.missedByUID, r.parkedByUID)
	}
}
