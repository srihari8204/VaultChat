// ghost_rest_parity_test.go — Ghost Mode on the REST reads.
//
// Realtime withholds a ghosted contact's presence_changed (hide_online) and
// message_read (hide_read) from the target, and GET /chats already blanked
// last seen for hide_last_seen. These pin that a reload — GET /chats,
// GET /chats/{id}, Message Info, the trusted-contacts list — does not hand
// back what realtime hid, and that the override stays per-target.
//
// Also: /contacts/sync/verify is single-use under concurrent redemption.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run 'TestGhostRestParity|TestSyncVerifySingleUse' -v
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"testing"

	"vaultchat/backend-go/internal/db"
)

const (
	ghrMe     = "7a700000-0000-4000-8000-00000000a001" // the caller
	ghrGhost  = "7a700000-0000-4000-8000-00000000a002" // hides everything from ghrMe only
	ghrPlain  = "7a700000-0000-4000-8000-00000000a003" // hides nothing
	ghrDMg    = "7a700000-0000-4000-8000-00000000c001" // direct ghrMe–ghrGhost
	ghrDMp    = "7a700000-0000-4000-8000-00000000c002" // direct ghrMe–ghrPlain
	ghrGroup  = "7a700000-0000-4000-8000-00000000c003" // all three
	ghrMarker = "7a700000-0000-4000-8000-%"
)

func ghrCleanup() {
	ctx := context.Background()
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM sync_codes WHERE initiator_id::text LIKE '%s'`, ghrMarker))
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM chats WHERE id::text LIKE '%s'`, ghrMarker))
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM users WHERE id::text LIKE '%s'`, ghrMarker))
}

func ghrDB(t *testing.T) context.Context {
	t.Helper()
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	ghrCleanup()
	t.Cleanup(ghrCleanup)
	return ctx
}

func ghrMember(t *testing.T, members []any, uid string) map[string]any {
	t.Helper()
	for _, m := range members {
		if mm, _ := m.(map[string]any); mm != nil && mm["userId"] == uid {
			return mm
		}
	}
	t.Fatalf("member %s missing", uid)
	return nil
}

func TestGhostRestParity(t *testing.T) {
	ctx := ghrDB(t)
	var msgID int64
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name, online, last_seen_at) VALUES
		  ('%s','gr1@t.test','Me',TRUE,NOW()), ('%s','gr2@t.test','Ghost',TRUE,NOW()),
		  ('%s','gr3@t.test','Plain',TRUE,NOW())`, ghrMe, ghrGhost, ghrPlain),
		fmt.Sprintf(`INSERT INTO chats (id, type, created_by) VALUES
		  ('%s','direct','%s'), ('%s','direct','%s')`, ghrDMg, ghrMe, ghrDMp, ghrMe),
		fmt.Sprintf(`INSERT INTO chats (id, type, name, created_by) VALUES ('%s','group','G','%s')`, ghrGroup, ghrMe),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		  ('%[1]s','%[4]s','member'), ('%[1]s','%[5]s','member'),
		  ('%[2]s','%[4]s','member'), ('%[2]s','%[6]s','member'),
		  ('%[3]s','%[4]s','admin'), ('%[3]s','%[5]s','member'), ('%[3]s','%[6]s','member')`,
			ghrDMg, ghrDMp, ghrGroup, ghrMe, ghrGhost, ghrPlain),
		fmt.Sprintf(`INSERT INTO ghost_mode (owner_id, target_id, hide_online, hide_read, hide_last_seen)
		  VALUES ('%s','%s',TRUE,TRUE,TRUE)`, ghrGhost, ghrMe),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`INSERT INTO messages (chat_id, sender_id, content) VALUES ('%s','%s','x') RETURNING id`, ghrGroup, ghrMe), &msgID); err != nil {
		t.Fatalf("seed message: %v", err)
	}
	// Everyone has read and received past the message.
	if err := adminExec(ctx, fmt.Sprintf(`UPDATE chat_members SET last_read_message_id = %[1]d,
	  last_delivered_message_id = %[1]d WHERE chat_id::text LIKE '%[2]s'`, msgID, ghrMarker)); err != nil {
		t.Fatalf("seed pointers: %v", err)
	}
	if err := adminExec(ctx, fmt.Sprintf(`INSERT INTO trusted_contacts (owner_id, contact_id) VALUES
	  ('%[1]s','%[2]s'), ('%[1]s','%[3]s')`, ghrMe, ghrGhost, ghrPlain)); err != nil {
		t.Fatalf("seed trusted: %v", err)
	}

	mux := http.NewServeMux()
	RegisterChats(mux)
	RegisterFamilySafety(mux)

	// GET /chats — the direct-chat peer fields.
	byID := map[string]map[string]any{}
	for _, c := range opList(t, mux, ghrMe, "/chats") {
		byID[fmt.Sprint(c["id"])] = c
	}
	g, p := byID[ghrDMg], byID[ghrDMp]
	if g == nil || p == nil {
		t.Fatalf("list is missing the direct chats: %v", byID)
	}
	if g["peerOnline"] != false || g["peerLastSeenAt"] != nil || g["peerLastReadMessageId"] != nil {
		t.Errorf("ghosted peer leaks via GET /chats: online=%v lastSeen=%v lastRead=%v",
			g["peerOnline"], g["peerLastSeenAt"], g["peerLastReadMessageId"])
	}
	if g["peerLastDeliveredMessageId"] == nil {
		t.Errorf("delivered is not hidden by Ghost Mode, got nil")
	}
	if p["peerOnline"] != true || p["peerLastSeenAt"] == nil || p["peerLastReadMessageId"] == nil {
		t.Errorf("plain peer over-masked: %v", p)
	}

	// GET /chats/{id} — group members, as the target and as a bystander.
	code, out := call(t, mux, ghrMe, "GET", "/chats/"+ghrGroup, "")
	if code != 200 {
		t.Fatalf("chat get: %d %v", code, out)
	}
	members, _ := out["members"].([]any)
	gm, pm := ghrMember(t, members, ghrGhost), ghrMember(t, members, ghrPlain)
	if gm["online"] != false || gm["lastSeenAt"] != nil || gm["lastReadMessageId"] != nil {
		t.Errorf("ghosted member leaks via GET /chats/{id}: %v", gm)
	}
	if gm["lastDeliveredMessageId"] == nil {
		t.Errorf("ghosted member's delivered pointer should stay")
	}
	if pm["online"] != true || pm["lastSeenAt"] == nil || pm["lastReadMessageId"] == nil {
		t.Errorf("plain member over-masked: %v", pm)
	}
	// Per-target: ghrPlain still sees ghrGhost.
	code, out = call(t, mux, ghrPlain, "GET", "/chats/"+ghrGroup, "")
	if code != 200 {
		t.Fatalf("chat get (bystander): %d %v", code, out)
	}
	members, _ = out["members"].([]any)
	if gb := ghrMember(t, members, ghrGhost); gb["online"] != true || gb["lastSeenAt"] == nil || gb["lastReadMessageId"] == nil {
		t.Errorf("override leaked to someone it does not target: %v", gb)
	}

	// Message Info on my group message.
	code, out = call(t, mux, ghrMe, "GET", fmt.Sprintf("/chats/%s/messages/%d/receipts", ghrGroup, msgID), "")
	if code != 200 {
		t.Fatalf("receipts: %d %v", code, out)
	}
	rows, _ := out["members"].([]any)
	if rg := ghrMember(t, rows, ghrGhost); rg["read"] != false || rg["readAt"] != nil || rg["delivered"] != true {
		t.Errorf("Message Info leaks a hidden read: %v", rg)
	}
	if rp := ghrMember(t, rows, ghrPlain); rp["read"] != true {
		t.Errorf("Message Info over-masked the plain member: %v", rp)
	}

	// Trusted contacts list.
	code, raw := opCall(t, mux, ghrMe, "GET", "/contacts/trusted", "")
	if code != 200 {
		t.Fatalf("trusted: %d %s", code, raw)
	}
	var trusted []any
	if err := json.Unmarshal(raw, &trusted); err != nil {
		t.Fatalf("trusted body: %v", err)
	}
	if tg := ghrMember(t, trusted, ghrGhost); tg["online"] != false {
		t.Errorf("trusted list leaks hidden online: %v", tg)
	}
	if tp := ghrMember(t, trusted, ghrPlain); tp["online"] != true {
		t.Errorf("trusted list over-masked: %v", tp)
	}
}

// Two people racing the same code: exactly one wins. Before, both could pass
// the `verified_at` read and both run the UPDATE, each learning the initiator.
func TestSyncVerifySingleUse(t *testing.T) {
	ctx := ghrDB(t)
	const racers = 8
	ids := make([]string, racers)
	for i := range ids {
		ids[i] = fmt.Sprintf("7a700000-0000-4000-8000-0000000b%04d", i)
	}
	seed := fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES ('%s','gr1@t.test','Init')`, ghrMe)
	for i, id := range ids {
		seed += fmt.Sprintf(`, ('%s','grr%d@t.test','R%d')`, id, i, i)
	}
	for _, q := range []string{
		seed,
		fmt.Sprintf(`INSERT INTO sync_codes (code, initiator_id, expires_at) VALUES
		  ('907711','%[1]s',NOW() + INTERVAL '5 minutes'), ('907712','%[1]s',NOW() - INTERVAL '1 minute')`, ghrMe),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}
	mux := http.NewServeMux()
	RegisterContacts(mux)

	for round := 0; round < 5; round++ {
		if round > 0 {
			if err := adminExec(ctx, `UPDATE sync_codes SET verified_at = NULL, verified_by = NULL WHERE code = '907711'`); err != nil {
				t.Fatalf("reset: %v", err)
			}
		}
		codes := make([]int, racers)
		var start, wg sync.WaitGroup
		start.Add(1)
		for i := range ids {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				start.Wait()
				codes[i], _ = call(t, mux, ids[i], "POST", "/contacts/sync/verify", `{"code":"907711"}`)
			}(i)
		}
		start.Done()
		wg.Wait()
		ok, conflict, winner := 0, 0, ""
		for i, c := range codes {
			switch c {
			case 200:
				ok++
				winner = ids[i]
			case http.StatusConflict:
				conflict++
			default:
				t.Errorf("round %d racer %d: status %d", round, i, c)
			}
		}
		if ok != 1 || conflict != racers-1 {
			t.Fatalf("round %d: %d succeeded, %d got 409 (want 1 and %d)", round, ok, conflict, racers-1)
		}
		var by string
		if err := db.Pool.QueryRow(ctx, `SELECT verified_by::text FROM sync_codes WHERE code = '907711'`).Scan(&by); err != nil || by != winner {
			t.Fatalf("round %d: verified_by = %q (%v), want the one 200 %q", round, by, err, winner)
		}
	}

	if c, out := call(t, mux, ids[0], "POST", "/contacts/sync/verify", `{"code":"907712"}`); c != http.StatusGone {
		t.Errorf("expired code: %d %v, want 410", c, out)
	}
	// The initiator cannot consume their own code.
	if err := adminExec(ctx, `UPDATE sync_codes SET verified_at = NULL, verified_by = NULL WHERE code = '907711'`); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if c, out := call(t, mux, ghrMe, "POST", "/contacts/sync/verify", `{"code":"907711"}`); c != 400 {
		t.Errorf("self-redeem: %d %v, want 400", c, out)
	}
}
