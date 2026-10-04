// groups_r4_test.go — round-4 group items: structured 409 codes on
// membership requests, communities edit/delete/leave/attach, updatedBy on
// shared-calendar events, and invite-link join requests merged into the
// pending queue.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run 'TestGroupsR4|TestMembershipWhyNotCode' -v
//
// Fixture ids carry the 4e03 marker.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/invites"
)

const (
	grOwner  = "4e030000-0000-4000-8000-0000000000a1"
	grAdmin  = "4e030000-0000-4000-8000-0000000000a2"
	grMember = "4e030000-0000-4000-8000-0000000000a3"
	grAsker  = "4e030000-0000-4000-8000-0000000000a4"
	grBanned = "4e030000-0000-4000-8000-0000000000a5"
	grLinker = "4e030000-0000-4000-8000-0000000000a6"
	grOpen   = "4e030000-0000-4000-8000-00000000c001" // admin_approval group
	grClosed = "4e030000-0000-4000-8000-00000000c002" // invite-only
	grAnn    = "4e030000-0000-4000-8000-00000000c003" // community announcements
	grSub    = "4e030000-0000-4000-8000-00000000c004" // community sub-group
	grLoose  = "4e030000-0000-4000-8000-00000000c005" // standalone, admin is grAdmin
	grComm   = "4e030000-0000-4000-8000-00000000d001"
	grComm2  = "4e030000-0000-4000-8000-00000000d002"
)

// No DB: every status maps to a stable code.
func TestMembershipWhyNotCode(t *testing.T) {
	want := map[invites.Status]string{
		invites.StatusJoined: "already_member", invites.StatusRejected: "invitation_declined",
		invites.StatusCancelled: "invitation_withdrawn", invites.StatusRevoked: "invitation_revoked",
		invites.StatusExpired: "invitation_expired", invites.StatusAccepted: "awaiting_approval",
		invites.StatusPending: "invitation_closed",
	}
	for st, code := range want {
		if got, msg := membershipWhyNotCode(st, "accepted"); got != code || msg == "" {
			t.Errorf("%s: code %q msg %q, want %q", st, got, msg, code)
		}
	}
	rec := httptest.NewRecorder()
	membershipConflict(rec, "cooldown", "You cannot rejoin this group yet", map[string]any{"cooldownUntil": "x"})
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 409 || body["code"] != "cooldown" || body["error"] != "You cannot rejoin this group yet" || body["cooldownUntil"] != "x" {
		t.Fatalf("conflict body = %d %v", rec.Code, body)
	}
}

func grCleanup() {
	ctx := context.Background()
	_ = adminExec(ctx, `DELETE FROM chats WHERE id::text LIKE '4e030000-0000-4000-8000-%'`)
	_ = adminExec(ctx, `DELETE FROM communities WHERE id::text LIKE '4e030000-0000-4000-8000-%'`)
	_ = adminExec(ctx, `DELETE FROM users WHERE id::text LIKE '4e030000-0000-4000-8000-%'`)
}

func grSeed(t *testing.T) *http.ServeMux {
	t.Helper()
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	grCleanup()
	t.Cleanup(grCleanup)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES ('%s','gro@t.test','Owner'), ('%s','gra@t.test','Admin'),
		  ('%s','grm@t.test','Member'), ('%s','grk@t.test','Asker'), ('%s','grb@t.test','Banned'), ('%s','grl@t.test','Linker')`,
			grOwner, grAdmin, grMember, grAsker, grBanned, grLinker),
		fmt.Sprintf(`INSERT INTO communities (id, name, created_by) VALUES ('%s','Comm','%s'), ('%s','Comm2','%s')`,
			grComm, grOwner, grComm2, grAdmin),
		fmt.Sprintf(`INSERT INTO chats (id, type, name, approval_mode, approve_members, community_id, is_announcement) VALUES
		  ('%s','group','Open','admin_approval',TRUE,NULL,FALSE), ('%s','group','Closed','strict',FALSE,NULL,FALSE),
		  ('%s','group','Comm Announcements','strict',FALSE,'%s',TRUE), ('%s','group','Sub','strict',FALSE,'%s',FALSE),
		  ('%s','group','Loose','strict',FALSE,NULL,FALSE)`,
			grOpen, grClosed, grAnn, grComm, grSub, grComm, grLoose),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		  ('%[1]s','%[3]s','owner'), ('%[1]s','%[4]s','admin'), ('%[1]s','%[5]s','member'),
		  ('%[2]s','%[3]s','owner'),
		  ('%[6]s','%[3]s','owner'), ('%[6]s','%[4]s','member'), ('%[6]s','%[5]s','member'),
		  ('%[7]s','%[3]s','owner'), ('%[7]s','%[5]s','member'),
		  ('%[8]s','%[4]s','admin'), ('%[8]s','%[5]s','member')`,
			grOpen, grClosed, grOwner, grAdmin, grMember, grAnn, grSub, grLoose),
		fmt.Sprintf(`INSERT INTO group_removals (chat_id, user_id, removed_by, cooldown_until) VALUES ('%s','%s','%s', NOW() + INTERVAL '1 day')`,
			grOpen, grBanned, grOwner),
		fmt.Sprintf(`INSERT INTO chat_join_requests (chat_id, user_id) VALUES ('%s','%s')`, grOpen, grLinker),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}
	mux := http.NewServeMux()
	RegisterChats(mux)
	RegisterCommunities(mux)
	return mux
}

func TestGroupsR4MembershipCodes(t *testing.T) {
	mux := grSeed(t)
	req := func(uid, chat string) (int, map[string]any) {
		return call(t, mux, uid, "POST", "/chats/"+chat+"/membership/request", "")
	}
	for _, c := range []struct {
		uid, chat, code string
	}{
		{grAsker, grClosed, "invite_only"},
		{grMember, grOpen, "already_member"},
		{grBanned, grOpen, "cooldown"},
	} {
		code, out := req(c.uid, c.chat)
		if code != 409 || out["code"] != c.code || out["error"] == nil {
			t.Errorf("%s: %d %v, want 409 %s", c.code, code, out, c.code)
		}
	}
	if code, out := req(grAsker, grOpen); code != 200 || out["pending"] != true {
		t.Fatalf("first request: %d %v", code, out)
	}
	if code, out := req(grAsker, grOpen); code != 409 || out["code"] != "already_requested" {
		t.Fatalf("second request: %d %v", code, out)
	}

	// Pending queue: without include, only invitations; with include=link the
	// link request joins, flagged and with no invitation id.
	rows := func(uid, q string) (int, []map[string]any) {
		r := httptest.NewRequest("GET", "/chats/"+grOpen+"/membership/pending"+q, nil)
		r.Header.Set("Authorization", "Bearer "+tokenFor(t, uid))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		var out []map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	code, plain := rows(grOwner, "")
	if code != 200 || len(plain) != 1 || plain[0]["source"] != "invitation" || plain[0]["userId"] != grAsker {
		t.Fatalf("pending plain: %d %v", code, plain)
	}
	_, merged := rows(grOwner, "?include=link")
	if len(merged) != 2 || merged[1]["source"] != "link" || merged[1]["userId"] != grLinker ||
		merged[1]["id"] != nil || merged[1]["canApprove"] != true {
		t.Fatalf("pending merged: %v", merged)
	}
	if code, _ := rows(grMember, "?include=link"); code != 403 {
		t.Fatalf("plain member pending: %d, want 403", code)
	}
}

func TestGroupsR4Communities(t *testing.T) {
	mux := grSeed(t)
	base := "/communities/" + grComm

	// Edit: owner only; empty name refused; description clears.
	if code, _ := call(t, mux, grMember, "PATCH", base, `{"name":"X"}`); code != 403 {
		t.Fatalf("member patch: %d", code)
	}
	if code, _ := call(t, mux, grOwner, "PATCH", base, `{"name":"  "}`); code != 400 {
		t.Fatalf("empty name: %d", code)
	}
	if code, _ := call(t, mux, grOwner, "PATCH", base, `{}`); code != 400 {
		t.Fatalf("no fields: %d", code)
	}
	code, out := call(t, mux, grOwner, "PATCH", base, `{"name":"Renamed","description":"About"}`)
	if code != 200 || out["name"] != "Renamed" || out["description"] != "About" {
		t.Fatalf("patch: %d %v", code, out)
	}
	if code, _ := call(t, mux, grOwner, "PATCH", "/communities/4e030000-0000-4000-8000-00000000d0ff", `{"name":"x"}`); code != 404 {
		t.Fatalf("missing: %d", code)
	}

	// Attach: community member AND group admin; foreign community, announcement
	// group and a non-admin are refused; attaching twice is idempotent.
	if code, _ := call(t, mux, grMember, "POST", base+"/groups/"+grLoose, ""); code != 403 {
		t.Fatalf("non-admin attach: %d, want 403", code)
	}
	if code, out := call(t, mux, grAdmin, "POST", base+"/groups/"+grLoose, ""); code != 200 || out["ok"] != true {
		t.Fatalf("attach: %d %v", code, out)
	}
	if code, out := call(t, mux, grAdmin, "POST", base+"/groups/"+grLoose, ""); code != 200 || out["already"] != true {
		t.Fatalf("attach again: %d %v", code, out)
	}
	// grAdmin is not a member of Comm2's chats (it has none) → 403.
	if code, _ := call(t, mux, grAdmin, "POST", "/communities/"+grComm2+"/groups/"+grLoose, ""); code != 403 {
		t.Fatalf("attach to a community you are not in: %d, want 403", code)
	}
	if code, _ := call(t, mux, grOwner, "POST", base+"/groups/"+grClosed, ""); code != 200 {
		t.Fatalf("owner attaches own group: %d", code)
	}

	// Leave: the owner cannot; a member leaves every group of the community.
	if code, out := call(t, mux, grOwner, "DELETE", base+"/members/me", ""); code != 409 || out["code"] != "owner_cannot_leave" {
		t.Fatalf("owner leave: %d %v", code, out)
	}
	code, out = call(t, mux, grMember, "DELETE", base+"/members/me", "")
	if code != 200 || len(out["leftChatIds"].([]any)) != 3 { // announcements, sub, loose (now attached)
		t.Fatalf("member leave: %d %v", code, out)
	}
	if code, _ := call(t, mux, grMember, "DELETE", base+"/members/me", ""); code != 403 {
		t.Fatalf("leave twice: %d, want 403", code)
	}
	var stillIn int
	_ = db.Pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM chat_members WHERE user_id = $1 AND left_at IS NULL AND chat_id IN ($2,$3,$4)`,
		grMember, grAnn, grSub, grLoose).Scan(&stillIn)
	if stillIn != 0 {
		t.Fatalf("member still in %d community chats", stillIn)
	}

	// Delete: owner only; the groups survive, unlinked, announcements unflagged.
	if code, _ := call(t, mux, grAdmin, "DELETE", base, ""); code != 403 {
		t.Fatalf("non-owner delete: %d", code)
	}
	if code, out := call(t, mux, grOwner, "DELETE", base, ""); code != 200 || out["ok"] != true {
		t.Fatalf("delete: %d %v", code, out)
	}
	var n, linked, flagged int
	_ = db.Pool.QueryRow(context.Background(),
		`SELECT COUNT(*), COUNT(community_id), COUNT(*) FILTER (WHERE is_announcement) FROM chats WHERE id IN ($1,$2,$3)`,
		grAnn, grSub, grLoose).Scan(&n, &linked, &flagged)
	if n != 3 || linked != 0 || flagged != 0 {
		t.Fatalf("after delete: chats=%d linked=%d flagged=%d", n, linked, flagged)
	}
}

func TestGroupsR4CalendarUpdatedBy(t *testing.T) {
	mux := grSeed(t)
	base := "/chats/" + grOpen + "/events"
	code, out := call(t, mux, grMember, "POST", base, `{"payload":"c1","monthKey":"2026-10"}`)
	if code != 200 {
		t.Fatalf("create: %d %v", code, out)
	}
	evID := fmt.Sprintf("%v", out["id"])
	list := func() map[string]any {
		r := httptest.NewRequest("GET", base+"?months=2026-10", nil)
		r.Header.Set("Authorization", "Bearer "+tokenFor(t, grOwner))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		var rows []map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &rows)
		if len(rows) != 1 {
			t.Fatalf("events: %d %s", rec.Code, rec.Body.String())
		}
		return rows[0]
	}
	if row := list(); row["createdBy"] != grMember || row["updatedBy"] != grMember {
		t.Fatalf("after create: %v", row)
	}
	// The owner (edit_settings) edits the member's event: updatedBy follows.
	if code, out := call(t, mux, grOwner, "PATCH", base+"/"+evID, `{"payload":"c2","monthKey":"2026-10"}`); code != 200 || out["updatedBy"] != grOwner {
		t.Fatalf("admin edit: %d %v", code, out)
	}
	if row := list(); row["createdBy"] != grMember || row["updatedBy"] != grOwner || row["payload"] != "c2" {
		t.Fatalf("after admin edit: %v", row)
	}
	// A row written before migration 143 (updated_by NULL) reports the creator.
	_ = adminExec(context.Background(), `UPDATE group_events SET updated_by = NULL WHERE id = `+evID)
	if row := list(); row["updatedBy"] != grMember {
		t.Fatalf("legacy row: %v", row)
	}
}
