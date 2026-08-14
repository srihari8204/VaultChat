// nav.go ← routes/nav.js — authenticated, rate-limited proxy to the internal
// Valhalla routing engine. Response bytes pass through untouched.
package routes

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

var navCostings = map[string]bool{"auto": true, "motorcycle": true, "bicycle": true, "pedestrian": true, "truck": true}

func RegisterNav(mux *http.ServeMux) {
	mux.HandleFunc("POST /nav/route", httpx.RequireAuth(navRoute))
	mux.HandleFunc("GET /nav/geocode", httpx.RequireAuth(navGeocode))
}

// ─── GET /nav/geocode?q=&lat=&lon= — address → candidate list ──────────
//
// Authenticated, rate-limited proxy to a Photon geocoder (OSM data). Default
// upstream is Photon's public instance — free, keyless, autocomplete-friendly —
// reached from the BOX's IP, so client identity never leaves our server, and
// queries are deliberately NOT logged. Self-hosting later is one env change
// (GEOCODE_UPSTREAM), exactly as the location-lock design doc planned; the
// heavy Photon container stays optional instead of a launch dependency.
func navGeocode(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)

	rl := redisx.Consume(ctx, "navgeo:"+user.ID, 30, 60)
	if !rl.Allowed {
		httpx.Err(w, 429, "Too many searches", map[string]any{"retryAfter": rl.ResetInSec})
		return
	}
	q := r.URL.Query().Get("q")
	if len(q) < 2 || len(q) > 200 {
		httpx.Err(w, 400, "q (2-200 chars) required")
		return
	}
	upstream := os.Getenv("GEOCODE_UPSTREAM")
	if upstream == "" {
		upstream = "https://photon.komoot.io"
	}
	u := upstream + "/api/?limit=8&q=" + urlQueryEscape(q)
	// Optional bias so "market" ranks the one near the user first.
	if lat, lon := r.URL.Query().Get("lat"), r.URL.Query().Get("lon"); lat != "" && lon != "" {
		u += "&lat=" + urlQueryEscape(lat) + "&lon=" + urlQueryEscape(lon)
	}

	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	req.Header.Set("User-Agent", "VaultChat-Nav/1.0")
	resp, err := (&http.Client{Timeout: 6 * time.Second}).Do(req)
	if err != nil {
		httpx.Err(w, 502, "Geocoder unavailable")
		return
	}
	defer resp.Body.Close()
	var body struct {
		Features []struct {
			Geometry struct {
				Coordinates []float64 `json:"coordinates"` // [lon, lat]
			} `json:"geometry"`
			Properties map[string]any `json:"properties"`
		} `json:"features"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body) != nil {
		httpx.Err(w, 502, "Geocoder unavailable")
		return
	}
	str := func(p map[string]any, k string) string { s, _ := p[k].(string); return s }
	out := []map[string]any{}
	for _, f := range body.Features {
		if len(f.Geometry.Coordinates) < 2 {
			continue
		}
		name := str(f.Properties, "name")
		if name == "" {
			name = str(f.Properties, "street")
		}
		parts := []string{}
		for _, k := range []string{"city", "county", "state", "country"} {
			if v := str(f.Properties, k); v != "" && v != name {
				parts = append(parts, v)
			}
		}
		label := name
		if len(parts) > 0 {
			label = name + ", " + joinMax(parts, 2)
		}
		out = append(out, map[string]any{
			"name": name, "label": label,
			"lat": f.Geometry.Coordinates[1], "lng": f.Geometry.Coordinates[0],
		})
	}
	httpx.JSON(w, 200, out)
}

func urlQueryEscape(s string) string { return url.QueryEscape(s) }

func joinMax(parts []string, n int) string {
	if len(parts) > n {
		parts = parts[:n]
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += ", " + p
	}
	return out
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
		From    map[string]any            `json:"from"`
		To      map[string]any            `json:"to"`
		Costing string                    `json:"costing"`
		Options map[string]map[string]any `json:"costing_options"`
	}
	_ = httpx.Body(r, &body)
	costing := "auto"
	if navCostings[body.Costing] {
		costing = body.Costing
	}
	// Route preferences (avoid tolls/highways, shortest). Whitelisted knob by
	// knob — this proxy's job is exactly to not forward arbitrary client JSON
	// to Valhalla. Only the validated costing's own options are read, so a
	// body claiming truck options on a pedestrian route sends nothing.
	opts := map[string]any{}
	if in := body.Options[costing]; in != nil {
		if v, ok := in["shortest"].(bool); ok && v {
			opts["shortest"] = true
		}
		motor := costing == "auto" || costing == "motorcycle" || costing == "truck"
		if v, ok := in["use_tolls"].(float64); ok && motor && v == 0 {
			opts["use_tolls"] = 0
		}
		if v, ok := in["use_highways"].(float64); ok && motor && v == 0 {
			opts["use_highways"] = 0
		}
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

	valhalla := map[string]any{
		"locations":          []map[string]any{{"lat": fLat, "lon": fLng}, {"lat": tLat, "lon": tLng}},
		"costing":            costing,
		"directions_options": map[string]any{"units": "kilometers"},
		// Google-style alternatives: ask for up to two extra routes. Valhalla
		// returns them as `alternates` only when genuinely distinct ones exist;
		// the client must never invent one when this comes back absent.
		"alternates": 2,
	}
	if len(opts) > 0 {
		valhalla["costing_options"] = map[string]any{costing: opts}
	}
	payload, _ := json.Marshal(valhalla)
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
