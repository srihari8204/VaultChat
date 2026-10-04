// channel_room_authz_db_test.go — channelAllowed's query against a real schema
// (migration 026): admin yes, subscriber yes, a subscriber who left no, a
// stranger no; and a leave + BumpChannelPermissions flips a cached "yes".
//
//	CALL_TEST_DB=1 DB_* CALL_TEST_ADMIN_DSN=... go test ./internal/realtime/ -run TestChannelAllowedDB -v
package realtime

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
)

func TestChannelAllowedDB(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" || os.Getenv("CALL_TEST_ADMIN_DSN") == "" {
		t.Skip("set CALL_TEST_DB=1, DB_* and CALL_TEST_ADMIN_DSN to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	admin, err := pgx.Connect(ctx, os.Getenv("CALL_TEST_ADMIN_DSN"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close(ctx) }) // registered first, so it runs after the row cleanup
	const (
		uAdmin = "4e070000-0000-4000-8000-0000000000a1"
		uSub   = "4e070000-0000-4000-8000-0000000000a2"
		uLeft  = "4e070000-0000-4000-8000-0000000000a3"
		uOut   = "4e070000-0000-4000-8000-0000000000a4"
		ch     = "4e070000-0000-4000-8000-00000000c001"
	)
	cleanup := func() {
		_, _ = admin.Exec(ctx, `DELETE FROM users WHERE id::text LIKE '4e070000-0000-4000-8000-%'`)
	}
	cleanup()
	t.Cleanup(cleanup)
	for _, q := range []string{
		`INSERT INTO users (id, email, name) VALUES ('` + uAdmin + `','ca@t.test','A'), ('` + uSub + `','cs@t.test','S'),
		   ('` + uLeft + `','cl@t.test','L'), ('` + uOut + `','co@t.test','O')`,
		`INSERT INTO channels (id, name, admin_id, invite_code) VALUES ('` + ch + `','C','` + uAdmin + `','4E07-AAAA')`,
		`INSERT INTO channel_subscribers (channel_id, user_id) VALUES ('` + ch + `','` + uSub + `'), ('` + ch + `','` + uLeft + `')`,
	} {
		if _, err := admin.Exec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	h := &Hub{}
	sd := func(uid string) *sockData { return &sockData{uid: uid, chatMemberOk: map[string]cachedPerm{}} }
	dLeft := sd(uLeft)
	if !h.channelAllowed(dLeft, ch) {
		t.Fatal("subscriber (before leaving) refused")
	}
	for uid, want := range map[string]bool{uAdmin: true, uSub: true, uOut: false} {
		if got := h.channelAllowed(sd(uid), ch); got != want {
			t.Errorf("%s: allowed=%v, want %v", uid, got, want)
		}
	}
	if h.channelAllowed(sd(uSub), "not-a-uuid") {
		t.Error("malformed channel id allowed")
	}
	// Leave: the row goes and the REST handler bumps; the cached yes must not survive.
	if _, err := admin.Exec(ctx, `DELETE FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2`, ch, uLeft); err != nil {
		t.Fatal(err)
	}
	BumpChannelPermissions(ch)
	if h.channelAllowed(dLeft, ch) {
		t.Fatal("a user who left is still allowed after the bump")
	}
}
