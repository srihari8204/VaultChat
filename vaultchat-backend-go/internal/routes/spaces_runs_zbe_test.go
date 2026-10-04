// spaces_runs_zbe_test.go — stop edits keep stop ids, the driver (only) sees
// each rider's guardians, and the shift window can be read back.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run TestSpaceZBE -v
//
// Every fixture id carries the 5c00 marker; zbeSpaceCleanup removes exactly
// those rows (the chat cascade takes runs, stops, riders, roster and links).
package routes

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"testing"

	"vaultchat/backend-go/internal/db"
)

const (
	zsChat    = "5c000000-0000-4000-8000-00000000c001"
	zsAdmin   = "5c000000-0000-4000-8000-00000000a001"
	zsDriver  = "5c000000-0000-4000-8000-00000000a002"
	zsMod     = "5c000000-0000-4000-8000-00000000a003"
	zsParent  = "5c000000-0000-4000-8000-00000000a004"
	zsLeft    = "5c000000-0000-4000-8000-00000000a005" // a guardian who left the space
	zsTeacher = "5c000000-0000-4000-8000-00000000a006" // linked, but not as guardian
	zsOutside = "5c000000-0000-4000-8000-00000000a007" // not a member at all
	zsChild   = "5c000000-0000-4000-8000-00000000e001"
	zsRParent = "5c000000-0000-4000-8000-00000000e002"
	zsRLeft   = "5c000000-0000-4000-8000-00000000e003"
	zsRTeach  = "5c000000-0000-4000-8000-00000000e004"
	zsRun     = "5c000000-0000-4000-8000-00000000f001"
	zsMarker  = "5c000000-0000-4000-8000-%"
)

func zbeSpaceCleanup() {
	ctx := context.Background()
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM chats WHERE id::text LIKE '%s'`, zsMarker))
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM users WHERE id::text LIKE '%s'`, zsMarker))
}

func zbeSpaceSeed(t *testing.T) *http.ServeMux {
	t.Helper()
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	zbeSpaceCleanup()
	t.Cleanup(zbeSpaceCleanup)
	q := []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES
		  ('%s','zs1@t.test','Admin'), ('%s','zs2@t.test','Driver'), ('%s','zs3@t.test','Mod'),
		  ('%s','zs4@t.test','Parent'), ('%s','zs5@t.test','Left'), ('%s','zs6@t.test','Teacher'),
		  ('%s','zs7@t.test','Outsider')`,
			zsAdmin, zsDriver, zsMod, zsParent, zsLeft, zsTeacher, zsOutside),
		fmt.Sprintf(`INSERT INTO chats (id, type, name, group_type) VALUES ('%s','group','ZBE School','school')`, zsChat),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		  ('%[1]s','%[2]s','admin'), ('%[1]s','%[3]s','member'), ('%[1]s','%[4]s','moderator'),
		  ('%[1]s','%[5]s','member'), ('%[1]s','%[6]s','member'), ('%[1]s','%[7]s','member')`,
			zsChat, zsAdmin, zsDriver, zsMod, zsParent, zsLeft, zsTeacher),
		fmt.Sprintf(`UPDATE chat_members SET left_at = NOW() WHERE chat_id = '%s' AND user_id = '%s'`, zsChat, zsLeft),
		fmt.Sprintf(`INSERT INTO space_roster (id, chat_id, user_id, display_name) VALUES
		  ('%[1]s','%[5]s',NULL,'Child'), ('%[2]s','%[5]s','%[6]s','Asha (mum)'),
		  ('%[3]s','%[5]s','%[7]s','Left Parent'), ('%[4]s','%[5]s','%[8]s','Teacher T')`,
			zsChild, zsRParent, zsRLeft, zsRTeach, zsChat, zsParent, zsLeft, zsTeacher),
		fmt.Sprintf(`INSERT INTO space_links (chat_id, subject_id, object_id, relation) VALUES
		  ('%[1]s','%[2]s','%[5]s','guardian_of'), ('%[1]s','%[3]s','%[5]s','guardian_of'),
		  ('%[1]s','%[4]s','%[5]s','teaches')`,
			zsChat, zsRParent, zsRLeft, zsRTeach, zsChild),
		fmt.Sprintf(`INSERT INTO runs (id, chat_id, name, driver_id) VALUES ('%s','%s','Bus 1','%s')`,
			zsRun, zsChat, zsDriver),
	}
	for _, s := range q {
		if err := adminExec(ctx, s); err != nil {
			t.Fatalf("seed: %v\n%s", err, s)
		}
	}
	mux := http.NewServeMux()
	RegisterSpaceRunsOnID(mux)
	RegisterSpaceOpsOnID(mux)
	return mux
}

func zsStrs(v any) []string {
	out := []string{}
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func TestSpaceZBEStopsKeepIDs(t *testing.T) {
	mux := zbeSpaceSeed(t)
	base := "/chats/" + zsChat + "/runs/" + zsRun

	code, out := call(t, mux, zsAdmin, "PUT", base+"/stops", `{"stops":[{"label":"A"},{"label":"B"}]}`)
	if code != 200 {
		t.Fatalf("first save: %d %v", code, out)
	}
	ids := zsStrs(out["stopIds"])
	s1, s2 := ids[0], ids[1]
	if code, out = call(t, mux, zsAdmin, "PUT", base+"/riders",
		fmt.Sprintf(`{"riders":[{"riderId":%q,"stopId":%q}]}`, zsChild, s1)); code != 200 {
		t.Fatalf("riders: %d %v", code, out)
	}
	if err := adminExec(context.Background(),
		fmt.Sprintf(`UPDATE run_stops SET arrived_at = NOW() WHERE id = '%s'`, s1)); err != nil {
		t.Fatal(err)
	}

	// Reorder, edit both, add one: the existing ids survive with their marks.
	code, out = call(t, mux, zsAdmin, "PUT", base+"/stops", fmt.Sprintf(
		`{"stops":[{"id":%q,"label":"B2"},{"id":%q,"label":"A2","lat":12.9,"lng":77.5,"plannedAt":"2026-10-05T08:00:00Z"},{"label":"C"}]}`,
		s2, s1))
	if code != 200 {
		t.Fatalf("in-place save: %d %v", code, out)
	}
	ids = zsStrs(out["stopIds"])
	if len(ids) != 3 || ids[0] != s2 || ids[1] != s1 || ids[2] == s1 || ids[2] == s2 {
		t.Fatalf("stopIds = %v, want [%s %s <new>]", ids, s2, s1)
	}
	code, out = call(t, mux, zsAdmin, "GET", base, "")
	if code != 200 {
		t.Fatalf("get: %d %v", code, out)
	}
	stops := out["stops"].([]any)
	a2 := stops[1].(map[string]any)
	if stops[0].(map[string]any)["label"] != "B2" || a2["label"] != "A2" || a2["id"] != s1 ||
		a2["arrivedAt"] == nil || a2["lat"] != 12.9 {
		t.Fatalf("stops after edit = %v", stops)
	}
	if rd := out["riders"].([]any)[0].(map[string]any); rd["stopId"] != s1 {
		t.Fatalf("rider stopId = %v, want %s (kept)", rd["stopId"], s1)
	}

	// A foreign or repeated id refuses the whole save.
	for _, body := range []string{
		`{"stops":[{"id":"5c000000-0000-4000-8000-00000000ffff","label":"X"}]}`,
		fmt.Sprintf(`{"stops":[{"id":%q,"label":"X"},{"id":%q,"label":"Y"}]}`, s1, s1),
	} {
		if code, out = call(t, mux, zsAdmin, "PUT", base+"/stops", body); code != 400 || out["code"] != "unknown_stop" {
			t.Errorf("bad ids %s: %d %v, want 400 unknown_stop", body, code, out)
		}
	}
	// Leaving a stop out deletes it; the survivor keeps its id.
	code, out = call(t, mux, zsAdmin, "PUT", base+"/stops", fmt.Sprintf(`{"stops":[{"id":%q,"label":"A3"}]}`, s1))
	if code != 200 || len(zsStrs(out["stopIds"])) != 1 || zsStrs(out["stopIds"])[0] != s1 {
		t.Fatalf("shrink: %d %v", code, out)
	}
	// Members without manage_runs still cannot edit stops.
	if code, _ = call(t, mux, zsDriver, "PUT", base+"/stops", `{"stops":[]}`); code != 403 {
		t.Errorf("driver PUT stops: %d, want 403", code)
	}
}

func TestSpaceZBEGuardiansDriverOnly(t *testing.T) {
	mux := zbeSpaceSeed(t)
	base := "/chats/" + zsChat + "/runs/" + zsRun
	if code, out := call(t, mux, zsAdmin, "PUT", base+"/riders",
		fmt.Sprintf(`{"riders":[{"riderId":%q}]}`, zsChild)); code != 200 {
		t.Fatalf("riders: %d %v", code, out)
	}

	code, out := call(t, mux, zsDriver, "GET", base, "")
	if code != 200 {
		t.Fatalf("driver get: %d %v", code, out)
	}
	rd := out["riders"].([]any)[0].(map[string]any)
	gs, ok := rd["guardians"].([]any)
	if !ok || len(gs) != 1 {
		t.Fatalf("driver guardians = %v, want exactly the current guardian", rd["guardians"])
	}
	if g := gs[0].(map[string]any); g["userId"] != zsParent || g["displayName"] != "Asha (mum)" {
		t.Fatalf("guardian = %v", g)
	}

	// Ops viewers and admins see the manifest but not the guardians.
	for _, uid := range []string{zsAdmin, zsMod} {
		code, out = call(t, mux, uid, "GET", base, "")
		if code != 200 {
			t.Fatalf("%s get: %d %v", uid, code, out)
		}
		for _, r := range out["riders"].([]any) {
			if _, has := r.(map[string]any)["guardians"]; has {
				t.Errorf("%s got guardians: %v", uid, r)
			}
		}
	}
	// Reassign the driver: the old driver loses them too.
	if err := adminExec(context.Background(),
		fmt.Sprintf(`UPDATE runs SET driver_id = '%s' WHERE id = '%s'`, zsAdmin, zsRun)); err != nil {
		t.Fatal(err)
	}
	if code, _ = call(t, mux, zsDriver, "GET", base, ""); code != 404 {
		t.Errorf("former driver get: %d, want 404", code)
	}
}

func TestSpaceZBEShiftGet(t *testing.T) {
	mux := zbeSpaceSeed(t)
	path := "/chats/" + zsChat + "/shift"

	code, out := call(t, mux, zsAdmin, "GET", path, "")
	if code != 200 || out["shiftStart"] != "" || out["shiftEnd"] != "" || out["shiftGraceMinutes"] != float64(10) {
		t.Fatalf("unset shift: %d %v", code, out)
	}
	if code, out = call(t, mux, zsAdmin, "PATCH", path,
		`{"shiftStart":"08:30","shiftEnd":"16:00","shiftGraceMinutes":15,"runDelayThresholdMinutes":20}`); code != 200 {
		t.Fatalf("patch: %d %v", code, out)
	}
	for _, uid := range []string{zsAdmin, zsMod} { // edit_settings, view_space_ops
		code, out = call(t, mux, uid, "GET", path, "")
		if code != 200 || out["shiftStart"] != "08:30" || out["shiftEnd"] != "16:00" ||
			out["shiftGraceMinutes"] != float64(15) || out["runDelayThresholdMinutes"] != float64(20) {
			t.Errorf("%s get: %d %v", uid, code, out)
		}
	}
	for _, uid := range []string{zsDriver, zsLeft, zsOutside} { // plain member, left, never joined
		if code, out = call(t, mux, uid, "GET", path, ""); code != 403 {
			t.Errorf("%s get: %d %v, want 403", uid, code, out)
		}
	}
}
