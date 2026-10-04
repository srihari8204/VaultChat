// netspeed_test.go — the app-owned speed endpoints. No database. Runs on the
// in-process limiter by default; with REDIS_URL set it also exercises the
// Redis-backed byte budget.
//
//	go test ./internal/routes/ -run TestNetSpeed -v
//	REDIS_URL=redis://127.0.0.1:6379 go test ./internal/routes/ -run TestNetSpeed -v
package routes

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/redisx"
)

func nsReq(t *testing.T, mux *http.ServeMux, uid, method, path string, body io.Reader, size int64) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, body)
	if uid != "" {
		req.Header.Set("Authorization", "Bearer "+tokenFor(t, uid))
	}
	if size >= 0 {
		req.ContentLength = size
	} else {
		req.ContentLength = -1 // chunked: size not declared
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func nsReset(uid string) {
	ctx := context.Background()
	for _, k := range []string{"netspeed:", "netspeed-down:", "netspeed-up:"} {
		redisx.Reset(ctx, k+uid)
	}
}

func TestNetSpeed(t *testing.T) {
	if os.Getenv("JWT_SECRET") == "" {
		t.Setenv("JWT_SECRET", "netspeed-test-secret")
	}
	if os.Getenv("REDIS_URL") != "" {
		redisx.Connect()
	}
	const uid = "4e050000-0000-4000-8000-0000000000a1"
	nsReset(uid)
	t.Cleanup(func() { nsReset(uid) })
	mux := http.NewServeMux()
	RegisterNetSpeed(mux)

	if rec := nsReq(t, mux, "", "GET", "/net/speed/down?bytes=10", nil, 0); rec.Code != 401 {
		t.Fatalf("unauthenticated: %d", rec.Code)
	}
	rec := nsReq(t, mux, uid, "GET", "/net/speed/down?bytes=200000", nil, 0)
	if rec.Code != 200 || rec.Body.Len() != 200000 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("down: %d len=%d", rec.Code, rec.Body.Len())
	}
	// Incompressible: gzip (what Caddy's `encode gzip` would apply) saves < 1%.
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(rec.Body.Bytes())
	_ = zw.Close()
	if gz.Len() < 198000 {
		t.Fatalf("payload compresses to %d bytes; the measurement would be skewed", gz.Len())
	}
	if rec := nsReq(t, mux, uid, "GET", "/net/speed/down?bytes=0", nil, 0); rec.Code != 200 || rec.Body.Len() != 0 {
		t.Fatalf("probe: %d", rec.Code)
	}
	if rec := nsReq(t, mux, uid, "HEAD", "/net/speed/down?bytes=5000000", nil, 0); rec.Code != 200 || rec.Body.Len() != 0 {
		t.Fatalf("head: %d len=%d", rec.Code, rec.Body.Len())
	}
	for _, q := range []string{"-1", "abc", "1.5"} {
		if rec := nsReq(t, mux, uid, "GET", "/net/speed/down?bytes="+q, nil, 0); rec.Code != 400 {
			t.Errorf("bytes=%s: %d, want 400", q, rec.Code)
		}
	}
	if rec := nsReq(t, mux, uid, "GET", "/net/speed/down?bytes=8388609", nil, 0); rec.Code != 413 {
		t.Fatalf("too big: %d", rec.Code)
	}

	up := strings.Repeat("x", 100000)
	rec = nsReq(t, mux, uid, "POST", "/net/speed/up", strings.NewReader(up), int64(len(up)))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 200 || out["bytes"] != float64(100000) {
		t.Fatalf("up: %d %s", rec.Code, rec.Body.String())
	}
	big := strings.Repeat("y", netSpeedMaxUp+1)
	if rec := nsReq(t, mux, uid, "POST", "/net/speed/up", strings.NewReader(big), int64(len(big))); rec.Code != 413 {
		t.Fatalf("declared too big: %d", rec.Code)
	}
	if rec := nsReq(t, mux, uid, "POST", "/net/speed/up", strings.NewReader(big), -1); rec.Code != 413 {
		t.Fatalf("undeclared too big: %d", rec.Code)
	}

	// Byte budget (Redis only: ConsumeBy fails open without it).
	if redisx.Client != nil {
		nsReset(uid)
		n := 0
		for ; n < 20; n++ {
			if rec := nsReq(t, mux, uid, "GET", "/net/speed/down?bytes=8000000", nil, 0); rec.Code == 429 {
				break
			}
		}
		if n != 8 { // 8 × 8,000,000 ≤ 64 MiB < 9 × 8,000,000
			t.Fatalf("byte budget allowed %d downloads of 8 MB, want 8", n)
		}
	}

	// Request count: fail-closed limiter, 60 per window.
	nsReset(uid)
	for i := 0; i < netSpeedReqLimit; i++ {
		if rec := nsReq(t, mux, uid, "GET", "/net/speed/down?bytes=0", nil, 0); rec.Code != 200 {
			t.Fatalf("request %d: %d", i+1, rec.Code)
		}
	}
	rec = nsReq(t, mux, uid, "GET", "/net/speed/down?bytes=0", nil, 0)
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 429 || out["retryAfter"] == nil || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("61st: %d %s", rec.Code, rec.Body.String())
	}
}
