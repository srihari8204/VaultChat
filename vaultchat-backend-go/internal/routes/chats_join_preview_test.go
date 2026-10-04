// chats_join_preview_test.go — GET /chats/join/{code}/preview tells a
// non-member only name, member count and whether approval is needed.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run TestChatsJoinPreview -v
package routes

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"sort"
	"testing"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/redisx"
)

const (
	jpChat   = "5d000000-0000-4000-8000-00000000c001"
	jpOwner  = "5d000000-0000-4000-8000-00000000a001"
	jpMember = "5d000000-0000-4000-8000-00000000a002"
	jpGone   = "5d000000-0000-4000-8000-00000000a003"
	jpViewer = "5d000000-0000-4000-8000-00000000a004" // not a member
	jpMarker = "5d000000-0000-4000-8000-%"
)

func jpCleanup() {
	ctx := context.Background()
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM chats WHERE id::text LIKE '%s'`, jpMarker))
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM users WHERE id::text LIKE '%s'`, jpMarker))
}

func TestChatsJoinPreview(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	jpCleanup()
	t.Cleanup(jpCleanup)
	redisx.Reset(ctx, "chatjoin:preview:"+jpViewer)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES ('%s','jp1@t.test','O'),
		  ('%s','jp2@t.test','M'), ('%s','jp3@t.test','G'), ('%s','jp4@t.test','V')`,
			jpOwner, jpMember, jpGone, jpViewer),
		fmt.Sprintf(`INSERT INTO chats (id, type, name, approve_members, created_by)
		  VALUES ('%s','group','Cricket Club',TRUE,'%s')`, jpChat, jpOwner),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		  ('%[1]s','%[2]s','admin'), ('%[1]s','%[3]s','member'), ('%[1]s','%[4]s','member')`,
			jpChat, jpOwner, jpMember, jpGone),
		fmt.Sprintf(`UPDATE chat_members SET left_at = NOW() WHERE user_id = '%s'`, jpGone),
		fmt.Sprintf(`INSERT INTO invite_links (code, chat_id, created_by) VALUES ('zbeLIVE1','%[1]s','%[2]s')`, jpChat, jpOwner),
		fmt.Sprintf(`INSERT INTO invite_links (code, chat_id, created_by, revoked) VALUES ('zbeREVOKED','%[1]s','%[2]s',TRUE)`, jpChat, jpOwner),
		fmt.Sprintf(`INSERT INTO invite_links (code, chat_id, created_by, expires_at) VALUES ('zbeEXPIRED','%[1]s','%[2]s',NOW()-INTERVAL '1 hour')`, jpChat, jpOwner),
		fmt.Sprintf(`INSERT INTO invite_links (code, chat_id, created_by, max_uses, uses) VALUES ('zbeUSEDUP','%[1]s','%[2]s',1,1)`, jpChat, jpOwner),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}
	mux := http.NewServeMux()
	RegisterChats(mux) // also proves the new pattern does not collide with /chats/{id}/

	code, out := call(t, mux, jpViewer, "GET", "/chats/join/zbeLIVE1/preview", "")
	if code != 200 {
		t.Fatalf("live: %d %v", code, out)
	}
	keys := []string{}
	for k := range out {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if fmt.Sprint(keys) != "[memberCount name requiresApproval]" {
		t.Errorf("preview fields = %v, want exactly memberCount, name, requiresApproval", keys)
	}
	if out["name"] != "Cricket Club" || out["memberCount"] != float64(2) || out["requiresApproval"] != true {
		t.Errorf("preview = %v", out)
	}
	// Previewing does not join or queue anything.
	var n int
	_ = db.Pool.QueryRow(ctx, `SELECT
	   (SELECT COUNT(*) FROM chat_members WHERE chat_id = $1 AND user_id = $2) +
	   (SELECT COUNT(*) FROM chat_join_requests WHERE chat_id = $1 AND user_id = $2)`, jpChat, jpViewer).Scan(&n)
	if n != 0 {
		t.Errorf("preview created %d membership/request rows", n)
	}

	for _, c := range []string{"zbeREVOKED", "zbeEXPIRED", "zbeUSEDUP", "nope-not-a-code"} {
		if code, out = call(t, mux, jpViewer, "GET", "/chats/join/"+c+"/preview", ""); code != 410 {
			t.Errorf("%s: %d %v, want 410", c, code, out)
		}
	}
	// 30 per 10 minutes per user: 5 used above, the 31st is refused.
	for i := 0; i < 25; i++ {
		call(t, mux, jpViewer, "GET", "/chats/join/nope/preview", "")
	}
	if code, out = call(t, mux, jpViewer, "GET", "/chats/join/zbeLIVE1/preview", ""); code != 429 {
		t.Errorf("31st preview: %d %v, want 429", code, out)
	}
	redisx.Reset(ctx, "chatjoin:preview:"+jpViewer)
}
