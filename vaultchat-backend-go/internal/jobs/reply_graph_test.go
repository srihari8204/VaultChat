// reply_graph_test.go — §15 finding 1: the sweep must reclaim `reply_to_id`
// along with `content`, and must reclaim it on EXACTLY the same rows.
//
// WHY THIS IS A SEPARATE FILE FROM THE DB TEST
//
// delete_on_delivery_db_test.go proves the behaviour against a real Postgres
// and is the stronger test — but it is skipped unless TEST_PG_URL is set, so on
// a normal `go test ./...` nothing at all would guard this. These are pure: no
// database, no network, they run on every build.
//
// WHAT THE TWO HALVES ARE FOR
//
// Asserting only "reply_to_id is nulled" is not enough, and is the mistake that
// makes this kind of test worthless: a statement that nulls the column
// unconditionally would pass it, while destroying the reply pointer of a
// message that has not been delivered to anybody and still has its body. So the
// second half asserts the negative — that `reply_to_id` appears in the SET
// clause and NOWHERE in the row-selection predicate. The rows the sweep touches
// must still be decided by the three delivery clauses and nothing else.
package jobs

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestDeliverySweepReclaimsTheReplyPointerWithTheBody(t *testing.T) {
	if !strings.Contains(deliveredMessagesSQL, "reply_to_id = NULL") {
		t.Fatal(`the delete-on-delivery sweep no longer nulls reply_to_id.

It nulls content and rewrites meta, and leaves behind a complete, queryable
reply graph: which message answered which, in every chat, forever, with the
ciphertext already reclaimed. envelope.proto:153-154 names reply_to as
deliberately absent from the wire — "a conversation graph the server has no
need to build" — and this sweep is the only place that graph is reclaimed.`)
	}
}

// The sweep's row set is the safety contract (see delete_on_delivery_test.go).
// reply_to_id belongs to the verb, not the predicate: it may be written, never
// read, and never used to decide which rows are touched.
func TestReplyPointerIsReclaimedOnlyWhereTheBodyIs(t *testing.T) {
	set, where, ok := strings.Cut(deliveredMessagesSQL, "WHERE m.ctid IN (")
	if !ok {
		t.Fatal("the sweep no longer batches by `WHERE m.ctid IN (` — this test can no longer tell its SET clause from its predicate, and the assertion below is meaningless until it is repointed")
	}
	if strings.Contains(where, "reply_to_id") {
		t.Fatalf(`reply_to_id has entered the sweep's row-selection predicate:

%s

Which rows this statement touches must be decided by the three delivery clauses
alone. A message nobody has received keeps its body, and must keep its reply
pointer with it.`, where)
	}
	// ...and it must sit alongside `content = NULL`, not in some other clause
	// that happens to mention it.
	if !regexp.MustCompile(`SET content = NULL,\s*reply_to_id = NULL,`).MatchString(set) {
		t.Fatalf(`reply_to_id is no longer nulled next to content in the SET clause.

Reclaiming it at any other moment is not safe: it is safe HERE only because the
body goes in the same statement, which is what makes the pointer unrenderable.

SET clause was:
%s`, set)
	}
}

// The unconditional age purge is a second statement in the same function, off
// by default, that also nulls content. It is inline rather than a const, so it
// is asserted against the source. Without this an operator who turns
// DELETE_ON_DELIVERY_MAX_AGE_DAYS on reclaims the ciphertext and keeps the
// reply graph — finding 1 exactly, through the back door.
func TestAgePurgeAlsoReclaimsTheReplyPointer(t *testing.T) {
	src, err := os.ReadFile("jobs.go")
	if err != nil {
		t.Fatalf("read jobs.go: %v", err)
	}
	// Comments are stripped first: a needle that matches the prose ABOUT the
	// rule, on a file where the rule itself has been deleted, is the trap
	// internal/realtime/payload_bounds_test.go exists to avoid.
	code := regexp.MustCompile(`(?m)^\s*//.*$`).ReplaceAllString(string(src), "")
	if !strings.Contains(code, "UPDATE messages SET content = NULL, reply_to_id = NULL") {
		t.Fatal(`the age purge nulls content without nulling reply_to_id.

Same reasoning as the delivery sweep: once the body is gone the pointer cannot
render anything, and leaving it keeps the reply graph on the spine forever.`)
	}
}
