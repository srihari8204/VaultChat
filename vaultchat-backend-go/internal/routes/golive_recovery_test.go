// golive_recovery_test.go — a host's network blip must not end their broadcast.
//
// SCOPE, STATED PLAINLY: STRUCTURAL. These read the source and assert the shape
// of the recovery wiring. They open no socket and write no row, so they prove
// nothing about a real reconnect — DEVICE VERIFICATION IS SEPARATE. What they
// do catch is the class of mistake that makes this change dangerous: the grace
// check going missing, a deliberate End becoming resurrectable, or a second
// transcoder being started for a stream that still has one.
//
// # THE DEFECT THIS CLOSES
//
// Two mechanisms could end a broadcast. golive_reaper.go waits hostGrace()
// before ending a host-abandoned session — deliberately, and its header explains
// why 90s is safe there when 12h was the most that could be justified elsewhere.
// broadcast_webhook.go ended it the instant egress reported a fault, with no
// grace at all. Egress faults within seconds of a host's network dropping, so
// the second always won and the first was dead code for the exact case it was
// written for. Measured on device: a 20s outage killed the stream permanently
// while the client's transport recovered moments later.
package routes

import (
	"os"
	"strings"
	"testing"
)

func recoverySrc(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	var out []string
	for _, l := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(l), "//") {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

func recoveryFunc(t *testing.T, file, fn string) string {
	t.Helper()
	src := recoverySrc(t, file)
	i := strings.Index(src, "func "+fn+"(")
	if i < 0 {
		t.Fatalf("%s not found in %s", fn, file)
	}
	body := src[i:]
	if j := strings.Index(body[1:], "\nfunc "); j >= 0 {
		body = body[:j]
	}
	return body
}

// The grace check must come BEFORE the terminating UPDATE, or it cannot
// prevent anything.
func TestEgressGoneHonoursHostGrace(t *testing.T) {
	b := recoveryFunc(t, "broadcast_webhook.go", "markBroadcastEgressGone")

	graceAt := strings.Index(b, "host_left_at > now() - $2::interval")
	failAt := strings.Index(b, "SET status = 'failed'")
	if graceAt < 0 {
		t.Fatal("no host-grace check — an egress fault still ends the broadcast instantly")
	}
	if failAt < 0 {
		t.Fatal("the terminating UPDATE disappeared entirely")
	}
	if graceAt > failAt {
		t.Error("the grace check runs AFTER the termination — it cannot prevent it")
	}
	if !strings.Contains(b, "hostGrace()") {
		t.Error("the window must come from hostGrace(), not a second hard-coded number")
	}
	// Held open, not ended: clearing egress_id is what tells the rejoin path a
	// transcoder is owed. Setting a status here would need a new enum value.
	if !strings.Contains(b, "SET egress_id = NULL") {
		t.Error("a held-open session must clear egress_id so the rejoin can restart it")
	}
	// An ordinary broadcast has no host_left_at and must be unaffected.
	if !strings.Contains(b, "host_left_at IS NOT NULL") {
		t.Error("grace must require host_left_at, so non-Go-Live broadcasts still end at once")
	}
}

// A deliberate End must never come back. It writes 'ended'; every recovery
// statement is scoped to ('starting','live'), so 'ended' can never match.
func TestDeliberateEndCannotResurrect(t *testing.T) {
	for _, c := range []struct{ file, fn string }{
		{"broadcast_webhook.go", "markBroadcastEgressGone"},
		{"golive_webhook.go", "goliveRestartEgress"},
	} {
		b := recoveryFunc(t, c.file, c.fn)
		for _, stmt := range strings.Split(b, "UPDATE broadcast_sessions")[1:] {
			head := stmt
			if i := strings.Index(head, "`"); i > 0 {
				head = head[:i]
			}
			if !strings.Contains(head, "status IN ('starting', 'live')") && !strings.Contains(head, "id = $1::uuid") {
				t.Errorf("%s: an UPDATE is not scoped to a live session:\n%s", c.fn, head)
			}
			if strings.Contains(head, "'ended'") {
				t.Errorf("%s: an ended broadcast must never be selected for recovery", c.fn)
			}
		}
	}
}

// One rejoin must not start two transcoders.
func TestEgressRestartIsSingleFlightAndScoped(t *testing.T) {
	b := recoveryFunc(t, "golive_webhook.go", "goliveRestartEgress")

	// The claim and the lookup are the same statement — that is what makes a
	// duplicate webhook find nothing rather than race.
	if !strings.Contains(b, "SET egress_id = 'restarting'") {
		t.Error("the restart must claim the row, or concurrent webhooks start two egresses")
	}
	if !strings.Contains(b, "egress_id IS NULL") {
		t.Error("only a session with NO transcoder may be restarted")
	}
	if !strings.Contains(b, "RETURNING id::text") {
		t.Error("claim and lookup must be one statement")
	}
	// A failed start must release the claim, or the session is stranded with a
	// sentinel it can never clear.
	if !strings.Contains(b, "egress_id = 'restarting'`, bid)") && !strings.Contains(b, "AND egress_id = 'restarting'") {
		t.Error("a failed restart must release the 'restarting' claim")
	}
	if !strings.Contains(b, "livekit.StartHLS(") {
		t.Error("must reuse the existing StartHLS, not a second egress path")
	}
	// Identity is preserved: the restart reuses the room and broadcast id it
	// found, so the viewer's PlaybackURL (derived from the id) does not move.
	if !strings.Contains(b, "StartHLS(ctx, gocfg.Config, room, bid)") {
		t.Error("the restart must reuse the SAME room and broadcast id")
	}
	if !strings.Contains(b, "gocfg.Usable()") {
		t.Error("must check the Go Live project is configured before calling it")
	}
}

// Restart fires only on a rejoin, never on a leave.
func TestRestartOnlyOnRejoin(t *testing.T) {
	b := recoveryFunc(t, "golive_webhook.go", "goliveHostPresence")
	i := strings.Index(b, "goliveRestartEgress(")
	if i < 0 {
		t.Fatal("presence handler never attempts a restart")
	}
	// Walk back to the nearest guard; it must be the joined branch.
	head := b[:i]
	if j := strings.LastIndex(head, "if joined {"); j < 0 {
		t.Error("the restart is not guarded by `if joined` — it would fire when the host LEAVES")
	}
}
