package domain

// Place is one geocoder candidate.
type Place struct {
	Name, Label string
	At          LatLng
}

// PlaceLabel is the name followed by at most two enclosing regions (city,
// county, state, country in that order), skipping blanks and repeats of the
// name.
func PlaceLabel(name string, regions []string) string {
	label, n := name, 0
	for _, r := range regions {
		if r == "" || r == name {
			continue
		}
		label += ", " + r
		if n++; n == 2 {
			break
		}
	}
	return label
}
