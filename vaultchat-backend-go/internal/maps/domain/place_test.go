package domain

import "testing"

func TestPlaceLabel(t *testing.T) {
	cases := []struct {
		name    string
		regions []string
		want    string
	}{
		{"Charminar", []string{"Hyderabad", "", "Telangana", "India"}, "Charminar, Hyderabad, Telangana"},
		{"Hyderabad", []string{"Hyderabad", "", "Telangana", "India"}, "Hyderabad, Telangana, India"},
		{"Somewhere", []string{"", "", "", ""}, "Somewhere"},
	}
	for _, c := range cases {
		if got := PlaceLabel(c.name, c.regions); got != c.want {
			t.Errorf("PlaceLabel(%q) = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestParseCostingWhitelists(t *testing.T) {
	if ParseCosting("truck") != "truck" || ParseCosting("rocket") != "auto" || ParseCosting("") != "auto" {
		t.Fatal("only known costings pass; anything else is auto")
	}
}
