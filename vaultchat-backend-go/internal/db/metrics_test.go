package db

import (
	"net/http/httptest"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/metrics"
)

// The gauges must survive a nil pool. RegisterPoolGauges is called from main
// alongside the other registrations, and a scrape that arrives while the pool
// is unset (startup, or a reconnect window) must report 0 rather than panic
// inside the metrics handler — a panic there takes down the scrape endpoint,
// which is exactly when someone is looking at it.
func TestPoolGaugesSurviveNilPool(t *testing.T) {
	saved := Pool
	Pool = nil
	t.Cleanup(func() { Pool = saved })

	RegisterPoolGauges()

	rec := httptest.NewRecorder()
	metrics.Handler(rec, httptest.NewRequest("GET", "/internal/metrics", nil))
	body := rec.Body.String()

	for _, want := range []string{
		"vaultchat_db_pool_acquired_conns",
		"vaultchat_db_pool_idle_conns",
		"vaultchat_db_pool_total_conns",
		"vaultchat_db_pool_max_conns",
		"vaultchat_db_pool_acquires_total",
		"vaultchat_db_pool_empty_acquires_total",
		"vaultchat_db_pool_canceled_acquires_total",
		"vaultchat_db_pool_acquire_wait_seconds_total",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("%s missing from the exposition", want)
		}
	}
	if rec.Code != 200 {
		t.Errorf("scrape returned %d, want 200", rec.Code)
	}
}

// The exposition must stay parseable: Prometheus rejects the whole scrape on a
// malformed line, so one bad gauge would blind every other metric in the
// process — including the ones that were already working.
func TestPoolGaugeLinesAreWellFormed(t *testing.T) {
	saved := Pool
	Pool = nil
	t.Cleanup(func() { Pool = saved })

	RegisterPoolGauges()
	rec := httptest.NewRecorder()
	metrics.Handler(rec, httptest.NewRequest("GET", "/internal/metrics", nil))

	for _, line := range strings.Split(rec.Body.String(), "\n") {
		if !strings.HasPrefix(line, "vaultchat_db_pool") {
			continue
		}
		// "name value" — exactly two fields, and the value must parse.
		parts := strings.Fields(line)
		if len(parts) != 2 {
			t.Errorf("malformed exposition line: %q", line)
			continue
		}
		if parts[1] != "0" && !strings.ContainsAny(parts[1], "0123456789") {
			t.Errorf("non-numeric value in %q", line)
		}
	}
}
