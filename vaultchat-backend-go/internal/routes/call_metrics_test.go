// call_metrics_test.go — the call counters reach the scrape endpoint.
//
// Instrumentation is the easiest thing in a codebase to add and never notice is
// broken: a counter that is never incremented, or incremented under a name no
// dashboard queries, looks identical to a working one until an incident. So the
// assertion here is end-to-end — drive the real handlers, then read the real
// /metrics output and check the series exist with the values they should.
//
// Skipped unless CALL_TEST_DB=1, like the other route tests.
package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/metrics"
)

const (
	mtA    = "aaaaaaaa-0000-4000-8000-00000000cd01"
	mtB    = "bbbbbbbb-0000-4000-8000-00000000cd02"
	mtEve  = "eeeeeeee-0000-4000-8000-00000000cd03"
	mtChat = "cccccccc-0000-4000-8000-00000000cd04"
)

func scrapeMetrics(t *testing.T) string {
	t.Helper()
	rec := httptest.NewRecorder()
	metrics.Handler(rec, httptest.NewRequest("GET", "/metrics", nil))
	return rec.Body.String()
}

// counterValue reads vaultchat_events_total{event="name"}. Returns -1 when the
// series is absent, which is different from zero: a missing series means the
// code path never ran at all.
func counterValue(scrape, name string) float64 {
	needle := fmt.Sprintf(`vaultchat_events_total{event=%q} `, name)
	for _, line := range strings.Split(scrape, "\n") {
		if strings.HasPrefix(line, needle) {
			var v float64
			if _, err := fmt.Sscanf(strings.TrimPrefix(line, needle), "%g", &v); err == nil {
				return v
			}
		}
	}
	return -1
}

func mtCleanup(ctx context.Context) {
	for _, q := range []string{
		fmt.Sprintf(`DELETE FROM calls WHERE chat_id = '%s'`, mtChat),
		fmt.Sprintf(`DELETE FROM chat_members WHERE chat_id = '%s'`, mtChat),
		fmt.Sprintf(`DELETE FROM chats WHERE id = '%s'`, mtChat),
		fmt.Sprintf(`DELETE FROM users WHERE id IN ('%s','%s','%s')`, mtA, mtB, mtEve),
	} {
		_ = adminExec(ctx, q)
	}
}

func TestCallMetricsReachTheScrape(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	mtCleanup(ctx)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES
		 ('%s','a@mt.test','A'), ('%s','b@mt.test','B'), ('%s','eve@mt.test','Eve')`, mtA, mtB, mtEve),
		fmt.Sprintf(`INSERT INTO chats (id, type) VALUES ('%s','group')`, mtChat),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		 ('%s','%s','owner'), ('%s','%s','member')`, mtChat, mtA, mtChat, mtB),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	t.Cleanup(func() { mtCleanup(ctx) })

	mux := http.NewServeMux()
	RegisterCallSessions(mux)
	body := fmt.Sprintf(`{"chatId":%q,"kind":"audio"}`, mtChat)

	// Counters are process-global and other tests share the process, so compare
	// deltas rather than absolutes. An absolute assertion here would pass or
	// fail depending on test ordering, which is worse than no test.
	before := scrapeMetrics(t)
	base := func(n string) float64 {
		if v := counterValue(before, n); v >= 0 {
			return v
		}
		return 0
	}
	b0, b1, b2, b3, b4 := base("call_started"), base("call_joined"),
		base("call_join_refused"), base("call_ended"), base("call_seconds_total")

	// A starts the call, B joins it, Eve (not in the chat) is refused.
	code, res := call(t, mux, mtA, "POST", "/calls", body)
	if code != 200 {
		t.Fatalf("start: %d %v", code, res)
	}
	callID := res["call"].(map[string]any)["id"].(string)
	if code, _ = call(t, mux, mtB, "POST", "/calls", body); code != 200 {
		t.Fatalf("join: %d", code)
	}
	if code, _ = call(t, mux, mtEve, "POST", "/calls", body); code != 403 {
		t.Fatalf("expected a refusal for a non-member, got %d", code)
	}
	if code, _ = call(t, mux, mtA, "POST", "/calls/"+callID+"/end", ""); code != 200 {
		t.Fatalf("end: %d", code)
	}

	after := scrapeMetrics(t)
	for _, tc := range []struct {
		name string
		base float64
		want float64
	}{
		{"call_started", b0, 1},
		{"call_joined", b1, 1},
		{"call_join_refused", b2, 1},
		{"call_ended", b3, 1},
	} {
		got := counterValue(after, tc.name)
		if got < 0 {
			t.Errorf("%s: series missing from the scrape — nothing ever incremented it", tc.name)
			continue
		}
		if got-tc.base != tc.want {
			t.Errorf("%s: delta %v, want %v", tc.name, got-tc.base, tc.want)
		}
	}

	// Duration is a sum, so it only has to have moved in the right direction —
	// a call that ends in the same second legitimately adds 0.
	if got := counterValue(after, "call_seconds_total"); got < b4 {
		t.Errorf("call_seconds_total went backwards: %v → %v", b4, got)
	}

	// The unconfigured-SFU counter fires on a server with no LiveKit keys, which
	// is exactly this one.
	code, _ = call(t, mux, mtA, "POST", "/calls", body) // reopen; the last one ended
	if code != 200 {
		t.Fatalf("reopen: %d", code)
	}
	code, res = call(t, mux, mtA, "POST", "/calls", body)
	callID = res["call"].(map[string]any)["id"].(string)
	// Read the counter HERE, not from the scrape taken at the top of the test.
	// Opening a call already probes the SFU, so a baseline from before those
	// two POSTs measures them as well and the delta is whatever this test
	// happened to do first — it asserted 1 and saw 5 the first time this ran
	// against a fresh database.
	u0 := counterValue(scrapeMetrics(t), "call_sfu_unconfigured")
	if u0 < 0 {
		u0 = 0
	}
	if code, _ = call(t, mux, mtA, "POST", "/calls/"+callID+"/sfu-token", ""); code != 503 {
		t.Skipf("LiveKit is configured in this environment (%d) — skipping the unconfigured counter", code)
	}
	if got := counterValue(scrapeMetrics(t), "call_sfu_unconfigured"); got-u0 != 1 {
		t.Errorf("call_sfu_unconfigured: delta %v, want 1", got-u0)
	}
}
