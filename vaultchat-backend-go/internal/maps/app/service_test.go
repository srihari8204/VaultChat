package app

import (
	"context"
	"errors"
	"testing"

	"vaultchat/backend-go/internal/maps/domain"
)

// fakeEngine stands in for the routing engine: the use cases are tested with
// no Valhalla, which is the point of the port.
type fakeEngine struct {
	traceLimit  int // a trace with more points than this is refused
	traceCalls  int
	matrixAsked []domain.LatLng
	rows        [][]domain.MatrixCell
	opts        domain.RouteOptions
}

func (f *fakeEngine) Route(_ context.Context, _, _ domain.LatLng, _ domain.Costing, o domain.RouteOptions) ([]byte, error) {
	f.opts = o
	return []byte(`{}`), nil
}

func (f *fakeEngine) Matrix(_ context.Context, src []domain.LatLng, _ domain.LatLng, _ domain.Costing) ([][]domain.MatrixCell, error) {
	f.matrixAsked = src
	return f.rows, nil
}

func (f *fakeEngine) Trace(_ context.Context, pts []domain.LatLng, _ domain.Costing) (float64, float64, error) {
	f.traceCalls++
	if len(pts) > f.traceLimit {
		return 0, 0, errors.New("too long")
	}
	return float64(len(pts) - 1), 60, nil // 1km and 60s per segment
}

func pt(lat, lng float64) *domain.LatLng { return &domain.LatLng{Lat: lat, Lng: lng} }
func fp(v float64) *float64              { return &v }

// An over-long track is halved until each piece is accepted, and the shared
// split point keeps every segment counted exactly once.
func TestTraceSplitsAndSums(t *testing.T) {
	track := make([]*domain.LatLng, 9)
	for i := range track {
		track[i] = pt(10+float64(i)/100, 10)
	}
	f := &fakeEngine{traceLimit: 3}
	km, _, ok, err := (&Service{Engine: f}).Trace(context.Background(), track, "auto")
	if err != nil || !ok {
		t.Fatalf("want a matched trace, got ok=%v err=%v", ok, err)
	}
	if km != 8 {
		t.Fatalf("8 segments must sum to 8km, got %v", km)
	}
	if f.traceCalls < 2 {
		t.Fatal("an over-long track must be split")
	}
}

func TestTraceUnmatchableIsAnErrorNotZero(t *testing.T) {
	track := []*domain.LatLng{pt(10, 10), pt(10.1, 10), pt(10.2, 10)}
	_, _, _, err := (&Service{Engine: &fakeEngine{traceLimit: 0}}).Trace(context.Background(), track, "auto")
	if !errors.Is(err, ErrTraceUnmatchable) {
		t.Fatalf("want ErrTraceUnmatchable, got %v", err)
	}
}

func TestTraceTooFewFixesIsNotMatched(t *testing.T) {
	f := &fakeEngine{traceLimit: 100}
	_, _, ok, err := (&Service{Engine: f}).Trace(context.Background(), []*domain.LatLng{pt(10, 10), nil, pt(0, 0)}, "auto")
	if ok || err != nil || f.traceCalls != 0 {
		t.Fatalf("one usable fix: want not matched, no engine call; got ok=%v err=%v calls=%d", ok, err, f.traceCalls)
	}
}

// Unusable sources are never sent, and results come back under the caller's
// original indexes.
func TestMatrixSkipsUnusableSourcesAndKeepsIndexes(t *testing.T) {
	f := &fakeEngine{rows: [][]domain.MatrixCell{{{DistanceKm: fp(1), TimeS: fp(60)}}, {{DistanceKm: fp(2), TimeS: fp(120)}}}}
	legs, err := (&Service{Engine: f}).Matrix(context.Background(),
		[]*domain.LatLng{nil, pt(17.3, 78.4), pt(0, 0), pt(17.4, 78.5)}, pt(17.5, 78.6), "auto")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.matrixAsked) != 2 {
		t.Fatalf("only the 2 usable sources may reach the engine, sent %d", len(f.matrixAsked))
	}
	if len(legs) != 2 || legs[0].Index != 1 || legs[1].Index != 3 {
		t.Fatalf("want indexes 1 and 3, got %+v", legs)
	}
}

func TestMatrixInputErrors(t *testing.T) {
	s := &Service{Engine: &fakeEngine{}}
	ctx := context.Background()
	many := make([]*domain.LatLng, domain.MaxMatrixSources+1)
	cases := []struct {
		src    []*domain.LatLng
		target *domain.LatLng
		want   error
	}{
		{[]*domain.LatLng{pt(1, 1)}, nil, ErrNoTarget},
		{nil, pt(1, 1), ErrNoSources},
		{many, pt(1, 1), ErrTooManySources},
		{[]*domain.LatLng{nil, pt(0, 0)}, pt(1, 1), ErrNoUsableSource},
		{[]*domain.LatLng{pt(1, 1)}, pt(95, 1), ErrTargetOutOfRange},
	}
	for i, c := range cases {
		if _, err := s.Matrix(ctx, c.src, c.target, "auto"); !errors.Is(err, c.want) {
			t.Errorf("case %d: want %v, got %v", i, c.want, err)
		}
	}
}

// Toll and highway avoidance mean nothing on foot, so they never reach the
// engine for a pedestrian route.
func TestRouteDropsOptionsThatDoNotApply(t *testing.T) {
	f := &fakeEngine{}
	all := domain.RouteOptions{Shortest: true, AvoidTolls: true, AvoidHighway: true}
	_, _ = (&Service{Engine: f}).Route(context.Background(), domain.LatLng{}, domain.LatLng{}, "pedestrian", all)
	if f.opts != (domain.RouteOptions{Shortest: true}) {
		t.Fatalf("pedestrian route got %+v", f.opts)
	}
}

func TestGeocodeQueryLength(t *testing.T) {
	s := &Service{}
	for _, q := range []string{"", "a", string(make([]byte, 201))} {
		if _, err := s.Geocode(context.Background(), q, "", ""); !errors.Is(err, ErrBadQuery) {
			t.Errorf("len %d: want ErrBadQuery, got %v", len(q), err)
		}
	}
}
