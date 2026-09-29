// nav.go ← routes/nav.js — authenticated, rate-limited proxy to the internal
// Valhalla routing engine. Response bytes pass through untouched.
package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	mux.HandleFunc("POST /nav/matrix", httpx.RequireAuth(navMatrix))
	mux.HandleFunc("POST /nav/trace", httpx.RequireAuth(navTrace))
}

// ─── POST /nav/trace — a GPS track → the distance actually DRIVEN ─────
//
// A travelled distance summed as straight lines between consecutive fixes
// UNDERSTATES the real one, and by more the sparser the fixes are: every bend
// between two points is cut into a chord. Map-matching snaps the track onto
// the road network and measures along it, which is the number a car odometer
// would show.
//
// The track never persists. It is proxied to Valhalla and the response is a
// length — nothing is written, and the shape is not logged, exactly like
// /nav/matrix.

/** Valhalla's own ceiling (service_limits.trace.max_shape). */
const maxTraceShape = 16000

/** Valhalla refuses a single trace longer than service_limits.trace.max_distance
 *  (200km). A day of driving passes that easily, so an over-limit trace is SPLIT
 *  and the halves summed rather than refused. */
const maxTraceSplitDepth = 5

type tracePoint struct {
	Lat *float64 `json:"lat"`
	Lng *float64 `json:"lng"`
}

func navTrace(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if rl := redisx.Consume(ctx, "navtrace:"+user.ID, 20, 60); !rl.Allowed {
		httpx.Err(w, 429, "Too many map-matching requests")
		return
	}
	var body struct {
		Shape   []tracePoint `json:"shape"`
		Costing string       `json:"costing"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&body); err != nil {
		httpx.Err(w, 400, "bad body")
		return
	}
	pts := make([][2]float64, 0, len(body.Shape))
	for _, p := range body.Shape {
		if p.Lat == nil || p.Lng == nil || !validLatLng(*p.Lat, *p.Lng) {
			continue // a dropped fix is a gap, not a reason to refuse the track
		}
		pts = append(pts, [2]float64{*p.Lat, *p.Lng})
	}
	if len(pts) < 2 {
		httpx.JSON(w, 200, map[string]any{"distanceM": 0, "durationS": 0, "matched": false})
		return
	}
	if len(pts) > maxTraceShape {
		pts = decimate(pts, maxTraceShape)
	}
	costing := "auto"
	if navCostings[body.Costing] {
		costing = body.Costing
	}

	km, secs, ok := traceSum(ctx, pts, costing, 0)
	if !ok {
		// Map matching failed for the whole track. The CALLER keeps whatever it
		// had — never answer 0, which reads as "you did not move".
		httpx.Err(w, 503, "could not match this track to roads")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"distanceM": int(km*1000 + 0.5),
		"durationS": int(secs + 0.5),
		"matched":   true,
	})
}

// Keep every Nth point so a very long track still fits Valhalla's shape limit.
// Endpoints are always preserved: losing the last fix would shorten the day.
func decimate(pts [][2]float64, max int) [][2]float64 {
	if len(pts) <= max || max < 2 {
		return pts
	}
	step := float64(len(pts)-1) / float64(max-1)
	out := make([][2]float64, 0, max)
	for i := 0; i < max-1; i++ {
		out = append(out, pts[int(float64(i)*step)])
	}
	return append(out, pts[len(pts)-1])
}

// traceSum map-matches `pts`, splitting in half when Valhalla refuses the
// distance, and returns kilometres + seconds.
func traceSum(ctx context.Context, pts [][2]float64, costing string, depth int) (float64, float64, bool) {
	if len(pts) < 2 {
		return 0, 0, true
	}
	km, secs, err := traceOnce(ctx, pts, costing)
	if err == nil {
		return km, secs, true
	}
	// Too long, or unmatchable as one piece: halve it. The split point is shared
	// by both halves so the join is not dropped.
	if depth >= maxTraceSplitDepth || len(pts) < 4 {
		return 0, 0, false
	}
	mid := len(pts) / 2
	aKm, aS, aOk := traceSum(ctx, pts[:mid+1], costing, depth+1)
	bKm, bS, bOk := traceSum(ctx, pts[mid:], costing, depth+1)
	if !aOk && !bOk {
		return 0, 0, false
	}
	// A half that cannot be matched contributes nothing rather than sinking the
	// whole day — a slightly short total beats no total.
	return aKm + bKm, aS + bS, true
}

func traceOnce(ctx context.Context, pts [][2]float64, costing string) (float64, float64, error) {
	shape := make([]map[string]any, 0, len(pts))
	for _, p := range pts {
		shape = append(shape, map[string]any{"lat": p[0], "lon": p[1]})
	}
	payload, err := json.Marshal(map[string]any{
		"shape":              shape,
		"costing":            costing,
		"shape_match":        "map_snap",
		"directions_options": map[string]any{"units": "kilometers"},
	})
	if err != nil {
		return 0, 0, err
	}
	base := os.Getenv("VALHALLA_URL")
	if base == "" {
		base = "http://valhalla:8002"
	}
	rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, "POST", base+"/trace_route", bytes.NewReader(payload))
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return 0, 0, errors.New("valhalla refused the trace")
	}
	var vr struct {
		Trip struct {
			Summary struct {
				Length *float64 `json:"length"`
				Time   *float64 `json:"time"`
			} `json:"summary"`
		} `json:"trip"`
	}
	if err := json.Unmarshal(data, &vr); err != nil {
		return 0, 0, err
	}
	if vr.Trip.Summary.Length == nil || *vr.Trip.Summary.Length < 0 {
		return 0, 0, errors.New("no matched length")
	}
	t := 0.0
	if vr.Trip.Summary.Time != nil && *vr.Trip.Summary.Time >= 0 {
		t = *vr.Trip.Summary.Time
	}
	return *vr.Trip.Summary.Length, t, nil
}

// Most sources one matrix call may carry. Ten family members plus a little
// headroom — the cap exists so this cannot be turned into a bulk isochrone
// engine by a modified client.
const maxMatrixSources = 12

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

// ─── POST /nav/matrix — many origins → one destination, in ONE call ─────
//
// The batch primitive behind Meet Here: ten family members each need a road
// distance and an ETA to the same place, and ten separate /nav/route calls
// would be ten Valhalla routings, ten round-trips and ten rate-limit tokens
// for one screen. Valhalla's sources_to_targets does it as a single matrix.
//
// WHAT THIS SERVER LEARNS, AND WHAT IT DOES NOT. Road distance is a property
// of the road network, so a routing engine cannot compute one without the
// coordinates — there is no version of ETA that keeps them on the device. So
// the contract is drawn as tightly as it can be: the caller sends a bare
// ORDERED LIST of coordinates and gets results back by index. No member ids, no
// names, no family id, no circle id are accepted or logged, nothing is
// persisted, and the response is normalised here so the client never parses
// engine internals. The server is told "how far are these twelve points from
// that one", never "where is this person".
//
// Distances come back in METRES and durations in SECONDS — never kilometres —
// because every consumer formats from metres and a mixed unit at the boundary
// is how a road distance ends up rendered as a straight-line one.
func navMatrix(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)

	// One matrix call is one Valhalla job regardless of how many sources it
	// carries, so it is budgeted like a route, not like a search.
	rl := redisx.Consume(ctx, "navmatrix:"+user.ID, 30, 60)
	if !rl.Allowed {
		httpx.Err(w, 429, "Too many distance requests", map[string]any{"retryAfter": rl.ResetInSec})
		return
	}

	var body struct {
		Sources []struct {
			Lat *float64 `json:"lat"`
			Lng *float64 `json:"lng"`
		} `json:"sources"`
		Target struct {
			Lat *float64 `json:"lat"`
			Lng *float64 `json:"lng"`
		} `json:"target"`
		Costing string `json:"costing"`
	}
	_ = httpx.Body(r, &body)

	if body.Target.Lat == nil || body.Target.Lng == nil {
		httpx.Err(w, 400, "target{lat,lng} required")
		return
	}
	if len(body.Sources) == 0 {
		httpx.Err(w, 400, "at least one source required")
		return
	}
	if len(body.Sources) > maxMatrixSources {
		httpx.Err(w, 400, "too many sources", map[string]any{"max": maxMatrixSources})
		return
	}

	// Build the source list, remembering each one's ORIGINAL index. A member
	// with an unusable coordinate is skipped rather than sent as (0,0) — the
	// Gulf of Guinea is a real place and Valhalla would happily route to it,
	// producing a confident 5000 km ETA for someone standing next door.
	srcIdx := make([]int, 0, len(body.Sources))
	locs := make([]map[string]any, 0, len(body.Sources)+1)
	for i, s := range body.Sources {
		if s.Lat == nil || s.Lng == nil || !validLatLng(*s.Lat, *s.Lng) {
			continue
		}
		srcIdx = append(srcIdx, i)
		locs = append(locs, map[string]any{"lat": *s.Lat, "lon": *s.Lng})
	}
	if len(locs) == 0 {
		httpx.Err(w, 400, "no source had a usable coordinate")
		return
	}
	if !validLatLng(*body.Target.Lat, *body.Target.Lng) {
		httpx.Err(w, 400, "target coordinate out of range")
		return
	}

	costing := "auto"
	if navCostings[body.Costing] {
		costing = body.Costing
	}

	payload, _ := json.Marshal(map[string]any{
		"sources":            locs,
		"targets":            []map[string]any{{"lat": *body.Target.Lat, "lon": *body.Target.Lng}},
		"costing":            costing,
		"directions_options": map[string]any{"units": "kilometers"},
	})
	base := os.Getenv("VALHALLA_URL")
	if base == "" {
		base = "http://valhalla:8002"
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", base+"/sources_to_targets", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	// A matrix is more work than one route, but the caller is a screen someone
	// is looking at — fail rather than hang past a sane wait.
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		httpx.Err(w, 503, "routing engine unavailable")
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		detail := string(data)
		if len(detail) > 200 {
			detail = detail[:200]
		}
		httpx.Err(w, 502, "routing engine error", map[string]any{"detail": detail})
		return
	}

	var vres valhallaMatrix
	if err := json.Unmarshal(data, &vres); err != nil {
		httpx.Err(w, 502, "routing engine returned an unreadable matrix")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"costing": costing,
		"results": normalizeMatrix(srcIdx, vres),
	})
}

// Map Valhalla's rows back onto the CALLER's original source indexes, in
// metres and seconds.
//
// The index mapping is the whole point: sources with unusable coordinates were
// dropped before the request, so Valhalla's row N is not the caller's source N.
// Getting this wrong silently attributes one member's ETA to another, which
// looks entirely plausible on screen and is impossible to notice.
//
// An unreachable pair (Valhalla sends nulls) is OMITTED, never emitted as zero.
// "0 km away" is the one answer that must never be invented for someone the
// road network cannot reach.
func normalizeMatrix(srcIdx []int, vres valhallaMatrix) []map[string]any {
	out := make([]map[string]any, 0, len(srcIdx))
	for row, cells := range vres.SourcesToTargets {
		if row >= len(srcIdx) || len(cells) == 0 {
			continue
		}
		c := cells[0]
		if c.Distance == nil || c.Time == nil || *c.Distance < 0 || *c.Time < 0 {
			continue
		}
		out = append(out, map[string]any{
			"index":     srcIdx[row],
			"distanceM": int(*c.Distance*1000 + 0.5),
			"durationS": int(*c.Time + 0.5),
		})
	}
	return out
}

// A coordinate that is merely present is not usable. Rejects out-of-range
// values and the (0,0) null island a missing fix serialises to.
func validLatLng(lat, lng float64) bool {
	if lat < -90 || lat > 90 || lng < -180 || lng > 180 {
		return false
	}
	return !(lat == 0 && lng == 0)
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
