package routes

import (
	"os"
	"strings"
	"testing"
)

// POST /broadcasts/{id}/invite had no host check at all.
//
// `broadcast_invites` is the ENTIRE audience table for a private broadcast —
// goliveMayWatch, goliveAudienceSQL, the stream chat read/write gates and the
// poll gates all resolve to a row in it. An unchecked INSERT was therefore a
// self-service grant, and the handler skipped only `invitee == uid`, so two
// accounts sufficed:
//
//	A: POST /broadcasts/<privateId>/invite {"userIds":["B"]}
//	B: POST /broadcasts/<privateId>/invite {"userIds":["A"]}
//	B: POST /broadcasts/<privateId>/invite/accept
//
// Both then passed broadcastToken and received a LiveKit token for the host's
// private room; after accept stamped seen_at, goliveStageRole returned
// RoleSpeaker — publish rights. A stranger's camera and microphone on someone
// else's private stage.
//
// It was not an RLS-is-off bug: migration 082's WITH CHECK (inviter_id =
// vc_current_user_id()) would have passed too. The host check existed nowhere.
//
// Asserted against source because the real path needs Postgres, Redis and
// LiveKit. Comments are stripped first — this file describes the attack in
// prose, and a raw search would match the description rather than the code.
// See stripLineComments in internal/realtime/payload_bounds_test.go.

func broadcastSocialSrc(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("broadcast_social.go")
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

func inviteBody(t *testing.T, src string) string {
	t.Helper()
	i := strings.Index(src, "func broadcastInvite(")
	if i < 0 {
		t.Fatal("broadcastInvite is gone; update this test deliberately")
	}
	rest := src[i:]
	if j := strings.Index(rest, "\nfunc "); j > 0 {
		rest = rest[:j]
	}
	return rest
}

// The gate must read visibility and host, and it must do so BEFORE the insert.
func TestBroadcastInviteChecksTheHostBeforeWriting(t *testing.T) {
	body := inviteBody(t, broadcastSocialSrc(t))

	sel := strings.Index(body, "SELECT visibility, host_id FROM broadcast_sessions")
	if sel < 0 {
		t.Fatal("broadcastInvite no longer reads the broadcast's visibility and host — " +
			"any user can grant themselves access to any private broadcast")
	}
	ins := strings.Index(body, "INSERT INTO broadcast_invites")
	if ins < 0 {
		t.Fatal("the invite insert vanished; update this test deliberately")
	}
	if sel > ins {
		t.Fatal("the visibility/host lookup happens AFTER the insert — the row is " +
			"already written by the time anything is checked")
	}
}

// A private broadcast must refuse a non-host. The comparison is the load-bearing
// line; assert its exact shape so an inverted or widened condition fails here.
func TestPrivateBroadcastRefusesANonHostInviter(t *testing.T) {
	body := inviteBody(t, broadcastSocialSrc(t))

	if !strings.Contains(body, `visibility != "public" && hostID != uid`) {
		t.Fatal(`the private-broadcast gate changed shape; it must deny unless the ` +
			`broadcast is public OR the caller is the host (unrecognised visibility ` +
			`must deny, matching goliveMayWatch)`)
	}
	if strings.Count(body, `httpx.Err(w, 403`) < 2 {
		t.Fatalf("expected both the lookup failure and the non-host case to answer 403; " +
			"a 404 on one of them would confirm which broadcast ids exist")
	}
}

// Public must stay open. The handler's premise is that a public broadcast is
// reachable by anyone holding the link, so an invitation only notifies someone
// about something already permitted. Narrowing it would break sharing while
// protecting nothing — and a test that only checked "denies" would happily pass
// on a handler that denied everyone.
func TestPublicBroadcastInvitesAreStillAllowedForAnyone(t *testing.T) {
	body := inviteBody(t, broadcastSocialSrc(t))
	if strings.Contains(body, "hostID != uid {") && !strings.Contains(body, `visibility != "public"`) {
		t.Fatal("the gate now denies every non-host regardless of visibility — " +
			"public sharing is broken")
	}
}
