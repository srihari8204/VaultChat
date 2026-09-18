// ccwire_metrics_test.go — a CC-Wire send must show up in the scrape.
//
// The public mux is wrapped once at the listener (cmd/api/main.go); the CC-Wire
// mux is served directly by internal/realtime and inherits nothing, so it was
// silently unobserved: every message sent over CC-Wire contributed nothing to
// the per-route latency histogram while the identical HTTP send did. That is
// the failure instrumentation is worst at — it looks exactly like low traffic.
//
// No DB: the stub handler here is the point (this asserts the registration
// wrapper, not the chat handlers, which have their own CALL_TEST_DB tests).
package routes

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/metrics"
)

func routeCount(t *testing.T, route string) float64 {
	t.Helper()
	rec := httptest.NewRecorder()
	metrics.Handler(rec, httptest.NewRequest("GET", "/internal/metrics", nil))
	needle := fmt.Sprintf(`vaultchat_http_route_duration_ms_count{route=%q} `, route)
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		if strings.HasPrefix(line, needle) {
			var v float64
			if _, err := fmt.Sscanf(strings.TrimPrefix(line, needle), "%g", &v); err == nil {
				return v
			}
		}
	}
	return 0 // series absent — the path was never observed
}

// A route registered through ccwireHandle is observed exactly once, under its
// own transport-prefixed series rather than the HTTP one.
func TestCCWireRouteIsObserved(t *testing.T) {
	const pattern = "POST /chats/{id}/ccwire-metrics-probe"
	mux := http.NewServeMux()
	ccwireHandle(mux, pattern, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(202)
	})

	before := routeCount(t, ccwireRoutePrefix+pattern)
	beforePlain := routeCount(t, pattern)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/chats/abc/ccwire-metrics-probe", nil))
	if rec.Code != 202 {
		t.Fatalf("wrapping changed the response: code %d, want 202", rec.Code)
	}

	// Exactly one: the counter would also move if something double-counted.
	if got := routeCount(t, ccwireRoutePrefix+pattern) - before; got != 1 {
		t.Errorf("CC-Wire route observations = %v, want 1 (0 = mux not instrumented)", got)
	}
	// The label is the PATTERN, not the path: a million chat ids must not mint
	// a million series, same as the public mux.
	if n := routeCount(t, ccwireRoutePrefix+"POST /chats/abc/ccwire-metrics-probe"); n != 0 {
		t.Errorf("route labelled by raw path (%v observations) — cardinality explodes", n)
	}
	// And it did not land in the HTTP series, or the two transports are one number.
	if got := routeCount(t, pattern) - beforePlain; got != 0 {
		t.Errorf("CC-Wire send counted under the HTTP route series (+%v)", got)
	}
}

// Every CC-Wire route goes through ccwireHandle. A raw cw.HandleFunc slips a
// route back out of the scrape, and nothing else would notice.
func TestCCWireMuxRegistersThroughInstrumentedHelper(t *testing.T) {
	src, err := os.ReadFile("chats.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)
	start := strings.Index(s, "cw := http.NewServeMux()")
	end := strings.Index(s, "realtime.SetCCWireRoutes(cw)")
	if start < 0 || end < start {
		t.Fatal("cw mux construction not found in chats.go — update this test")
	}
	block := s[start:end]
	if n := strings.Count(block, "cw.Handle"); n != 0 {
		t.Errorf("%d CC-Wire route(s) registered directly on the mux — they emit no metrics; use ccwireHandle", n)
	}
	if n := strings.Count(block, "ccwireHandle(cw,"); n < 6 {
		t.Errorf("only %d instrumented CC-Wire routes, want >= 6", n)
	}
}
