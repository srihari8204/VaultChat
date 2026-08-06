// vaultbeam_rollout_metrics.go — the signals the VB_SEAMLESS_RESUME canary is
// read from.
//
// A percentage rollout with no signal is not a rollout, it is a hope. These are
// the counters that answer "is the canary cohort doing worse than everyone
// else?", which is the only question a canary can actually answer.
//
// THE COHORT LABEL IS ALREADY IN THE DATA
// ---------------------------------------
// No new client telemetry, no new privacy surface, no extra request: a sender on
// the seamless path writes a v2 segment plan and a sender on the legacy path
// writes a v1 one, and the server already stores that plan. So the cohort is
// read from a column that exists rather than reported by the device.
//
// WHAT THESE NUMBERS ARE, AND ARE NOT
// -----------------------------------
// `staged_blocks / block_count` is NOT a bug detector on its own. A transfer
// that legitimately never found a direct tier stages every block, and its ratio
// is 1.0 with nothing wrong. The number is only meaningful as a COMPARISON
// between cohorts: if v2's aggregate ratio is not lower than v1's, seamless
// resume is not saving the re-upload it exists to save. If it is HIGHER,
// something is re-staging and the dial should come down.
//
// Everything here is content-free — counts and block totals, never bytes, never
// filenames, never who is talking to whom.
package routes

import "vaultchat/backend-go/internal/metrics"

// vbCohort labels a transfer by the segment-plan version its sender wrote.
// A plan is absent until the sender first grows one, so an unstarted transfer
// is "none" rather than being silently counted as legacy.
func vbCohort(t *vbTransfer) string {
	if t == nil || t.Plan == nil || *t.Plan == "" {
		return "none"
	}
	// The plan is JSON, `{"version":N,...}`. Parsing the whole structure here
	// would duplicate the client's segment model in a second language for one
	// integer; matching the field is enough and cannot drift, because the field
	// name is part of the frozen wire contract.
	if vbPlanIsV2(*t.Plan) {
		return "v2"
	}
	return "v1"
}

// vbPlanIsV2 reports whether a serialized segment plan declares version >= 2.
// Deliberately a substring match on the leading version field rather than a
// JSON decode: this runs on every completion and must never be able to fail,
// and a malformed plan should read as "not v2" rather than as an error.
func vbPlanIsV2(plan string) bool {
	const key = `"version":`
	i := indexOf(plan, key)
	if i < 0 {
		return false
	}
	j := i + len(key)
	for j < len(plan) && (plan[j] == ' ' || plan[j] == '\t') {
		j++
	}
	// Any version digit >= 2. Single digit is enough: the plan version is a
	// small integer and a two-digit one is even more certainly >= 2.
	if j >= len(plan) {
		return false
	}
	if plan[j] < '0' || plan[j] > '9' {
		return false
	}
	if j+1 < len(plan) && plan[j+1] >= '0' && plan[j+1] <= '9' {
		return true // two or more digits ⇒ >= 10
	}
	return plan[j] >= '2'
}

func indexOf(s, sub string) int {
	n := len(sub)
	if n == 0 || len(s) < n {
		return -1
	}
	for i := 0; i+n <= len(s); i++ {
		if s[i:i+n] == sub {
			return i
		}
	}
	return -1
}

// vbMetricStarted records a transfer entering the relay. This is the
// denominator: without it a falling completion COUNT is indistinguishable from
// fewer people sending files.
func vbMetricStarted(t *vbTransfer) {
	metrics.Inc("vaultbeam_started_" + vbCohort(t))
}

// vbMetricCompleted records a successful delivery plus how much of the file the
// relay actually had to carry.
func vbMetricCompleted(t *vbTransfer, stagedBlocks int) {
	c := vbCohort(t)
	metrics.Inc("vaultbeam_completed_" + c)
	if t != nil && t.BlockCount > 0 && stagedBlocks >= 0 {
		// Two counters, not a ratio: summing them in a dashboard gives the
		// aggregate ratio, and an aggregate is what a cohort comparison needs.
		// A per-transfer ratio averaged across transfers would weight a 1 MB
		// file the same as a 12 GB one.
		metrics.Add("vaultbeam_staged_blocks_"+c, uint64(stagedBlocks))
		metrics.Add("vaultbeam_total_blocks_"+c, uint64(t.BlockCount))
	}
}

// vbMetricAborted records a transfer that ended without delivering.
func vbMetricAborted(t *vbTransfer) {
	metrics.Inc("vaultbeam_aborted_" + vbCohort(t))
}

// vbMetricVersionBump records a session-version increment: the transfer was
// materially reset. Rare and expected; a SPIKE means clients are re-initing,
// which is the condition that forces fresh key material and drops both bitmaps.
func vbMetricVersionBump(t *vbTransfer) {
	metrics.Inc("vaultbeam_version_bump_" + vbCohort(t))
}
