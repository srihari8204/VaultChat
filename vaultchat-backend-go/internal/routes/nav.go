// nav.go ← routes/nav.js — authenticated, rate-limited proxy to the internal
// Valhalla routing engine. Response bytes pass through untouched.
package routes

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"time"

	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

var navCostings = map[string]bool{"auto": true, "motorcycle": true, "bicycle": true, "pedestrian": true, "truck": true}

func RegisterNav(mux *http.ServeMux) {
	mux.HandleFunc("POST /nav/route", httpx.RequireAuth(navRoute))
}

func navRoute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)

	rl := redisx.Consume(ctx, "navroute:"+user.ID, 60, 60)
	if !rl.Allowed {
		httpx.Err(w, 429, "Too many route requests", map[string]any{"retryAfter": rl.ResetInSec})
		return
	}

	var body struct {
		From    map[string]any `json:"from"`
		To      map[string]any `json:"to"`
		Costing string         `json:"costing"`
	}
	_ = httpx.Body(r, &body)
	costing := "auto"
	if navCostings[body.Costing] {
		costing = body.Costing
	}
	num := func(m map[string]any, k string) (float64, bool) {
		v, ok := m[k].(float64) // JSON numbers only — strings/null fail like Node's typeof check
		return v, ok
	}
	fLat, ok1 := num(body.From, "lat")
	fLng, ok2 := num(body.From, "lng")
	tLat, ok3 := num(body.To, "lat")
	tLng, ok4 := num(body.To, "lng")
	if !ok1 || !ok2 || !ok3 || !ok4 {
		httpx.Err(w, 400, "from{lat,lng} + to{lat,lng} required")
		return
	}

	payload, _ := json.Marshal(map[string]any{
		"locations":          []map[string]any{{"lat": fLat, "lon": fLng}, {"lat": tLat, "lon": tLng}},
		"costing":            costing,
		"directions_options": map[string]any{"units": "kilometers"},
	})
	base := os.Getenv("VALHALLA_URL")
	if base == "" {
		base = "http://valhalla:8002"
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", base+"/route", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		httpx.Err(w, 503, "routing engine unavailable")
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		detail := string(data)
		if len(detail) > 200 {
			detail = detail[:200]
		}
		httpx.Err(w, 502, "routing engine error", map[string]any{"detail": detail})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
