// channels_manage_test.go — broadcast channels: leave, admin post delete, and
// channelId on posts.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run TestChannelManage -v
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
)

const (
	cmAdmin = "4e020000-0000-4000-8000-0000000000a1"
	cmSub   = "4e020000-0000-4000-8000-0000000000a2"
	cmOther = "4e020000-0000-4000-8000-0000000000a3"
	cmChan  = "4e020000-0000-4000-8000-00000000c001"
	cmChan2 = "4e020000-0000-4000-8000-00000000c002"
)

func TestChannelManage(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	cleanup := func() {
		_ = adminExec(ctx, `DELETE FROM users WHERE id::text LIKE '4e020000-0000-4000-8000-%'`)
	}
	cleanup()
	t.Cleanup(cleanup)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES ('%s','cma@t.test','Admin'), ('%s','cms@t.test','Sub'), ('%s','cmo@t.test','Other')`,
			cmAdmin, cmSub, cmOther),
		fmt.Sprintf(`INSERT INTO channels (id, name, admin_id, invite_code) VALUES ('%s','News','%s','4E02-AAAA'), ('%s','Other','%s','4E02-BBBB')`,
			cmChan, cmAdmin, cmChan2, cmOther),
		fmt.Sprintf(`INSERT INTO channel_subscribers (channel_id, user_id) VALUES ('%s','%s')`, cmChan, cmSub),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}
	mux := http.NewServeMux()
	RegisterChannels(mux)
	base := "/channels/" + cmChan

	code, p1 := call(t, mux, cmAdmin, "POST", base+"/posts", `{"text":"first"}`)
	if code != 200 || p1["channelId"] != cmChan {
		t.Fatalf("post 1: %d %v", code, p1)
	}
	_, p2 := call(t, mux, cmAdmin, "POST", base+"/posts", `{"text":"second"}`)
	_, o2 := call(t, mux, cmOther, "POST", "/channels/"+cmChan2+"/posts", `{"text":"elsewhere"}`)

	// Only the admin deletes; a post id from another channel is 404 here.
	if code, _ := call(t, mux, cmSub, "DELETE", base+"/posts/"+p2["id"].(string), ""); code != 403 {
		t.Fatalf("subscriber delete: %d, want 403", code)
	}
	if code, _ := call(t, mux, cmAdmin, "DELETE", base+"/posts/"+o2["id"].(string), ""); code != 404 {
		t.Fatalf("foreign post: %d, want 404", code)
	}
	if code, _ := call(t, mux, cmAdmin, "DELETE", base+"/posts/x", ""); code != 400 {
		t.Fatalf("bad id: %d, want 400", code)
	}
	code, out := call(t, mux, cmAdmin, "DELETE", base+"/posts/"+p2["id"].(string), "")
	if code != 200 || out["ok"] != true || out["channelId"] != cmChan {
		t.Fatalf("delete: %d %v", code, out)
	}
	if code, _ := call(t, mux, cmAdmin, "DELETE", base+"/posts/"+p2["id"].(string), ""); code != 404 {
		t.Fatalf("delete twice: %d, want 404", code)
	}
	// The preview falls back to the newest remaining post.
	var last *string
	if err := db.Pool.QueryRow(ctx, `SELECT last_post FROM channels WHERE id = $1`, cmChan).Scan(&last); err != nil ||
		last == nil || *last != "first" {
		t.Fatalf("last_post = %v %v, want first", last, err)
	}
	// GET posts carries channelId too (the body is an array, so read it raw).
	req := httptest.NewRequest("GET", base+"/posts", nil)
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, cmSub))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var posts []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &posts); rec.Code != 200 || err != nil ||
		len(posts) != 1 || posts[0]["channelId"] != cmChan || posts[0]["text"] != "first" {
		t.Fatalf("get posts: %d %s", rec.Code, rec.Body.String())
	}

	// Leave: the admin cannot; the subscriber can, twice; then reading is 403.
	if code, _ := call(t, mux, cmAdmin, "POST", base+"/leave", ""); code != 409 {
		t.Fatalf("admin leave: %d, want 409", code)
	}
	for i := 0; i < 2; i++ {
		if code, out := call(t, mux, cmSub, "POST", base+"/leave", ""); code != 200 || out["ok"] != true {
			t.Fatalf("leave #%d: %d %v", i+1, code, out)
		}
	}
	if code, _ := call(t, mux, cmSub, "GET", base+"/posts", ""); code != 403 {
		t.Fatalf("after leave: %d, want 403", code)
	}
	if code, _ := call(t, mux, cmSub, "POST", "/channels/4e020000-0000-4000-8000-00000000c0ff/leave", ""); code != 404 {
		t.Fatalf("missing channel leave: %d, want 404", code)
	}
}
