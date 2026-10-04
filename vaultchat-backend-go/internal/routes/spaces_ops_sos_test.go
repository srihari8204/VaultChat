// spaces_ops_sos_test.go — the optional SOS fields incidentCreate reads
// (migration 146): the idempotency key, the press time and the late-alert
// wording. Pure; no database. The idempotent INSERT itself is rehearsed by
// vaultchat-backend/migrations/tests/146_incident_client_key_test.sql.
package routes

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestIncidentClientKey(t *testing.T) {
	for _, c := range []struct {
		in   any
		want string
		ok   bool
	}{
		{nil, "", true},
		{"", "", true},
		{"  ", "", true},
		{"0f9a3c1e-7d2b-4c55-9a10-3e2f1b6d8c42", "0f9a3c1e-7d2b-4c55-9a10-3e2f1b6d8c42", true},
		{"short", "short", false},
		{"has space in it", "has space in it", false},
		{"x'; DROP TABLE runs;--", "x'; DROP TABLE runs;--", false},
	} {
		got, ok := incidentClientKey(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("incidentClientKey(%q) = %q, %v; want %q, %v", c.in, got, ok, c.want, c.ok)
		}
	}
	if _, ok := incidentClientKey(strings.Repeat("a", 65)); ok {
		t.Errorf("a 65-character key was accepted")
	}
}

func TestIncidentPressedAt(t *testing.T) {
	now := time.Date(2026, 10, 4, 8, 40, 0, 0, time.UTC)
	at := func(s string) *time.Time { return incidentPressedAt(s, now) }
	if p := at("2026-10-04T08:14:00.000Z"); p == nil || !p.Equal(now.Add(-26*time.Minute)) {
		t.Errorf("JS toISOString not read: %v", p)
	}
	if p := at("2026-10-04T09:00:00Z"); p == nil || !p.Equal(now) {
		t.Errorf("a time ahead of the server is not taken as now: %v", p)
	}
	for _, bad := range []string{"", "yesterday", "2026-10-02T08:00:00Z"} {
		if p := at(bad); p != nil {
			t.Errorf("%q: want nil, got %v", bad, p)
		}
	}
	if incidentPressedAt(12345, now) != nil {
		t.Errorf("a number is not a press time")
	}
}

func TestIncidentClock(t *testing.T) {
	for in, want := range map[any]string{"08:14": "08:14", "23:59": "23:59", "24:00": "", "8:14": "", "08:14pm": "", nil: "", "<b>": ""} {
		if got := incidentClock(in); got != want {
			t.Errorf("incidentClock(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestSosLateWording(t *testing.T) {
	now := time.Date(2026, 10, 4, 8, 40, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { p := now.Add(-d); return &p }
	for _, c := range []struct {
		pressed *time.Time
		clock   string
		when    string
	}{
		{nil, "08:14", ""},
		{ago(90 * time.Second), "08:38", ""},
		{ago(26 * time.Minute), "08:14", " (pressed at 08:14, 26 min ago)"},
		{ago(26 * time.Minute), "", " (pressed 26 min ago)"},
		{ago(2 * time.Hour), "06:40", " (pressed at 06:40, 2 h ago)"},
		{ago(125 * time.Minute), "06:35", " (pressed at 06:35, 2 h 5 min ago)"},
	} {
		if got := sosPressedWhen(c.pressed, c.clock, now); got != c.when {
			t.Errorf("sosPressedWhen(%v, %q) = %q, want %q", c.pressed, c.clock, got, c.when)
		}
	}
	if got := sosRunWideText(""); got != "An emergency has been reported on this run" {
		t.Errorf("timely text changed: %q", got)
	}
	if got := sosRunWideText(" (pressed at 08:14, 26 min ago)"); got != "An emergency was reported on this run (pressed at 08:14, 26 min ago)" {
		t.Errorf("late text: %q", got)
	}
}

func TestIncidentCreatedAnswer(t *testing.T) {
	if got := incidentCreated("i1", false, false); !reflect.DeepEqual(got, map[string]any{"id": "i1"}) {
		t.Errorf("an ordinary answer must stay exactly {id}: %v", got)
	}
	want := map[string]any{"id": "i1", "duplicate": true, "runEnded": true}
	if got := incidentCreated("i1", true, true); !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
