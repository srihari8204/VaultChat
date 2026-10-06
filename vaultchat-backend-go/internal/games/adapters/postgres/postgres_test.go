package postgres

import (
	"strings"
	"testing"
)

// THE SCOPING IS THE WHOLE SECURITY MODEL of the live-tables list.
//
// RLS is inert in production — the API connects as a superuser and bypasses
// every policy — so if the query stops filtering by user_id, the endpoint
// serves every player's tables to whoever asks first.
func TestLiveTablesQueryScopesToTheCaller(t *testing.T) {
	if !strings.Contains(liveTablesSQL, "WHERE user_id = $1") {
		t.Fatal("the live-tables query must filter by user_id — RLS will not do it in prod")
	}
	if !strings.Contains(liveTablesSQL, "FROM games_live_tables") {
		t.Fatal("the live-tables query must read games_live_tables")
	}
}
