package metrics

// The deploy question this file answers: "is the box actually serving
// protobuf?" Before vaultchat_http_responses_total there was no series that
// could tell a fully-negotiated box from one whose edge proxy strips Accept —
// request counts, latency and route histograms are identical either way.
//
// Drives Wrap with a handler shaped exactly like the negotiation sites in
// internal/routes (branch on Accept, set Content-Type, write), then scrapes the
// real exposition handler and reads the numbers back out.

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func TestResponseRepresentationCounter(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /app/flags", func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.Header.Get("Accept"), "application/protobuf") {
			w.Header().Set("Content-Type", "application/protobuf")
			w.WriteHeader(200)
			_, _ = w.Write([]byte{0x0a, 0x01, 'x'})
			return
		}
		// httpx.JSON writes the charset too — the label must survive that.
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"flags":{}}`))
	})
	h := Wrap(mux)

	before := scrapeRepr(t)

	// Two clients that negotiated protobuf, three that did not.
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("GET", "/app/flags", nil)
		req.Header.Set("Accept", "application/protobuf, application/json")
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("GET", "/app/flags", nil)
		req.Header.Set("Accept", "application/json")
		h.ServeHTTP(httptest.NewRecorder(), req)
	}

	after := scrapeRepr(t)
	for _, c := range []struct {
		repr string
		want uint64
	}{{"protobuf", 2}, {"json", 3}, {"other", 0}} {
		got := after[c.repr] - before[c.repr]
		if got != c.want {
			t.Errorf("repr=%q: delta %d, want %d (before %d, after %d)",
				c.repr, got, c.want, before[c.repr], after[c.repr])
		}
		t.Logf("repr=%-8s before=%d after=%d delta=%d (want %d)",
			c.repr, before[c.repr], after[c.repr], got, c.want)
	}
}

// A CC-Wire send must not move these counters. The loopback mux runs the same
// handlers under the same patterns but never crossed the network, and folding
// it in would make "protobuf responses served" mean two different things.
func TestResponseRepresentationIgnoresCCWireTransport(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /chats/delta", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{}`))
	})
	h := WrapTransport(mux, "ccwire ")

	before := scrapeRepr(t)
	for i := 0; i < 4; i++ {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/chats/delta", nil))
	}
	after := scrapeRepr(t)

	for _, k := range []string{"protobuf", "json", "other"} {
		if d := after[k] - before[k]; d != 0 {
			t.Errorf("repr=%q moved by %d on a CC-Wire send; it must stay HTTP-only", k, d)
		}
	}
}

// scrapeRepr reads the three representation counters out of the REAL exposition
// handler. Deltas, not absolutes: these are process-global counters and every
// other test in this package drives Wrap too, so an absolute assertion would
// pass alone and fail in a package run — which it did, on the first attempt.
func scrapeRepr(t *testing.T) map[string]uint64 {
	t.Helper()
	rec := httptest.NewRecorder()
	Handler(rec, httptest.NewRequest("GET", "/internal/metrics", nil))
	out := map[string]uint64{}
	for _, l := range strings.Split(rec.Body.String(), "\n") {
		m := reprLine.FindStringSubmatch(strings.TrimSpace(l))
		if m == nil {
			continue
		}
		n, err := strconv.ParseUint(m[2], 10, 64)
		if err != nil {
			t.Fatalf("unparseable counter line %q", l)
		}
		out[m[1]] = n
	}
	// All three are emitted unconditionally, at zero if never hit. If that ever
	// stops being true, an alert on protobuf==0 stops being expressible — and
	// "no series" would read on a dashboard exactly like "no traffic".
	for _, k := range []string{"protobuf", "json", "other"} {
		if _, ok := out[k]; !ok {
			t.Fatalf("repr=%q series absent from the scrape", k)
		}
	}
	return out
}

var reprLine = regexp.MustCompile(`^vaultchat_http_responses_total\{repr="([a-z]+)"\} (\d+)$`)
