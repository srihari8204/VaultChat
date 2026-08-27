package routes

import (
	"encoding/json"
	"strings"
	"testing"
)

// parseGate is the handler-side guard for migration 117. The CHECK constraint
// is the backstop that stops a half-written row reaching disk, but a constraint
// violation surfaces as a 500 with no explanation; these paths are what let a
// client find out WHAT it got wrong.

func TestParseGateNoneIsTheCommonCase(t *testing.T) {
	// Every pre-existing status looks like this, and it must stay cheap and
	// silent — no gate, no error.
	for _, g := range []*gateInput{
		nil,
		{},
		{Kind: ""},
		{Kind: "none"},
	} {
		k, gr, p, sa, err := parseGate(g)
		if err != "" {
			t.Fatalf("ungated status rejected: %q", err)
		}
		if k != nil || gr != nil || p != nil || sa != nil {
			t.Fatal("ungated status produced gate columns")
		}
	}
}

func TestParseGatePuzzle(t *testing.T) {
	for _, n := range []float64{3, 4, 9} {
		k, gr, p, sa, err := parseGate(&gateInput{Kind: "puzzle", Grid: n})
		if err != "" {
			t.Fatalf("grid %v rejected: %s", n, err)
		}
		if k == nil || *k != "puzzle" || gr == nil || *gr != int(n) {
			t.Fatalf("grid %v not carried through", n)
		}
		if p != nil || sa != nil {
			t.Fatal("a puzzle must not carry question fields")
		}
	}
}

// JSON has no integers — every number arrives as float64. Truncating 4.5 into a
// valid-looking 4 would silently give the poster a different puzzle than the one
// they chose, so it must be refused rather than rounded.
func TestParseGateRejectsFractionalGrid(t *testing.T) {
	if _, _, _, _, err := parseGate(&gateInput{Kind: "puzzle", Grid: 4.5}); err == "" {
		t.Fatal("4.5 was accepted as a grid")
	}
}

func TestParseGateRejectsGridOutOfRange(t *testing.T) {
	for _, n := range []float64{0, 2, 10, 81} {
		if _, _, _, _, err := parseGate(&gateInput{Kind: "puzzle", Grid: n}); err == "" {
			t.Fatalf("grid %v was accepted — must be 3..9, matching lib/status/gate.ts", n)
		}
	}
}

func TestParseGateRejectsMissingGrid(t *testing.T) {
	// A puzzle with no grid has nothing to render.
	if _, _, _, _, err := parseGate(&gateInput{Kind: "puzzle"}); err == "" {
		t.Fatal("a puzzle without a grid was accepted")
	}
	if _, _, _, _, err := parseGate(&gateInput{Kind: "puzzle", Grid: "4"}); err == "" {
		t.Fatal("a string grid was accepted")
	}
}

func TestParseGateQuestion(t *testing.T) {
	k, gr, p, sa, err := parseGate(&gateInput{
		Kind: "question", Prompt: "  Where did we meet?  ", Salt: "deadbeef",
	})
	if err != "" {
		t.Fatalf("valid question rejected: %s", err)
	}
	if k == nil || *k != "question" {
		t.Fatal("kind not carried")
	}
	if p == nil || *p != "Where did we meet?" {
		t.Fatalf("prompt not trimmed: %q", *p)
	}
	if sa == nil || *sa != "deadbeef" {
		t.Fatal("salt not carried")
	}
	if gr != nil {
		t.Fatal("a question must not carry a grid")
	}
}

// THE ONE THAT MATTERS. A question gate stored without its salt is unopenable
// by ANYBODY, including its author, and looks perfectly healthy until a viewer
// answers correctly and still sees nothing.
func TestParseGateRejectsQuestionWithoutSalt(t *testing.T) {
	if _, _, _, _, err := parseGate(&gateInput{Kind: "question", Prompt: "q?"}); err == "" {
		t.Fatal("a question without a salt was accepted — unopenable forever")
	}
	if _, _, _, _, err := parseGate(&gateInput{Kind: "question", Prompt: "q?", Salt: "   "}); err == "" {
		t.Fatal("a whitespace-only salt was accepted")
	}
}

func TestParseGateRejectsEmptyPrompt(t *testing.T) {
	for _, p := range []any{"", "   ", nil} {
		if _, _, _, _, err := parseGate(&gateInput{Kind: "question", Prompt: p, Salt: "ab"}); err == "" {
			t.Fatalf("empty prompt %v was accepted — a question with nothing to ask", p)
		}
	}
}

func TestParseGateRejectsUnknownKind(t *testing.T) {
	for _, k := range []string{"captcha", "PUZZLE", "quiz", "1"} {
		if _, _, _, _, err := parseGate(&gateInput{Kind: k, Grid: 4.0}); err == "" {
			t.Fatalf("unknown kind %q was accepted", k)
		}
	}
}

// The prompt is shown to viewers and stored; an unbounded one is a cheap way to
// bloat every feed response that carries it.
func TestParseGateTruncatesLongPrompt(t *testing.T) {
	long := make([]byte, gatePromptMax+500)
	for i := range long {
		long[i] = 'a'
	}
	_, _, p, _, err := parseGate(&gateInput{Kind: "question", Prompt: string(long), Salt: "ab"})
	if err != "" {
		t.Fatalf("long prompt rejected instead of truncated: %s", err)
	}
	if p == nil || len([]rune(*p)) > gatePromptMax {
		t.Fatalf("prompt not truncated to %d", gatePromptMax)
	}
}

// THE ONE THAT WOULD HAVE CAUGHT THE SHIPPED BUG.
//
// The feed query selected the gate columns and the scan read them, so the code
// looked complete from either end — but feedStory carried no gate fields and
// the mapping never copied them. Every gated status therefore reached every
// viewer ungated: no puzzle, no question, opened straight away. Nothing
// errored, which is why only a device test found it.
//
// This drives feedStoryFrom (the real mapping) rather than building a
// feedStory by hand — a hand-built literal would still pass with the copy
// missing, and the missing copy was half the bug.
//
// publicStory is the POST response and goes back to the POSTER, who is never
// challenged. The feed is the only story payload a VIEWER ever reads, which is
// why it — not publicStory — is what this asserts on.
func TestFeedCarriesTheGate(t *testing.T) {
	kind, grid, prompt, salt := "puzzle", 5, "Where did we meet?", "deadbeef"
	blob, err := json.Marshal(feedStoryFrom(storyRow{
		ID: 1, MediaType: "image",
		GateKind: &kind, GateGrid: &grid, GatePrompt: &prompt, GateSalt: &salt,
	}, false))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(blob, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// These key names are the contract with StoryItem in lib/chatService.ts.
	// The client reads the API response verbatim with no field mapping, so a
	// rename here ungates every status silently rather than failing loudly.
	for _, k := range []string{"gateKind", "gateGrid", "gatePrompt", "gateSalt"} {
		if _, ok := got[k]; !ok {
			t.Fatalf("feed dropped %q — every gated status opens ungated for viewers", k)
		}
	}
	if got["gateGrid"] != float64(5) {
		t.Fatalf("poster chose a 5x5 board, viewer was told %v", got["gateGrid"])
	}
	if got["gateKind"] != "puzzle" {
		t.Fatalf("kind not carried: %v", got["gateKind"])
	}
}

// An ordinary status must stay exactly as it was: omitempty means no gate keys
// at all, so an older client never sees a field it cannot interpret.
func TestFeedWithoutGateStaysClean(t *testing.T) {
	blob, _ := json.Marshal(feedStoryFrom(storyRow{ID: 1, MediaType: "image"}, false))
	for _, k := range []string{"gateKind", "gateGrid", "gatePrompt", "gateSalt"} {
		if strings.Contains(string(blob), k) {
			t.Fatalf("ungated status leaked %q: %s", k, blob)
		}
	}
}
