package domain

// MaxMatrixSources is the most sources one matrix call may carry. Ten family
// members plus a little headroom — the cap exists so this cannot be turned into
// a bulk isochrone engine by a modified client.
const MaxMatrixSources = 12

// MatrixCell is one engine answer in kilometres and seconds; nil when the pair
// is unreachable.
type MatrixCell struct{ DistanceKm, TimeS *float64 }

// Leg is one source's road distance and ETA to the target, keyed by the
// CALLER's source index. Metres and seconds — never kilometres — because every
// consumer formats from metres and a mixed unit at the boundary is how a road
// distance ends up rendered as a straight-line one.
type Leg struct{ Index, DistanceM, DurationS int }

// Legs maps the engine's rows back onto the caller's original source indexes.
//
// The index mapping is the whole point: sources with unusable coordinates were
// dropped before the request, so the engine's row N is not the caller's source
// N. Getting this wrong silently attributes one member's ETA to another, which
// looks entirely plausible on screen and is impossible to notice.
//
// An unreachable pair is OMITTED, never emitted as zero. "0 km away" is the
// one answer that must never be invented for someone the road network cannot
// reach.
func Legs(srcIdx []int, rows [][]MatrixCell) []Leg {
	out := make([]Leg, 0, len(srcIdx))
	for row, cells := range rows {
		if row >= len(srcIdx) || len(cells) == 0 {
			continue
		}
		c := cells[0]
		if c.DistanceKm == nil || c.TimeS == nil || *c.DistanceKm < 0 || *c.TimeS < 0 {
			continue
		}
		out = append(out, Leg{
			Index:     srcIdx[row],
			DistanceM: Metres(*c.DistanceKm),
			DurationS: Seconds(*c.TimeS),
		})
	}
	return out
}

// Metres rounds a non-negative kilometre figure to whole metres.
func Metres(km float64) int { return int(km*1000 + 0.5) }

// Seconds rounds a non-negative duration to whole seconds.
func Seconds(s float64) int { return int(s + 0.5) }
