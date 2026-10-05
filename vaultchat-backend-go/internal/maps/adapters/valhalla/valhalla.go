// Package valhalla is the outbound adapter implementing app.RoutingEngine on
// the internal Valhalla routing engine (openspec: hexagonal-architecture).
// Valhalla's wire format stops here.
package valhalla

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"vaultchat/backend-go/internal/maps/app"
	"vaultchat/backend-go/internal/maps/domain"
)

type Engine struct{ BaseURL string }

var _ app.RoutingEngine = Engine{}

func loc(p domain.LatLng) map[string]any { return map[string]any{"lat": p.Lat, "lon": p.Lng} }

// post sends body to path and returns the response bytes, read up to limit.
// Transport failure is app.ErrUnavailable; a non-2xx status is an
// *app.RefusedError carrying at most 200 bytes of the engine's answer.
func (e Engine) post(ctx context.Context, path string, body any, timeout time.Duration, limit int64) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", e.BaseURL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return nil, app.ErrUnavailable
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, limit))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		detail := string(data)
		if len(detail) > 200 {
			detail = detail[:200]
		}
		return nil, &app.RefusedError{Detail: detail}
	}
	return data, nil
}

func (e Engine) Route(ctx context.Context, from, to domain.LatLng, c domain.Costing, o domain.RouteOptions) ([]byte, error) {
	body := map[string]any{
		"locations":          []map[string]any{loc(from), loc(to)},
		"costing":            c,
		"directions_options": map[string]any{"units": "kilometers"},
		// Google-style alternatives: ask for up to two extra routes. Valhalla
		// returns them as `alternates` only when genuinely distinct ones exist;
		// the client must never invent one when this comes back absent.
		"alternates": 2,
	}
	opts := map[string]any{}
	if o.Shortest {
		opts["shortest"] = true
	}
	if o.AvoidTolls {
		opts["use_tolls"] = 0
	}
	if o.AvoidHighway {
		opts["use_highways"] = 0
	}
	if len(opts) > 0 {
		body["costing_options"] = map[string]any{string(c): opts}
	}
	return e.post(ctx, "/route", body, 15*time.Second, 8<<20)
}

// The slice of Valhalla's sources_to_targets response we actually read.
type matrixResponse struct {
	SourcesToTargets [][]struct {
		Distance *float64 `json:"distance"` // kilometres, per directions_options
		Time     *float64 `json:"time"`     // seconds
	} `json:"sources_to_targets"`
}

func (e Engine) Matrix(ctx context.Context, sources []domain.LatLng, target domain.LatLng, c domain.Costing) ([][]domain.MatrixCell, error) {
	locs := make([]map[string]any, 0, len(sources))
	for _, s := range sources {
		locs = append(locs, loc(s))
	}
	// A matrix is more work than one route, but the caller is a screen someone
	// is looking at — fail rather than hang past a sane wait.
	data, err := e.post(ctx, "/sources_to_targets", map[string]any{
		"sources":            locs,
		"targets":            []map[string]any{loc(target)},
		"costing":            c,
		"directions_options": map[string]any{"units": "kilometers"},
	}, 20*time.Second, 4<<20)
	if err != nil {
		return nil, err
	}
	var vres matrixResponse
	if err := json.Unmarshal(data, &vres); err != nil {
		return nil, app.ErrUnreadable
	}
	rows := make([][]domain.MatrixCell, len(vres.SourcesToTargets))
	for i, cells := range vres.SourcesToTargets {
		rows[i] = make([]domain.MatrixCell, len(cells))
		for j, cell := range cells {
			rows[i][j] = domain.MatrixCell{DistanceKm: cell.Distance, TimeS: cell.Time}
		}
	}
	return rows, nil
}

func (e Engine) Trace(ctx context.Context, pts []domain.LatLng, c domain.Costing) (float64, float64, error) {
	shape := make([]map[string]any, 0, len(pts))
	for _, p := range pts {
		shape = append(shape, loc(p))
	}
	rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	data, err := e.post(rctx, "/trace_route", map[string]any{
		"shape":              shape,
		"costing":            c,
		"shape_match":        "map_snap",
		"directions_options": map[string]any{"units": "kilometers"},
	}, 20*time.Second, 8<<20)
	if err != nil {
		return 0, 0, err
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
