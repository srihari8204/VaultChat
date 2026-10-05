// Package httpapi is Maps' inbound adapter (openspec: hexagonal-architecture):
// the authenticated, rate-limited /nav/* endpoints. It decodes requests,
// calls the application service and maps its errors onto the existing status
// codes and messages. No rule about maps lives here.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/maps/app"
	"vaultchat/backend-go/internal/maps/domain"
	"vaultchat/backend-go/internal/redisx"
)

type handlers struct{ svc *app.Service }

func Register(mux *http.ServeMux, svc *app.Service) {
	h := handlers{svc}
	mux.HandleFunc("POST /nav/route", httpx.RequireAuth(h.route))
	mux.HandleFunc("GET /nav/geocode", httpx.RequireAuth(h.geocode))
	mux.HandleFunc("POST /nav/matrix", httpx.RequireAuth(h.matrix))
	mux.HandleFunc("POST /nav/trace", httpx.RequireAuth(h.trace))
}

// point is a client coordinate; either half may be missing.
type point struct {
	Lat *float64 `json:"lat"`
	Lng *float64 `json:"lng"`
}

func (p point) latLng() *domain.LatLng {
	if p.Lat == nil || p.Lng == nil {
		return nil
	}
	return &domain.LatLng{Lat: *p.Lat, Lng: *p.Lng}
}

func points(ps []point) []*domain.LatLng {
	out := make([]*domain.LatLng, len(ps))
	for i, p := range ps {
		out[i] = p.latLng()
	}
	return out
}

// engineErr writes the routing engine's failure the way every /nav endpoint
// always has.
func engineErr(w http.ResponseWriter, err error) {
	var refused *app.RefusedError
	switch {
	case errors.As(err, &refused):
		httpx.Err(w, 502, "routing engine error", map[string]any{"detail": refused.Detail})
	case errors.Is(err, app.ErrUnreadable):
		httpx.Err(w, 502, "routing engine returned an unreadable matrix")
	default:
		httpx.Err(w, 503, "routing engine unavailable")
	}
}

// POST /nav/route — the engine's route response, bytes passed through.
func (h handlers) route(w http.ResponseWriter, r *http.Request) {
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
	costing := domain.ParseCosting(body.Costing)
	// Route preferences (avoid tolls/highways, shortest), read knob by knob —
	// this proxy's job is exactly to not forward arbitrary client JSON to the
	// engine. Only the validated costing's own options are read.
	var opts domain.RouteOptions
	if in := body.Options[string(costing)]; in != nil {
		opts.Shortest, _ = in["shortest"].(bool)
		if v, ok := in["use_tolls"].(float64); ok && v == 0 {
			opts.AvoidTolls = true
		}
		if v, ok := in["use_highways"].(float64); ok && v == 0 {
			opts.AvoidHighway = true
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
	data, err := h.svc.Route(ctx, domain.LatLng{Lat: fLat, Lng: fLng}, domain.LatLng{Lat: tLat, Lng: tLng}, costing, opts)
	if err != nil {
		engineErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}

// POST /nav/matrix — many origins → one destination, in ONE call. The batch
// primitive behind Meet Here. The caller sends a bare ORDERED LIST of
// coordinates and gets results back by index: no member ids, names, family or
// circle ids are accepted or logged, and nothing is persisted.
func (h handlers) matrix(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	// One matrix call is one engine job regardless of how many sources it
	// carries, so it is budgeted like a route, not like a search.
	rl := redisx.Consume(ctx, "navmatrix:"+user.ID, 30, 60)
	if !rl.Allowed {
		httpx.Err(w, 429, "Too many distance requests", map[string]any{"retryAfter": rl.ResetInSec})
		return
	}
	var body struct {
		Sources []point `json:"sources"`
		Target  point   `json:"target"`
		Costing string  `json:"costing"`
	}
	_ = httpx.Body(r, &body)
	costing := domain.ParseCosting(body.Costing)
	legs, err := h.svc.Matrix(ctx, points(body.Sources), body.Target.latLng(), costing)
	switch {
	case errors.Is(err, app.ErrNoTarget):
		httpx.Err(w, 400, "target{lat,lng} required")
	case errors.Is(err, app.ErrNoSources):
		httpx.Err(w, 400, "at least one source required")
	case errors.Is(err, app.ErrTooManySources):
		httpx.Err(w, 400, "too many sources", map[string]any{"max": domain.MaxMatrixSources})
	case errors.Is(err, app.ErrNoUsableSource):
		httpx.Err(w, 400, "no source had a usable coordinate")
	case errors.Is(err, app.ErrTargetOutOfRange):
		httpx.Err(w, 400, "target coordinate out of range")
	case err != nil:
		engineErr(w, err)
	default:
		// Field order matches the keys' sorted order, so the body is
		// byte-identical to the map it replaced.
		type leg struct {
			DistanceM int `json:"distanceM"`
			DurationS int `json:"durationS"`
			Index     int `json:"index"`
		}
		results := make([]leg, len(legs))
		for i, l := range legs {
			results[i] = leg{l.DistanceM, l.DurationS, l.Index}
		}
		httpx.JSON(w, 200, map[string]any{"costing": costing, "results": results})
	}
}

// POST /nav/trace — a GPS track → the distance actually DRIVEN. The track
// never persists and its shape is not logged.
func (h handlers) trace(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if rl := redisx.Consume(ctx, "navtrace:"+user.ID, 20, 60); !rl.Allowed {
		httpx.Err(w, 429, "Too many map-matching requests")
		return
	}
	var body struct {
		Shape   []point `json:"shape"`
		Costing string  `json:"costing"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&body); err != nil {
		httpx.Err(w, 400, "bad body")
		return
	}
	km, secs, matched, err := h.svc.Trace(ctx, points(body.Shape), domain.ParseCosting(body.Costing))
	if err != nil {
		httpx.Err(w, 503, "could not match this track to roads")
		return
	}
	if !matched {
		httpx.JSON(w, 200, map[string]any{"distanceM": 0, "durationS": 0, "matched": false})
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"distanceM": domain.Metres(km),
		"durationS": domain.Seconds(secs),
		"matched":   true,
	})
}

// GET /nav/geocode?q=&lat=&lon= — address → candidate list.
func (h handlers) geocode(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rl := redisx.Consume(ctx, "navgeo:"+user.ID, 30, 60)
	if !rl.Allowed {
		httpx.Err(w, 429, "Too many searches", map[string]any{"retryAfter": rl.ResetInSec})
		return
	}
	q := r.URL.Query()
	places, err := h.svc.Geocode(ctx, q.Get("q"), q.Get("lat"), q.Get("lon"))
	if errors.Is(err, app.ErrBadQuery) {
		httpx.Err(w, 400, "q (2-200 chars) required")
		return
	}
	if err != nil {
		httpx.Err(w, 502, "Geocoder unavailable")
		return
	}
	// Field order matches the keys' sorted order (see matrix).
	type place struct {
		Label string  `json:"label"`
		Lat   float64 `json:"lat"`
		Lng   float64 `json:"lng"`
		Name  string  `json:"name"`
	}
	out := make([]place, len(places))
	for i, p := range places {
		out[i] = place{p.Label, p.At.Lat, p.At.Lng, p.Name}
	}
	httpx.JSON(w, 200, out)
}
