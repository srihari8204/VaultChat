// Package domain is the core of Maps (openspec: hexagonal-architecture): the
// rules for coordinates, travel modes, track thinning and matrix results.
// Standard library only — no HTTP, Redis, env or routing-engine wire formats.
package domain

// LatLng is a coordinate in degrees.
type LatLng struct{ Lat, Lng float64 }

// Valid reports whether a coordinate is usable. A coordinate that is merely
// present is not: this rejects out-of-range values and the (0,0) null island a
// missing fix serialises to.
func (p LatLng) Valid() bool {
	if p.Lat < -90 || p.Lat > 90 || p.Lng < -180 || p.Lng > 180 {
		return false
	}
	return !(p.Lat == 0 && p.Lng == 0)
}

// Costing is the routing engine's travel mode.
type Costing string

var costings = map[Costing]bool{"auto": true, "motorcycle": true, "bicycle": true, "pedestrian": true, "truck": true}

// ParseCosting whitelists a client-sent mode; anything else is "auto".
func ParseCosting(s string) Costing {
	if c := Costing(s); costings[c] {
		return c
	}
	return "auto"
}

// Motorised reports whether toll and highway avoidance apply to this mode.
func (c Costing) Motorised() bool { return c == "auto" || c == "motorcycle" || c == "truck" }

// RouteOptions are the only route preferences a client may set. Each is a
// "prefer this" flag; false means the engine's default.
type RouteOptions struct {
	Shortest     bool
	AvoidTolls   bool
	AvoidHighway bool
}

// For drops the options that do not apply to costing, so a body claiming
// truck options on a pedestrian route sends nothing.
func (o RouteOptions) For(c Costing) RouteOptions {
	if !c.Motorised() {
		o.AvoidTolls, o.AvoidHighway = false, false
	}
	return o
}
