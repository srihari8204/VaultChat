// Package app holds Maps' use cases and the ports they drive (openspec:
// hexagonal-architecture). It depends on the domain only; adapters implement
// the ports and are wired together in package maps.
package app

import (
	"context"
	"errors"

	"vaultchat/backend-go/internal/maps/domain"
)

// RoutingEngine is the outbound port to the road-network engine.
type RoutingEngine interface {
	// Route returns the engine's route response verbatim; the client renders
	// it as-is.
	Route(ctx context.Context, from, to domain.LatLng, c domain.Costing, o domain.RouteOptions) ([]byte, error)
	// Matrix returns one row per source, cells in target order.
	Matrix(ctx context.Context, sources []domain.LatLng, target domain.LatLng, c domain.Costing) ([][]domain.MatrixCell, error)
	// Trace map-matches one track and returns the driven kilometres and seconds.
	Trace(ctx context.Context, pts []domain.LatLng, c domain.Costing) (km, secs float64, err error)
}

// Geocoder is the outbound port to the address search engine. biasLat and
// biasLon are forwarded as the client sent them; empty means no bias.
type Geocoder interface {
	Search(ctx context.Context, q, biasLat, biasLon string) ([]domain.Place, error)
}

// ErrUnavailable means the engine could not be reached.
var ErrUnavailable = errors.New("engine unavailable")

// ErrUnreadable means the engine answered with something that could not be
// decoded.
var ErrUnreadable = errors.New("engine response unreadable")

// RefusedError means the engine answered with a non-2xx status.
type RefusedError struct{ Detail string }

func (e *RefusedError) Error() string { return "engine refused: " + e.Detail }
