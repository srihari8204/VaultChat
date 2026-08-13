package routes

import (
	"os"
	"strings"
	"testing"
)

// TestLeaveDecideRefusesSelfApproval pins a security fix that reached
// production.
//
// leaveDecide gated approve/decline on view_space_ops and nothing else. An
// owner holds that by definition, so an owner could approve their own leave
// request — and did: a real device test produced user_id = decided_by,
// status = approved. An approval the requester can grant themselves is not an
// approval, it is a formality that leaves an audit row.
//
// The fix belongs in the UPDATE's WHERE clause, not in a preceding SELECT. A
// separate read leaves a window where two requests interleave, and this is
// exactly the rule that must not have one — so this test checks for the clause
// rather than for "some check exists somewhere".
//
// It cannot exercise the handler: that needs a live database, and the packages
// here are pure. What it can do is fail the moment someone rewrites the query
// without the guard, which is the realistic way this regresses — a refactor
// that "tidies up" the conditional branch.
func TestLeaveDecideRefusesSelfApproval(t *testing.T) {
	src, err := os.ReadFile("spaces_workforce.go")
	if err != nil {
		t.Fatalf("read spaces_workforce.go: %v", err)
	}
	body := string(src)

	start := strings.Index(body, "func leaveDecide(")
	if start < 0 {
		t.Fatal("leaveDecide is gone — if it was renamed, move this guard with it")
	}
	// Bound the search to the handler so an unrelated query elsewhere cannot
	// satisfy it by accident.
	end := strings.Index(body[start+1:], "\nfunc ")
	if end < 0 {
		end = len(body) - start - 1
	}
	fn := body[start : start+1+end]

	// The requester must be excluded from deciding. `user_id <> $4` is the
	// clause; $4 is the caller's own id in the argument list.
	if !strings.Contains(fn, "user_id <> $4") {
		t.Error(`leaveDecide no longer excludes the requester from approving their own leave.

The UPDATE must carry "AND user_id <> $4" on the approve/decline path. Without
it, anyone holding view_space_ops — which every owner does — can approve their
own request. This shipped once already and was caught only by tapping the button
on a real device.

Do NOT replace this with a separate SELECT: two interleaved requests would slip
between the read and the write.`)
	}

	// Cancelling your own request is yours to do, and must stay that way. If
	// this clause disappears, the "cancel" path has stopped being self-scoped.
	if !strings.Contains(fn, "user_id = $4") {
		t.Error(`leaveDecide no longer scopes "cancelled" to the requester's own row.

Withdrawing your own request must remain possible — and must remain limited to
your own request.`)
	}

	// A refusal has to say what actually happened. "That request is no longer
	// pending" would be a lie about a row still sitting in front of the user,
	// and would send them to retry something that cannot work.
	if !strings.Contains(fn, "cannot decide your own leave request") {
		t.Error("a self-approval attempt must say so specifically, not fall through to the generic 409")
	}
}

// TestLeaveSelfApprovalGuardIsNotCosmetic checks the guard sits on the write
// path rather than only in the permission switch above it.
//
// A check in the switch would be bypassed by any future code path that reaches
// the UPDATE another way. The WHERE clause travels with the write.
func TestLeaveSelfApprovalGuardIsNotCosmetic(t *testing.T) {
	src, err := os.ReadFile("spaces_workforce.go")
	if err != nil {
		t.Skipf("spaces_workforce.go unavailable: %v", err)
	}
	body := string(src)

	upd := strings.Index(body, "UPDATE space_leave")
	if upd < 0 {
		t.Fatal("the space_leave UPDATE is gone — move this guard with it")
	}
	// Look ahead a little past the statement for the clause that qualifies it.
	// NB: no local min() helper — this package already uses Go's builtin min
	// with int64 arguments, and shadowing it breaks those call sites.
	stop := upd + 1200
	if stop > len(body) {
		stop = len(body)
	}
	window := body[upd:stop]
	if !strings.Contains(window, "user_id <> $4") {
		t.Error("the self-approval guard is not attached to the space_leave UPDATE. " +
			"A check elsewhere can be routed around; the WHERE clause cannot.")
	}
}
