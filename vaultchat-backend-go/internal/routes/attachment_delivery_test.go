package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// A delivery row is PERMISSION TO DELETE THE FILE.
//
// internal/jobs/jobs.go reclaims an attachment once
//
//	count(attachment_deliveries) >= count(distinct chat members)
//
// which in a 1:1 chat is 1 >= 1. So one row is the whole quorum, and a row
// written for a transfer that did not complete destroys the object within the
// five-minute sweep. The recipient gets a permanently broken photo; the
// sender's bubble still reads "sent". Nothing recovers it — the re-body PUT
// restores message text only, and the handler sets no Accept-Ranges, so there
// is not even a resume.
//
// The bug was ordering, not a missing error check: the INSERT ran at the top of
// the handler, before a single byte was streamed, and before the view-once gate
// that was about to refuse the request with 410.
//
// These assertions read the source because the real thing needs S3, a database
// and a client that hangs up mid-stream. Source is comment-stripped first —
// this file describes the old code in prose, and a raw substring search would
// match the description and fail on a correct file. That exact trap has bitten
// this repo before; see stripLineComments in
// internal/realtime/payload_bounds_test.go.

func uploadsSrc(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("uploads.go")
	if err != nil {
		t.Fatal(err)
	}
	var sb strings.Builder
	for _, line := range strings.Split(string(b), "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		sb.WriteString(line)
		sb.WriteByte('\n')
	}
	return sb.String()
}

// The INSERT must live in exactly one place — the recordDelivery helper — so
// there is a single point that decides when a delivery has happened.
func TestDeliveryIsRecordedInOneePlaceOnly(t *testing.T) {
	src := uploadsSrc(t)
	if n := strings.Count(src, "INSERT INTO attachment_deliveries"); n != 1 {
		t.Fatalf("attachment_deliveries is inserted in %d places; it must be exactly 1 (recordDelivery)", n)
	}
	if !strings.Contains(src, "recordDelivery := func()") {
		t.Fatal("the recordDelivery helper is gone — the ordering guarantee went with it")
	}
}

// THE REGRESSION. Every call site must be guarded by a successful copy.
func TestDeliveryIsOnlyRecordedAfterASuccessfulCopy(t *testing.T) {
	src := uploadsSrc(t)

	calls := strings.Count(src, "recordDelivery()")
	if calls < 2 {
		t.Fatalf("only %d recordDelivery() call sites; the object-store path and the "+
			"local-file path must each record their own completion", calls)
	}

	// Each call must sit inside an `if _, cerr := io.Copy(...); cerr == nil {`.
	guard := regexp.MustCompile(`if _, cerr := io\.Copy\([^)]*\); cerr == nil \{\s*recordDelivery\(\)`)
	if n := len(guard.FindAllString(src, -1)); n != calls {
		t.Fatalf("%d recordDelivery() calls but only %d guarded by a successful io.Copy — "+
			"an unguarded one records a delivery for bytes the client never got", calls, n)
	}

	// And no fire-and-forget copy may remain on a path that can record one.
	if strings.Contains(src, "_, _ = io.Copy(w,") {
		t.Fatal("a response copy discards its error again; that is how the delivery " +
			"ordering bug came back")
	}
}

// The delivery must be recorded strictly AFTER the view-once gate, not before.
// Recording first counted a delivery for a request that was refused with 410.
func TestDeliveryIsNotRecordedBeforeTheViewOnceGate(t *testing.T) {
	src := uploadsSrc(t)
	insert := strings.Index(src, "INSERT INTO attachment_deliveries")
	gate := strings.Index(src, "already been viewed")
	if insert < 0 || gate < 0 {
		t.Skip("the view-once gate or the insert was renamed; update this test deliberately")
	}
	// The helper is DEFINED before the gate, which is fine — what matters is
	// that it is only CALLED from the streaming paths, which are after it.
	firstCall := strings.Index(src, "recordDelivery()")
	if firstCall > 0 && firstCall < gate {
		t.Fatal("recordDelivery() is called before the view-once gate — a refused " +
			"request would still count as a delivery and let the sweeper delete the file")
	}
}
