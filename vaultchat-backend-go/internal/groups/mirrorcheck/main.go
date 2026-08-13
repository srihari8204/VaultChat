// Command mirrorcheck dumps every permission-model decision the Go side makes,
// so the TypeScript mirror in lib/groups/permissions.ts can be checked against
// it exhaustively rather than by two hand-written tables happening to agree.
//
//	go run ./internal/groups/mirrorcheck | npx tsx scripts/check-permission-mirror.ts
package main

import (
	"encoding/json"
	"fmt"

	"vaultchat/backend-go/internal/groups"
)

func main() {
	roles := groups.SortedRoles()
	all := make([]string, 0, len(groups.All))
	for _, p := range groups.All {
		all = append(all, string(p))
	}
	// Exhaustive over every role (plus an invalid one), not a sample: the
	// interesting mismatches are exactly the combinations nobody thought to
	// write a case for.
	probe := append(append([]string{}, roles...), "bogus")
	manage, remove, transfer := [][]any{}, [][]any{}, [][]any{}
	for _, a := range probe {
		for _, t := range probe {
			remove = append(remove, []any{a, t, groups.CanRemoveMember(a, t)})
			transfer = append(transfer, []any{a, t, groups.CanTransferOwnership(a, t)})
			for _, n := range probe {
				manage = append(manage, []any{a, t, n, groups.CanManageRole(a, t, n)})
			}
		}
	}
	// Role catalog (migration 084). Exhaustive over every probe role against a
	// catalog that covers each interesting shape — replace, inherit, revoke, and
	// a rank that does not match. The rank-mismatch rows are the ones worth
	// having: if one side forgets that check, that side silently escalates.
	catalog := []groups.RoleDef{
		{Key: "principal", Label: "Principal", Rank: groups.RoleOwner},
		{Key: "manager", Label: "Manager", Rank: groups.RoleAdmin,
			Permissions: []string{"manage_runs", "view_space_ops"}},
		{Key: "driver", Label: "Driver", Rank: groups.RoleMember,
			Permissions: []string{"drive_run", "report_incident"}},
		{Key: "parent", Label: "Parent", Rank: groups.RoleMember, Permissions: []string{}},
		{Key: "teacher", Label: "Teacher", Rank: groups.RoleMember},
	}
	catalogKeys := []string{"principal", "manager", "driver", "parent", "teacher", "astronaut", ""}
	catalogCases := [][]any{}
	for _, key := range catalogKeys {
		for _, role := range probe {
			perms, set := groups.CatalogLayer(catalog, key, role)
			if perms == nil {
				perms = []string{}
			}
			catalogCases = append(catalogCases, []any{key, role, set, perms})
		}
	}

	b, err := json.Marshal(map[string]any{
		"permissions": all, "roles": roles,
		"manageRole": manage, "removeMember": remove, "transfer": transfer,
		"catalog": catalog, "catalogLayer": catalogCases,
	})
	if err != nil {
		panic(err)
	}
	fmt.Println(string(b))
}
