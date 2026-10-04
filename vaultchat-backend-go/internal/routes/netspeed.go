// netspeed.go — an app-owned network speed test (app/network-test.tsx used
// speed.cloudflare.com, a third party that sees every tester's IP and timing).
//
//	GET  /net/speed/down?bytes=N   N incompressible bytes (0 = latency probe)
//	POST /net/speed/up             body read and discarded
//
// Authenticated and metered per user, because both ends move real bandwidth:
// a request-count limit that fails CLOSED (ConsumeSecure) plus a byte budget
// per direction (ConsumeBy — fails open, so the count limit and the per-request
// size caps still bound a Redis outage).
package routes

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

const (
	netSpeedMaxDown    = 8 << 20  // per request; the app asks for at most 5 MB
	netSpeedMaxUp      = 2 << 20  // per request; the app sends at most 1 MB
	netSpeedReqLimit   = 60       // requests per window (one full test is ~12)
	netSpeedDownBudget = 64 << 20 // bytes per window (one full test is ~8 MB)
	netSpeedUpBudget   = 16 << 20 // bytes per window (one full test is ~1.6 MB)
	netSpeedWindow     = 600      // seconds
)

// One random block, generated once. 64 KiB is twice deflate's 32 KiB window, so
// Caddy's `encode gzip` cannot shrink the stream and skew the measurement.
var netSpeedBlock = func() []byte {
	b := make([]byte, 64<<10)
	_, _ = rand.Read(b)
	return b
}()

func RegisterNetSpeed(mux *http.ServeMux) {
	mux.HandleFunc("GET /net/speed/down", httpx.RequireAuth(netSpeedDown)) // GET also answers HEAD
	mux.HandleFunc("POST /net/speed/up", httpx.RequireAuth(netSpeedUp))
}

// netSpeedGate charges one request and `bytes` against the caller's budget for
// `dir`. It answers 429 itself and returns false when either is spent.
func netSpeedGate(w http.ResponseWriter, r *http.Request, dir string, bytes, budget int64) bool {
	uid := httpx.UserFrom(r).ID
	gate := redisx.ConsumeSecure(r.Context(), "netspeed:"+uid, netSpeedReqLimit, netSpeedWindow)
	if gate.Allowed && bytes > 0 {
		gate = redisx.ConsumeBy(r.Context(), "netspeed-"+dir+":"+uid, bytes, budget, netSpeedWindow)
	}
	if !gate.Allowed {
		retry := gate.ResetInSec
		if retry <= 0 {
			retry = netSpeedWindow
		}
		w.Header().Set("Retry-After", strconv.FormatInt(retry, 10))
		httpx.Err(w, http.StatusTooManyRequests, "Too many speed tests. Try again later.",
			map[string]any{"retryAfter": retry})
		return false
	}
	return true
}

func netSpeedDown(w http.ResponseWriter, r *http.Request) {
	n := int64(0)
	if s := r.URL.Query().Get("bytes"); s != "" {
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil || v < 0 {
			httpx.Err(w, 400, "bytes must be a whole number ≥ 0")
			return
		}
		if v > netSpeedMaxDown {
			httpx.Err(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("bytes may be at most %d", netSpeedMaxDown),
				map[string]any{"max": netSpeedMaxDown})
			return
		}
		n = v
	}
	if r.Method == http.MethodHead {
		n = 0 // a reachability probe moves no payload
	}
	if !netSpeedGate(w, r, "down", n, netSpeedDownBudget) {
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.FormatInt(n, 10))
	w.WriteHeader(http.StatusOK)
	for left := n; left > 0; {
		chunk := netSpeedBlock
		if left < int64(len(chunk)) {
			chunk = chunk[:left]
		}
		if _, err := w.Write(chunk); err != nil {
			return // client went away; nothing to report
		}
		left -= int64(len(chunk))
	}
}

func netSpeedUp(w http.ResponseWriter, r *http.Request) {
	// Charge what the client declares (or the cap when it does not say), up
	// front: the bytes arrive whether or not we read them.
	declared := r.ContentLength
	if declared > netSpeedMaxUp {
		httpx.Err(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("upload may be at most %d bytes", netSpeedMaxUp),
			map[string]any{"max": netSpeedMaxUp})
		return
	}
	if declared < 0 {
		declared = netSpeedMaxUp
	}
	if !netSpeedGate(w, r, "up", declared, netSpeedUpBudget) {
		return
	}
	start := time.Now()
	got, err := io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, netSpeedMaxUp))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpx.Err(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("upload may be at most %d bytes", netSpeedMaxUp),
				map[string]any{"max": netSpeedMaxUp})
			return
		}
		httpx.Err(w, 400, "upload was interrupted")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, map[string]any{"bytes": got, "ms": time.Since(start).Milliseconds()})
}
