package services

import "testing"

func TestParse(t *testing.T) {
	for _, v := range []string{"", "  ", "all"} {
		set, err := Parse(v)
		if err != nil {
			t.Fatalf("Parse(%q): %v", v, err)
		}
		if len(set) != len(known) {
			t.Fatalf("Parse(%q) enabled %d services, want all %d", v, len(set), len(known))
		}
	}

	set, err := Parse("golive, maps")
	if err != nil {
		t.Fatal(err)
	}
	if !set[GoLive] || !set[Maps] || set[Core] || len(set) != 2 {
		t.Fatalf("Parse(golive, maps) = %v", set)
	}

	if _, err := Parse("golive,chat"); err == nil {
		t.Fatal("unknown service name must be an error")
	}
	if _, err := Parse(","); err == nil {
		t.Fatal("a list naming no service must be an error")
	}
}
