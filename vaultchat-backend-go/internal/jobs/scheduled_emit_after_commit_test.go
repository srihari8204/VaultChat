package jobs

import (
	"os"
	"strings"
	"testing"
)

// SCHEDULED MESSAGES — FAN-OUT BEFORE COMMIT.
//
// deliverScheduled emitted chat:new-message while still inside the sweep's
// transaction. A failed commit therefore left recipients holding a message that
// does not exist, and the row went back to sent_at IS NULL so the next tick
// re-delivered it with NEW ids — a duplicate, not a retry.
//
// The emit now happens after Commit returns nil. A failed commit is then simply
// a retry: nothing was announced.
//
// The commit failure itself is not exercised (it needs a live Postgres and an
// induced commit error); this asserts the ordering at source level.

func TestScheduledFanOutHappensAfterCommit(t *testing.T) {
	b, err := os.ReadFile("jobs.go")
	if err != nil {
		t.Fatal(err)
	}
	src := stripJobsLineComments(string(b))

	deliver := src[strings.Index(src, "func deliverScheduled("):]
	if strings.Contains(deliver, "emitx.ChatNewMessage") {
		t.Error("deliverScheduled emits again — it runs inside the caller's transaction")
	}

	sweep := src[strings.Index(src, "func sweepScheduledMessages("):strings.Index(src, "func deliverScheduled(")]
	commit := strings.Index(sweep, "tx.Commit(ctx)")
	emit := strings.Index(sweep, "emitx.ChatNewMessage")
	if commit < 0 || emit < 0 || emit < commit {
		t.Fatal("the scheduled fan-out no longer runs after the commit")
	}
	// After the commit is not enough on its own: a failed commit must return
	// before the flush, or the emit happens anyway.
	between := sweep[commit:emit]
	if !strings.Contains(between, "return") {
		t.Error("a failed commit no longer skips the fan-out")
	}
}

func stripJobsLineComments(src string) string {
	var b strings.Builder
	for _, line := range strings.Split(src, "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}
