package routes

import (
	"strings"
	"testing"
)

// Six digits, leading zeros kept, and uniform.
//
// The leading zero is the one that bites: '004271' read aloud is a different
// code from '4271', and anything that drops the zeros hands people a code the
// server will not recognise.
func TestNewChatCode(t *testing.T) {
	seen := map[string]int{}
	const runs = 5000
	for i := 0; i < runs; i++ {
		code, err := newChatCode()
		if err != nil {
			t.Fatalf("newChatCode: %v", err)
		}
		if len(code) != chatCodeLen {
			t.Fatalf("%q is %d characters, want %d", code, len(code), chatCodeLen)
		}
		if strings.Trim(code, "0123456789") != "" {
			t.Fatalf("%q is not all digits", code)
		}
		seen[code[:1]]++
	}
	// The whole reason newChatCode uses rand.Int rather than a byte modulo 10:
	// 10 does not divide 256, so a byte trick makes the low digits likelier. If
	// that regresses, the FIRST digit skews measurably — 0..5 over-represented.
	// Expect runs/10 per leading digit; allow generous slack for real randomness.
	for d := '0'; d <= '9'; d++ {
		n := seen[string(d)]
		if n < runs/20 || n > runs/5 {
			t.Errorf("leading digit %q appeared %d times in %d, expected about %d — biased generator?",
				d, n, runs, runs/10)
		}
	}
}

func TestNormalizeChatCode(t *testing.T) {
	cases := []struct{ in, want string }{
		{"004271", "004271"},
		{"  004271 ", "004271"},
		{"004-271", "004271"},
		{"00 42 71", "004271"},
		// Too long is refused, never truncated — a doubled paste must fail
		// loudly rather than silently match its own first six digits.
		{"004271004271", ""},
		{"0042710", ""},
		// Too short falls through to the caller's length check.
		{"0042", "0042"},
		{"", ""},
		{"abcdef", ""},
	}
	for _, c := range cases {
		if got := normalizeChatCode(c.in); got != c.want {
			t.Errorf("normalizeChatCode(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestChatCodeSeconds(t *testing.T) {
	// Absent, null and 0 all mean "no timer" — what "Until I delete" and "Save
	// this contact" both send.
	for _, v := range []any{nil, float64(0)} {
		got, ok := chatCodeSeconds(v)
		if !ok || got != nil {
			t.Errorf("chatCodeSeconds(%v) = %v, %v; want nil, true", v, got, ok)
		}
	}
	// The two timed options the screen offers.
	for _, want := range []int64{3600, 10800} {
		got, ok := chatCodeSeconds(float64(want))
		if !ok || got == nil || *got != want {
			t.Errorf("chatCodeSeconds(%d) = %v, %v", want, got, ok)
		}
	}
	// Out of range and wrong type are refused, not clamped: a code that
	// silently opened a chat with a different timer than the one chosen would
	// break the only promise the feature makes.
	for _, v := range []any{float64(59), float64(-3600), float64(400 * 24 * 3600), "3600", true} {
		if _, ok := chatCodeSeconds(v); ok {
			t.Errorf("chatCodeSeconds(%v) accepted", v)
		}
	}
}

// chatCodeLife is the whole security argument for six digits — it is what keeps
// the pool of live codes small enough that a guess is unlikely to land. If
// someone stretches it to an hour for convenience, this is the tripwire.
func TestChatCodeLifeStaysShort(t *testing.T) {
	if chatCodeLife.Minutes() > 5 {
		t.Fatalf("chatCodeLife is %v — at six digits the short life IS the defence. "+
			"Raising it grows the live pool a guesser shoots at; lengthen the code first.", chatCodeLife)
	}
}
