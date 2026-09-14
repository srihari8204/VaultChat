package realtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

// The DISPATCH wiring, as distinct from the handlers behind it.
//
// ccwire_fragment_test.go drives serveFragment directly and proves the
// reassembler. That leaves the seam this file covers: that handle() actually
// ROUTES body 112 there, creates the per-session reassembler on demand, and
// keeps it per-session. A handler nothing reaches is not served, and the
// difference is invisible to a test that calls the handler itself.

// A fragment must no longer be answered UNKNOWN_OPERATION by the dispatch.
// TestCCWireAnswersUnservedOperations pins the complement of this.
func TestDispatchRoutesFragmentToTheReassembler(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)

	if s.frag != nil {
		t.Fatal("a session that has never seen a fragment should not carry a reassembler")
	}
	alive := s.handle(frame(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassMessaging,
		BodyField:    ccwire.BodyFragment,
	}))
	if !alive {
		t.Fatal("a malformed fragment must not kill the session")
	}
	if got := errorCodeOf(t, f.last(t)); got == errUnknownOperation {
		t.Fatal("body 112 is still answered UNKNOWN_OPERATION — the dispatch case is " +
			"not routing to serveFragment, so the reassembler is unreachable")
	}
	if s.frag == nil {
		t.Fatal("the dispatch did not create the per-session reassembler")
	}
}

// The reassembler is per session on purpose: a shared one would let any client
// evict or observe another client's partial sets. Prove two sessions do not
// share one.
func TestDispatchGivesEachSessionItsOwnReassembler(t *testing.T) {
	a, _ := newSession("u1", map[string]cachedPerm{})
	b, _ := newSession("u2", map[string]cachedPerm{})
	hello(t, a)
	hello(t, b)

	body := frame(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassMessaging,
		BodyField:    ccwire.BodyFragment,
	})
	a.handle(body)
	b.handle(body)

	if a.frag == nil || b.frag == nil {
		t.Fatal("both sessions should have a reassembler after dispatching a fragment")
	}
	if a.frag == b.frag {
		t.Fatal("two sessions share one reassembler — one client can evict or observe " +
			"another's partial fragment sets")
	}
}

// cursor_batch (65) must stay OUTBOUND. cursor.proto gives it `more` and a
// server-authored `continuation`; a client cannot author either, so accepting
// one inbound would be serving a reply shape as a request.
func TestDispatchDoesNotServeCursorBatchInbound(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)

	if !s.handle(frame(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassMessaging,
		BodyField:    ccwire.BodyCursorBatch,
	})) {
		t.Fatal("an unserved operation must not kill the session")
	}
	if got := errorCodeOf(t, f.last(t)); got != errUnknownOperation {
		t.Fatalf("cursor_batch is being served inbound (code %d). It is the REPLY "+
			"shape - see cursor.proto: `more` and a server-authored `continuation`.", got)
	}
}

// Catch-up is throttled per session.
//
// ccwire_messages.go routes SENDS through the REST handler specifically so
// CC-Wire inherits chatsMessagePost's rate limit. chatsDelta has none, and each
// cursor_sync additionally costs an owner lookup over up to 256 ids inside an
// RLS transaction plus a MAX(id) read - so one authenticated socket looping the
// frame was unbounded database work with no limiter anywhere in the path.
func TestCursorSyncIsRateLimitedPerSession(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)

	// An EMPTY body on purpose. The throttle runs first and admits this frame
	// (stamping lastCursorAt), then the decode refuses it - so the first call
	// never reaches the database, which is not configured in this package's
	// tests. What is under test is the throttle, not the query.
	if !s.cursorSync(cursorFrame(nil)) {
		t.Fatal("a malformed catch-up must not kill the session")
	}
	if got := errorCodeOf(t, f.last(t)); got == errRateLimited {
		t.Fatal("the FIRST catch-up on a fresh session was rate limited")
	}
	first := len(f.out)

	if !s.cursorSync(cursorFrame(nil)) {
		t.Fatal("a throttled frame must not kill the session")
	}
	if len(f.out) == first {
		t.Fatal("the second immediate catch-up produced no reply at all")
	}
	if got := errorCodeOf(t, f.last(t)); got != errRateLimited {
		t.Fatalf("a second immediate catch-up should be RATE_LIMITED, got %d - one "+
			"socket can loop cursor_sync and drive unbounded delta queries", got)
	}

	// RETRYABLE, not fatal: the client must back off, not lose the transport.
	// (sendError's class table; PAYLOAD_INVALID used to get this wrong.)
	if !s.closed && len(f.out) > 0 {
		m := f.last(t)
		fields := pbFields(t, m.Body)
		if len(fields[2]) == 0 || fields[2][0].num != 1 {
			t.Fatal("rate-limit refusals must be ERROR_CLASS_RETRYABLE (1), or the " +
				"client tears the transport down instead of backing off")
		}
	}
}

// The CC-Wire marker must be UNFORGEABLE.
//
// It gates the cold-sync clamp in chatsDelta, and it started life as an
// `X-CCWire: 1` header stamped by the loopback. The comment claimed "set from
// the server side, never from a payload, so a client cannot clear it" — true of
// the loopback and false of the route, because GET /chats/delta is on the
// PUBLIC mux, so any authenticated client could send the header itself and
// trigger its own clamp.
//
// It is a context value under an unexported key now. A header cannot produce
// one, which is the whole point.
func TestCCWireMarkerCannotBeForgedByAHeader(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/chats/delta?since=5", nil)
	req.Header.Set("X-CCWire", "1")
	req.Header.Set("x-ccwire", "1")
	if IsCCWire(req) {
		t.Fatal("a client-supplied header still marks a request as CC-Wire — the " +
			"cold-sync clamp can be triggered by any authenticated caller")
	}

	// And the real thing still reports true, or the clamp is dead and CC-Wire
	// cold starts stream full account history again.
	marked := req.WithContext(context.WithValue(req.Context(), ccwireCtxKey{}, true))
	if !IsCCWire(marked) {
		t.Fatal("the loopback marker is not recognised; the cold-sync clamp never fires")
	}

	// Nil-safe: IsCCWire is called from a handler that must not panic.
	if IsCCWire(nil) {
		t.Fatal("a nil request reported as CC-Wire")
	}
}
