// stale_resurrection_test.go — guards against a deleted chat coming back.
//
// A user blocked someone and deleted the chat, and it reappeared with an unread
// badge and no notification. Blocking was enforced at chat CREATION, in push
// fan-out and in realtime delivery — but not on the INSERT, so a blocked
// sender's message was still stored, and the un-hide in the same transaction
// dragged the chat back into the recipient's list.
//
// These assert the guards are attached to the code paths that matter, in the
// style of leaveselfapprove_test.go: a check somewhere else can be routed
// around, so the test pins WHERE it lives.
package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// The send path must refuse a blocked sender BEFORE anything is written.
func TestBlockedSenderCannotWriteOrUnhide(t *testing.T) {
	src := mustRead(t, "chats_helpers.go")

	post := strings.Index(src, "func chatsMessagePost(")
	if post < 0 {
		t.Fatal("chatsMessagePost not found — renamed?")
	}
	guard := strings.Index(src[post:], "chatsBlockedDirect(")
	if guard < 0 {
		t.Fatal("chatsMessagePost has no block check. A blocked sender's message " +
			"is still stored, and the un-hide below resurrects the chat.")
	}

	// Order matters more than presence: the check is worthless after the insert.
	unhide := strings.Index(src[post:], "SET hidden = FALSE")
	if unhide < 0 {
		t.Fatal("the un-hide statement moved out of chatsMessagePost — re-point this test")
	}
	if guard > unhide {
		t.Fatalf("the block check sits AFTER the un-hide (guard@%d, unhide@%d): "+
			"the chat is resurrected before the sender is refused", guard, unhide)
	}

	// It must test both directions. Checking only "they blocked me" lets a
	// person I blocked keep writing into my list.
	fn := src[strings.Index(src, "func chatsBlockedDirect("):]
	fn = fn[:strings.Index(fn, "\nfunc ")]
	if !strings.Contains(fn, "ub.blocker_id = cm.user_id") || !strings.Contains(fn, "ub.blocker_id = $2") {
		t.Error("chatsBlockedDirect must match blocks in BOTH directions")
	}
	// Groups must stay unaffected — blocking is a 1:1 relationship.
	if !strings.Contains(fn, "c.type = 'direct'") {
		t.Error("chatsBlockedDirect must be scoped to direct chats, or a blocked " +
			"member silently breaks a shared group for everyone")
	}
	// A database hiccup must not look like a block.
	if !strings.Contains(fn, "return false") {
		t.Error("chatsBlockedDirect must fail open on a query error")
	}
}

// A hidden (deleted) chat must not keep streaming its history into the client.
func TestDeltaSkipsHiddenChats(t *testing.T) {
	src := mustRead(t, "chats.go")

	const anchor = "JOIN chat_members cm ON cm.chat_id = m.chat_id"
	joins := []string{}
	for i := 0; ; {
		j := strings.Index(src[i:], anchor)
		if j < 0 {
			break
		}
		start := i + j
		end := start + 260
		if end > len(src) {
			end = len(src)
		}
		joins = append(joins, src[start:end])
		i = start + len(anchor)
	}
	// delta, mutation page, and the cold-sync floor all scope to the same rows.
	if len(joins) < 3 {
		t.Fatalf("expected 3 member joins over messages in chats.go, found %d", len(joins))
	}
	for i, j := range joins {
		if !strings.Contains(j, "cm.hidden = FALSE") {
			t.Errorf("delta join %d does not filter hidden chats — a deleted chat "+
				"keeps re-populating the local cache:\n%s", i, j)
		}
	}
}

// The cold-sync cap has to actually apply, or a reinstall pulls all history.
func TestColdSyncCapIsEnforcedByDefault(t *testing.T) {
	src := mustRead(t, "chats.go")

	fn := src[strings.Index(src, "func coldSyncWarnOnly("):]
	fn = fn[:strings.Index(fn, "\n}")]
	if strings.Contains(fn, `!= "false"`) {
		t.Error(`coldSyncWarnOnly defaults to TRUE, which makes the cap decorative: ` +
			`"enforce" is never true and an unrecognised device pulls the entire history`)
	}
	if !strings.Contains(fn, `== "true"`) {
		t.Errorf("coldSyncWarnOnly should enforce unless explicitly opted out; got:\n%s", fn)
	}

	// The floor scan must not run when its result is discarded.
	if !regexp.MustCompile(`if enforce \{\s*floor = coldSyncFloor\(`).MatchString(src) {
		t.Error("coldSyncFloor still runs on uncapped cold syncs — an OFFSET scan " +
			"over messages JOIN chat_members, computed and thrown away")
	}
}

// Someone the user blocked must not be re-offered by address-book matching.
func TestContactDiscoveryExcludesBlocked(t *testing.T) {
	src := mustRead(t, "contacts.go")

	q := src[strings.Index(src, "FROM users"):]
	q = q[:strings.Index(q, "`")]
	if !strings.Contains(q, "user_blocks") {
		t.Fatal("contact matching does not exclude blocked users — a removed " +
			"person is re-suggested every time the Contacts screen opens")
	}
	if !strings.Contains(q, "ub.blocker_id = $2") || !strings.Contains(q, "ub.blocker_id = users.id") {
		t.Error("contact matching must exclude blocks in both directions")
	}
}
