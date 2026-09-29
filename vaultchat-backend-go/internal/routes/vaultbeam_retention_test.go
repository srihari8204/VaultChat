// vaultbeam_retention_test.go — a relay object may not outlive 24 hours, and a
// verified receive must delete it at once.
//
// SCOPE, STATED PLAINLY: STRUCTURAL. These read the source and the migration and
// assert the shape of the retention wiring. They open no socket, write no row
// and delete no object, so they prove nothing about a live R2 bucket — the real
// round-trip is a separate, production-safe script. What they DO catch is the
// class of mistake that made this change necessary in the first place.
//
// # THE DEFECT THIS CLOSES
//
// The sweep used to be one statement:
//
//	DELETE FROM vb_transfer WHERE expires_at < NOW()
//
// carrying a comment that said "objects are auto-purged by the 24h R2 lifecycle
// rule". It deleted the ROW ONLY. Nothing in the application ever deleted an
// expired relay object; the entire retention guarantee rested on a bucket rule
// outside this codebase, which on 2026-08-20 could not be confirmed to exist —
// the API token is not permitted to read lifecycle configuration.
//
// And because transfer_id is the ONLY handle from a transfer to its
// `vault_relay/<id>/` prefix, dropping the row first destroyed any way of ever
// finding those objects again. If the rule were absent, the leak would be both
// permanent and unobservable.
package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func retentionSrc(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

// Body of one function, comments stripped, so prose cannot satisfy a check.
func retentionFunc(t *testing.T, file, fn string) string {
	t.Helper()
	src := retentionSrc(t, file)
	i := strings.Index(src, "func "+fn+"(")
	if i < 0 {
		t.Fatalf("%s not found in %s", fn, file)
	}
	body := src[i:]
	if j := strings.Index(body[1:], "\nfunc "); j >= 0 {
		body = body[:j]
	}
	var out []string
	for _, l := range strings.Split(body, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(l), "//") {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

// 1. The deadline is created_at + 24h, and it comes from the schema default.
func TestRelayDeadlineIs24Hours(t *testing.T) {
	m := retentionSrc(t, "../../../vaultchat-backend/migrations/057_vaultbeam_transfers.sql")
	if !regexp.MustCompile(`expires_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\) \+ INTERVAL '24 hours'`).MatchString(m) {
		t.Error("the 24h relay deadline is no longer the column default")
	}
}

// 2-4. The reaper's predicate must be the deadline itself: everything at or past
// it is eligible, everything before it is not. `<` on a timestamp gives 23h59m
// not-yet-eligible and 24h+ eligible with no extra arithmetic.
func TestSweepSelectsExactlyTheExpired(t *testing.T) {
	b := retentionFunc(t, "vaultbeam.go", "VaultbeamSweepExpired")
	if !strings.Contains(b, "WHERE expires_at < NOW()") {
		t.Error("the sweep no longer selects by the relay deadline")
	}
	if strings.Contains(b, "last_seen") || strings.Contains(b, "updated_at") || strings.Contains(b, "INTERVAL") {
		t.Error("the sweep must key off the absolute deadline, never activity — that is an inactivity TTL")
	}
}

// 5-6. NOTHING may push a deadline later. Not a re-init, not a resume, not a
// fresh presigned URL. The only permitted write to expires_at is the LEAST(...)
// that pulls it FORWARD when a cleanup failed.
func TestTtlNeverSlides(t *testing.T) {
	src := retentionSrc(t, "vaultbeam.go")
	// Capture the ASSIGNED VALUE, not just the left-hand side: stopping at the
	// `=` was the first version of this check and it could never see the
	// LEAST() that makes the write safe.
	writes := regexp.MustCompile(`(?i)expires_at\s*=\s*[^,\n]+`).FindAllString(src, -1)
	for _, w := range writes {
		if !strings.Contains(w, "LEAST(") {
			t.Errorf("a write to expires_at that is not a LEAST() can only extend retention: %q", w)
		}
		if strings.Contains(w, "GREATEST(") || strings.Contains(w, "+ INTERVAL") {
			t.Errorf("this write extends the deadline: %q", w)
		}
	}
	// The idempotent re-init must not refresh the deadline either.
	init := retentionFunc(t, "vaultbeam.go", "vbRelayInit")
	if i := strings.Index(init, "ON CONFLICT"); i >= 0 {
		clause := init[i:]
		if j := strings.Index(clause, "RETURNING"); j > 0 {
			clause = clause[:j]
		}
		if strings.Contains(clause, "expires_at") {
			t.Error("re-init touches expires_at — a sender retry would slide the TTL")
		}
	}
	// Handing out another presigned URL must not touch it at all.
	if strings.Contains(retentionFunc(t, "vaultbeam.go", "vbRelayBlockURL"), "expires_at") {
		t.Error("presigning writes expires_at — regenerating a URL would extend relay lifetime")
	}
}

// 7-8. Deletion is gated on the integrity claim, not on chunk arrival.
func TestSuccessCleanupHappensAfterTheIntegrityGate(t *testing.T) {
	b := retentionFunc(t, "vaultbeam.go", "vbRelayComplete")

	gate := strings.Index(b, "incomplete mask")
	clean := strings.Index(b, "vbCleanupRelay(")
	if clean < 0 {
		t.Fatal("a verified receive no longer cleans up its relay objects")
	}
	if gate < 0 {
		t.Fatal("the completion claim is no longer checked against the chunk count")
	}
	if clean < gate {
		t.Error("cleanup runs BEFORE the completeness gate — a bad claim would destroy the resume copy")
	}
	if strings.Index(b, "recipient only") > clean {
		t.Error("cleanup runs before recipient authorisation")
	}
	// Per-block deletion would strand a receiver whose final hash fails.
	for _, fn := range []string{"vbRelayBlockURL", "vbRelayUploaded", "vbRelayReceived"} {
		if strings.Contains(retentionFunc(t, "vaultbeam.go", fn), "vbDeletePrefix") ||
			strings.Contains(retentionFunc(t, "vaultbeam.go", fn), "vbCleanupRelay") {
			t.Errorf("%s deletes relay objects mid-transfer — resume would break on a hash mismatch", fn)
		}
	}
}

// 9-10. Abort (either party) cleans up.
func TestAbortCleansUp(t *testing.T) {
	b := retentionFunc(t, "vaultbeam.go", "vbRelayAbort")
	if !strings.Contains(b, `vbCleanupRelay(ctx, t.TransferID, "ABORTED")`) {
		t.Error("abort no longer purges the relay copy")
	}
	if strings.Index(b, "vbCleanupRelay(") > strings.Index(b, "state = 'aborted'") {
		t.Error("the row is marked aborted before the objects are deleted")
	}
}

// 11-13. THE INVARIANT. The row is the work queue and the only handle to the
// object keys, so it may not be dropped until the objects are gone. This is what
// makes a retry, an API restart and a crashed worker all safe.
func TestRowIsNeverDroppedBeforeItsObjects(t *testing.T) {
	b := retentionFunc(t, "vaultbeam.go", "VaultbeamSweepExpired")

	if strings.Contains(b, "DELETE FROM vb_transfer WHERE expires_at") {
		t.Fatal("the sweep deletes rows in bulk again — objects are never deleted and become unreachable")
	}
	del := strings.Index(b, "DELETE FROM vb_transfer WHERE transfer_id = $1")
	if del < 0 {
		t.Fatal("the sweep no longer deletes the row it has cleaned")
	}
	obj := strings.Index(b, "vbDeletePrefixCount(")
	if obj < 0 || obj > del {
		t.Error("the row DELETE is not preceded by the object delete")
	}
	// A failed delete must `continue`, leaving the row for the next tick.
	if !strings.Contains(b, "if derr != nil {") || !strings.Contains(b, "continue") {
		t.Error("a failed object delete no longer leaves the row behind for retry")
	}
	// It must be the ERROR that decides, not the count: deleting an already
	// empty prefix legitimately removes zero objects.
	if strings.Contains(b, "if n == 0") || strings.Contains(b, "n > 0 {") {
		t.Error("the sweep branches on the object COUNT; an already-clean prefix would be treated as a failure")
	}
}

// 14-15. No client, no user, no lock. The sweep must run for a sender and a
// receiver who are both offline, and two workers must not corrupt each other.
func TestSweepIsSelfContainedAndIdempotent(t *testing.T) {
	b := retentionFunc(t, "vaultbeam.go", "VaultbeamSweepExpired")
	for _, forbidden := range []string{"httpx.UserFrom", "http.Request", "emitx.", "user.ID"} {
		if strings.Contains(b, forbidden) {
			t.Errorf("the sweep depends on %s — it must run with every client offline", forbidden)
		}
	}
	// Bounded, so a backlog cannot turn one tick into an unbounded storm.
	if !strings.Contains(b, "LIMIT $1") {
		t.Error("the sweep is unbounded")
	}
	// Deleting by primary key is what makes a duplicate worker a harmless no-op.
	if !strings.Contains(b, "WHERE transfer_id = $1") {
		t.Error("row deletion is not keyed by primary key — two workers could race destructively")
	}
}

// The counting variant must report failure, or the caller cannot know whether it
// is safe to drop the row.
func TestDeletePrefixReportsFailure(t *testing.T) {
	b := retentionFunc(t, "vaultbeam.go", "vbDeletePrefixCount")
	if !strings.Contains(b, "(int, error)") && !strings.Contains(b, "func vbDeletePrefixCount(ctx context.Context, prefix string) (int, error)") {
		t.Error("vbDeletePrefixCount does not return an error")
	}
	for _, must := range []string{"return deleted, err", "return deleted, nil"} {
		if !strings.Contains(b, must) {
			t.Errorf("missing %q — a failure path swallows its error", must)
		}
	}
	// A partial page failure counts as failure, so it is retried.
	if strings.Contains(b, "return deleted, nil\n\t\t}\n\t\tif err") {
		t.Error("a page failure returns success")
	}
}

// Cleanup logging is operational, and must stay free of anything sensitive.
func TestCleanupLogsCarryNoSecrets(t *testing.T) {
	src := retentionSrc(t, "vaultbeam.go")
	for _, line := range strings.Split(src, "\n") {
		if !strings.Contains(line, "RELAY_CLEANUP") {
			continue
		}
		low := strings.ToLower(line)
		for _, bad := range []string{"key", "secret", "token", "signature", "authorization", "url", "presign", "bearer"} {
			// "transferId" and "objects" are fine; a credential name is not.
			if strings.Contains(low, bad) {
				t.Errorf("a cleanup log line mentions %q: %s", bad, strings.TrimSpace(line))
			}
		}
	}
	// And the reasons that must exist for the log to be useful.
	for _, ev := range []string{"RELAY_CLEANUP_SUCCESS", "RELAY_CLEANUP_FAILED", "RELAY_CLEANUP_EXPIRED", "RELAY_CLEANUP_RETRY", "RELAY_CLEANUP_COMPLETED"} {
		if !strings.Contains(src, ev) {
			t.Errorf("missing cleanup event %s", ev)
		}
	}
}

// A failed terminal cleanup must arm the reaper rather than wait out the full
// 24h — and must only ever shorten the deadline.
func TestFailedCleanupArmsTheReaper(t *testing.T) {
	b := retentionFunc(t, "vaultbeam.go", "vbCleanupRelay")
	if !strings.Contains(b, "expires_at = LEAST(expires_at, NOW())") {
		t.Error("a failed cleanup does not bring the retry forward")
	}
	if strings.Contains(b, "GREATEST(") {
		t.Error("cleanup extends a deadline")
	}
	// It must never turn a storage error into a failed transfer.
	if strings.Contains(b, "httpx.Err(") {
		t.Error("cleanup can fail the request — a verified receive would be reported as failed")
	}
}

// The reaper must run ONCE AT STARTUP as well as hourly.
//
// `for range time.Tick(time.Hour)` does not deliver until a full hour has
// elapsed. A go-api that restarts more often than that — a crash loop, a rolling
// deploy — would never reach its first tick, and the 24h ceiling would go
// silently unenforced while expired objects piled up. Proven on production
// 2026-08-20: the container started at 10:20:33Z and RELAY_CLEANUP_EXPIRED was
// logged at 10:20:33Z, reaping a transfer whose deadline had passed.
func TestSweepRunsAtStartupAndHourly(t *testing.T) {
	// CRLF-normalised: the working copy on Windows is CRLF and the deployed
	// copy is LF. A line-ending difference must not be able to fail a check
	// about scheduling.
	src := strings.ReplaceAll(retentionSrc(t, "../../cmd/api/main.go"), "\r\n", "\n")

	// Comments stripped: the explanation above the loop mentions the ticker, and
	// prose must not be able to satisfy — or break — a structural check.
	var code []string
	for _, l := range strings.Split(src, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(l), "//") {
			code = append(code, l)
		}
	}
	body := strings.Join(code, "\n")

	i := strings.Index(body, "routes.VaultbeamSweepExpired(ctx)")
	if i < 0 {
		t.Fatal("main.go no longer schedules the VaultBeam sweep at all")
	}
	if n := strings.Count(body, "routes.VaultbeamSweepExpired(ctx)"); n != 1 {
		t.Errorf("the sweep is invoked from %d places; it must be one shared call, not a duplicated implementation", n)
	}

	// EXACTLY ONE scheduler. A second ticker would double the sweep rate and be
	// invisible until it showed up as duplicated cleanup work.
	if n := strings.Count(body, "time.Tick(time.Hour)"); n != 1 {
		t.Errorf("expected exactly 1 hourly ticker in code, found %d", n)
	}

	// The startup call must come BEFORE the loop, or it is just the loop again.
	// Indentation-insensitive: the block's nesting depth (it now sits inside
	// the core-only branch) is not what this checks.
	if !regexp.MustCompile(`sweep\(\)\n\s*for range time\.Tick\(time\.Hour\)`).MatchString(body) {
		t.Error("no immediate sweep() precedes the hourly loop — the first cleanup is still start+1h")
	}
	// And the loop must still call it, or hourly cleanup is gone.
	if !regexp.MustCompile(`for range time\.Tick\(time\.Hour\) \{\n\s*sweep\(\)`).MatchString(body) {
		t.Error("the hourly loop no longer invokes the sweep")
	}

	// Scope: this file must not have acquired unrelated undeployed work.
	for _, unrelated := range []string{"ShopbookKhata", "RegisterShopbookKhata"} {
		if strings.Contains(body, unrelated) {
			t.Errorf("main.go references %s — unrelated work would ship with a retention deploy", unrelated)
		}
	}
}

// An expired transfer must stop being READABLE, not merely stop being stored.
//
// vbLoadTransfer reads expires_at and never compares it, so before this gate the
// only thing ending access was the hourly sweep. Measured on production
// 2026-08-20: a transfer whose deadline had passed two hours earlier still
// minted a working presigned GET, and R2 served the bytes — a window of up to
// one hour past the 24h ceiling.
func TestExpiredTransferCannotBePresigned(t *testing.T) {
	b := retentionFunc(t, "vaultbeam.go", "vbRelayBlockURL")

	gate := strings.Index(b, `httpx.Err(w, 410, "transfer expired")`)
	if gate < 0 {
		t.Fatal("no deadline gate — an expired transfer can still be handed a fresh presigned URL")
	}
	if !strings.Contains(b, "!time.Now().Before(t.ExpiresAt)") {
		t.Error("the gate does not compare against the transfer's own deadline")
	}
	// It must run BEFORE any URL is minted.
	mint := strings.Index(b, "vbPresign(")
	if mint > 0 && gate > mint {
		t.Error("the deadline is checked after a URL has already been signed")
	}

	// And a URL must not be able to outlive the deadline either: a link minted
	// one second before expiry would otherwise stay usable for its full hour.
	if !strings.Contains(b, "vbClampTTL(vbPutTTL, t.ExpiresAt)") ||
		!strings.Contains(b, "vbClampTTL(vbGetTTL, t.ExpiresAt)") {
		t.Error("presigned TTLs are not clamped to the transfer deadline")
	}
}

// The clamp may only ever shorten.
func TestClampTtlOnlyShortens(t *testing.T) {
	b := retentionFunc(t, "vaultbeam.go", "vbClampTTL")
	if b == "" {
		t.Fatal("vbClampTTL is gone")
	}
	for _, must := range []string{"if left < ttlSec {", "return left", "return ttlSec"} {
		if !strings.Contains(b, must) {
			t.Errorf("missing %q — the clamp cannot be shortening correctly", must)
		}
	}
	if strings.Contains(b, "left > ttlSec") || strings.Contains(b, "+ ttlSec") {
		t.Error("the clamp can EXTEND a TTL")
	}
	// It must never write the deadline.
	if strings.Contains(b, "expires_at") || strings.Contains(b, "UPDATE ") {
		t.Error("the clamp touches the stored deadline")
	}
}

// Cleanup paths must stay reachable on an expired transfer, or abort — which is
// how objects get released early — would be blocked by the very gate that is
// supposed to protect them.
func TestExpiryGateDoesNotBlockCleanupPaths(t *testing.T) {
	for _, fn := range []string{"vbRelayComplete", "vbRelayAbort"} {
		b := retentionFunc(t, "vaultbeam.go", fn)
		if strings.Contains(b, `"transfer expired"`) {
			t.Errorf("%s refuses expired transfers — abort/complete must stay callable so objects can be released", fn)
		}
	}
	// The gate belongs to the URL-minting path only.
	if strings.Contains(retentionFunc(t, "vaultbeam.go", "vbLoadTransfer"), "ExpiresAt)") {
		t.Error("the deadline gate was pushed into vbLoadTransfer, which every relay route shares")
	}
}
