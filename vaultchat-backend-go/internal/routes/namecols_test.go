package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestNoLegacyNameColumnInSpaceQueries guards the bug class that made every
// Spaces screen anonymous and the invite picker unusable.
//
// users.name is a legacy plaintext column. It is NULL for every account on the
// production deployment, because real names live encrypted in
// first_name_cipher/last_name_cipher and are opened through vault.IdentityFromRow.
// A query that selects u.name alone compiles, runs, returns rows, and shows
// nobody — which is exactly how it survived review four separate times:
//
//   - ops/people, attendance, leave and tasks listed rows of "Member"
//   - the devices list had no owner
//   - every invitation card said it came from nobody
//   - and `u.name ILIKE $2` in the invite search matched NOTHING, so a member
//     could not be found by name at all
//
// The last one is why "invitations don't work": the picker was not broken, it
// was searching a column that is empty for all users.
//
// This test fails if a Spaces or invitation query reaches for the legacy column
// without also selecting the ciphers it would need to resolve a real name.
func TestNoLegacyNameColumnInSpaceQueries(t *testing.T) {
	// Scoped to the Spaces and membership surface. Other modules (shopbook,
	// broadcasts) have their own display-name conventions and are not in scope
	// for this guard — widening it is a separate change, not a drive-by.
	files := []string{
		"spaces_workforce.go",
		"spaces_devices.go",
		"spaces_roster.go",
		"spaces_runs.go",
		"spaces_ops.go",
		"chats_invitations.go",
		"chats_membership.go",
	}

	// Only aliases that refer to the USERS table. Other tables have genuinely
	// plaintext names — a run is called "Bus 01 Morning", a chat is called
	// "Acme Corp" — and flagging those would make this guard noise.
	legacy := regexp.MustCompile(`\b(u|iu|au|usr|inviter|invitee)\.name\b`)

	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			if os.IsNotExist(err) {
				continue // file legitimately absent in a trimmed checkout
			}
			t.Fatalf("read %s: %v", f, err)
		}
		text := string(src)

		for i, line := range strings.Split(text, "\n") {
			if !legacy.MatchString(line) {
				continue
			}
			// A comment explaining the trap is not a use of it.
			if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "//") {
				continue
			}
			// c.name is the CHAT's name, which is genuinely plaintext.
			if strings.Contains(line, "c.name") && !strings.Contains(line, "u.name") {
				continue
			}
			// Selecting the legacy column as a FALLBACK is correct — that is what
			// spaceNameCols does, and IdentityFromRow prefers the cipher. What is
			// wrong is reaching for it without the ciphers alongside.
			if strings.Contains(line, "_cipher") {
				continue
			}
			t.Errorf("%s:%d selects a legacy plaintext name column without the "+
				"ciphers beside it — it will render blank for every user.\n"+
				"    %s\n"+
				"Use spaceNameCols in the SELECT and resolve with spaceName().",
				f, i+1, strings.TrimSpace(line))
		}
	}
}

// TestNameSearchIsNotDelegatedToSQL pins the specific regression: an encrypted
// name cannot be matched with ILIKE, so the invite candidate search must filter
// in Go. If someone "optimises" this back into SQL, the picker silently returns
// nothing again — the failure is invisible, which is why it needs a test rather
// than a comment.
func TestNameSearchIsNotDelegatedToSQL(t *testing.T) {
	src, err := os.ReadFile("chats_membership.go")
	if err != nil {
		t.Skipf("chats_membership.go unavailable: %v", err)
	}
	for _, line := range strings.Split(string(src), "\n") {
		// The comment above the fix quotes the broken SQL on purpose. Describing
		// the trap is not falling into it.
		if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "//") {
			continue
		}
		if strings.Contains(line, "u.name ILIKE") {
			t.Error("invite candidate search matches u.name with ILIKE. That column is " +
				"NULL for every account, so the search always returns zero results. " +
				"Names are encrypted — decrypt the bounded candidate set and match in Go.")
		}
	}
}
