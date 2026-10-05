// shared_valhalla.go — Valhalla's matrix response shape (openspec:
// microservices-prepare). ShopBook decodes it; Maps has its own copy in
// internal/maps/adapters/valhalla (openspec: hexagonal-architecture).
package routes

// The slice of Valhalla's sources_to_targets response we actually read.
type valhallaMatrix struct {
	SourcesToTargets [][]struct {
		Distance *float64 `json:"distance"` // kilometres, per directions_options
		Time     *float64 `json:"time"`     // seconds
	} `json:"sources_to_targets"`
}
