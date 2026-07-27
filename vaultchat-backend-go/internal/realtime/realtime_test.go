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
