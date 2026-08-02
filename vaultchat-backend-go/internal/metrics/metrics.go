// Package metrics — minimal Prometheus text-format exposition (UITE §19).
// Hand-rolled on purpose: method+code counters, a total latency sum/count, and
// runtime gauges cover the launch dashboard without importing client_golang.
// Scraped in-network at GET /internal/metrics (Caddy 404s /internal/* publicly).
//
// P-W1: per-route latency histograms added — the p95-per-route question this
// file anticipated is now the launch SLI (message-send p95 < 800ms, call-setup
// p95 < 2s), and neither is answerable from a single global sum/count.
//
// Still hand-rolled, still no client_golang. Cardinality is bounded BY
// CONSTRUCTION rather than by discipline: the label is http.Request.Pattern —
// the ServeMux route pattern ("GET /chats/{id}/messages"), not the raw path —
// so a million distinct chat ids collapse to one series. Unmatched requests
// (404 probing) fall into a single "other" bucket, and MaxSeries is a hard
// backstop if a future router ever starts producing dynamic patterns.
//
// Deliberately NOT OpenTelemetry. OTel's case here was distributed tracing
// across the Node→Go hop; that hop no longer exists (Go owns every
// client-facing route, Node runs background jobs only), so a collector
// deployment would buy tracing across one service. Revisit when there is a
// second service worth correlating — the SFU is the obvious candidate.
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

// Bucket edges in milliseconds. Chosen around the SLIs rather than by round
// numbers: 800 brackets the message-send target and 2000 the call-setup target,
// so p95 lands inside a bucket boundary instead of being interpolated across a
// wide one.
var bucketsMs = []float64{5, 10, 25, 50, 100, 250, 500, 800, 1000, 2000, 5000, 10000}

// Hard backstop on distinct label values per histogram family. Route patterns
// are a fixed set today, so this should never trip; if it does, something is
// feeding dynamic strings in and dropping series beats an OOM.
const MaxSeries = 256

type hist struct {
	counts []uint64 // len(bucketsMs)+1, last is +Inf
	sum    float64
	n      uint64
}

func newHist() *hist { return &hist{counts: make([]uint64, len(bucketsMs)+1)} }

func (h *hist) observe(ms float64) {
	h.sum += ms
	h.n++
	for i, b := range bucketsMs {
		if ms <= b {
			h.counts[i]++
			return
		}
	}
	h.counts[len(bucketsMs)]++
}

var (
	start    = time.Now()
	inflight atomic.Int64

	mu       sync.Mutex
	requests = map[string]uint64{} // "METHOD|code" → count
	durMs    float64               // total handler time
	durN     uint64

	routeDur = map[string]*hist{}  // route pattern → latency
	opDur    = map[string]*hist{}  // domain op name → latency
	counters = map[string]uint64{} // domain counter name → count

	gmu    sync.Mutex
	gauges = map[string]func() float64{} // name → live reader
)

// Observe records a domain latency in milliseconds under a CONSTANT name
// (e.g. "call_setup"). Never pass a user-derived string.
func Observe(name string, ms float64) {
	mu.Lock()
	defer mu.Unlock()
	h := opDur[name]
	if h == nil {
		if len(opDur) >= MaxSeries {
			return
		}
		h = newHist()
		opDur[name] = h
	}
	h.observe(ms)
}

// Inc bumps a domain counter under a CONSTANT name.
func Inc(name string) { Add(name, 1) }

// Add bumps a domain counter by n.
func Add(name string, n uint64) {
	mu.Lock()
	defer mu.Unlock()
	if _, ok := counters[name]; !ok && len(counters) >= MaxSeries {
		return
	}
	counters[name] += n
}

// SetGauge registers a live reader for a gauge, sampled at scrape time. Use for
// values that already exist elsewhere (connected sockets, queue depth) so they
// are not duplicated into this package.
func SetGauge(name string, read func() float64) {
	gmu.Lock()
	defer gmu.Unlock()
	gauges[name] = read
}

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

		// r.Pattern is set by ServeMux on this same *Request during
		// ServeHTTP, so it is populated by the time we get here. Empty means
		// nothing matched — bucket those together rather than by path, or a
		// 404 scanner would mint a series per probe.
		route := r.Pattern
		if route == "" {
			route = "other"
		}

		mu.Lock()
		requests[r.Method+"|"+fmt.Sprint(rw.code)]++
		durMs += el
		durN++
		if h := routeDur[route]; h != nil {
			h.observe(el)
		} else if len(routeDur) < MaxSeries {
			h = newHist()
			h.observe(el)
			routeDur[route] = h
		}
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

	// Snapshot the histograms + counters under the same lock so a scrape is
	// internally consistent (bucket counts can never exceed _count).
	routeSnap := snapshot(routeDur)
	opSnap := snapshot(opDur)
	ctrKeys := make([]string, 0, len(counters))
	for k := range counters {
		ctrKeys = append(ctrKeys, k)
	}
	sort.Strings(ctrKeys)
	ctrSnap := make(map[string]uint64, len(counters))
	for _, k := range ctrKeys {
		ctrSnap[k] = counters[k]
	}
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

	writeHist(w, "vaultchat_http_route_duration_ms", "route", routeSnap)
	writeHist(w, "vaultchat_op_duration_ms", "op", opSnap)

	if len(ctrSnap) > 0 {
		fmt.Fprintln(w, "# TYPE vaultchat_events_total counter")
		for _, k := range ctrKeys {
			fmt.Fprintf(w, "vaultchat_events_total{event=%q} %d\n", k, ctrSnap[k])
		}
	}

	gmu.Lock()
	gnames := make([]string, 0, len(gauges))
	for k := range gauges {
		gnames = append(gnames, k)
	}
	sort.Strings(gnames)
	readers := make([]func() float64, len(gnames))
	for i, k := range gnames {
		readers[i] = gauges[k]
	}
	gmu.Unlock()
	for i, name := range gnames {
		// Read outside the gauge lock: a reader may take its own lock (the
		// realtime hub's presence mutex does), and holding gmu across that
		// would invert lock order against SetGauge.
		fmt.Fprintf(w, "# TYPE vaultchat_%s gauge\n", name)
		fmt.Fprintf(w, "vaultchat_%s %.0f\n", name, readers[i]())
	}
}

// snapshot deep-copies a histogram map; callers must hold mu.
func snapshot(src map[string]*hist) map[string]hist {
	out := make(map[string]hist, len(src))
	for k, h := range src {
		c := make([]uint64, len(h.counts))
		copy(c, h.counts)
		out[k] = hist{counts: c, sum: h.sum, n: h.n}
	}
	return out
}

// writeHist emits Prometheus histogram exposition. Buckets are CUMULATIVE per
// the format spec — observe() stores per-bucket counts, so they are summed
// forward here.
func writeHist(w http.ResponseWriter, metric, label string, data map[string]hist) {
	if len(data) == 0 {
		return
	}
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	fmt.Fprintf(w, "# TYPE %s histogram\n", metric)
	for _, k := range keys {
		h := data[k]
		var cum uint64
		for i, b := range bucketsMs {
			cum += h.counts[i]
			fmt.Fprintf(w, "%s_bucket{%s=%q,le=\"%g\"} %d\n", metric, label, k, b, cum)
		}
		cum += h.counts[len(bucketsMs)]
		fmt.Fprintf(w, "%s_bucket{%s=%q,le=\"+Inf\"} %d\n", metric, label, k, cum)
		fmt.Fprintf(w, "%s_sum{%s=%q} %.3f\n", metric, label, k, h.sum)
		fmt.Fprintf(w, "%s_count{%s=%q} %d\n", metric, label, k, h.n)
	}
}
