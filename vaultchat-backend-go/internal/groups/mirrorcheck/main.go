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
	b, err := json.Marshal(map[string]any{
		"permissions": all, "roles": roles,
		"manageRole": manage, "removeMember": remove, "transfer": transfer,
	})
	if err != nil {
		panic(err)
	}
	fmt.Println(string(b))
}
