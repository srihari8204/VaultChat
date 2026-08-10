// shopbook_pipeline_test.go — the order pipeline's actor split (openspec:
// shop-book-upgrade, design D5a).
//
// The rule this guards is a trust rule, not a workflow nicety: the owner owns
// pending→ready, but only the customer can assert they took the goods, because
// that assertion is what posts the khata purchase and issues the invoice. A
// stray edge back into sbOwnerNext would silently hand the shop the power to
// bill for an order nobody collected — and it would look like a working
// pipeline. No DB needed: the transition table is pure data.
package routes

import "testing"

func TestOwnerCannotReachCollectedOrCompleted(t *testing.T) {
	t.Setenv("SHOPBOOK_OWNER_COLLECT", "deny") // the post-rollout steady state
	for from, tos := range sbOwnerNext {
		for _, to := range tos {
			if to == "collected" || to == "completed" {
				t.Errorf("owner may transition %s→%s; collection is the customer's assertion (D5a)", from, to)
			}
		}
	}
	// Belt and braces: the checker itself must refuse, whatever the table says.
	for _, to := range []string{"collected", "completed"} {
		if sbTransitionAllowed("ready", to) {
			t.Errorf("sbTransitionAllowed(ready, %s) = true, want false", to)
		}
	}
}

// The grace window exists so the backend can deploy before the client update
// without stranding every in-flight order at 'ready' (see sbOwnerCollectDenied).
// It must be OFF by default and must not leak into any other transition.
func TestOwnerCollectGraceIsNarrowAndDefaultsOpen(t *testing.T) {
	t.Setenv("SHOPBOOK_OWNER_COLLECT", "")
	for _, to := range []string{"collected", "completed"} {
		if !sbTransitionAllowed("ready", to) {
			t.Errorf("grace window closed by default: ready→%s refused; old clients would strand orders", to)
		}
	}
	// Grace is only ever a ready→handover shortcut, never a way around the
	// review gate, the cancellation window, or a terminal state.
	for _, from := range []string{"pending", "accepted", "preparing", "packing", "cancelled", "not_collected"} {
		if sbTransitionAllowed(from, "collected") || sbTransitionAllowed(from, "completed") {
			t.Errorf("grace window leaked into %s→collected/completed", from)
		}
	}
}

func TestOwnerPipelineReachesReadyAndTheWriteOff(t *testing.T) {
	want := [][2]string{
		{"pending", "accepted"},
		{"accepted", "preparing"},
		{"preparing", "packing"},
		{"packing", "ready"},
		{"ready", "not_collected"}, // the escape hatch for the actor split
		{"pending", "rejected"},
		{"pending", "cancelled"},
		{"preparing", "cancelled"},
	}
	for _, tr := range want {
		if !sbTransitionAllowed(tr[0], tr[1]) {
			t.Errorf("sbTransitionAllowed(%s, %s) = false, want true", tr[0], tr[1])
		}
	}
	// Cancellation window closes once packing starts (spec: cancellation rules).
	for _, from := range []string{"packing", "ready"} {
		if sbTransitionAllowed(from, "cancelled") {
			t.Errorf("owner may cancel from %s; the window closes at packing", from)
		}
	}
	// Terminal states go nowhere.
	for _, from := range []string{"completed", "cancelled", "rejected", "not_collected"} {
		if len(sbOwnerNext[from]) != 0 {
			t.Errorf("%s is terminal but has owner transitions %v", from, sbOwnerNext[from])
		}
	}
}
