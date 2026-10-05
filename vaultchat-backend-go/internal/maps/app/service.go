package app

import (
	"context"
	"errors"

	"vaultchat/backend-go/internal/maps/domain"
)

// Service is Maps' application layer. Nothing it handles is persisted or
// logged: coordinates go to the engine and only the answer comes back.
type Service struct {
	Engine   RoutingEngine
	Geocoder Geocoder
}

// Input errors. The inbound adapter maps each to its 400 message.
var (
	ErrNoTarget         = errors.New("target required")
	ErrNoSources        = errors.New("sources required")
	ErrTooManySources   = errors.New("too many sources")
	ErrNoUsableSource   = errors.New("no usable source")
	ErrTargetOutOfRange = errors.New("target out of range")
	ErrTraceUnmatchable = errors.New("track could not be matched")
	ErrBadQuery         = errors.New("query must be 2-200 bytes")
)

func (s *Service) Route(ctx context.Context, from, to domain.LatLng, c domain.Costing, o domain.RouteOptions) ([]byte, error) {
	return s.Engine.Route(ctx, from, to, c, o.For(c))
}

// Matrix answers many origins → one destination in one engine call. sources
// may hold nils (no fix); they and unusable coordinates are skipped rather
// than sent as (0,0) — the Gulf of Guinea is a real place and the engine would
// happily produce a confident 5000 km ETA for someone standing next door.
func (s *Service) Matrix(ctx context.Context, sources []*domain.LatLng, target *domain.LatLng, c domain.Costing) ([]domain.Leg, error) {
	if target == nil {
		return nil, ErrNoTarget
	}
	if len(sources) == 0 {
		return nil, ErrNoSources
	}
	if len(sources) > domain.MaxMatrixSources {
		return nil, ErrTooManySources
	}
	srcIdx := make([]int, 0, len(sources))
	pts := make([]domain.LatLng, 0, len(sources))
	for i, p := range sources {
		if p == nil || !p.Valid() {
			continue
		}
		srcIdx = append(srcIdx, i)
		pts = append(pts, *p)
	}
	if len(pts) == 0 {
		return nil, ErrNoUsableSource
	}
	if !target.Valid() {
		return nil, ErrTargetOutOfRange
	}
	rows, err := s.Engine.Matrix(ctx, pts, *target, c)
	if err != nil {
		return nil, err
	}
	return domain.Legs(srcIdx, rows), nil
}

// Trace turns a GPS track into the distance actually DRIVEN. Straight lines
// between fixes understate it — every bend is cut into a chord — so the track
// is map-matched and measured along the roads. ok=false (the matched flag)
// means fewer than two usable fixes, so there is nothing to measure.
func (s *Service) Trace(ctx context.Context, track []*domain.LatLng, c domain.Costing) (km, secs float64, ok bool, err error) {
	pts := make([]domain.LatLng, 0, len(track))
	for _, p := range track {
		if p == nil || !p.Valid() {
			continue // a dropped fix is a gap, not a reason to refuse the track
		}
		pts = append(pts, *p)
	}
	if len(pts) < 2 {
		return 0, 0, false, nil
	}
	pts = domain.Decimate(pts, domain.MaxTraceShape)
	km, secs, matched := s.traceSum(ctx, pts, c, 0)
	if !matched {
		// The CALLER keeps whatever it had — never answer 0, which reads as
		// "you did not move".
		return 0, 0, false, ErrTraceUnmatchable
	}
	return km, secs, true, nil
}

// traceSum map-matches pts, splitting in half when the engine refuses the
// distance, and returns kilometres + seconds.
func (s *Service) traceSum(ctx context.Context, pts []domain.LatLng, c domain.Costing, depth int) (float64, float64, bool) {
	if len(pts) < 2 {
		return 0, 0, true
	}
	km, secs, err := s.Engine.Trace(ctx, pts, c)
	if err == nil {
		return km, secs, true
	}
	// Too long, or unmatchable as one piece: halve it. The split point is shared
	// by both halves so the join is not dropped.
	if depth >= domain.MaxTraceSplitDepth || len(pts) < 4 {
		return 0, 0, false
	}
	mid := len(pts) / 2
	aKm, aS, aOk := s.traceSum(ctx, pts[:mid+1], c, depth+1)
	bKm, bS, bOk := s.traceSum(ctx, pts[mid:], c, depth+1)
	if !aOk && !bOk {
		return 0, 0, false
	}
	// A half that cannot be matched contributes nothing rather than sinking the
	// whole day — a slightly short total beats no total.
	return aKm + bKm, aS + bS, true
}

func (s *Service) Geocode(ctx context.Context, q, biasLat, biasLon string) ([]domain.Place, error) {
	if len(q) < 2 || len(q) > 200 {
		return nil, ErrBadQuery
	}
	return s.Geocoder.Search(ctx, q, biasLat, biasLon)
}
