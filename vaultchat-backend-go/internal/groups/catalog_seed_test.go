package groups

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The seeded catalogs and permission presets live in SQL — that is the point,
// they are config — but "config" does not mean "unchecked". These tests read the
// migration itself, so a hand-edit that breaks an invariant fails `go test`
// rather than failing in production three weeks later.

const seedMigration = "../../../vaultchat-backend/migrations/084_space_roles.sql"

// Single-quoted blobs in the migration: the role catalogs (JSON arrays) and the
// default_permissions presets (JSON objects). Anything else quoted in the file
// is a bare identifier and will not parse as JSON, so it is skipped.
var sqlBlob = regexp.MustCompile(`'(\[[\s\S]*?\]|\{[\s\S]*?\})'`)

func seedBlobs(t *testing.T) (catalogs [][]RoleDef, presets []map[string][]string) {
	t.Helper()
	raw, err := os.ReadFile(seedMigration)
	if err != nil {
		t.Skipf("migration not readable from here: %v", err)
	}
	for _, m := range sqlBlob.FindAllStringSubmatch(string(raw), -1) {
		blob := m[1]
		if strings.HasPrefix(blob, "[") {
			defs, err := ParseRoleCatalog([]byte(blob))
			if err != nil {
				t.Errorf("seeded catalog does not parse: %v\n%s", err, blob)
				continue
			}
			catalogs = append(catalogs, defs)
			continue
		}
		var preset map[string][]string
		if err := json.Unmarshal([]byte(blob), &preset); err != nil {
			continue // not a permission preset
		}
		presets = append(presets, preset)
	}
	return
}

// Every seeded catalog must survive the same parser the server uses. Without
// this, a typo in the SQL means the layer silently vanishes at runtime and
// everyone quietly resolves to their bare rank default.
func TestSeededCatalogsParse(t *testing.T) {
	catalogs, presets := seedBlobs(t)
	if len(catalogs) == 0 {
		t.Fatal("no role catalogs found in the migration — did the file move?")
	}
	if len(presets) == 0 {
		t.Fatal("no permission presets found in the migration")
	}
	for _, preset := range presets {
		for role, perms := range preset {
			if !IsValidRole(role) {
				t.Errorf("preset names unknown role %q", role)
			}
			for _, p := range perms {
				if !IsValidPermission(p) {
					t.Errorf("preset for %q lists unknown permission %q", role, p)
				}
			}
		}
	}
}

// The RLS floor in migration 085 (vc_space_ops_viewer) admits moderator and
// above. A role below that rank holding view_space_ops would pass the route's
// permission check and then be shown nothing by the database — a bug that looks
// like an empty screen, with no error anywhere to explain it.
//
// If this test fails, the fix is one of: raise that role's rank, drop
// view_space_ops and use space_links instead, or teach vc_space_ops_viewer to
// resolve the real permission (which means a second copy of the permission model
// in PL/pgSQL — see the comment in 085 for why that was rejected).
func TestNoSubModeratorHoldsOpsView(t *testing.T) {
	catalogs, presets := seedBlobs(t)
	below := func(role string) bool { return role == RoleMember || role == RoleGuest }

	for _, defs := range catalogs {
		for _, d := range defs {
			if !below(d.Rank) {
				continue
			}
			for _, p := range d.Permissions {
				if Permission(p) == PermViewSpaceOps {
					t.Errorf("catalog role %q is rank %s and holds view_space_ops; the RLS floor will show it nothing", d.Key, d.Rank)
				}
			}
		}
	}
	for _, preset := range presets {
		for role, perms := range preset {
			if !below(role) {
				continue
			}
			for _, p := range perms {
				if Permission(p) == PermViewSpaceOps {
					t.Errorf("preset grants view_space_ops to rank %s; the RLS floor will show it nothing", role)
				}
			}
		}
	}
}

// A catalog entry's rank must be a rank the resolver knows, and its key must be
// usable: CatalogLayer matches on rank equality, so an entry whose rank is
// misspelled applies to nobody and fails silently.
func TestSeededCatalogEntriesResolve(t *testing.T) {
	catalogs, _ := seedBlobs(t)
	for _, defs := range catalogs {
		for _, d := range defs {
			if d.Permissions == nil {
				continue // label-only entry, inherits the rank default
			}
			perms, set := CatalogLayer(defs, d.Key, d.Rank)
			if !set {
				t.Errorf("catalog entry %q does not resolve against its own catalog", d.Key)
			}
			if len(perms) != len(d.Permissions) {
				t.Errorf("catalog entry %q resolved to %v, want %v", d.Key, perms, d.Permissions)
			}
		}
	}
}
