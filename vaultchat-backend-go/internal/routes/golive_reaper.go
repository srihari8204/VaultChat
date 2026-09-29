// golive_reaper.go — end a broadcast whose host never came back.
//
// WHAT THIS IS FOR, AND WHAT IT IS NOT
// ------------------------------------
// broadcast_reaper.go is the LOCKOUT safety net: it closes rows so stale ones
// cannot hold the one-active-per-host unique index forever. Its 'live' threshold
// is twelve hours precisely because it has no way to tell a quiet-but-real
// broadcast from a dead one, and cutting off a real stream would be worse than
// the bug it fixes.
//
// This sweep has that missing signal. golive_webhook.go records host_left_at
// when the HOST leaves the room and clears it when they return, so "the host is
// gone" is a fact here rather than a guess — which is what makes a 90-second
// verdict safe where a 12-hour one was the most that could be justified.
//
// The two do not conflict: this closes host-abandoned sessions in seconds, the
// other still backstops everything else. broadcast_reaper.go is untouched.
//
// WHY A SWEEP AND NOT A TIMER
// ---------------------------
// A goroutine holding a 90-second deadline dies with the process. The scenario
// this exists for — a host whose app was killed — is exactly the scenario that
// coincides with a deploy or a crash, so the mechanism must survive one. A
// timestamp in the row plus a poll does; nothing is lost to a restart beyond one
// tick of latency.
package routes

import (
	"context"
	"os"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/golive"
	"vaultchat/backend-go/internal/jobs"
	"vaultchat/backend-go/internal/livekit"
)

// Ticks fast because the grace period is short: a poll far longer than the
// deadline it enforces turns "90 seconds" into "up to 90 seconds plus the poll".
// One partial-index UPDATE that matches nothing on a healthy system
// (broadcast_sessions_host_gone_idx, migration 105).
const goliveHostSweepInterval = 20 * time.Second

// The grace period. Long enough to cover the reconnect cases that actually
// happen — a tunnel, a Wi-Fi→cellular handover, an app briefly backgrounded —
// and short enough that a viewer is not left staring at a frozen stream.
const defaultHostGrace = 90 * time.Second

func hostGrace() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("GOLIVE_HOST_GRACE")); err == nil && d > 0 {
		return d
	}
	return defaultHostGrace
}

// StartGoLiveHostSweep launches the grace-period sweep.
//
// GOLIVE_HOST_REAPER=off disables it, matching BROADCAST_REAPER and
// SHOPBOOK_JOBS. The switch exists so a bad grace value can be neutralised
// without a rollback — an over-eager sweep here would end live broadcasts, which
// is the one failure mode worth an escape hatch.
func StartGoLiveHostSweep(ctx context.Context) {
	if os.Getenv("GOLIVE_HOST_REAPER") == "off" {
		goliveLog("HOST_SWEEP_DISABLED", "", "", "", "reason=GOLIVE_HOST_REAPER=off")
		return
	}
	go func() {
		t := time.NewTicker(goliveHostSweepInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				jobs.RunLocked(ctx, "golive-host-sweep", goliveSweepAbandoned)
			}
		}
	}()
	goliveLog("HOST_SWEEP_STARTED", "", "", "",
		"grace="+hostGrace().String(), "interval="+goliveHostSweepInterval.String())
}

// goliveSweepAbandoned ends broadcasts whose host left and stayed gone.
func goliveSweepAbandoned(ctx context.Context) {
	// ended, not failed: the stream really did happen, the host just did not
	// close it. 'failed' is what the webhook records when egress reports a fault,
	// and conflating the two makes the history lie about how often broadcasting
	// breaks.
	//
	// SysPool: there is no acting user, and the whole point is to repair rows
	// whose owner is unreachable.
	rows, err := db.SysPool.Query(ctx, `
		UPDATE broadcast_sessions
		   SET status = 'ended', ended_at = now()
		 WHERE status IN ('starting', 'live')
		   AND host_left_at IS NOT NULL
		   AND host_left_at < now() - $1::interval
		RETURNING id::text, host_id::text, room, COALESCE(egress_id, '')`,
		hostGrace().String())
	if err != nil {
		goliveLog("HOST_SWEEP_FAILED", "", "", "", "error="+err.Error())
		goliveMetric("host_sweep_failed")
		return
	}
	defer rows.Close()

	type gone struct{ id, host, room, egress string }
	var all []gone
	for rows.Next() {
		var g gone
		if rows.Scan(&g.id, &g.host, &g.room, &g.egress) == nil {
			all = append(all, g)
		}
	}
	rows.Close()
	if len(all) == 0 {
		return // the healthy case, and the common one
	}

	cfg := golive.ConfigFromEnv()
	for _, g := range all {
		goliveLog("BROADCAST_ENDED_HOST_GONE", g.id, g.room, g.host, "grace="+hostGrace().String())
		goliveMetric("ended_host_gone")

		// Stop the transcoder. Without this an abandoned broadcast keeps headless
		// Chrome and ffmpeg running and writing segments — the most expensive
		// leak in the stack, and the reason a grace period beats waiting twelve
		// hours. Best-effort and after the row is closed, same as broadcastEnd.
		//
		// The GO LIVE project: this egress id belongs to that cluster and the
		// calling one has never heard of it.
		if g.egress != "" && cfg.Usable() {
			if e := livekit.StopHLS(ctx, cfg.Config, g.egress); e != nil {
				goliveLog("EGRESS_STOP_FAILED", g.id, g.room, g.host, "egress_id="+g.egress, "error="+e.Error())
				goliveMetric("egress_stop_failed")
			}
		}
	}
}
