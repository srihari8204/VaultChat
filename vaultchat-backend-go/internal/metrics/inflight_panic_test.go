package metrics

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// A handler panic must not strand vaultchat_http_inflight.
//
// net/http recovers a handler panic, so the process survives and the operator
// sees nothing wrong -- which is exactly why this was worth a test. Before the
// fix, inflight.Add(-1) sat below next.ServeHTTP as a plain statement and was
// skipped on the panic path, so the gauge only ever climbed. One panicking
// handler was enough to leave it permanently overstated and any alert built on
// it permanently red. A metric that lies about the system is worse than one
// that is missing, because people act on it.
func TestInflightReturnsToZeroAfterHandlerPanic(t *testing.T) {
	start := inflight.Load()

	h := Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))

	func() {
		// httptest.NewRecorder is not an http.Server, so nothing recovers for
		// us here; catch it so the test reports rather than dies.
		defer func() {
			if recover() == nil {
				t.Error("handler did not panic -- this test is no longer testing anything")
			}
		}()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/panics", nil))
	}()

	if got := inflight.Load(); got != start {
		t.Errorf("inflight leaked: %d before, %d after a panicking request (want %d)", start, got, start)
	}
}

// The ordinary path must still balance -- a deferred decrement that fired twice,
// or not at all, would show up here and not above.
func TestInflightReturnsToZeroAfterNormalRequest(t *testing.T) {
	start := inflight.Load()

	h := Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := inflight.Load(); got != start+1 {
			t.Errorf("inflight during request = %d, want %d", got, start+1)
		}
		w.WriteHeader(204)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/ok", nil))

	if got := inflight.Load(); got != start {
		t.Errorf("inflight after request = %d, want %d", got, start)
	}
}

// WrapTransport with a non-empty prefix is the CC-Wire loopback, which
// deliberately does NOT touch the global gauge (see the comment block in
// WrapTransport). Pinned here so nobody "fixes" the asymmetry by accident:
// those requests never crossed the network, and counting them would inflate
// the gauge on top of the long-lived WS upgrade already in flight.
func TestLoopbackTransportDoesNotTouchInflight(t *testing.T) {
	start := inflight.Load()

	h := WrapTransport(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := inflight.Load(); got != start {
			t.Errorf("loopback moved the global gauge to %d, want %d", got, start)
		}
		w.WriteHeader(200)
	}), "ccwire ")
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/chats", nil))

	if got := inflight.Load(); got != start {
		t.Errorf("inflight after loopback request = %d, want %d", got, start)
	}
}
