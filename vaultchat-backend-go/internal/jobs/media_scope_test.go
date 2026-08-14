// media_scope_test.go — retention is per content class, and the classes that
// must never be swept are absent from the sweep entirely.
//
// WHY THIS TEST EXISTS
// --------------------
// `attachments` is a SHARED table: chat media, profile avatars, group photos
// and story media all arrive through routes/uploads.go. Retention used to be
// inferred from whether a `messages` row referenced the object, which is a
// side effect rather than a purpose, and it failed in both directions:
//
//	FALSE ORPHAN  an avatar is referenced by users.photo_url and no message,
//	              so the sweep deleted every avatar 14 days after upload —
//	              silently, because purged_at is stamped and the serve path
//	              never reads it. Verified pending on production before the fix.
//	FALSE CHAT    delete-for-everyone NULLs messages.meta, destroying the only
//	              reference to that message's attachment.
//
// And shortening the chat window for the ephemeral body store pointed a THREE
// HOUR timer at all of it. Measured on production at that moment:
//
//	live 95 · chat-referenced 8 · non-chat 87
//	old predicate @3h → 95 deleted (87 non-chat) · scoped → 8 (0 non-chat)
//
// Purpose is now a stored fact (migration 100). These tests pin the property
// that matters: a class the sweep does not NAME cannot be deleted by it, so
// forgetting a class fails toward retention rather than loss.
package jobs

import (
	"os"
	"strings"
	"testing"
	"time"
)

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

// The heart of it. These four classes must be unreachable by this job.
func TestSweepCannotDeleteProtectedPurposes(t *testing.T) {
	src := mediaSweepSource(t)
	for _, p := range []string{"profile", "group", "mini_app", "unknown"} {
		if strings.Contains(src, "'"+p+"'") {
			t.Errorf("purpose %q appears in the media sweep — it must be absent so the job "+
				"cannot delete it at all; retention for %q is owned elsewhere", p, p)
		}
	}
}

func TestSweepIsPurposeScopedNotReferenceInferred(t *testing.T) {
	src := mediaSweepSource(t)
	if !strings.Contains(src, "a.purpose = 'chat'") {
		t.Fatal("the sweep does not filter on purpose — it is still inferring class from references, " +
			"which is what deleted avatars")
	}
	// Both chat branches (delivered-to-all, and past-the-window) must carry it.
	if strings.Count(src, "a.purpose = 'chat'") < 2 {
		t.Fatalf("every chat branch must be purpose-scoped; found %d, want >= 2",
			strings.Count(src, "a.purpose = 'chat'"))
	}
}

func TestStoryMediaSurvivesUntilItsStoryIsGone(t *testing.T) {
	src := mediaSweepSource(t)
	if !strings.Contains(src, "a.purpose = 'story'") {
		t.Fatal("story media has no branch — it is either unreachable (fine) or swept by a chat rule (not fine)")
	}
	// Eligibility must depend on the STORY row disappearing, never on age. The
	// story's own 24h expiry is authoritative and sweepExpiredStories enforces
	// it; an age test here could delete the media out from under a live story.
	i := strings.Index(src, "a.purpose = 'story'")
	branch := src[i:]
	if e := strings.Index(branch, "\n\t\t      OR"); e > 0 {
		branch = branch[:e]
	}
	if !strings.Contains(branch, "NOT EXISTS (SELECT 1 FROM stories s") {
		t.Fatal("story branch is not gated on the story row being gone")
	}
	if strings.Contains(branch, "created_at <") {
		t.Fatal("story media is being aged out directly — the story's own expiry must be the only trigger")
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
