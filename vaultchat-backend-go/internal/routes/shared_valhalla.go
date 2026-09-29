// shared_valhalla.go — Valhalla's matrix response shape (openspec:
// microservices-prepare). Maps and ShopBook both decode it, so it moved here
// from nav.go. ShopBook asks Maps for distances once Maps moves out.
package routes

// The slice of Valhalla's sources_to_targets response we actually read.
type valhallaMatrix struct {
	SourcesToTargets [][]struct {
		Distance *float64 `json:"distance"` // kilometres, per directions_options
		Time     *float64 `json:"time"`     // seconds
	} `json:"sources_to_targets"`
}
