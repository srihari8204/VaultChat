// Package maps is the composition root of the Maps module (openspec:
// hexagonal-architecture): it builds the outbound adapters from the
// environment, hands them to the application service, and mounts the inbound
// HTTP adapter.
//
//	adapters/httpapi ──▶ app (use cases, ports) ──▶ domain
//	                         ▲ implemented by
//	        adapters/valhalla, adapters/photon
package maps

import (
	"net/http"
	"os"

	"vaultchat/backend-go/internal/maps/adapters/httpapi"
	"vaultchat/backend-go/internal/maps/adapters/photon"
	"vaultchat/backend-go/internal/maps/adapters/valhalla"
	"vaultchat/backend-go/internal/maps/app"
)

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// Register mounts /nav/route, /nav/geocode, /nav/matrix and /nav/trace.
func Register(mux *http.ServeMux) {
	httpapi.Register(mux, &app.Service{
		Engine:   valhalla.Engine{BaseURL: envOr("VALHALLA_URL", "http://valhalla:8002")},
		Geocoder: photon.Geocoder{BaseURL: envOr("GEOCODE_UPSTREAM", "https://photon.komoot.io")},
	})
}
