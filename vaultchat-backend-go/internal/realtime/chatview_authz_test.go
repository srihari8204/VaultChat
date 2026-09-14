// chatview_authz_test.go — chat_view was the one chat relay with no membership
// check.
//
// Every sibling in handlers.go gates on chatMemberAllowed; onChatView did not,
// and it both READS (cvList returns the uid of everyone viewing the chat) and
// WRITES (cvTouch announces the caller to them as a viewer). The comment said
// RLS covered it; RLS is inert while the API connects as the table owner, so
// any account could enumerate and join the viewer list of any chat id it could
// name. See internal/db/rls.go.
package realtime

import (
	"strings"
	"testing"
)

func TestChatViewIsGatedOnMembership(t *testing.T) {
	src := stripLineComments(mustRead(t, "handlers.go"))

	i := strings.Index(src, "func (h *Hub) onChatView(")
	if i < 0 {
		t.Fatal("onChatView vanished")
	}
	body := src[i:]
	if j := strings.Index(body[1:], "\nfunc "); j >= 0 {
		body = body[:j+1]
	}

	gate := strings.Index(body, "h.chatMemberAllowed(d, chatID)")
	if gate < 0 {
		t.Fatal("onChatView no longer checks chat membership: the viewer list of " +
			"any chat is readable, and joinable, by any authenticated socket")
	}
	// Before anything is read out of, or written into, the chat's viewer set.
	for _, after := range []string{"h.cvRemove(", "h.cvTouch(", "h.cvList("} {
		at := strings.Index(body, after)
		if at >= 0 && at < gate {
			t.Fatalf("onChatView touches %s before its membership check", after)
		}
	}
}
