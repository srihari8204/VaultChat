package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// OWNERSHIP TRANSFER — TWO OWNERS.
//
// The caller's role came from a SELECT and the demotion was unconditional, so
// two transfers in flight both promoted their target and the group ended up
// with TWO owners. Nothing demotes an owner, so that state is permanent — the
// handler's own comment says it is worse than a failed transfer.
//
// THE RACE IS NOT EXERCISED HERE — it needs a live Postgres and two concurrent
// transactions. This is a SOURCE-LEVEL assertion on the shape of the fix.

func TestOwnershipTransferDemotionIsConditionalOnStillBeingOwner(t *testing.T) {
	b, err := os.ReadFile("chats_membership.go")
	if err != nil {
		t.Fatal(err)
	}
	src := stripLineComments(string(b))
	body := src[strings.Index(src, "func membershipTransfer("):]

	demote := regexp.MustCompile(`UPDATE chat_members SET role = 'admin'\s+WHERE chat_id = \$1 AND user_id = \$2 AND role = 'owner'`)
	if !demote.MatchString(body) {
		t.Fatal("the demotion no longer requires the caller to still be the owner")
	}
	// The predicate is only half of it: the loser has to ABORT, or its
	// promotion commits on its own and the group still has two owners.
	if !regexp.MustCompile(`ct\.RowsAffected\(\) == 0\s*{\s*return errMembershipRaced`).MatchString(body) {
		t.Error("a demotion that matched no row no longer rolls the transfer back")
	}
	// And the loser is a 409, not a 500: nothing is broken.
	if !strings.Contains(body[:strings.Index(body, "InvalidateChatMembers")], "err == errMembershipRaced") {
		t.Error("the losing transfer no longer reports a conflict")
	}
}
