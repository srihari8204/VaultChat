// user_devices_migration_test.go — guards the two properties that make
// migration 132 safe to apply to a live, end-to-end-encrypted deployment:
// it is ADDITIVE (no existing column changes meaning, no backfill) and it is
// INERT (no code reads or writes any of it yet).
//
// STRUCTURAL, like vaultbeam_retention_test.go: this reads the .sql text and
// the Go tree. It executes no DDL — Postgres is not available here. What it
// catches is the class of mistake that matters: someone later adding a NOT NULL
// or a key-table ALTER into this file, or wiring it into a live handler without
// noticing that the device claim is still self-asserted.
package routes

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const userDevicesMigration = "../../../vaultchat-backend/migrations/132_user_devices.sql"

func TestUserDevicesMigrationIsAdditive(t *testing.T) {
	src := readSource(t, userDevicesMigration)

	// Statements only — the file's prose legitimately names the key tables.
	var stmts []string
	for _, line := range strings.Split(src, "\n") {
		if s := strings.TrimSpace(line); s != "" && !strings.HasPrefix(s, "--") {
			stmts = append(stmts, s)
		}
	}
	body := strings.Join(stmts, "\n")

	// 1. No DDL against live cryptographic tables. Widening these is Phase 2/3
	//    and can silently make shipped messages undecryptable.
	for _, tbl := range []string{"identity_keys", "signed_prekeys", "one_time_prekeys", "group_sender_keys"} {
		if regexp.MustCompile(`(?i)(alter|drop|create)[^\n]*\b` + tbl + `\b`).MatchString(body) {
			t.Fatalf("migration 132 issues DDL against %s — that is Phase 2/3, not Phase 1", tbl)
		}
	}

	// 2. Columns added to live tables must be nullable and un-defaulted, so no
	//    existing row or existing INSERT changes meaning.
	adds := regexp.MustCompile(`(?i)ALTER TABLE\s+\w+\s+ADD COLUMN[^;]*;`).FindAllString(body, -1)
	if len(adds) == 0 {
		t.Fatal("expected ADD COLUMN statements; migration shape changed")
	}
	for _, a := range adds {
		if regexp.MustCompile(`(?i)NOT NULL|DEFAULT`).MatchString(a) {
			t.Fatalf("column added to a live table is not nullable/un-defaulted: %s", a)
		}
		if !strings.Contains(strings.ToUpper(a), "IF NOT EXISTS") {
			t.Fatalf("not idempotent: %s", a)
		}
	}

	// 3. No backfill: an UPDATE here would be writing to live rows.
	if regexp.MustCompile(`(?i)^\s*(UPDATE|INSERT|DELETE)\b`).MatchString(body) {
		t.Fatal("migration 132 writes rows; it must be schema-only")
	}

	// 4. Reversible.
	if !strings.Contains(src, "ROLLBACK") || !strings.Contains(src, "DROP TABLE IF EXISTS user_devices") {
		t.Fatal("migration 132 has no rollback block")
	}
}

// user_devices is schema-only until the access JWT carries a device claim
// (LINKED_DEVICES_PLAN §6, Phase 1). Until then no handler may key anything on
// it: X-Device-Id is still self-asserted, so a read here would be a security
// guard built on an unauthenticated header. Delete this test in the same change
// that adds the claim.
func TestUserDevicesTableIsUnreferenced(t *testing.T) {
	err := filepath.Walk("../..", func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return err
		}
		if strings.HasSuffix(path, "user_devices_migration_test.go") {
			return nil
		}
		b, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		if strings.Contains(string(b), "user_devices") {
			t.Errorf("%s references user_devices, but the device claim does not exist yet", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
