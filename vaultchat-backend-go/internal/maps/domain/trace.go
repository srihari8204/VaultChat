package domain

// MaxTraceShape is Valhalla's own ceiling (service_limits.trace.max_shape).
const MaxTraceShape = 16000

// MaxTraceSplitDepth bounds how often an over-long trace is halved. Valhalla
// refuses a single trace longer than service_limits.trace.max_distance (200km).
// A day of driving passes that easily, so an over-limit trace is SPLIT and the
// halves summed rather than refused.
const MaxTraceSplitDepth = 5

// Decimate keeps every Nth point so a very long track still fits the engine's
// shape limit. Endpoints are always preserved: losing the last fix would
// shorten the day.
func Decimate(pts []LatLng, max int) []LatLng {
	if len(pts) <= max || max < 2 {
		return pts
	}
	step := float64(len(pts)-1) / float64(max-1)
	out := make([]LatLng, 0, max)
	for i := 0; i < max-1; i++ {
		out = append(out, pts[int(float64(i)*step)])
	}
	return append(out, pts[len(pts)-1])
}
