// stories_audience_base_test.go — GET /stories/audience?base=1 lists everyone
// the author shares an active chat with (a group-only peer included) BEFORE the
// status-privacy filter, minus blocks, and hides a photo its owner hid.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run TestStoriesAudienceBase -v
//
// Every fixture id carries the 5a0d marker; the cleanup removes exactly those.
package routes

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"sort"
	"testing"

	"vaultchat/backend-go/internal/db"
)

const (
	sabChat    = "5a0d0000-0000-4000-8000-00000000c001"
	sabAuthor  = "5a0d0000-0000-4000-8000-00000000a001"
	sabPeer    = "5a0d0000-0000-4000-8000-00000000a002"
	sabHidden  = "5a0d0000-0000-4000-8000-00000000a003" // photo hidden
	sabBlocked = "5a0d0000-0000-4000-8000-00000000a004"
	sabMarker  = "5a0d0000-0000-4000-8000-%"
)

func sabCleanup() {
	ctx := context.Background()
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM chats WHERE id::text LIKE '%s'`, sabMarker))
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM users WHERE id::text LIKE '%s'`, sabMarker))
}

func TestStoriesAudienceBase(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	sabCleanup()
	t.Cleanup(sabCleanup)
	for _, s := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name, photo_url, status_privacy) VALUES
		  ('%s','sab1@t.test','Author',NULL,'only'), ('%s','sab2@t.test','Peer','p.jpg','contacts'),
		  ('%s','sab3@t.test','Hidden','h.jpg','contacts'), ('%s','sab4@t.test','Blocked',NULL,'contacts')`,
			sabAuthor, sabPeer, sabHidden, sabBlocked),
		fmt.Sprintf(`UPDATE users SET profile_photo_visible = FALSE WHERE id = '%s'`, sabHidden),
		fmt.Sprintf(`INSERT INTO chats (id, type, name) VALUES ('%s','group','SAB group')`, sabChat),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		  ('%[1]s','%[2]s','admin'), ('%[1]s','%[3]s','member'), ('%[1]s','%[4]s','member'), ('%[1]s','%[5]s','member')`,
			sabChat, sabAuthor, sabPeer, sabHidden, sabBlocked),
		fmt.Sprintf(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('%s','%s')`, sabBlocked, sabAuthor),
	} {
		if err := adminExec(ctx, s); err != nil {
			t.Fatalf("seed: %v\n%s", err, s)
		}
	}
	mux := http.NewServeMux()
	RegisterStories(mux)

	// 'only' with nobody listed: the real audience is empty...
	code, out := call(t, mux, sabAuthor, "GET", "/stories/audience", "")
	if code != 200 || len(out["viewerIds"].([]any)) != 0 {
		t.Fatalf("filtered audience: %d %v, want 200 and none", code, out)
	}
	// ...but the picker still gets both group peers, never the blocker.
	code, out = call(t, mux, sabAuthor, "GET", "/stories/audience?base=1", "")
	if code != 200 {
		t.Fatalf("base: %d %v", code, out)
	}
	got := []string{}
	photo := map[string]any{}
	for _, p := range out["people"].([]any) {
		m := p.(map[string]any)
		got = append(got, m["id"].(string))
		photo[m["id"].(string)] = m["photoURL"]
	}
	sort.Strings(got)
	if fmt.Sprint(got) != fmt.Sprint([]string{sabPeer, sabHidden}) {
		t.Fatalf("base people = %v, want [%s %s]", got, sabPeer, sabHidden)
	}
	if photo[sabPeer] != "p.jpg" || photo[sabHidden] != nil {
		t.Fatalf("photos = %v, want the peer's and none for the hidden one", photo)
	}
}
