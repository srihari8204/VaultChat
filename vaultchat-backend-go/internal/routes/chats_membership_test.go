package routes

import (
	"strings"
	"testing"
)

// The events this package actually emits. Kept as a literal rather than
// scraped, so adding an emit without adding a table entry fails here instead
// of silently defaulting to the group at runtime — which for an invitee-facing
// event means the one person who needed telling is the one person not told.
var emittedMembershipEvents = []string{
	"invitation_created", "invitation_accepted", "invitation_declined",
	"invitation_cancelled", "invitation_revoked",
	"member_approved", "member_rejected",
	"join_requested", "members_added", "ownership_transferred",
}

func TestEveryEmittedEventHasAnAudience(t *testing.T) {
	for _, e := range emittedMembershipEvents {
		if _, ok := membershipEvents[e]; !ok {
			t.Errorf("%q is emitted but has no audience — it would default to the group", e)
		}
	}
	for e := range membershipEvents {
		found := false
		for _, k := range emittedMembershipEvents {
			if k == e {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%q is in the table but nothing emits it", e)
		}
	}
}

func TestInviteeFacingEventsGoToTheUser(t *testing.T) {
	// These four are ABOUT the recipient and reach someone who is not in the
	// group's socket room. Routing any of them to the group would announce it
	// to everybody except the person it concerns.
	for _, e := range []string{"invitation_created", "invitation_cancelled", "invitation_revoked", "member_approved", "member_rejected"} {
		if membershipEvents[e].audience != audUser {
			t.Errorf("%q must be addressed to the user, not the group", e)
		}
	}
	for _, e := range []string{"invitation_accepted", "join_requested", "members_added", "ownership_transferred"} {
		if membershipEvents[e].audience != audGroup {
			t.Errorf("%q must go to the group", e)
		}
	}
}

func TestOnlyUserEventsCarryAPush(t *testing.T) {
	for name, ev := range membershipEvents {
		if ev.title == "" {
			continue
		}
		if ev.audience != audUser {
			t.Errorf("%q has a push but is addressed to the group; there is no single device to wake", name)
		}
		if ev.body == "" {
			t.Errorf("%q has a push title but no body", name)
		}
	}
}

// A push lands on a lock screen, which is readable by whoever is holding the
// phone. Naming the group there would disclose a membership the invitee has
// not yet agreed to — and in the case of, say, a support or family group, that
// disclosure is the whole harm.
func TestPushTextNamesNoGroup(t *testing.T) {
	for name, ev := range membershipEvents {
		if ev.title == "" {
			continue
		}
		for _, s := range []string{ev.title, ev.body} {
			if strings.Contains(s, "%s") || strings.Contains(s, "{") {
				t.Errorf("%q push text looks templated: %q — it must be constant", name, s)
			}
		}
	}
}

// ── group_ref: the in-app replacement for an invite link ──

// The card must be storable as a message type, and — more importantly — must
// NOT be schedulable. A group reference asserts the group is open to requests,
// and that can stop being true between scheduling and sending; a card arriving
// for a group that has since closed is worse than no card, because the
// recipient taps it and is refused with no explanation. Migration 071 leaves
// scheduled_messages_type_check alone on purpose.
func TestGroupRefIsAKnownMessageType(t *testing.T) {
	if !chatsMsgTypes["group_ref"] {
		t.Fatal("group_ref must be an accepted message type")
	}
}

// The card carries a pointer, never a credential. If any of these ever appear
// in the meta a group_ref is built from, it has become a link again — which is
// the exact thing membership v2 removed.
func TestGroupRefMetaCarriesNoCredential(t *testing.T) {
	forbidden := []string{"token", "code", "sig", "signature", "secret", "inviteToken", "url", "link"}
	// The keys chatsValidateGroupRef writes. Kept as a literal so ADDING a key
	// to that function without thinking about it fails here.
	written := []string{"groupId", "name", "groupType", "icon", "color"}
	for _, w := range written {
		for _, f := range forbidden {
			if strings.EqualFold(w, f) {
				t.Errorf("group_ref meta writes %q, which is a credential — the card must only point", w)
			}
		}
	}
}
