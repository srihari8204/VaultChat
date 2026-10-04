// sos_reached_test.go — POST /user/sos reports contactsReached: contacts for
// whom the push provider accepted the alert on at least one device. A fake
// Expo endpoint answers "ok" for tokens containing "good" and
// DeviceNotRegistered for the rest.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run TestSosContactsReached -v
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/db"
)

const (
	sosOwner = "4e040000-0000-4000-8000-0000000000a1"
	sosC1    = "4e040000-0000-4000-8000-0000000000a2" // good device
	sosC2    = "4e040000-0000-4000-8000-0000000000a3" // dead device only
	sosC3    = "4e040000-0000-4000-8000-0000000000a4" // no device
	sosC4    = "4e040000-0000-4000-8000-0000000000a5" // one good, one dead
)

func TestSosContactsReached(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var msgs []map[string]any
		_ = json.Unmarshal(raw, &msgs)
		out := []map[string]any{}
		for _, m := range msgs {
			if strings.Contains(m["to"].(string), "good") {
				out = append(out, map[string]any{"status": "ok", "id": "x"})
			} else {
				out = append(out, map[string]any{"status": "error", "details": map[string]any{"error": "DeviceNotRegistered"}})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": out})
	}))
	defer fake.Close()
	prev := userExpoPushURL
	userExpoPushURL = fake.URL
	t.Cleanup(func() { userExpoPushURL = prev })

	cleanup := func() { _ = adminExec(ctx, `DELETE FROM users WHERE id::text LIKE '4e040000-0000-4000-8000-%'`) }
	cleanup()
	t.Cleanup(cleanup)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES ('%s','so@t.test','Owner'), ('%s','s1@t.test','C1'),
		  ('%s','s2@t.test','C2'), ('%s','s3@t.test','C3'), ('%s','s4@t.test','C4')`, sosOwner, sosC1, sosC2, sosC3, sosC4),
		fmt.Sprintf(`INSERT INTO trusted_contacts (owner_id, contact_id) VALUES ('%[1]s','%[2]s'), ('%[1]s','%[3]s'), ('%[1]s','%[4]s'), ('%[1]s','%[5]s')`,
			sosOwner, sosC1, sosC2, sosC3, sosC4),
		fmt.Sprintf(`INSERT INTO devices (user_id, push_token, platform) VALUES
		  ('%s','ExponentPushToken[good-1]','android'), ('%s','ExponentPushToken[dead-2]','ios'),
		  ('%s','ExponentPushToken[good-4]','ios'), ('%s','ExponentPushToken[dead-4]','android')`, sosC1, sosC2, sosC4, sosC4),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}
	mux := http.NewServeMux()
	RegisterFamilySafety(mux)

	code, out := call(t, mux, sosOwner, "POST", "/user/sos", `{"test":true}`)
	if code != 200 || out["contactsNotified"] != float64(4) || out["contactsReached"] != float64(2) {
		t.Fatalf("sos: %d %v, want notified 4 reached 2", code, out)
	}
	// History carries it; the dead tokens were pruned as before.
	req := httptest.NewRequest("GET", "/user/sos", nil)
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, sosOwner))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var hist []map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &hist)
	if len(hist) != 1 || hist[0]["contactsReached"] != float64(2) || hist[0]["contactsNotified"] != float64(4) {
		t.Fatalf("history: %s", rec.Body.String())
	}
	var dead int
	_ = db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM devices WHERE push_token LIKE 'ExponentPushToken[dead-%'`).Scan(&dead)
	if dead != 0 {
		t.Fatalf("dead tokens left: %d", dead)
	}
	// Subset to the contact with no device: addressed 1, reached 0.
	code, out = call(t, mux, sosOwner, "POST", "/user/sos", fmt.Sprintf(`{"test":true,"contactIds":[%q]}`, sosC3))
	if code != 200 || out["contactsNotified"] != float64(1) || out["contactsReached"] != float64(0) {
		t.Fatalf("subset: %d %v", code, out)
	}
}
