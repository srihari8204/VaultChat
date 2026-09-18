// vaultbeam_routes_test.go — the seamless-resume guards against a REAL Postgres.
//
// Skipped unless CALL_TEST_DB=1, like the other route tests, so `go test ./...`
// stays green without a database. Reuses that file's `call` / `tokenFor` helpers.
//
//	CALL_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=5432 \
//	DB_NAME=vaultchat_test DB_USER=vaultchat_app DB_PASS=... JWT_SECRET=test \
//	CALL_TEST_ADMIN_DSN='postgres://postgres@127.0.0.1:5432/vaultchat_test' \
//	go test ./internal/routes/ -run TestVaultbeam -v
//
// It WRITES. Never point it at production.
//
// WHY AGAINST A REAL DATABASE
// ---------------------------
// Every assertion here is about state transitions the DATABASE owns: an
// ON CONFLICT that must bump session_version and null recv_mask, a UNION merge
// under concurrent posts, and the immutability of a completed row. The pure
// bitmask logic is unit-tested without a DB in vaultbeam_mask_test.go; what is
// left is exactly the part a mock cannot tell you anything about.
package routes

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"testing"

	"vaultchat/backend-go/internal/db"
)

const (
	vbSender = "aaaaaaaa-0000-4000-8000-00000000ab01"
	vbRecv   = "bbbbbbbb-0000-4000-8000-00000000ab02"
	vbEve    = "eeeeeeee-0000-4000-8000-00000000ab03"
)

func vbSkip(t *testing.T) {
	t.Helper()
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 (and DB_*/JWT_SECRET) to run the VaultBeam route tests")
	}
	// CONNECT. Without this these four tests nil-deref pgxpool inside vbSeed:
	// db.Pool is package state that nothing here initialises, so they only ever
	// worked if some OTHER test in the package happened to connect first. That
	// is an ordering dependency, and `-run TestVaultbeam` alone always panicked.
	//
	// It went unnoticed because the whole file is gated on CALL_TEST_DB, which
	// had never been set — the first run of these tests was 2026-09-18. Matches
	// csSkip in chats_send_characterization_test.go, which does the same thing.
	if err := db.Connect(context.Background()); err != nil {
		t.Fatalf("connect: %v", err)
	}
}

// vbSeed writes a transfer row directly, so the tests do not depend on
// /relay/init's storage precondition (S3_* need not be configured).
func vbSeed(t *testing.T, transferID string, chunkCount, blockCount int, state string) {
	t.Helper()
	ctx := context.Background()
	// Create the users this transfer references. The test used to assume they
	// were already there — true on a scratch database that another test had
	// seeded, false on a fresh one, where every VaultBeam test failed on
	// vb_transfer_sender_id_fkey. A fixture that depends on rows it does not
	// create cannot run in CI.
	for _, u := range []string{vbSender, vbRecv, vbEve} {
		if _, err := db.Pool.Exec(ctx,
			`INSERT INTO users (id, email, name) VALUES ($1, $2, 'VaultBeam Fixture')
			 ON CONFLICT (id) DO NOTHING`, u, u+"@vb.test"); err != nil {
			t.Fatalf("seed user %s: %v", u, err)
		}
	}

	mask := make([]byte, vbMaskWidth(blockCount))
	_, err := db.Pool.Exec(ctx, `DELETE FROM vb_transfer WHERE transfer_id = $1`, transferID)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	_, err = db.Pool.Exec(ctx,
		`INSERT INTO vb_transfer (transfer_id, sender_id, recipient_id, total_bytes, block_count,
		                          chunk_count, uploaded_mask, state, session_version)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)`,
		transferID, vbSender, vbRecv, int64(chunkCount)*512*1024, blockCount, chunkCount, mask, state)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func vbMaskB64(chunkCount int, bits ...int) string {
	m := make([]byte, vbMaskWidth(chunkCount))
	for _, b := range bits {
		if b >= 0 && b < chunkCount {
			m[b>>3] |= 1 << uint(b&7)
		}
	}
	return base64.StdEncoding.EncodeToString(m)
}

func vbMux() *http.ServeMux {
	mux := http.NewServeMux()
	RegisterVaultbeam(mux)
	return mux
}

// The receiver's bitmap reaches the sender, union-merged, and only the recipient
// may publish it.
func TestVaultbeamReceivedMerge(t *testing.T) {
	vbSkip(t)
	mux := vbMux()
	const id, n = "vbrecvmerge0001", 10
	vbSeed(t, id, n, 2, "pending")

	code, out := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q}`, id, vbMaskB64(n, 0, 1, 2)))
	if code != 200 || out["received"] != float64(3) {
		t.Fatalf("first post: %d %v", code, out)
	}

	// a later, DISJOINT post adds without removing
	_, out = call(t, mux, vbRecv, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q}`, id, vbMaskB64(n, 7)))
	if out["received"] != float64(4) {
		t.Fatalf("merge lost bits: %v", out)
	}

	// a STALE post (a subset of what is stored) must not clear anything
	_, out = call(t, mux, vbRecv, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q}`, id, vbMaskB64(n, 0)))
	if out["received"] != float64(4) {
		t.Fatalf("a stale post cleared bits: %v", out)
	}

	// the SENDER reads it back from /relay/:id — this is the whole point
	code, st := call(t, mux, vbSender, "GET", "/vaultbeam/relay/"+id, "")
	if code != 200 || st["received"] != float64(4) {
		t.Fatalf("sender cannot read recvMask: %d %v", code, st)
	}
	if _, ok := st["recvMask"].(string); !ok {
		t.Fatalf("recvMask missing from state: %v", st)
	}

	// only the recipient may publish
	if code, _ := call(t, mux, vbSender, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q}`, id, vbMaskB64(n, 9))); code != 403 {
		t.Fatalf("sender publishing recv_mask = %d, want 403", code)
	}
	if code, _ := call(t, mux, vbEve, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q}`, id, vbMaskB64(n, 9))); code != 403 && code != 404 {
		t.Fatalf("stranger publishing recv_mask = %d, want 403/404", code)
	}
}

// A stale session version is rejected on every mutating call.
func TestVaultbeamStaleSessionVersion(t *testing.T) {
	vbSkip(t)
	mux := vbMux()
	const id, n = "vbstalever00001", 8
	vbSeed(t, id, n, 1, "pending")
	if _, err := db.Pool.Exec(context.Background(),
		`UPDATE vb_transfer SET session_version = 3 WHERE transfer_id = $1`, id); err != nil {
		t.Fatalf("bump: %v", err)
	}

	for _, tc := range []struct{ name, uid, path, body string }{
		{"received", vbRecv, "/vaultbeam/relay/received",
			fmt.Sprintf(`{"transferId":%q,"mask":%q,"sessionVersion":2}`, id, vbMaskB64(n, 0))},
		{"uploaded", vbSender, "/vaultbeam/relay/uploaded",
			fmt.Sprintf(`{"transferId":%q,"blocks":[0],"sessionVersion":2}`, id)},
		{"grow", vbSender, "/vaultbeam/relay/grow",
			fmt.Sprintf(`{"transferId":%q,"blockCount":2,"sessionVersion":2}`, id)},
		{"complete", vbRecv, "/vaultbeam/relay/complete",
			fmt.Sprintf(`{"transferId":%q,"sessionVersion":2}`, id)},
	} {
		if code, _ := call(t, mux, tc.uid, "POST", tc.path, tc.body); code != 409 {
			t.Errorf("%s with a stale version = %d, want 409", tc.name, code)
		}
	}

	// the CURRENT version is accepted …
	if code, _ := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q,"sessionVersion":3}`, id, vbMaskB64(n, 0))); code != 200 {
		t.Errorf("current version rejected = %d, want 200", code)
	}
	// … and so is an ABSENT one, so pre-vbm3 clients keep working
	if code, _ := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q}`, id, vbMaskB64(n, 1))); code != 200 {
		t.Errorf("absent version rejected = %d, want 200", code)
	}
}

// A completed session is immutable, and completing is idempotent. This is the
// gap that let a lost completion notification turn into a full re-upload.
func TestVaultbeamCompletedSessionIsImmutable(t *testing.T) {
	vbSkip(t)
	mux := vbMux()
	const id, n = "vbcomplete00001", 8
	vbSeed(t, id, n, 1, "complete")

	for _, tc := range []struct{ name, uid, path, body string }{
		{"uploaded", vbSender, "/vaultbeam/relay/uploaded", fmt.Sprintf(`{"transferId":%q,"blocks":[0]}`, id)},
		{"grow", vbSender, "/vaultbeam/relay/grow", fmt.Sprintf(`{"transferId":%q,"blockCount":2}`, id)},
		{"received", vbRecv, "/vaultbeam/relay/received",
			fmt.Sprintf(`{"transferId":%q,"mask":%q}`, id, vbMaskB64(n, 0))},
		{"abort", vbSender, "/vaultbeam/relay/abort", fmt.Sprintf(`{"transferId":%q}`, id)},
	} {
		if code, _ := call(t, mux, tc.uid, "POST", tc.path, tc.body); code != 410 {
			t.Errorf("%s on a completed transfer = %d, want 410", tc.name, code)
		}
	}

	// completing again succeeds without changing the outcome
	if code, out := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/complete",
		fmt.Sprintf(`{"transferId":%q}`, id)); code != 200 || out["ok"] != true {
		t.Fatalf("repeat completion = %d %v, want 200 ok", code, out)
	}
	var state string
	if err := db.Pool.QueryRow(context.Background(),
		`SELECT state FROM vb_transfer WHERE transfer_id = $1`, id).Scan(&state); err != nil || state != "complete" {
		t.Fatalf("state = %q (%v), want complete", state, err)
	}
}

// A completion claim whose bitmap does not cover every chunk is refused.
func TestVaultbeamCompletionRequiresFullMask(t *testing.T) {
	vbSkip(t)
	mux := vbMux()
	const id, n = "vbfullmask00001", 8
	vbSeed(t, id, n, 1, "ready")

	if code, _ := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/complete",
		fmt.Sprintf(`{"transferId":%q,"mask":%q}`, id, vbMaskB64(n, 0, 1, 2))); code != 409 {
		t.Fatalf("partial mask accepted, want 409")
	}
	full := []int{0, 1, 2, 3, 4, 5, 6, 7}
	if code, _ := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/complete",
		fmt.Sprintf(`{"transferId":%q,"mask":%q}`, id, vbMaskB64(n, full...))); code != 200 {
		t.Fatalf("full mask rejected, want 200")
	}
}

// Re-initing the same transfer id is a MATERIAL RESET: the version bumps and any
// receiver bitmap describing the previous layout is dropped.
func TestVaultbeamReinitBumpsVersionAndClearsRecvMask(t *testing.T) {
	vbSkip(t)
	mux := vbMux()
	const id, n = "vbreinit0000001", 8
	vbSeed(t, id, n, 1, "pending")
	if code, _ := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q}`, id, vbMaskB64(n, 0, 1))); code != 200 {
		t.Fatal("seed recv_mask failed")
	}

	ctx := context.Background()
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO vb_transfer (transfer_id, sender_id, recipient_id, total_bytes, block_count,
		                          chunk_count, uploaded_mask, state, session_version)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',1)
		 ON CONFLICT (transfer_id) DO UPDATE
		   SET session_version = vb_transfer.session_version + 1, recv_mask = NULL
		   WHERE vb_transfer.sender_id = $2 AND vb_transfer.state IN ('pending','ready')`,
		id, vbSender, vbRecv, int64(n)*512*1024, 1, n, make([]byte, 1)); err != nil {
		t.Fatalf("re-init: %v", err)
	}

	var version int
	var recv []byte
	if err := db.Pool.QueryRow(ctx,
		`SELECT session_version, COALESCE(recv_mask, ''::bytea) FROM vb_transfer WHERE transfer_id = $1`,
		id).Scan(&version, &recv); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if version != 2 {
		t.Errorf("session_version = %d, want 2", version)
	}
	if vbCountSet(recv, n) != 0 {
		t.Errorf("recv_mask survived a re-init with %d bits set", vbCountSet(recv, n))
	}
	// the old version is now stale on the wire
	if code, _ := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q,"sessionVersion":1}`, id, vbMaskB64(n, 3))); code != 409 {
		t.Errorf("pre-reset version accepted, want 409")
	}
}
