// cross_tenant_test.go — user A reaching for user B's data, and being refused.
//
// The September audit's three worst findings were all the same shape: a handler
// that looked a row up by id and then acted on it without ever asking whether
// the CALLER was entitled to it. F03 burned another person's view-once media,
// F04 settled one customer's invoice with another customer's payment, F06 threw
// the caller off their own device. Every one of them needs two users and a real
// database to see; none of them is visible to a handler test with a mock, which
// is why they survived review.
//
// So this file is deliberately monotonous. Alice acts, Bob owns, and every
// assertion is the same sentence: Alice must not get a 2xx. What varies is the
// surface — an attachment, a view-once burn, a chat, a message, a session, a
// shop ledger — because the bug was never in one handler, it was in a habit.
//
// WHY A REFUSAL MAY BE 403 OR 404, AND BOTH ARE CORRECT
// -----------------------------------------------------
// Same reasoning as bookmarks_rls_test.go, for the same two-gate design:
//
//	RLS enforced      → the row is invisible to Alice → the handler answers 404
//	RLS not enforced  → the read succeeds → the handler's own check answers 403
//
// The point of the two gates is that the outcome does not depend on which one
// fired. `refused` below asserts that, and names the endpoint when it fails.
// Where a handler deliberately collapses both onto ONE code — uploadsViewed
// answers 404 either way, so a stranger cannot learn whether an id exists —
// the exact code is asserted instead, and the comment says why.
//
// Same harness and same two roles as call_sessions_test.go; see that file's
// header for why fixtures need an admin connection.
//
// ISOLATION. Every fixture id carries the literal marker c7000000-0000-4000-8000-,
// and ctCleanup deletes exactly that marker. Nothing outside it is touched.
package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"vaultchat/backend-go/internal/db"
)

const (
	ctAlice  = "c7000000-0000-4000-8000-00000000a001" // the outsider, and a shop owner
	ctBob    = "c7000000-0000-4000-8000-00000000a002" // the victim
	ctCarol  = "c7000000-0000-4000-8000-00000000a003" // in Bob's chat, but not the sender
	ctDave   = "c7000000-0000-4000-8000-00000000a004" // Alice's other shop customer
	ctChat   = "c7000000-0000-4000-8000-00000000b001" // Bob and Carol's chat; Alice is not in it
	ctAtt    = "c7000000-0000-4000-8000-00000000b002" // Bob's view-once media
	ctShopA  = "c7000000-0000-4000-8000-00000000c001" // Alice's shop
	ctShopB  = "c7000000-0000-4000-8000-00000000c002" // Bob's shop
	ctOrdBob = "c7000000-0000-4000-8000-00000000d001" // Bob's order AT ALICE'S SHOP
	ctInvBob = "c7000000-0000-4000-8000-00000000d002" // and its invoice
	ctOrdB2  = "c7000000-0000-4000-8000-00000000d003" // Dave's order at BOB's shop
	ctMarker = "c7000000-0000-4000-8000-%"
)

// refused accepts either half of the two-gate answer and nothing else. A 500 is
// not a refusal — it is a handler that fell over, and reporting it as "denied"
// is how a broken guard gets mistaken for a working one.
func refused(t *testing.T, what string, code int, res map[string]any) {
	t.Helper()
	switch code {
	case 403:
		t.Logf("%s: refused by the handler's own check (403) — RLS is not enforced on "+
			"this database, so the read succeeded and the guard caught it. res=%v", what, res)
	case 404:
		t.Logf("%s: refused by invisibility (404) — RLS hid the row, so the handler's "+
			"guard never had to run. res=%v", what, res)
	default:
		t.Fatalf("%s: a cross-tenant request must be refused, got %d %v", what, code, res)
	}
}

func ctCleanup(ctx context.Context) {
	for _, q := range []string{
		// shopbook_audit is append-only (095) and a shop cascade fires its
		// RAISE-on-DELETE trigger, which aborts the whole statement. Same
		// admin-only, statement-scoped bypass sbFlowCleanup uses, and for the
		// same reason: the fixture has to be removable.
		fmt.Sprintf(`DO $ct$ BEGIN
			SET LOCAL session_replication_role = replica;
			DELETE FROM shopbook_audit WHERE shop_id::text LIKE '%s';
		END $ct$`, ctMarker),
		fmt.Sprintf(`DELETE FROM shopbook_payment WHERE shop_id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM shopbook_ledger_item WHERE ledger_id IN
			(SELECT id FROM shopbook_ledger WHERE shop_id::text LIKE '%s')`, ctMarker),
		fmt.Sprintf(`DELETE FROM shopbook_ledger WHERE shop_id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM shopbook_invoice WHERE shop_id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM shopbook_order_item WHERE order_id IN
			(SELECT id FROM shopbook_order WHERE shop_id::text LIKE '%s')`, ctMarker),
		fmt.Sprintf(`DELETE FROM shopbook_order WHERE shop_id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM shopbook_customer WHERE shop_id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM shopbook_shop WHERE id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM attachment_deliveries WHERE attachment_id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM attachments WHERE id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM message_bodies WHERE chat_id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM messages WHERE chat_id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM chat_members WHERE chat_id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM chats WHERE id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM refresh_tokens WHERE user_id::text LIKE '%s'`, ctMarker),
		fmt.Sprintf(`DELETE FROM users WHERE id::text LIKE '%s'`, ctMarker),
	} {
		_ = adminExec(ctx, q)
	}
}

// ctFixture returns the ids that only exist once the rows do: Bob's message and
// his refresh-token row.
func ctFixture(t *testing.T, ctx context.Context) (msgID, bobSession int64) {
	t.Helper()
	ctCleanup(ctx)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES
		 ('%s','alice@ct.test','Alice'), ('%s','bob@ct.test','Bob'),
		 ('%s','carol@ct.test','Carol'), ('%s','dave@ct.test','Dave')`,
			ctAlice, ctBob, ctCarol, ctDave),
		fmt.Sprintf(`INSERT INTO chats (id, type) VALUES ('%s','group')`, ctChat),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		 ('%s','%s','owner'), ('%s','%s','member')`, ctChat, ctBob, ctChat, ctCarol),
		// view_once with viewed_at still NULL is the exact state F03 destroyed:
		// media the recipient has not opened yet. Nothing asserts a burn that
		// could not have happened.
		// `purpose` is NOT NULL with no default and a CHECK — a later migration
		// added it, and this fixture predates it, so the seed failed with
		// 23502 the first time this test was run against a real database.
		// 'chat' is the only value that fits: the retention sweep keys media
		// lifetime off this column (internal/jobs/media_scope_test.go) and
		// chat media is what a view-once attachment in a chat is.
		fmt.Sprintf(`INSERT INTO attachments
		 (id, owner_user_id, filename, mime_type, size_bytes, storage_path, view_once, purpose)
		 VALUES ('%s','%s','secret.jpg','image/jpeg',1024,'ct/secret.jpg',TRUE,'chat')`, ctAtt, ctBob),

		// Two shops, so "another shop's order" is a real row and not an absence.
		fmt.Sprintf(`INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone, approved)
		 VALUES ('%s','%s','CROSSTEST A','grocery','Pangidi','+91c700000001',TRUE),
		        ('%s','%s','CROSSTEST B','grocery','Pangidi','+91c700000002',TRUE)`,
			ctShopA, ctAlice, ctShopB, ctBob),
		// Bob and Dave both hold a khata with Alice's shop, so the payment
		// handler's relationship check passes and the test reaches the
		// order/customer pairing — which is the thing F04 got wrong.
		fmt.Sprintf(`INSERT INTO shopbook_customer (shop_id, customer_user_id) VALUES
		 ('%s','%s'), ('%s','%s'), ('%s','%s')`,
			ctShopA, ctBob, ctShopA, ctDave, ctShopB, ctDave),
		fmt.Sprintf(`INSERT INTO shopbook_order (id, shop_id, customer_user_id, total)
		 VALUES ('%s','%s','%s',500.00)`, ctOrdBob, ctShopA, ctBob),
		fmt.Sprintf(`INSERT INTO shopbook_invoice (id, shop_id, order_id, customer_user_id, number, total)
		 VALUES ('%s','%s','%s','%s',1,500.00)`, ctInvBob, ctShopA, ctOrdBob, ctBob),
		fmt.Sprintf(`INSERT INTO shopbook_order (id, shop_id, customer_user_id, total)
		 VALUES ('%s','%s','%s',250.00)`, ctOrdB2, ctShopB, ctDave),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	if err := adminQueryRow(ctx,
		fmt.Sprintf(`INSERT INTO messages (chat_id, sender_id, type, content)
		             VALUES ('%s','%s','text','bob original') RETURNING id`, ctChat, ctBob),
		&msgID); err != nil {
		t.Fatalf("seed message: %v", err)
	}
	// The attachment must be REFERENCED by a message in Bob and Carol's chat.
	// That reference is the entire definition of "in the audience" for both
	// uploadsGet and uploadsIsRecipient — without it Carol would be refused
	// too, and the positive control below would prove nothing.
	if err := adminExec(ctx, fmt.Sprintf(
		`INSERT INTO messages (chat_id, sender_id, type, content, meta)
		 VALUES ('%s','%s','image','media','{"attachmentId":"%s"}'::jsonb)`,
		ctChat, ctBob, ctAtt)); err != nil {
		t.Fatalf("seed media message: %v", err)
	}

	if err := adminQueryRow(ctx, fmt.Sprintf(
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
		 VALUES ('%s','ct-bob-refresh-hash', NOW() + INTERVAL '30 days') RETURNING id`, ctBob),
		&bobSession); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	return msgID, bobSession
}

func TestCrossTenantActionsAreRefused(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	msgID, bobSession := ctFixture(t, ctx)
	t.Cleanup(func() { ctCleanup(ctx) })

	mux := http.NewServeMux()
	RegisterChats(mux)
	RegisterUploads(mux)
	RegisterUser(mux)
	RegisterShopBook(mux)
	RegisterShopBookPayments(mux)

	// ── the attachment ──
	// GET is the reference implementation of "may see this attachment"; the
	// consume endpoint was supposed to share it and did not (F03).
	code, res := call(t, mux, ctAlice, "GET", "/uploads/"+ctAtt, "")
	refused(t, "GET /uploads/{id} by a stranger", code, res)

	// ── F03: burning someone else's view-once media ──
	// 404 in BOTH worlds, and that is a decision rather than an accident: a
	// caller with no business here must not be able to distinguish "no such
	// attachment" from "someone else's attachment", so the handler answers the
	// same way RLS would.
	if code, res = call(t, mux, ctAlice, "POST", "/uploads/"+ctAtt+"/viewed", ""); code != 404 {
		t.Fatalf("a stranger must not burn view-once media, got %d %v", code, res)
	}
	// The status code is the smaller half of this. What F03 actually cost the
	// victim was the BURN — the real recipient opening the bubble to be told it
	// had already been viewed. Read through the admin connection, because under
	// enforced RLS a check on the app pool would see no row and pass for the
	// wrong reason.
	var viewed int
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT count(*) FROM attachments WHERE id = '%s' AND viewed_at IS NOT NULL`, ctAtt),
		&viewed); err != nil {
		t.Fatalf("viewed_at check: %v", err)
	}
	if viewed != 0 {
		t.Fatal("a refused view-once call must leave the media unburned")
	}
	// The positive control. A guard that refuses everyone is not a guard, it is
	// an outage, and the first draft of every fix in this file could have been
	// that. Carol is in the chat the media was sent to, so she may consume it.
	if code, res = call(t, mux, ctCarol, "POST", "/uploads/"+ctAtt+"/viewed", ""); code != 200 {
		t.Fatalf("the real recipient must still be able to open it: %d %v", code, res)
	}

	// Revoking is owner-only, and Alice is not the owner.
	code, res = call(t, mux, ctAlice, "POST", "/uploads/"+ctAtt+"/revoke", "")
	refused(t, "POST /uploads/{id}/revoke by a stranger", code, res)

	// ── the chat ──
	code, res = call(t, mux, ctAlice, "GET", "/chats/"+ctChat, "")
	refused(t, "GET /chats/{id} by a non-member", code, res)

	code, res = call(t, mux, ctAlice, "GET", "/chats/"+ctChat+"/messages", "")
	refused(t, "GET /chats/{id}/messages by a non-member", code, res)

	code, res = call(t, mux, ctAlice, "POST", "/chats/"+ctChat+"/messages",
		`{"type":"text","content":"hello from a stranger"}`)
	refused(t, "POST /chats/{id}/messages by a non-member", code, res)

	// Writing into someone else's chat is worse than reading it: a refusal that
	// still inserted the row would be invisible to the response code.
	var extra int
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT count(*) FROM messages WHERE chat_id = '%s' AND sender_id = '%s'`, ctChat, ctAlice),
		&extra); err != nil {
		t.Fatalf("message count: %v", err)
	}
	if extra != 0 {
		t.Fatalf("a refused send must not persist, found %d", extra)
	}

	// Mute is the quiet one: a per-member setting keyed by (chat, user), so a
	// missing membership check writes a row for a chat the caller is not in.
	code, res = call(t, mux, ctAlice, "POST", "/chats/"+ctChat+"/mute", `{"muted":true}`)
	refused(t, "POST /chats/{id}/mute by a non-member", code, res)

	// ── the message ──
	msg := strconv.FormatInt(msgID, 10)
	code, res = call(t, mux, ctAlice, "PATCH", "/chats/"+ctChat+"/messages/"+msg,
		`{"content":"edited by a stranger"}`)
	refused(t, "PATCH message by a non-member", code, res)

	code, res = call(t, mux, ctAlice, "DELETE", "/chats/"+ctChat+"/messages/"+msg, "")
	refused(t, "DELETE message by a non-member", code, res)

	// Carol is INSIDE the chat and still may not touch what Bob wrote. Same
	// shape one ring further in: membership is not authorship, and the audit's
	// pattern was a handler that stopped checking once the first gate passed.
	code, res = call(t, mux, ctCarol, "DELETE", "/chats/"+ctChat+"/messages/"+msg, "")
	refused(t, "DELETE another member's message", code, res)

	code, res = call(t, mux, ctCarol, "PATCH", "/chats/"+ctChat+"/messages/"+msg,
		`{"content":"edited by a fellow member"}`)
	refused(t, "PATCH another member's message", code, res)

	var intact int
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT count(*) FROM messages
		  WHERE id = %d AND content = 'bob original'
		    AND deleted_at IS NULL AND edited_at IS NULL`, msgID), &intact); err != nil {
		t.Fatalf("message integrity: %v", err)
	}
	if intact != 1 {
		t.Fatal("four refused calls still altered Bob's message")
	}

	// Bob can do what nobody else could — the fixture is a real chat with a real
	// message in it, not a pile of rows that happens to refuse everything.
	if code, res = call(t, mux, ctBob, "GET", "/chats/"+ctChat+"/messages", ""); code != 200 {
		t.Fatalf("the chat's own member must be able to read it: %d %v", code, res)
	}

	// ── F06's neighbour: someone else's session ──
	// F06 was the mirror of this — "sign out other devices" killing the CURRENT
	// device. The cross-tenant half is the one nobody wrote down: the revoke
	// paths are scoped by user_id in the WHERE clause, and if that scoping ever
	// moves to a check beside the query, this is what notices.
	sess := strconv.FormatInt(bobSession, 10)
	code, res = call(t, mux, ctAlice, "DELETE", "/user/sessions/"+sess, "")
	refused(t, "DELETE /user/sessions/{id} for another user's device", code, res)

	var live int
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT count(*) FROM refresh_tokens WHERE id = %d AND revoked_at IS NULL`, bobSession),
		&live); err != nil {
		t.Fatalf("session check: %v", err)
	}
	if live != 1 {
		t.Fatal("Bob's device was signed out by somebody else")
	}

	// And the bulk path. Alice signing out ALL her devices must not reach into
	// Bob's, which needs her to actually succeed — a 400 would prove nothing.
	// `call` cannot carry X-Current-Refresh, and the header is the whole point
	// of the F06 fix, so this one request is built by hand.
	//
	// token_lookup stays NULL so the handler takes its bcrypt fallback: the
	// lookup path needs a configured pepper, which a scratch database has no
	// reason to have. MinCost because this is a fixture, not a password.
	raw := "ct-alice-raw-refresh-token"
	hash, err := bcrypt.GenerateFromPassword([]byte(raw), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if err := adminExec(ctx, fmt.Sprintf(
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
		 VALUES ('%s','%s', NOW() + INTERVAL '30 days')`, ctAlice, string(hash))); err != nil {
		t.Fatalf("seed alice session: %v", err)
	}
	req := httptest.NewRequest("DELETE", "/user/sessions", strings.NewReader(""))
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, ctAlice))
	req.Header.Set("X-Current-Refresh", raw)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("Alice should be able to sign out her own other devices: %d %s", rec.Code, rec.Body)
	}
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT count(*) FROM refresh_tokens WHERE id = %d AND revoked_at IS NULL`, bobSession),
		&live); err != nil {
		t.Fatalf("session check: %v", err)
	}
	if live != 1 {
		t.Fatal("a sign-out-everywhere revoked another user's session")
	}

	// ── F04: a payment against somebody else's invoice ──
	// The original bug in one request. Alice's shop legitimately serves both Bob
	// and Dave, so every gate except the one that was missing passes: Dave is a
	// customer of hers, the order is hers, the amount is fine. Only the PAIRING
	// is wrong — and the old code resolved the invoice on (order_id, shop_id)
	// without ever consulting the customer, so Dave's money settled Bob's bill.
	body := fmt.Sprintf(`{"customerId":%q,"orderId":%q,"amount":500,"method":"cash"}`, ctDave, ctOrdBob)
	if code, res = call(t, mux, ctAlice, "POST", "/shopbook/my-shop/payments", body); code != 400 {
		t.Fatalf("a payment naming another customer's order must be refused with 400, got %d %v", code, res)
	}

	// The status code again is the smaller half. F04's damage was two ledgers
	// moving at once, so both are checked: nothing credited to Dave, and Bob's
	// invoice still owed in full.
	var ledgerRows, paidRows int
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_ledger WHERE shop_id = '%s'`, ctShopA), &ledgerRows); err != nil {
		t.Fatalf("ledger count: %v", err)
	}
	if ledgerRows != 0 {
		t.Fatalf("a refused payment still wrote %d khata entries", ledgerRows)
	}
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_payment WHERE invoice_id = '%s'`, ctInvBob), &paidRows); err != nil {
		t.Fatalf("payment count: %v", err)
	}
	if paidRows != 0 {
		t.Fatalf("a refused payment still settled %d of another customer's invoices", paidRows)
	}

	// The cross-SHOP variant of the same pairing. Dave is Alice's customer AND
	// Bob's, so the customer half of the check passes and only shop ownership
	// stands between Alice and a row in Bob's order history.
	body = fmt.Sprintf(`{"customerId":%q,"orderId":%q,"amount":250,"method":"cash"}`, ctDave, ctOrdB2)
	if code, res = call(t, mux, ctAlice, "POST", "/shopbook/my-shop/payments", body); code != 400 {
		t.Fatalf("a payment against another shop's order must be refused with 400, got %d %v", code, res)
	}

	// And the outer gate: a stranger to the shop cannot be given a khata by the
	// shop merely naming them. Carol has never transacted with Alice, so this
	// one is refused before any order is looked at — 403, because at this point
	// the shop owner IS entitled to know their own customer list.
	body = fmt.Sprintf(`{"customerId":%q,"amount":100,"method":"cash"}`, ctCarol)
	if code, res = call(t, mux, ctAlice, "POST", "/shopbook/my-shop/payments", body); code != 403 {
		t.Fatalf("a payment for a non-customer must be refused with 403, got %d %v", code, res)
	}
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_ledger WHERE shop_id = '%s'`, ctShopA), &ledgerRows); err != nil {
		t.Fatalf("ledger count: %v", err)
	}
	if ledgerRows != 0 {
		t.Fatalf("a refused payment still opened a khata: %d rows", ledgerRows)
	}
}
