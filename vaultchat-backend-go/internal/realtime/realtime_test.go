package realtime

import "testing"

// Smallest checks that fail if the money/branch/security helpers drift from
// server.js semantics. No DB, no sockets.

func TestToInt(t *testing.T) {
	// bet parsing: JSON numbers arrive as float64, legacy clients as strings.
	cases := []struct {
		in   any
		want int
	}{
		{float64(5), 5}, {"7", 7}, {"-3", -3}, {"", 0}, {nil, 0}, {int(9), 9},
	}
	for _, c := range cases {
		if got := toInt(c.in); got != c.want {
			t.Errorf("toInt(%v)=%d want %d", c.in, got, c.want)
		}
	}
}

func TestTruthy(t *testing.T) {
	for in, want := range map[any]bool{
		nil: false, "": false, "x": true, float64(0): false, float64(5): true, true: true, false: false,
	} {
		if got := truthy(in); got != want {
			t.Errorf("truthy(%v)=%v want %v", in, got, want)
		}
	}
}

func TestSafeKeyEqual(t *testing.T) {
	if !safeKeyEqual("s3cr3t", "s3cr3t") {
		t.Error("equal keys must match")
	}
	if safeKeyEqual("a", "b") || safeKeyEqual("", "") || safeKeyEqual("x", "") {
		t.Error("mismatched/empty keys must not match")
	}
}

func TestSenderOfEvent(t *testing.T) {
	if got := senderOfEvent("typing_start", map[string]any{"uid": "a"}); got != "a" {
		t.Errorf("typing sender=%q want a", got)
	}
	if got := senderOfEvent("message_read", map[string]any{"userId": "b"}); got != "b" {
		t.Errorf("read sender=%q want b", got)
	}
	if got := senderOfEvent("new_message", map[string]any{"uid": "c"}); got != "" {
		t.Errorf("non-ghost event sender=%q want empty", got)
	}
}

// P6.1: the full-mesh participant cap. Guards both the default and the
// override parsing — a bad override must fall back to the safe default
// rather than silently admitting an unbounded number of peers.
func TestMeshMaxParticipants(t *testing.T) {
	t.Setenv("MESH_MAX_PARTICIPANTS", "")
	if got := meshMaxParticipants(); got != 5 {
		t.Errorf("default = %d, want 5", got)
	}
	for _, c := range []struct {
		env  string
		want int
	}{
		{"8", 8}, {"2", 2},
		{"1", 5},   // below the 2-person minimum → default
		{"0", 5},   // ditto
		{"-3", 5},  // ditto
		{"abc", 5}, // unparseable → default
	} {
		t.Setenv("MESH_MAX_PARTICIPANTS", c.env)
		if got := meshMaxParticipants(); got != c.want {
			t.Errorf("MESH_MAX_PARTICIPANTS=%q → %d, want %d", c.env, got, c.want)
		}
	}
}

// The admission rule itself: joining is refused when the joiner would push
// the room past the cap. `existing` excludes the joiner, hence the +1.
func TestMeshAdmission(t *testing.T) {
	t.Setenv("MESH_MAX_PARTICIPANTS", "5")
	for _, c := range []struct {
		existing int
		admit    bool
	}{
		{0, true}, {3, true}, {4, true}, // 5th person fills the room
		{5, false}, {6, false}, // 6th and beyond refused
	} {
		admit := c.existing+1 <= meshMaxParticipants()
		if admit != c.admit {
			t.Errorf("existing=%d admit=%v want %v", c.existing, admit, c.admit)
		}
	}
}
