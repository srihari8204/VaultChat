// spaces_runs_r4_test.go — GET /chats/{id}/runs?include=riders,stops returns
// each run's riders and stops in one call, with the single-run read's
// per-rider visibility. Reuses the ZBE space fixture (5c00 marker).
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run TestSpaceR4RunsInclude -v
package routes

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
)

func TestSpaceR4RunsInclude(t *testing.T) {
	mux := zbeSpaceSeed(t)
	runBase := "/chats/" + zsChat + "/runs/" + zsRun
	code, out := call(t, mux, zsAdmin, "PUT", runBase+"/stops", `{"stops":[{"label":"Gate"},{"label":"School"}]}`)
	if code != 200 {
		t.Fatalf("stops: %d %v", code, out)
	}
	stop1 := zsStrs(out["stopIds"])[0]
	if code, out := call(t, mux, zsAdmin, "PUT", runBase+"/riders",
		fmt.Sprintf(`{"riders":[{"riderId":%q,"stopId":%q}]}`, zsChild, stop1)); code != 200 {
		t.Fatalf("riders: %d %v", code, out)
	}

	list := func(uid, q string) (int, []map[string]any) {
		r := httptest.NewRequest("GET", "/chats/"+zsChat+"/runs"+q, nil)
		r.Header.Set("Authorization", "Bearer "+tokenFor(t, uid))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		var rows []map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &rows)
		return rec.Code, rows
	}

	// Default shape is unchanged: no riders/stops keys.
	code, rows := list(zsAdmin, "")
	if code != 200 || len(rows) != 1 || rows[0]["riders"] != nil || rows[0]["stops"] != nil {
		t.Fatalf("plain list: %d %v", code, rows)
	}
	// Admin (ops viewer): riders and stops attached, same shapes as runGet.
	code, rows = list(zsAdmin, "?include=riders,stops")
	if code != 200 || len(rows) != 1 {
		t.Fatalf("include: %d %v", code, rows)
	}
	riders, _ := rows[0]["riders"].([]any)
	stops, _ := rows[0]["stops"].([]any)
	if len(riders) != 1 || len(stops) != 2 {
		t.Fatalf("include riders=%v stops=%v", riders, stops)
	}
	rd := riders[0].(map[string]any)
	if rd["riderId"] != zsChild || rd["stopId"] != stop1 || rd["displayName"] != "Child" || rd["guardians"] != nil {
		t.Fatalf("rider row = %v", rd)
	}
	if stops[0].(map[string]any)["label"] != "Gate" {
		t.Fatalf("stops order = %v", stops)
	}
	// Only riders requested: stops key absent.
	if _, rows = list(zsAdmin, "?include=riders"); rows[0]["stops"] != nil || rows[0]["riders"] == nil {
		t.Fatalf("riders only: %v", rows[0])
	}
	// The child's guardian sees the run with their child's row; the single-run
	// read agrees.
	_, rows = list(zsParent, "?include=riders")
	_, single := call(t, mux, zsParent, "GET", runBase, "")
	if len(rows) != 1 || len(rows[0]["riders"].([]any)) != 1 || len(single["riders"].([]any)) != 1 {
		t.Fatalf("guardian list %v vs single %v", rows, single["riders"])
	}
	// Outsider: 403 as before.
	if code, _ := list(zsOutside, "?include=riders"); code != 403 {
		t.Fatalf("outsider: %d, want 403", code)
	}
}
