// vaultbeam_session_version_test.go — migration 076's stated guarantee, made real.
//
// 076 says session_version "increments ONLY on a material reset of the transfer
// (a re-init of the same transfer_id, or a replaced source file), never on a
// transport change, crash, resume, or plan growth", and names the sequence it
// exists to stop:
//
//	sender crashes -> user re-sends the same file -> relay/init resets the row
//	-> the OLD in-memory receiver session posts recv_mask bits describing the
//	PREVIOUS file's chunk layout.
//
// Nothing incremented it. The column existed, vbLoadTransfer read it, four
// vbStaleVersion gates compared against it, and it was 1 forever — so the gates
// could never fire and ON CONFLICT rewrote geometry while both bitmaps kept the
// previous file's bits.
//
// The DB-backed half needs a real Postgres (CALL_TEST_DB=1) because what is
// asserted IS the ON CONFLICT. The structural half below runs everywhere, so a
// future edit that drops the increment fails `go test ./...` on any machine.

package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/db"
)

// ── runs everywhere ─────────────────────────────────────────────────

// The increment must live in relay/init's ON CONFLICT and nowhere else: any
// other site would bump on a resume or a plan growth, which 076 forbids and
// which would 409 a healthy transfer to death.
func TestVaultbeamVersionIncrementsOnlyOnReinit(t *testing.T) {
	src := vbSource(t)

	const bump = "session_version = vb_transfer.session_version + 1"
	if n := strings.Count(src, bump); n != 1 {
		t.Fatalf("session_version is incremented at %d sites, want exactly 1 (relay/init's ON CONFLICT)", n)
	}

	init := src[strings.Index(src, "func vbRelayInit("):]
	init = init[:strings.Index(init, "func vbRelayBlockURL(")]
	conflict := init[strings.Index(init, "ON CONFLICT (transfer_id) DO UPDATE"):]
	if !strings.Contains(conflict, bump) {
		t.Error("the increment is not in relay/init's ON CONFLICT branch")
	}
	// A reset that bumps the version but keeps the old file's bitmaps is the
	// exact corruption 076 describes — the geometry is already being rewritten
	// two lines above.
	for _, want := range []string{"uploaded_mask = EXCLUDED.uploaded_mask", "recv_mask = NULL", "state = 'pending'"} {
		if !strings.Contains(conflict, want) {
			t.Errorf("a re-init no longer resets %q — the previous file's mask survives into the new layout", want)
		}
	}
	// The client is told the version it must ride, rather than a hardcoded 1.
	if !strings.Contains(init, "RETURNING transfer_id, expires_at, session_version") {
		t.Error("relay/init does not read the post-reset session_version back")
	}
	if strings.Contains(init, "sessionVersion := 1") {
		t.Error("relay/init still reports a constant session version")
	}

	// All four mutating routes stay gated. Losing one re-opens the hole for
	// exactly that message type.
	for _, fn := range []string{"vbRelayUploaded(", "vbRelayGrow(", "vbRelayReceived(", "vbRelayComplete("} {
		body := src[strings.Index(src, "func "+fn):]
		if i := strings.Index(body[1:], "\nfunc "); i > 0 {
			body = body[:i]
		}
		if !strings.Contains(body, "vbStaleVersion(b.SessionVersion, t.Version)") {
			t.Errorf("%s lost its stale-version gate", fn)
		}
	}
}

// ── needs a real Postgres ───────────────────────────────────────────

// A re-init through the REAL handler is a material reset: the version moves,
// both bitmaps are dropped, and every message carrying the pre-reset version is
// refused with 409 instead of writing bits into the new file's layout.
func TestVaultbeamRelayInitResetsSessionOverTheWire(t *testing.T) {
	vbSkip(t)
	// relay/init refuses to run without object storage configured; nothing in
	// this test reaches S3 (no presign, no HEAD), so a syntactically valid
	// endpoint + key is all the precondition needs.
	t.Setenv("VAULTBEAM_S3_ENDPOINT", "https://vb.invalid")
	t.Setenv("VAULTBEAM_S3_ACCESS_KEY", "test")

	mux := vbMux()
	const id, n = "vbinitreset000001", 8
	vbSeed(t, id, n, n, "pending")

	// The receiver publishes a bitmap describing THIS file's layout, and the
	// sender marks geometry — the state a re-init must not let leak forward.
	if code, _ := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q,"sessionVersion":1}`, id, vbMaskB64(n, 0, 1, 2))); code != 200 {
		t.Fatal("seed recv_mask failed")
	}

	ctx := context.Background()
	var before int
	if err := db.Pool.QueryRow(ctx,
		`SELECT session_version FROM vb_transfer WHERE transfer_id = $1`, id).Scan(&before); err != nil {
		t.Fatalf("read pre-init version: %v", err)
	}

	// The user re-sends: same transfer id, a DIFFERENT file.
	code, body := call(t, mux, vbSender, "POST", "/vaultbeam/relay/init",
		fmt.Sprintf(`{"transferId":%q,"recipientId":%q,"totalBytes":%d,"blockCount":0,"plan":""}`,
			id, vbRecv, int64(n)*512*1024))
	if code != 200 {
		t.Fatalf("re-init returned %d %v", code, body)
	}

	got, _ := body["sessionVersion"].(float64)
	if int(got) != before+1 {
		t.Errorf("relay/init reported sessionVersion %v, want %d — the gates stay inert", body["sessionVersion"], before+1)
	}

	var version int
	var recv, uploaded []byte
	var state string
	if err := db.Pool.QueryRow(ctx,
		`SELECT session_version, COALESCE(recv_mask, ''::bytea), uploaded_mask, state
		   FROM vb_transfer WHERE transfer_id = $1`, id).Scan(&version, &recv, &uploaded, &state); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if version != before+1 {
		t.Errorf("stored session_version = %d, want %d", version, before+1)
	}
	if c := vbCountSet(recv, n); c != 0 {
		t.Errorf("recv_mask kept %d bits from the PREVIOUS file", c)
	}
	if c := vbCountSet(uploaded, n); c != 0 {
		t.Errorf("uploaded_mask kept %d bits from the PREVIOUS file", c)
	}
	if state != "pending" {
		t.Errorf("state = %q after a reset, want pending", state)
	}

	// THE SEQUENCE 076 NAMES: the pre-reset receiver session posts bits for the
	// old layout. It must bounce, not merge.
	if code, _ := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q,"sessionVersion":%d}`, id, vbMaskB64(n, 5), before)); code != 409 {
		t.Errorf("stale recv_mask post returned %d, want 409", code)
	}
	// And so does the pre-reset SENDER, on both of its mutating calls.
	if code, _ := call(t, mux, vbSender, "POST", "/vaultbeam/relay/uploaded",
		fmt.Sprintf(`{"transferId":%q,"blocks":[0],"sessionVersion":%d}`, id, before)); code != 409 {
		t.Errorf("stale mark-uploaded returned %d, want 409", code)
	}
	if code, _ := call(t, mux, vbSender, "POST", "/vaultbeam/relay/grow",
		fmt.Sprintf(`{"transferId":%q,"blockCount":%d,"sessionVersion":%d}`, id, n+1, before)); code != 409 {
		t.Errorf("stale grow returned %d, want 409", code)
	}
	// The CURRENT version still works — the gate must reject staleness, not traffic.
	if code, _ := call(t, mux, vbRecv, "POST", "/vaultbeam/relay/received",
		fmt.Sprintf(`{"transferId":%q,"mask":%q,"sessionVersion":%d}`, id, vbMaskB64(n, 5), version)); code != 200 {
		t.Errorf("current-version post returned %d, want 200", code)
	}
}
