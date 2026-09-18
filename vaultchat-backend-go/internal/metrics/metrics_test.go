package metrics

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// The exposition format is a contract with Prometheus, and a malformed line is
// silently dropped at scrape time rather than erroring anywhere we would see.
// These pin the parts that are easy to get wrong: cumulative buckets, the
// route label carrying the PATTERN and not the path, and the "other" bucket
// that stops 404 probing from minting a series per URL.

func scrape() string {
	w := httptest.NewRecorder()
	Handler(w, httptest.NewRequest("GET", "/internal/metrics", nil))
	return w.Body.String()
}

func TestRouteLabelIsPatternNotPath(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /chats/{id}/messages", func(w http.ResponseWriter, r *http.Request) {})
	h := Wrap(mux)

	// Three different chat ids must collapse to ONE series.
	for _, id := range []string{"aaa", "bbb", "ccc"} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/chats/"+id+"/messages", nil))
	}

	out := scrape()
	if !strings.Contains(out, `vaultchat_http_route_duration_ms_count{route="GET /chats/{id}/messages"} 3`) {
		t.Errorf("expected one series with count 3, got:\n%s", out)
	}
	for _, id := range []string{"aaa", "bbb", "ccc"} {
		if strings.Contains(out, "/chats/"+id+"/messages\"") {
			t.Errorf("raw path %q leaked into a label — cardinality bug", id)
		}
	}
}

func TestUnmatchedRequestsBucketAsOther(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /known", func(w http.ResponseWriter, r *http.Request) {})
	h := Wrap(mux)

	for _, p := range []string{"/wp-admin", "/.env", "/random/probe"} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", p, nil))
	}

	out := scrape()
	if !strings.Contains(out, `route="other"`) {
		t.Errorf("unmatched requests should bucket as other:\n%s", out)
	}
	if strings.Contains(out, "wp-admin") || strings.Contains(out, ".env") {
		t.Error("probe paths leaked into labels")
	}
}

func TestHistogramBucketsAreCumulative(t *testing.T) {
	// Prometheus requires le buckets to be cumulative and non-decreasing, and
	// the +Inf bucket to equal _count.
	Observe("unit_test_op", 1)
	Observe("unit_test_op", 300)
	Observe("unit_test_op", 99999)

	out := scrape()
	var prev uint64
	var inf, count uint64
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, `op="unit_test_op"`) {
			continue
		}
		var v uint64
		switch {
		case strings.Contains(line, "_bucket{"):
			if _, err := fmtSscanTail(line, &v); err != nil {
				t.Fatalf("unparseable bucket line %q: %v", line, err)
			}
			if v < prev {
				t.Errorf("buckets not cumulative: %d then %d in %q", prev, v, line)
			}
			prev = v
			if strings.Contains(line, `le="+Inf"`) {
				inf = v
			}
		case strings.Contains(line, "_count{"):
			if _, err := fmtSscanTail(line, &count); err != nil {
				t.Fatalf("unparseable count line %q: %v", line, err)
			}
		}
	}
	if count != 3 {
		t.Errorf("count = %d, want 3", count)
	}
	if inf != count {
		t.Errorf("+Inf bucket %d must equal count %d", inf, count)
	}
}

func TestGaugeReaderIsSampledAtScrape(t *testing.T) {
	n := 41.0
	SetGauge("unit_test_gauge", func() float64 { return n })
	if !strings.Contains(scrape(), "vaultchat_unit_test_gauge 41") {
		t.Error("gauge not rendered from its reader")
	}
	n = 42
	if !strings.Contains(scrape(), "vaultchat_unit_test_gauge 42") {
		t.Error("gauge must re-read at scrape time, not cache")
	}
}

func TestCounterRenders(t *testing.T) {
	Inc("unit_test_event")
	Add("unit_test_event", 4)
	if !strings.Contains(scrape(), `vaultchat_events_total{event="unit_test_event"} 5`) {
		t.Error("counter did not render with the expected total")
	}
}

// fmtSscanTail reads the trailing whitespace-separated integer off a metric line.
func fmtSscanTail(line string, out *uint64) (int, error) {
	i := strings.LastIndexByte(line, ' ')
	if i < 0 {
		return 0, errNoValue
	}
	var v uint64
	for _, c := range line[i+1:] {
		if c < '0' || c > '9' {
			return 0, errNoValue
		}
		v = v*10 + uint64(c-'0')
	}
	*out = v
	return 1, nil
}

var errNoValue = errValue("no trailing integer")

type errValue string

func (e errValue) Error() string { return string(e) }

// A CC-Wire send must contribute ONLY its own prefixed route histogram — never
// the global HTTP aggregates.
//
// WHY THIS IS A TEST AND NOT A COMMENT. WrapTransport was first written
// applying routePrefix to the route label alone, leaving requests/code, the
// mean-duration sum/count and the inflight gauge unprefixed and unconditional.
// Every CC-Wire loopback send then landed in series that had been HTTP-only,
// which silently changes what a live dashboard means: an error-rate alert
// built on rate(vaultchat_http_requests_total{code=~"5.."}) / rate(...total)
// starts counting CC-Wire failures in BOTH numerator and denominator, and
// vaultchat_http_inflight counts loopback handler runs on top of the
// long-lived WS upgrade already in flight for the same connection.
//
// Nothing caught it: the route histogram was asserted, the global counters
// were not. Hence this.
func TestWrapTransportKeepsGlobalCountersHTTPOnly(t *testing.T) {
	before := countLine(scrape(), `vaultchat_http_requests_total{method="GET",code="200"}`)

	mux := http.NewServeMux()
	mux.Handle("GET /ccwire-only", WrapTransport(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }),
		"ccwire ",
	))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/ccwire-only", nil))
	if rec.Code != 200 {
		t.Fatalf("handler code = %d, want 200", rec.Code)
	}

	if got := countLine(scrape(), `vaultchat_http_requests_total{method="GET",code="200"}`); got != before {
		t.Errorf("global request counter moved %d -> %d; a CC-Wire send must not land in the HTTP totals", before, got)
	}

	// It must still get its OWN series, or the fix has thrown the baby out.
	if !strings.Contains(scrape(), `route="ccwire GET /ccwire-only"`) {
		t.Error("the prefixed route histogram is missing; CC-Wire sends would be invisible entirely")
	}
}

// countLine returns the numeric value of the metrics line with the given
// prefix, or -1 when that series does not exist yet.
func countLine(body, prefix string) int {
	for _, ln := range strings.Split(body, "\n") {
		if strings.HasPrefix(ln, prefix) {
			n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(ln, prefix)))
			if err != nil {
				return -1
			}
			return n
		}
	}
	return -1
}
