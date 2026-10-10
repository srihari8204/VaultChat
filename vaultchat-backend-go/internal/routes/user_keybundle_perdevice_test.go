// user_keybundle_perdevice_test.go — two devices on one account, and neither
// one destroying the other.
//
// THE BUG THIS PINS
// -----------------
// `identity_keys.user_id` was the PRIMARY KEY and /user/keybundle wrote at
// ACCOUNT grain: `ON CONFLICT (user_id) DO UPDATE`, then, on an identity
// change, `DELETE FROM one_time_prekeys WHERE user_id = $1` and
// `UPDATE signed_prekeys SET retired_at = NOW() WHERE user_id = $1`.
//
// So the second install by the same person — a new phone, a reinstall after a
// crash, cleared app data, or the signing cutover itself — overwrote their own
// identity key, emptied the first device's entire prekey pool and retired its
// signed prekey. The first device stayed reachable only to peers that already
// held a session, and became permanently unreachable to new senders. Nothing
// surfaced: the padlock still showed.
//
// Migration 140 moved the grain to (user_id, device_id) and the handlers now
// scope every statement to the signed `dev` claim. That is two changes that
// have to agree, and a schema test cannot see the handlers while a handler test
// with a mock cannot see the constraint — so this runs the real mux against a
// real database, like cross_tenant_test.go, and for the same reason.
//
// WHY "" IS A DEVICE AND NOT AN ERROR
// -----------------------------------
// Migration 140's `device_id TEXT NOT NULL DEFAULT ''` keeps every client that
// predates the claim writing the exact row it always wrote.
// TestLegacyDeviceIDStillPublishesAndFetches pins that: a token with no `dev`
// must still publish and still fetch. Delete that test and the next refactor is
// free to reject old tokens, which logs out the field.
//
// ISOLATION. Every fixture id carries the marker fd000000-0000-4000-8000- and
// cleanup deletes exactly that marker. Nothing outside it is touched.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/db"
)

const (
	pdOwner  = "fd000000-0000-4000-8000-00000000a001" // one person, two phones
	pdPeer   = "fd000000-0000-4000-8000-00000000a002" // someone fetching their bundle
	pdDevA   = "aaaaaaaaaaaaaaaa"                     // 16 hex — authDeviceID's floor
	pdDevB   = "bbbbbbbbbbbbbbbb"
	pdMarker = "fd000000-0000-4000-8000-%"
)

// pdCall is `call` with a device id. It mints through authSignAccess — the
// production signer — so a change that stops binding `dev` into the token fails
// here rather than passing against a test-only forgery.
func pdCall(t *testing.T, mux *http.ServeMux, uid, dev, method, path, body string) (int, map[string]any) {
	t.Helper()
	tok, err := authSignAccess(uid, nil, dev)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// pdBundle is what one device publishes. Distinct key material per device, so
// an assertion can name WHICH device's keys came back.
func pdBundle(tag string, otpkFrom int) string {
	otpk := make([]string, 0, 3)
	for i := otpkFrom; i < otpkFrom+3; i++ {
		otpk = append(otpk, fmt.Sprintf(`{"keyId":%d,"publicKey":"otpk-%s-%d"}`, i, tag, i))
	}
	return fmt.Sprintf(`{"identityKey":"ik-%s",
		"signedPreKey":{"keyId":%d,"publicKey":"spk-%s","signature":"sig-%s"},
		"oneTimePreKeys":[%s]}`, tag, otpkFrom, tag, tag, strings.Join(otpk, ","))
}

func pdSeed(t *testing.T, ctx context.Context) {
	t.Helper()
	pdCleanup(ctx)
	if err := adminExec(ctx, fmt.Sprintf(
		`INSERT INTO users (id, email, name) VALUES
		 ('%s','owner@pd.test','Owner'), ('%s','peer@pd.test','Peer')`, pdOwner, pdPeer)); err != nil {
		t.Fatalf("seed users: %v", err)
	}
}

func pdCleanup(ctx context.Context) {
	for _, tbl := range []string{"one_time_prekeys", "signed_prekeys", "identity_keys"} {
		_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE user_id::text LIKE '%s'`, tbl, pdMarker))
	}
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM users WHERE id::text LIKE '%s'`, pdMarker))
}

// pdCount reads through the ADMIN connection on purpose. A count on the app
// pool under enforced RLS could see no rows and pass for the wrong reason —
// "the keys survived" and "I cannot see the keys" must not look alike.
func pdCount(t *testing.T, ctx context.Context, q string) int {
	t.Helper()
	var n int
	if err := adminQueryRow(ctx, q, &n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func pdOne(t *testing.T, ctx context.Context, q string) string {
	t.Helper()
	var s string
	if err := adminQueryRow(ctx, q, &s); err != nil {
		t.Fatalf("read: %v", err)
	}
	return s
}

func TestTwoDevicesDoNotDestroyEachOthersKeys(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	pdSeed(t, ctx)
	t.Cleanup(func() { pdCleanup(ctx) })

	mux := http.NewServeMux()
	RegisterUser(mux)

	// Device A publishes first.
	if code, res := pdCall(t, mux, pdOwner, pdDevA, "POST", "/user/keybundle", pdBundle("A", 1)); code != 200 {
		t.Fatalf("device A publish: %d %v", code, res)
	}
	if n := pdCount(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM one_time_prekeys WHERE user_id = '%s' AND device_id = '%s'`,
		pdOwner, pdDevA)); n != 3 {
		t.Fatalf("device A should have 3 one-time prekeys, has %d", n)
	}

	// Device B publishes a DIFFERENT identity key. This is the exact sequence
	// that used to empty device A: upsert, see the identity change, purge.
	if code, res := pdCall(t, mux, pdOwner, pdDevB, "POST", "/user/keybundle", pdBundle("B", 100)); code != 200 {
		t.Fatalf("device B publish: %d %v", code, res)
	}

	// ── the three assertions that were false before migration 140 ──
	if n := pdCount(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM one_time_prekeys WHERE user_id = '%s' AND device_id = '%s'`,
		pdOwner, pdDevA)); n != 3 {
		t.Errorf("device A's prekey pool was emptied by device B publishing: %d of 3 left", n)
	}
	if ik := pdOne(t, ctx, fmt.Sprintf(
		`SELECT public_key_b64 FROM identity_keys WHERE user_id = '%s' AND device_id = '%s'`,
		pdOwner, pdDevA)); ik != "ik-A" {
		t.Errorf("device A's identity key is now %q — device B overwrote it", ik)
	}
	if n := pdCount(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM signed_prekeys
		 WHERE user_id = '%s' AND device_id = '%s' AND retired_at IS NULL`,
		pdOwner, pdDevA)); n != 1 {
		t.Errorf("device A's signed prekey was retired by device B publishing (%d active)", n)
	}

	// Both devices really are present — otherwise the three checks above could
	// pass because device B never wrote anything.
	if n := pdCount(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM identity_keys WHERE user_id = '%s'`, pdOwner)); n != 2 {
		t.Fatalf("expected 2 device rows for one account, got %d", n)
	}

	// ── the fetch must not mix devices ──
	// Three independent reads at account grain would happily return device B's
	// identity key with device A's signed prekey. That bundle fails signature
	// verification and X3DH derives a shared secret the sender cannot reach, so
	// the handler picks ONE device first. A mixed bundle is worse than no
	// bundle: it is an undecryptable conversation with a padlock on it.
	code, res := pdCall(t, mux, pdPeer, "", "GET", "/user/"+pdOwner+"/keybundle", "")
	if code != 200 {
		t.Fatalf("peer fetch: %d %v", code, res)
	}
	ik, _ := res["identityKey"].(string)
	if ik == "" {
		t.Fatalf("no identity key in bundle: %v", res)
	}
	want := strings.TrimPrefix(ik, "ik-") // "A" or "B" — whichever device won
	spk, _ := res["signedPreKey"].(map[string]any)
	if pub, _ := spk["publicKey"].(string); pub != "spk-"+want {
		t.Errorf("bundle mixes devices: identity %q with signed prekey %q", ik, pub)
	}
	if sig, _ := spk["signature"].(string); sig != "sig-"+want {
		t.Errorf("bundle mixes devices: identity %q with signature %q", ik, sig)
	}
	if otpk, ok := res["oneTimePreKey"].(map[string]any); ok && otpk != nil {
		if pub, _ := otpk["publicKey"].(string); !strings.HasPrefix(pub, "otpk-"+want+"-") {
			t.Errorf("bundle mixes devices: identity %q with one-time prekey %q", ik, pub)
		}
	}

	// /user/{id}/identity is what the safety-number screen reads. If it picks a
	// different device than the bundle, the fingerprint the user is asked to
	// compare is not the key their messages are encrypted to — a verification
	// screen that certifies the wrong thing. Both share one ORDER BY for this.
	code, res = pdCall(t, mux, pdPeer, "", "GET", "/user/"+pdOwner+"/identity", "")
	if code != 200 {
		t.Fatalf("peer identity fetch: %d %v", code, res)
	}
	if got, _ := res["identityKey"].(string); got != ik {
		t.Errorf("/identity returned %q but /keybundle returned %q — the safety number "+
			"would not match the key in use", got, ik)
	}
}

// Every token already in the field has no `dev` claim, and migration 140's
// DEFAULT '' is what keeps those clients working. If this test fails, the
// change logs out every existing install.
func TestLegacyDeviceIDStillPublishesAndFetches(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	pdSeed(t, ctx)
	t.Cleanup(func() { pdCleanup(ctx) })

	mux := http.NewServeMux()
	RegisterUser(mux)

	if code, res := pdCall(t, mux, pdOwner, "", "POST", "/user/keybundle", pdBundle("legacy", 1)); code != 200 {
		t.Fatalf("a token with no dev claim must still publish: %d %v", code, res)
	}
	if n := pdCount(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM identity_keys WHERE user_id = '%s' AND device_id = ''`,
		pdOwner)); n != 1 {
		t.Fatalf("a claimless token must write the legacy device_id='' row, found %d", n)
	}
	code, res := pdCall(t, mux, pdPeer, "", "GET", "/user/"+pdOwner+"/keybundle", "")
	if code != 200 {
		t.Fatalf("legacy bundle must be fetchable: %d %v", code, res)
	}
	if got, _ := res["identityKey"].(string); got != "ik-legacy" {
		t.Errorf("identityKey = %q, want ik-legacy", got)
	}
}
