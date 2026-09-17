package realtime

// Round-trip tests for resume: park a session, then present its token on a new
// connection and assert what is and is not restored.
//
// These cover the wiring the store tests cannot: ClientHello field parsing,
// tryResume's refusal paths, and the generation increment that makes a resumed
// connection authoritative over the one it replaced.

import (
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

// helloBytes builds a ClientHello the way a client would: device_id (5),
// optional resume_token (7), optional resume_from (8).
func helloBytes(deviceID, token string, cursors map[uint32]uint64) []byte {
	var b []byte
	b = ccwire.AppendVarintField(b, 1, 1) // protocol_major
	b = ccwire.AppendStringField(b, 5, deviceID)
	if token != "" {
		b = ccwire.AppendStringField(b, 7, token)
	}
	for stream, seq := range cursors {
		var sc []byte
		sc = ccwire.AppendVarintField(sc, 1, uint64(stream))
		sc = ccwire.AppendVarintField(sc, 2, seq)
		b = ccwire.AppendBytesField(b, 8, sc)
	}
	return b
}

func hubWithResume() *Hub { return &Hub{resume: newResumeStore()} }

// sessionOn mirrors a session after its ServerHello — see testSession.
func sessionOn(h *Hub, uid, device, sessionID string) *ccwireSession {
	tok, ok := newResumeToken()
	if !ok {
		panic("RNG unavailable in test")
	}
	return &ccwireSession{
		hub:         h,
		sessionID:   sessionID,
		deviceID:    device,
		resumeToken: tok,
		// Token and window together, as the handshake creates them. A session
		// holding a token but no window is not a state production can reach,
		// and a helper that builds one tests a session that does not exist.
		replay: newReplayWindow(),
		d:      &sockData{uid: uid},
		subs:   map[string]struct{}{},
		lim:    ccwire.DefaultLimits(),
	}
}

func TestClientHelloParsesResumeFields(t *testing.T) {
	body := helloBytes("dev-1", "tok-abc", map[uint32]uint64{2: 42})
	h, ok := ccwireParseClientHello(body, ccwire.DefaultLimits())
	if !ok {
		t.Fatal("parse failed")
	}
	if h.deviceID != "dev-1" {
		t.Fatalf("deviceID = %q", h.deviceID)
	}
	if h.resumeToken != "tok-abc" {
		t.Fatalf("resumeToken = %q", h.resumeToken)
	}
	if h.resumeFrom[2] != 42 {
		t.Fatalf("resumeFrom = %v", h.resumeFrom)
	}
}

func TestClientHelloWithoutResumeIsUnchanged(t *testing.T) {
	// The path every current client takes. It must parse exactly as before and
	// offer nothing.
	body := helloBytes("dev-1", "", nil)
	h, ok := ccwireParseClientHello(body, ccwire.DefaultLimits())
	if !ok {
		t.Fatal("parse failed")
	}
	if h.resumeToken != "" || len(h.resumeFrom) != 0 {
		t.Fatalf("a hello with no resume offered one: %+v", h)
	}
}

func TestTooManyResumeFromEntriesIsRefused(t *testing.T) {
	// envelope.proto bounds resume_from at 8 and there are only five streams.
	// Beyond that is malformed or hostile; either way it is refused rather than
	// allocated for.
	cursors := map[uint32]uint64{}
	for i := uint32(1); i <= 12; i++ {
		cursors[i] = uint64(i)
	}
	body := helloBytes("dev-1", "tok", cursors)
	if _, ok := ccwireParseClientHello(body, ccwire.DefaultLimits()); ok {
		t.Fatal("a ClientHello with 12 resume_from entries was accepted")
	}
}

func TestResumeRoundTripRestoresSubsAndCursors(t *testing.T) {
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	first.subs["chat:alpha"] = struct{}{}
	first.subs["chat:beta"] = struct{}{}
	first.cursors = map[uint32]uint64{2: 100, 3: 7}
	first.generation = 4

	tok := first.parkForResume()
	if tok == "" {
		t.Fatal("park produced no token")
	}

	// A new physical connection, same principal.
	second := sessionOn(h, "u1", "dev-1", "")
	second.tryResume(clientHello{
		deviceID:    "dev-1",
		resumeToken: tok,
		// BOTH streams. This used to report only stream 2, and the resume
		// succeeded anyway — which was the bug: silence about stream 3 was read
		// as "I have everything on it". A client must account for every stream
		// the session sent on, or the resume is refused.
		resumeFrom: map[uint32]uint64{2: 100, 3: 7},
	})

	if !second.resumed {
		t.Fatal("resume was refused for a valid token")
	}
	if second.sessionID != "sess-1" {
		t.Fatalf("sessionID = %q, want the parked one", second.sessionID)
	}
	if len(second.subs) != 2 {
		t.Fatalf("subscriptions not restored: %v", second.subs)
	}
	if second.cursors[2] != 100 || second.cursors[3] != 7 {
		t.Fatalf("cursors not restored: %v", second.cursors)
	}
	// The resumed connection must supersede the one that parked it.
	if second.generation != 5 {
		t.Fatalf("generation = %d, want 5 (parked 4 + 1)", second.generation)
	}
}

func TestResumeRefusedLeavesSessionFresh(t *testing.T) {
	// The safety property: a refused resume must look exactly like a fresh
	// connection, because that is what the client will be told to do.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "")
	s.tryResume(clientHello{deviceID: "dev-1", resumeToken: "not-a-real-token"})

	if s.resumed {
		t.Fatal("an unknown token produced resumed=true")
	}
	if s.sessionID != "" {
		t.Fatalf("a refused resume adopted a session id: %q", s.sessionID)
	}
	if len(s.subs) != 0 {
		t.Fatalf("a refused resume restored subscriptions: %v", s.subs)
	}
}

func TestResumeRefusedForFutureCursor(t *testing.T) {
	h := hubWithResume()
	first := sessionOn(h, "u1", "dev-1", "sess-1")
	first.cursors = map[uint32]uint64{2: 10}
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "dev-1", "")
	// Claiming progress the server never sent.
	second.tryResume(clientHello{
		deviceID:    "dev-1",
		resumeToken: tok,
		resumeFrom:  map[uint32]uint64{2: 9999},
	})
	if second.resumed {
		t.Fatal("a client that claimed unsent progress was resumed")
	}
}

func TestResumeAcrossDevicesIsRefusedEndToEnd(t *testing.T) {
	h := hubWithResume()
	first := sessionOn(h, "u1", "device-a", "sess-1")
	tok := first.parkForResume()

	second := sessionOn(h, "u1", "device-b", "")
	second.tryResume(clientHello{deviceID: "device-b", resumeToken: tok})
	if second.resumed {
		t.Fatal("a token parked on device-a resumed on device-b")
	}
}

func TestServerHelloReportsResumedOnlyWhenTrue(t *testing.T) {
	h := hubWithResume()

	fresh := sessionOn(h, "u1", "dev-1", "sess-1")
	freshBody := fresh.serverHello()
	if helloResumedFlag(freshBody) {
		t.Fatal("a fresh session reported resumed=true")
	}

	resumedSess := sessionOn(h, "u1", "dev-1", "sess-1")
	resumedSess.resumed = true
	if !helloResumedFlag(resumedSess.serverHello()) {
		t.Fatal("a resumed session did not report resumed=true")
	}
}

// helloResumedFlag reads ServerHello.resumed (field 8, varint).
func helloResumedFlag(body []byte) bool {
	r := pbr{b: body}
	lim := ccwire.DefaultLimits()
	for r.p < len(r.b) {
		tag, ok := r.varint()
		if !ok || tag>>3 == 0 {
			return false
		}
		field, wire := uint32(tag>>3), uint8(tag&7)
		if field == 8 && wire == 0 {
			v, ok := r.varint()
			return ok && v != 0
		}
		if !r.skip(wire, lim) {
			return false
		}
	}
	return false
}

func TestResumptionIsOffByDefault(t *testing.T) {
	// The safe-rollout property. With CCWIRE_RESUME unset the server must
	// behave exactly as it does today: no capability, no token, nothing for a
	// client to offer back.
	t.Setenv("CCWIRE_RESUME", "")
	if resumptionEnabled() {
		t.Fatal("resumption is enabled with the flag unset")
	}

	s := sessionOn(hubWithResume(), "u1", "dev-1", "sess-1")
	s.wantsResume = false
	s.resumeToken = ""
	body := s.serverHello()
	if helloHasField(body, 6) {
		t.Fatal("a resume_token was issued while the feature is off")
	}
}

func TestCapabilityRequiresBothSides(t *testing.T) {
	// Intersection, not union: the server must not claim resumption for a
	// client that did not ask, even when the deployment enabled it.
	s := sessionOn(hubWithResume(), "u1", "dev-1", "sess-1")
	s.wantsResume = false
	if capabilityHasResumption(s.capabilities()) {
		t.Fatal("resumption advertised to a client that never negotiated it")
	}

	s.wantsResume = true
	if !capabilityHasResumption(s.capabilities()) {
		t.Fatal("resumption withheld from a client that negotiated it and holds a token")
	}
}

func TestClientHelloCapabilityReaderDetectsResumption(t *testing.T) {
	lim := ccwire.DefaultLimits()
	var withCap []byte
	withCap = ccwire.AppendVarintField(withCap, 1, 1)
	withCap = ccwire.AppendBytesField(withCap, 3, ccwire.AppendBoolField(nil, 2, true))
	if !helloWantsResumption(withCap, lim) {
		t.Fatal("resumption capability not detected")
	}

	var without []byte
	without = ccwire.AppendVarintField(without, 1, 1)
	without = ccwire.AppendBytesField(without, 3, ccwire.AppendBoolField(nil, 1, true))
	if helloWantsResumption(without, lim) {
		t.Fatal("resumption detected in a hello that did not offer it")
	}
}

func helloHasField(body []byte, want uint32) bool {
	r := pbr{b: body}
	lim := ccwire.DefaultLimits()
	for r.p < len(r.b) {
		tag, ok := r.varint()
		if !ok || tag>>3 == 0 {
			return false
		}
		field, wire := uint32(tag>>3), uint8(tag&7)
		if field == want {
			return true
		}
		if !r.skip(wire, lim) {
			return false
		}
	}
	return false
}

func capabilityHasResumption(caps []byte) bool {
	r := pbr{b: caps}
	lim := ccwire.DefaultLimits()
	for r.p < len(r.b) {
		tag, ok := r.varint()
		if !ok || tag>>3 == 0 {
			return false
		}
		field, wire := uint32(tag>>3), uint8(tag&7)
		if field == 2 && wire == 0 {
			v, ok := r.varint()
			return ok && v != 0
		}
		if !r.skip(wire, lim) {
			return false
		}
	}
	return false
}

func TestCursorsAdvanceOnSend(t *testing.T) {
	// Without this the cursor half of resume is decorative: a parked session
	// would carry an empty map and acceptCursors would validate a claim against
	// nothing, while the metrics happily reported success.
	s := sessionOn(hubWithResume(), "u1", "dev-1", "sess-1")
	s.noteSent(ccwire.Message{Stream: 2, Seq: 5})
	s.noteSent(ccwire.Message{Stream: 2, Seq: 9})
	s.noteSent(ccwire.Message{Stream: 3, Seq: 1})
	if s.cursors[2] != 9 {
		t.Fatalf("stream 2 cursor = %d, want 9", s.cursors[2])
	}
	if s.cursors[3] != 1 {
		t.Fatalf("stream 3 cursor = %d, want 1", s.cursors[3])
	}
}

func TestCursorDoesNotGoBackwardsOnSend(t *testing.T) {
	// Streams are per-stream FIFO, so a lower seq means a bug upstream. Taking
	// it would move the cursor BACKWARDS and re-deliver on the next resume.
	s := sessionOn(hubWithResume(), "u1", "dev-1", "sess-1")
	s.noteSent(ccwire.Message{Stream: 2, Seq: 10})
	s.noteSent(ccwire.Message{Stream: 2, Seq: 4})
	if s.cursors[2] != 10 {
		t.Fatalf("cursor regressed to %d", s.cursors[2])
	}
}

func TestUnsequencedControlDoesNotMoveACursor(t *testing.T) {
	// ServerHello, Pong and Error carry no position. Recording them would
	// invent progress the stream never made.
	s := sessionOn(hubWithResume(), "u1", "dev-1", "sess-1")
	s.noteSent(ccwire.Message{Stream: 1, Seq: 0})
	if len(s.cursors) != 0 {
		t.Fatalf("unsequenced frame created a cursor: %v", s.cursors)
	}
}

func TestLogoutHookInvalidatesParkedSessions(t *testing.T) {
	// The security property: a resume token must not outlive the authority it
	// was issued under.
	h := hubWithResume()
	s := sessionOn(h, "u-logout", "dev-1", "sess-1")
	tok := s.parkForResume()
	if tok == "" {
		t.Fatal("park failed")
	}
	if n := h.InvalidateResume("u-logout"); n != 1 {
		t.Fatalf("InvalidateResume dropped %d, want 1", n)
	}
	if _, ok := h.resume.take(tok, "u-logout", "dev-1"); ok {
		t.Fatal("a token survived logout")
	}
}

func TestInvalidateResumeIsSafeWithoutRealtime(t *testing.T) {
	// Callers must not need to know whether CC-Wire is running.
	var nilHub *Hub
	if n := nilHub.InvalidateResume("u1"); n != 0 {
		t.Fatal("nil hub should invalidate nothing, not panic")
	}
	if n := (&Hub{}).InvalidateResume("u1"); n != 0 {
		t.Fatal("hub without a store should invalidate nothing, not panic")
	}
}

func TestPingProgressRecordsClientAcks(t *testing.T) {
	s := sessionOn(hubWithResume(), "u1", "dev-1", "sess-1")
	s.noteSent(ccwire.Message{Stream: 2, Seq: 50})

	// Ping{progress: [StreamCursor{stream: 2, last_delivered_seq: 30}]}
	var sc []byte
	sc = ccwire.AppendVarintField(sc, 1, 2)
	sc = ccwire.AppendVarintField(sc, 2, 30)
	s.noteProgress(ccwire.AppendBytesField(nil, 2, sc))

	if s.acked[2] != 30 {
		t.Fatalf("acked = %d, want 30", s.acked[2])
	}
}

func TestPingProgressCannotClaimPastWhatWeSent(t *testing.T) {
	// A client cannot have received what does not exist. Honouring the claim
	// would let it skip frames by lying.
	s := sessionOn(hubWithResume(), "u1", "dev-1", "sess-1")
	s.noteSent(ccwire.Message{Stream: 2, Seq: 10})

	var sc []byte
	sc = ccwire.AppendVarintField(sc, 1, 2)
	sc = ccwire.AppendVarintField(sc, 2, 9999)
	s.noteProgress(ccwire.AppendBytesField(nil, 2, sc))

	if _, present := s.acked[2]; present {
		t.Fatalf("a future ack was recorded: %v", s.acked)
	}
}

func TestPingProgressDoesNotRegress(t *testing.T) {
	s := sessionOn(hubWithResume(), "u1", "dev-1", "sess-1")
	s.noteSent(ccwire.Message{Stream: 2, Seq: 50})
	s.noteAcked(2, 40)
	s.noteAcked(2, 12) // stale or reordered ping
	if s.acked[2] != 40 {
		t.Fatalf("ack regressed to %d", s.acked[2])
	}
}

func TestParkRecordsWhatWasSentAsTheCeiling(t *testing.T) {
	// This test previously asserted the OPPOSITE — that park records the ACKED
	// position — and was changed deliberately when the replay window was wired
	// in. Recording the reversal rather than quietly rewriting it:
	//
	// While the parked cursor WAS the resume-from point, parking `sent` would
	// have told the next connection the client already had the frames that
	// never arrived. Replay moved that job elsewhere. The resume-from point now
	// comes from the client's own resume_from claim, and this number is the
	// CEILING that claim is checked against — "you cannot have received what I
	// never sent".
	//
	// An acked ceiling would be wrong for that question: a client that received
	// all 100 and lost only the ack would have its honest claim refused as a
	// future cursor, turning the most ordinary drop into a forced resync.
	h := hubWithResume()
	s := sessionOn(h, "u1", "dev-1", "sess-1")
	s.noteSent(ccwire.Message{Stream: 2, Seq: 100})
	s.noteAcked(2, 60)

	tok := s.parkForResume()
	p, ok := h.resume.take(tok, "u1", "dev-1")
	if !ok {
		t.Fatal("take failed")
	}
	if p.cursors[2] != 100 {
		t.Fatalf("parked ceiling = %d, want the SENT 100", p.cursors[2])
	}
	// The ceiling admits an honest claim anywhere up to it, and refuses beyond.
	if _, ok := acceptCursors(p.cursors, map[uint32]uint64{2: 100}); !ok {
		t.Fatal("a client that received everything was refused")
	}
	if _, ok := acceptCursors(p.cursors, map[uint32]uint64{2: 101}); ok {
		t.Fatal("a claim past what was sent was accepted")
	}
}

func TestRepeatedResumeFromEntriesAreBounded(t *testing.T) {
	// The bound counted len(map), so N entries naming the SAME stream collapsed
	// to one key and it never tripped. A hello packed with field-8 entries for
	// stream 2 made the server span() and parse every one of them while the
	// count stayed at 1.
	body := []byte{8, 1} // protocol_major
	cursor := []byte{0x08, 0x02, 0x10, 0x07}
	for i := 0; i < maxResumeFromEntries+4; i++ {
		body = append(body, 0x42, byte(len(cursor)))
		body = append(body, cursor...)
	}
	if _, ok := ccwireParseClientHello(body, ccwire.DefaultLimits()); ok {
		t.Fatal("a hello repeating one stream past the bound was accepted")
	}
}

func TestDuplicateResumeFromStreamIsRefused(t *testing.T) {
	// Two cursors for one stream: which is the truth? Refusing is the only
	// answer that does not involve picking one, and no conforming client sends
	// it — last-write-wins would let a client hide the lower position it
	// actually has behind a higher one it does not.
	body := []byte{8, 1}
	for _, seq := range []byte{7, 9} {
		body = append(body, 0x42, 4, 0x08, 0x02, 0x10, seq)
	}
	if _, ok := ccwireParseClientHello(body, ccwire.DefaultLimits()); ok {
		t.Fatal("a hello naming the same stream twice was accepted")
	}
}

func TestOverLongTagVarintIsRefusedOnTheLivePath(t *testing.T) {
	// internal/ccwire, the TypeScript codec and the Rust parser all cap a TAG
	// varint at five bytes and refuse anything longer as VARINT_OVERFLOW —
	// codec.json pins that refusal as a shared vector. This reader accepted
	// ten, which made the live handshake path accept bytes the frame layer of
	// the same server refuses: a parser differential one layer up.
	overlong := []byte{0x88, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00, 0x01}
	if _, ok := ccwireParseClientHello(overlong, ccwire.DefaultLimits()); ok {
		t.Fatal("an over-long tag varint was accepted")
	}
	// The same field number encoded canonically is still fine.
	if _, ok := ccwireParseClientHello([]byte{8, 1}, ccwire.DefaultLimits()); !ok {
		t.Fatal("a canonical hello was refused")
	}
}
