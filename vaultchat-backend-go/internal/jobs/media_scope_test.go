// media_scope_test.go — chat retention must not reach non-chat content.
//
// WHY THIS TEST EXISTS
// --------------------
// `attachments` is a SHARED table. Profile avatars (app/(tabs)/profile.tsx,
// lib/onboarding.ts), story media, and every mini-app upload go through the
// same routes/uploads.go path as chat media. The only thing that makes a row
// "chat media" is a message referencing it via meta->>'attachmentId'.
//
// The media sweep's TTL branch originally had no such join, so shortening its
// window for the ephemeral body store pointed a THREE HOUR deletion timer at
// every avatar on the service. Measured against production before the fix:
//
//	live attachments  95
//	chat-referenced    8
//	non-chat          87
//	old predicate @3h  would delete 95  (87 of them non-chat)
//	new predicate      would delete  8  ( 0 of them non-chat)
//
// 92% of live media, none of it chat content, deleted by a job named for chat
// retention. The scoping is the whole fix, so it gets a test that fails loudly
// if anyone widens it again.
package jobs

import (
	"os"
	"strings"
	"testing"
	"time"
)

// mediaSweepSQL is the predicate as it appears in sweepDeliveredAttachments.
// Kept as a literal so the test pins the SHAPE of the query rather than
// re-deriving it — if the real statement changes, this diverges and the
// structural assertions below are what catch it.
func mediaSweepSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("jobs.go")
	if err != nil {
		t.Fatalf("read jobs.go: %v", err)
	}
	src := string(b)
	i := strings.Index(src, "func sweepDeliveredAttachments")
	if i < 0 {
		t.Fatal("sweepDeliveredAttachments not found — was it renamed?")
	}
	j := strings.Index(src[i:], "\nfunc ")
	if j < 0 {
		return src[i:]
	}
	return src[i : i+j]
}

func TestMediaSweepScopesShortWindowToChatMedia(t *testing.T) {
	src := mediaSweepSource(t)

	// Every branch that can delete on the SHORT window must be guarded by a
	// message reference. Two independent guards are required: the TTL branch
	// and the delivered-to-everyone branch.
	if strings.Count(src, "m.meta->>'attachmentId' = a.id::text") < 4 {
		t.Fatalf("expected the attachment-reference guard on every branch; the sweep is:\n%s", src)
	}
	if !strings.Contains(src, "NOT EXISTS (SELECT 1 FROM messages m") {
		t.Fatal("no NOT EXISTS branch — non-chat attachments have no separate (longer) window, " +
			"which means chat retention governs avatars and mini-app content")
	}
	if !strings.Contains(src, "chatCutoff") || !strings.Contains(src, "orphanCutoff") {
		t.Fatal("expected two distinct cutoffs: chat media and non-chat orphans")
	}
}

func TestMediaSweepDeliveredBranchRequiresAMessage(t *testing.T) {
	src := mediaSweepSource(t)
	// The delivered-to-all branch compares a delivery count against the number
	// of chat recipients. For a row no message references that recipient count
	// is 0, so `deliveries >= 0` is trivially true and ANY downloaded avatar
	// becomes eligible. The EXISTS guard must come first in that branch.
	idx := strings.Index(src, "attachment_deliveries")
	if idx < 0 {
		t.Fatal("delivered-to-all branch not found")
	}
	before := src[:idx]
	if !strings.Contains(before, "EXISTS (SELECT 1 FROM messages m") {
		t.Fatal("the delivered-to-all branch is not guarded by a message reference: " +
			"deliveries >= 0 is trivially true for non-chat rows, so a viewed avatar is purgeable")
	}
}

func TestMediaHardTTLCannotExceedThreeHours(t *testing.T) {
	// Same asymmetry as bodyTTL: the knob may only tighten. A media object
	// outliving the message body that carries its decryption key is pointless
	// ciphertext; outliving it by a configurable amount is a retention hole.
	for _, v := range []string{"", "0", "-5", "4", "24", "8760", "notanumber"} {
		t.Setenv("MEDIA_TTL_HOURS", v)
		if got := mediaHardTTL(); got > 3*time.Hour {
			t.Fatalf("MEDIA_TTL_HOURS=%q produced %v, exceeding the 3h ceiling", v, got)
		}
	}
	t.Setenv("MEDIA_TTL_HOURS", "1")
	if got := mediaHardTTL(); got != time.Hour {
		t.Fatalf("mediaHardTTL() = %v, want 1h — the knob must be able to tighten", got)
	}
}
