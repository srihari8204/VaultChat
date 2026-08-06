package routes

import "testing"

func planPtr(s string) *string { return &s }

// The cohort label is the whole basis of the canary comparison. Getting it
// wrong does not produce an error — it produces confident numbers about the
// wrong population, which is worse.
func TestCohortFromPlanVersion(t *testing.T) {
	cases := []struct {
		name string
		plan *string
		want string
	}{
		{"no plan yet", nil, "none"},
		{"empty plan", planPtr(""), "none"},
		{"v1 legacy", planPtr(`{"version":1,"totalBytes":100,"segments":[]}`), "v1"},
		{"v2 canonical", planPtr(`{"version":2,"totalBytes":100,"segments":[]}`), "v2"},
		{"v3 future", planPtr(`{"version":3,"totalBytes":100}`), "v2"},
		{"double digit", planPtr(`{"version":10,"totalBytes":100}`), "v2"},
		{"whitespace", planPtr(`{"version": 2,"totalBytes":100}`), "v2"},
		{"version last", planPtr(`{"totalBytes":100,"version":2}`), "v2"},
		// Garbage must read as NOT v2 rather than blowing up: this runs on every
		// completion and a metrics helper may never be able to fail a request.
		{"malformed", planPtr(`not json at all`), "v1"},
		{"no version field", planPtr(`{"totalBytes":100}`), "v1"},
		{"truncated", planPtr(`{"version":`), "v1"},
	}
	for _, c := range cases {
		got := vbCohort(&vbTransfer{Plan: c.plan})
		if got != c.want {
			t.Errorf("%s: cohort = %q, want %q", c.name, got, c.want)
		}
	}
	if vbCohort(nil) != "none" {
		t.Error("a nil transfer must not panic and must not be attributed to a cohort")
	}
}

// Emitting metrics must never be able to fail a request, whatever it is handed.
func TestMetricsNeverPanic(t *testing.T) {
	for _, tr := range []*vbTransfer{
		nil,
		{},
		{Plan: planPtr(`{"version":2}`), BlockCount: 0},
		{Plan: planPtr(`{"version":2}`), BlockCount: 10},
	} {
		vbMetricStarted(tr)
		vbMetricAborted(tr)
		vbMetricVersionBump(tr)
		vbMetricCompleted(tr, 5)
		vbMetricCompleted(tr, 0)
		vbMetricCompleted(tr, -1) // a nonsense count must be ignored, not recorded
	}
}

func TestPlanIsV2(t *testing.T) {
	if vbPlanIsV2(`{"version":1}`) {
		t.Error("v1 must not read as v2")
	}
	if !vbPlanIsV2(`{"version":2}`) {
		t.Error("v2 must read as v2")
	}
	if vbPlanIsV2("") {
		t.Error("an empty plan must not read as v2")
	}
	if vbPlanIsV2(`{"version":x}`) {
		t.Error("a non-numeric version must not read as v2")
	}
}
