// Package photon is the outbound adapter implementing app.Geocoder on a Photon
// geocoder (OSM data) (openspec: hexagonal-architecture). The default upstream
// is Photon's public instance — free, keyless, autocomplete-friendly — reached
// from the BOX's IP, so client identity never leaves our server, and queries
// are deliberately NOT logged. Self-hosting is one env change
// (GEOCODE_UPSTREAM).
package photon

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"

	"vaultchat/backend-go/internal/maps/app"
	"vaultchat/backend-go/internal/maps/domain"
)

type Geocoder struct{ BaseURL string }

var _ app.Geocoder = Geocoder{}

func (g Geocoder) Search(ctx context.Context, q, biasLat, biasLon string) ([]domain.Place, error) {
	u := g.BaseURL + "/api/?limit=8&q=" + url.QueryEscape(q)
	// Optional bias so "market" ranks the one near the user first.
	if biasLat != "" && biasLon != "" {
		u += "&lat=" + url.QueryEscape(biasLat) + "&lon=" + url.QueryEscape(biasLon)
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, app.ErrUnavailable
	}
	req.Header.Set("User-Agent", "VaultChat-Nav/1.0")
	resp, err := (&http.Client{Timeout: 6 * time.Second}).Do(req)
	if err != nil {
		return nil, app.ErrUnavailable
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
		return nil, app.ErrUnreadable
	}
	str := func(p map[string]any, k string) string { s, _ := p[k].(string); return s }
	out := []domain.Place{}
	for _, f := range body.Features {
		if len(f.Geometry.Coordinates) < 2 {
			continue
		}
		name := str(f.Properties, "name")
		if name == "" {
			name = str(f.Properties, "street")
		}
		regions := []string{str(f.Properties, "city"), str(f.Properties, "county"), str(f.Properties, "state"), str(f.Properties, "country")}
		out = append(out, domain.Place{
			Name:  name,
			Label: domain.PlaceLabel(name, regions),
			At:    domain.LatLng{Lat: f.Geometry.Coordinates[1], Lng: f.Geometry.Coordinates[0]},
		})
	}
	return out, nil
}
