package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// AUDIT F05/F06/F07. All three came from one missing thing: a refresh token had
// no searchable identity, because bcrypt salts every hash and is not lookupable.
// Migration 127 adds token_lookup (a keyed digest) and revoked_reason.

// The digest must be deterministic — otherwise it cannot index anything — and
// distinct per token, or two sessions would collide on the unique index.
func TestRefreshLookupIsDeterministicAndDistinct(t *testing.T) {
	t.Setenv("VAULTCHAT_LOOKUP_PEPPER", "test-pepper-value")

	a1 := authRefreshLookup("token-alpha")
	a2 := authRefreshLookup("token-alpha")
	b := authRefreshLookup("token-beta")

	if a1 == "" {
		t.Fatal("no digest produced with a pepper set")
	}
	if a1 != a2 {
		t.Fatalf("not deterministic: %q vs %q — an indexed lookup would never hit", a1, a2)
	}
	if a1 == b {
		t.Fatal("two different tokens produced the same digest")
	}
	if strings.Contains(a1, "token-alpha") {
		t.Fatal("the digest leaks the token it was made from")
	}
	if authRefreshLookup("") != "" {
		t.Fatal("an empty token must not produce a digest")
	}
}

// A missing pepper must degrade to the legacy scan, not lock every user out of
// refreshing. Returning "" is the signal the callers branch on.
func TestRefreshLookupEmptyWithoutPepper(t *testing.T) {
	t.Setenv("VAULTCHAT_LOOKUP_PEPPER", "")
	if got := authRefreshLookup("token-alpha"); got != "" {
		t.Fatalf("got %q with no pepper; callers rely on \"\" to fall back", got)
	}
}

// The handlers are wired to a live database, so these assert the SQL that
// carries the fix. A source check is the honest tool: this package has no
// database, and the defects are all in the shape of the query.
func readSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRefreshUsesIndexedLookup(t *testing.T) {
	src := readSource(t, "auth.go")

	if !regexp.MustCompile(`WHERE token_lookup = \$1`).MatchString(src) {
		t.Error("F05: refresh no longer selects its single candidate by token_lookup")
	}
	// The 500-row scan may remain ONLY as the pre-127 fallback, and must be
	// fenced to rows that have no lookup value.
	if strings.Contains(src, "LIMIT 500") &&
		!regexp.MustCompile(`token_lookup IS NULL[\s\S]{0,400}LIMIT 500`).MatchString(src) {
		t.Error("F05: the 500-row scan is not fenced to legacy (token_lookup IS NULL) rows")
	}
}

func TestGraceWindowIsRotationOnly(t *testing.T) {
	src := readSource(t, "auth.go")

	// F07: the window is what lets a retried refresh win its race. It must be
	// reachable only for a row revoked BY rotation.
	if !regexp.MustCompile(`revoked_reason = 'rotated'[\s\S]{0,200}revoked_at > NOW\(\)`).MatchString(src) {
		t.Error("F07: the refresh grace window is not restricted to revoked_reason='rotated'")
	}
	if !strings.Contains(src, "revoked_reason = 'rotated', last_used_at = NOW()") {
		t.Error("F07: rotation no longer stamps revoked_reason='rotated'")
	}
}

func TestSessionRevocationIsFinal(t *testing.T) {
	src := readSource(t, "user.go")

	// Both revoke paths — one device, and all other devices — must be final.
	if n := strings.Count(src, "revoked_reason = 'revoked'"); n < 2 {
		t.Errorf("F07: %d of 2 session-revocation paths mark the revocation final", n)
	}
}

func TestSignOutOthersKeepsThisDevice(t *testing.T) {
	src := readSource(t, "user.go")

	// F06: the exclusion must be by row id — the thing that actually identifies
	// a session — not by comparing a freshly salted bcrypt hash, which can
	// never equal the stored one and so excluded nothing.
	if !strings.Contains(src, "AND id <> $2") {
		t.Error("F06: sign-out-others no longer excludes the caller's session by id")
	}
	if strings.Contains(src, "token_hash <> $2") {
		t.Error("F06: the freshly-salted-bcrypt comparison is back; it can never match")
	}
	if strings.Contains(src, "func userHashCurrentRefresh") {
		t.Error("F06: userHashCurrentRefresh is back — it cannot identify a session")
	}
	if !strings.Contains(src, "id = $2 AS is_current") {
		t.Error("F06: the sessions list no longer marks the current session by id")
	}
}

// Migration 127 has to exist and carry both columns, or every query above is
// referencing something that is not there.
func TestMigration127AddsLookupAndReason(t *testing.T) {
	src := readSource(t, "../../../vaultchat-backend/migrations/127_refresh_token_lookup.sql")
	for _, want := range []string{
		"ADD COLUMN IF NOT EXISTS token_lookup",
		"ADD COLUMN IF NOT EXISTS revoked_reason",
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_lookup",
		"WHERE token_lookup IS NOT NULL", // partial, so legacy NULLs are exempt
	} {
		if !strings.Contains(src, want) {
			t.Errorf("migration 127 is missing %q", want)
		}
	}
}
