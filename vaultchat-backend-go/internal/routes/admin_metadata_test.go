// admin_metadata_test.go — §15 finding 3: the admin message feed is metadata
// only, and the reply graph is not part of it.
//
// GET /api/admin/messages is an operator-facing live tail. It correctly selects
// neither `content` nor `meta`. It also used to select `reply_to_id`, which no
// operator surface has ever rendered — admin/index.html draws six columns and
// never reads the field — so it was pure leak: finding 1's conversation graph,
// assembled into a feed, for a reader who could not use it.
//
// It is removed. This pins it removed, because re-adding it is a one-word edit
// in a SELECT and nothing else in the repo would notice.
//
// WHY THIS IS A SOURCE SCAN AND NOT AN HTTP TEST
//
// The route needs db.SysPool, which needs a database; a pure test on every
// `go test ./...` is worth more here than a stronger test that is skipped on
// every normal build. The thing being asserted is the text of a SQL literal, so
// reading the text is not a proxy for the behaviour — it IS the behaviour.
package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Comments are stripped first: the paragraph above explains the rule and would
// itself match a naive substring search on a file where the rule was deleted.
// Same trap as internal/realtime/payload_bounds_test.go's stripLineComments.
func adminSourceWithoutComments(t *testing.T) string {
	t.Helper()
	src, err := os.ReadFile("admin.go")
	if err != nil {
		t.Fatalf("read admin.go: %v", err)
	}
	return regexp.MustCompile(`(?m)^\s*//.*$`).ReplaceAllString(string(src), "")
}

func TestAdminMessageFeedDoesNotAssembleTheReplyGraph(t *testing.T) {
	code := adminSourceWithoutComments(t)
	if strings.Contains(code, "reply_to_id") || strings.Contains(code, "replyToId") {
		t.Fatal(`the admin message feed reads the reply pointer again.

envelope.proto:153-154 names reply_to as deliberately absent from the wire — "a
conversation graph the server has no need to build". The delivery sweep now
reclaims the column, but a row between send and sweep still carries it, and this
endpoint is the only place it was ever readable as a live feed of who answered
whom. Nothing renders it: admin/index.html draws id, type, sender, chat, status
and time. If an operator surface genuinely needs it, that is a product decision
to take deliberately — not a column that drifted back into a SELECT.`)
	}
}

// The other half of "metadata only": the header comment has claimed this since
// the route was written, and nothing asserted it. `content` and `meta` are the
// ciphertext and the spine metadata; either in this file is the leak the whole
// of §15 is about.
func TestAdminMessageFeedSelectsNoContent(t *testing.T) {
	code := adminSourceWithoutComments(t)
	stmt, ok := cutAdminMessagesSelect(code)
	if !ok {
		t.Fatal("the admin messages SELECT no longer starts `SELECT id, chat_id, sender_id, type` — this test can no longer find the statement it guards, and is meaningless until repointed")
	}
	for _, col := range []string{"content", "meta"} {
		if regexp.MustCompile(`\b` + col + `\b`).MatchString(stmt) {
			t.Fatalf(`the admin message feed now selects %q:

%s

This route is METADATA ONLY. It is the one operator surface that could
trivially have selected the ciphertext or the thumbnail and did not.`, col, stmt)
		}
	}
}

func cutAdminMessagesSelect(code string) (string, bool) {
	const head = "SELECT id, chat_id, sender_id, type"
	i := strings.Index(code, head)
	if i < 0 {
		return "", false
	}
	rest := code[i:]
	j := strings.Index(rest, "LIMIT $1")
	if j < 0 {
		return "", false
	}
	return rest[:j], true
}
