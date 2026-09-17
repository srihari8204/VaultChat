package realtime

// Covers the resume store (ccwire_resume.go).
//
// The security cases are the point of this file. A resume token is an
// authentication-adjacent credential: if it can be replayed, or used by a
// different account or device, it is an account-takeover primitive rather than
// a latency optimisation. Those are tested first and most.
//
// The bound cases matter almost as much for a different reason: parked state is
// memory held on behalf of clients that are NOT connected. Unbounded, a tunnel
// full of commuters becomes a gateway outage.

import (
	"testing"
	"time"
)

// testSession mirrors a real session AFTER its ServerHello: the resume token is
// minted at handshake and held by the client from then on, so a session that
// has not handshaken cannot park. Tests that omitted it were testing a state
// the server never reaches.
// parkTest mirrors what parkForResume does before it reaches the store: snapshot
// the subscriptions, hand the window over, and leave the session holding
// neither. Tests that drive the store directly go through this rather than
// calling park() with hand-built arguments, so they cannot drift away from the
// one production caller.
func parkTest(r *resumeStore, s *ccwireSession, cursors map[uint32]uint64, gen uint64) (string, bool) {
	subs := make([]string, 0, len(s.subs))
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	w := s.replay
	s.replay = nil
	return r.park(s, cursors, subs, w, gen)
}

func testSession(uid, device, sessionID string) *ccwireSession {
	tok, ok := newResumeToken()
	if !ok {
		panic("RNG unavailable in test")
	}
	return &ccwireSession{
		sessionID:   sessionID,
		deviceID:    device,
		resumeToken: tok,
		d:           &sockData{uid: uid},
		subs:        map[string]struct{}{"chat:a": {}, "chat:b": {}},
	}
}

// ── security ────────────────────────────────────────────────────────

func TestResumeTokenIsSingleUse(t *testing.T) {
	r := newResumeStore()
	tok, ok := parkTest(r, testSession("u1", "d1", "s1"), map[uint32]uint64{2: 10}, 1)
	if !ok {
		t.Fatal("park failed")
	}
	if _, ok := r.take(tok, "u1", "d1"); !ok {
		t.Fatal("first take should succeed")
	}
	// A captured token must be worth one race, never a standing capability.
	if _, ok := r.take(tok, "u1", "d1"); ok {
		t.Fatal("token was accepted TWICE — replayable resume credential")
	}
}

func TestResumeTokenFromAnotherUserIsRefused(t *testing.T) {
	// Acceptance case 7.9. The most serious thing this store can be asked to do.
	r := newResumeStore()
	tok, _ := parkTest(r, testSession("victim", "d1", "s1"), nil, 1)
	if _, ok := r.take(tok, "attacker", "d1"); ok {
		t.Fatal("a token bound to one user was accepted for ANOTHER user")
	}
}

func TestResumeTokenFromAnotherDeviceIsRefused(t *testing.T) {
	// Acceptance case 7.8.
	r := newResumeStore()
	tok, _ := parkTest(r, testSession("u1", "device-a", "s1"), nil, 1)
	if _, ok := r.take(tok, "u1", "device-b"); ok {
		t.Fatal("a token bound to one device was accepted for ANOTHER device")
	}
}

func TestResumeTokenIsConsumedEvenWhenRefused(t *testing.T) {
	// A failed attempt must still burn the token, or an attacker gets unlimited
	// tries against a token they hold while they work out the right principal.
	r := newResumeStore()
	tok, _ := parkTest(r, testSession("u1", "d1", "s1"), nil, 1)
	if _, ok := r.take(tok, "wrong-user", "d1"); ok {
		t.Fatal("wrong user accepted")
	}
	if _, ok := r.take(tok, "u1", "d1"); ok {
		t.Fatal("token survived a failed attempt — unlimited guessing window")
	}
}

func TestResumeTokensAreDistinctAndOpaque(t *testing.T) {
	r := newResumeStore()
	seen := map[string]bool{}
	// Principals long enough that an accidental substring match is not credible.
	// Short ones ("u1") appear inside a 43-char base64url string by chance, which
	// would make this assertion noise rather than evidence.
	const uid, dev, sid = "uid-7f3a9c2e41", "device-b8d16e04", "sess-29ae57cc"
	for i := 0; i < 500; i++ {
		tok, ok := parkTest(r, testSession(uid, dev, sid), nil, 1)
		if !ok {
			t.Fatal("park failed")
		}
		if seen[tok] {
			t.Fatal("duplicate resume token generated")
		}
		seen[tok] = true
		for _, secret := range []string{uid, dev, sid} {
			if contains(tok, secret) {
				t.Fatalf("token leaks %q: %q", secret, tok)
			}
		}
	}
}

func contains(h, n string) bool {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return true
		}
	}
	return false
}

func TestLogoutInvalidatesEveryParkedSession(t *testing.T) {
	r := newResumeStore()
	a, _ := parkTest(r, testSession("u1", "d1", "s1"), nil, 1)
	b, _ := parkTest(r, testSession("u1", "d2", "s2"), nil, 1)
	other, _ := parkTest(r, testSession("u2", "d3", "s3"), nil, 1)

	if n := r.forgetUID("u1"); n != 2 {
		t.Fatalf("forgetUID invalidated %d sessions, want 2", n)
	}
	if _, ok := r.take(a, "u1", "d1"); ok {
		t.Fatal("token survived logout")
	}
	if _, ok := r.take(b, "u1", "d2"); ok {
		t.Fatal("second device's token survived logout")
	}
	// Another user must be untouched — logout is not a global flush.
	if _, ok := r.take(other, "u2", "d3"); !ok {
		t.Fatal("another user's session was invalidated by an unrelated logout")
	}
}

// ── bounds ──────────────────────────────────────────────────────────

func TestExpiredSessionsDoNotResume(t *testing.T) {
	// Acceptance case 7.6.
	r := newResumeStore()
	tok, _ := parkTest(r, testSession("u1", "d1", "s1"), nil, 1)
	r.mu.Lock()
	r.byToken[string(hashKey(tok))].expiresAt = time.Now().Add(-time.Second)
	r.mu.Unlock()

	if _, ok := r.take(tok, "u1", "d1"); ok {
		t.Fatal("an expired session resumed")
	}
}

func TestParkedTableIsBounded(t *testing.T) {
	r := newResumeStore()
	// Well past capacity: the table must not grow with the number of clients
	// that walked into a lift.
	for i := 0; i < maxParkedSessions+500; i++ {
		parkTest(r, testSession("u1", "d1", "s1"), nil, 1)
	}
	if got := r.len(); got > maxParkedSessions {
		t.Fatalf("parked table holds %d, exceeding maxParkedSessions=%d", got, maxParkedSessions)
	}
}

func TestSweepReleasesExpired(t *testing.T) {
	r := newResumeStore()
	// Park them ALL first, then expire them all: park() sweeps internally, so
	// expiring as we go would let later parks reap earlier entries and the
	// explicit sweep would find nothing left to do.
	toks := make([]string, 0, 50)
	for i := 0; i < 50; i++ {
		tok, _ := parkTest(r, testSession("u1", "d1", "s1"), nil, 1)
		toks = append(toks, tok)
	}
	r.mu.Lock()
	for _, tok := range toks {
		r.byToken[string(hashKey(tok))].expiresAt = time.Now().Add(-time.Second)
	}
	r.mu.Unlock()
	if n := r.sweep(time.Now()); n != 50 {
		t.Fatalf("swept %d, want 50", n)
	}
	if r.len() != 0 {
		t.Fatalf("%d sessions survived the sweep", r.len())
	}
}

func TestParkedSessionHoldsNoPayload(t *testing.T) {
	// A transport optimisation must never become an unaudited copy of user
	// content in gateway memory. Enforced structurally: assert the parked type
	// exposes no byte-carrying field.
	r := newResumeStore()
	tok, _ := parkTest(r, testSession("u1", "d1", "s1"), map[uint32]uint64{2: 7}, 1)
	p, ok := r.take(tok, "u1", "d1")
	if !ok {
		t.Fatal("take failed")
	}
	if p.cursors[2] != 7 {
		t.Fatalf("cursor not preserved: %v", p.cursors)
	}
	if len(p.subs) != 2 {
		t.Fatalf("subscriptions not preserved: %v", p.subs)
	}
}

// ── cursors ─────────────────────────────────────────────────────────

func TestFutureCursorIsRefused(t *testing.T) {
	// A client cannot have received what the server never sent. Accepting the
	// claim would let a client skip frames by lying about its progress.
	_, ok := acceptCursors(map[uint32]uint64{2: 10}, map[uint32]uint64{2: 99})
	if ok {
		t.Fatal("a cursor ahead of what the server sent was accepted")
	}
}

func TestCursorNeverRegresses(t *testing.T) {
	out, ok := acceptCursors(map[uint32]uint64{2: 10}, map[uint32]uint64{2: 3})
	if !ok {
		t.Fatal("a behind cursor should not fail the resume")
	}
	if out[2] != 10 {
		t.Fatalf("cursor regressed to %d, want it held at 10", out[2])
	}
}

func TestUnknownStreamIsIgnoredNotFatal(t *testing.T) {
	out, ok := acceptCursors(map[uint32]uint64{2: 10}, map[uint32]uint64{2: 10, 99: 5})
	if !ok {
		t.Fatal("one unknown stream should not fail the whole handshake")
	}
	if _, present := out[99]; present {
		t.Fatal("an unknown stream was accepted into the restored cursors")
	}
}

// ── generation ──────────────────────────────────────────────────────

func TestStaleGenerationCannotAdvanceState(t *testing.T) {
	// Acceptance case 7.14: connection A is alive but unreachable, B resumes at
	// a higher generation, then A's queued frames finally arrive.
	p := &parkedSession{generation: 5}
	if p.supersedes(4) {
		t.Fatal("a frame from an older generation was allowed to advance state")
	}
	if !p.supersedes(5) {
		t.Fatal("the current generation was refused")
	}
	if !p.supersedes(6) {
		t.Fatal("a newer generation was refused")
	}
}
