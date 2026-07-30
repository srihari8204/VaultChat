// Package metrics — minimal Prometheus text-format exposition (UITE §19).
// Hand-rolled on purpose: method+code counters, a total latency sum/count, and
// runtime gauges cover the launch dashboard without importing client_golang.
// Scraped in-network at GET /internal/metrics (Caddy 404s /internal/* publicly).
//
// ponytail: no per-route labels (path cardinality) and no latency quantiles —
// add client_golang histograms when p95-per-route questions actually come up.
package metrics

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

var (
	start    = time.Now()
	inflight atomic.Int64

	mu       sync.Mutex
	requests = map[string]uint64{} // "METHOD|code" → count
	durMs    float64               // total handler time
	durN     uint64
)

type rec struct {
	http.ResponseWriter
	code int
}

func (r *rec) WriteHeader(c int) { r.code = c; r.ResponseWriter.WriteHeader(c) }

// Socket.IO's websocket upgrade needs Hijacker; SSE-ish paths need Flusher.
// The recorder must pass both through or realtime silently breaks.
func (r *rec) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := r.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("hijack not supported")
}
func (r *rec) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Wrap counts every request; mount the result as the server handler.
func Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t0 := time.Now()
		inflight.Add(1)
		rw := &rec{ResponseWriter: w, code: 200}
		next.ServeHTTP(rw, r)
		inflight.Add(-1)
		el := float64(time.Since(t0).Microseconds()) / 1000.0
		mu.Lock()
		requests[r.Method+"|"+fmt.Sprint(rw.code)]++
		durMs += el
		durN++
		mu.Unlock()
	})
}

// Handler renders Prometheus text exposition format 0.0.4.
func Handler(w http.ResponseWriter, _ *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	mu.Lock()
	keys := make([]string, 0, len(requests))
	for k := range requests {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		var method, code string
		fmt.Sscanf(k, "%s", &method) // k = METHOD|code
		for i := 0; i < len(k); i++ {
			if k[i] == '|' {
				method, code = k[:i], k[i+1:]
				break
			}
		}
		lines = append(lines, fmt.Sprintf(`vaultchat_http_requests_total{method=%q,code=%q} %d`, method, code, requests[k]))
	}
	sumMs, n := durMs, durN
	mu.Unlock()

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	fmt.Fprintln(w, "# TYPE vaultchat_http_requests_total counter")
	for _, l := range lines {
		fmt.Fprintln(w, l)
	}
	fmt.Fprintln(w, "# TYPE vaultchat_http_request_duration_ms_sum counter")
	fmt.Fprintf(w, "vaultchat_http_request_duration_ms_sum %.3f\n", sumMs)
	fmt.Fprintln(w, "# TYPE vaultchat_http_request_duration_ms_count counter")
	fmt.Fprintf(w, "vaultchat_http_request_duration_ms_count %d\n", n)
	fmt.Fprintln(w, "# TYPE vaultchat_http_inflight gauge")
	fmt.Fprintf(w, "vaultchat_http_inflight %d\n", inflight.Load())
	fmt.Fprintln(w, "# TYPE vaultchat_uptime_seconds gauge")
	fmt.Fprintf(w, "vaultchat_uptime_seconds %.0f\n", time.Since(start).Seconds())
	fmt.Fprintln(w, "# TYPE vaultchat_goroutines gauge")
	fmt.Fprintf(w, "vaultchat_goroutines %d\n", runtime.NumGoroutine())
	fmt.Fprintln(w, "# TYPE vaultchat_heap_alloc_bytes gauge")
	fmt.Fprintf(w, "vaultchat_heap_alloc_bytes %d\n", m.HeapAlloc)
}
