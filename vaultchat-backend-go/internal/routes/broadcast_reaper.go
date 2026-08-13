// broadcast_reaper.go — close broadcasts whose egress died without saying so.
//
// WHY THIS EXISTS
// ---------------
// A broadcast leaves 'starting' only when the LiveKit webhook reports
// EGRESS_ACTIVE, and leaves 'live' only on egress_ended / egress_failed
// (broadcast_webhook.go). Every transition depends on a webhook ARRIVING. If the
// egress container dies, is restarted, or the webhook is simply lost, no
// terminal event is ever delivered and the row stays non-terminal forever.
//
// That is not cosmetic, and it is worse than "a stale row in a table". This
// index exists on broadcast_sessions:
//
//	CREATE UNIQUE INDEX broadcast_one_active_per_host
//	    ON broadcast_sessions (host_id)
//	    WHERE status IN ('starting', 'live')
//
// One non-terminal row per host, enforced by the database. So a wedged row does
// not merely look untidy — it makes every future "go live" for that host fail
// the unique constraint, PERMANENTLY. The host is locked out of broadcasting and
// nothing in the system ever repairs it.
//
// Observed in production: host a31fa0b6 had a row stuck in 'starting' from
// 2026-08-11 17:53 with an egress_id that never produced a terminal webhook.
// That account could not have started another broadcast at any point since.
//
// WHY AGE, AND NOT A LIVEKIT QUERY
// --------------------------------
// The authoritative answer is "ask LiveKit whether this egress still exists",
// but internal/livekit exposes StartHLS and StopHLS only — no ListEgress. Adding
// that twirp call means new, untested request plumbing on a path whose whole job
// is to be a safety net, and it could not be verified here without a live
// broadcast. An age threshold needs no new external contract and fails in the
// safe direction, so that is what this uses. If ListEgress is added later, this
// is the one place that would consult it.
//
// TWO THRESHOLDS, DELIBERATELY VERY DIFFERENT
// -------------------------------------------
// 'starting' is unambiguous: egress was requested and never reported itself
// active. Normal activation takes seconds, so anything still 'starting' after a
// few minutes is dead. This is the case that actually bit us.
//
// 'live' is NOT unambiguous. A host with no viewers is still legitimately
// broadcasting, and there is no "host is still publishing" signal in the
// database to distinguish that from a missed terminal webhook. Reaping 'live' on
// a short timer would cut off real broadcasts — a far worse failure than the one
// being fixed. So its ceiling is set beyond any plausible real session and acts
// purely as a backstop against the same lockout.
package routes

import (
	"context"
	"log"
	"os"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/livekit"
	"vaultchat/backend-go/internal/metrics"
)

// How often the sweep runs. Frequent enough that a lockout lasts minutes rather
// than days, cheap enough to be irrelevant: it is one indexed UPDATE that
// matches nothing on a healthy system.
const broadcastReapInterval = 5 * time.Minute

// Defaults for the two thresholds. Both are overridable, because the right
// answer depends on how long egress takes to start under real load.
const (
	defaultStartingStaleMinutes = 15
	defaultLiveStaleHours       = 12
)

func reapStartingAfter() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("BROADCAST_STARTING_STALE")); err == nil && d > 0 {
		return d
	}
	return defaultStartingStaleMinutes * time.Minute
}

func reapLiveAfter() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("BROADCAST_LIVE_STALE")); err == nil && d > 0 {
		return d
	}
	return defaultLiveStaleHours * time.Hour
}

// StartBroadcastReaper launches the sweep.
//
// BROADCAST_REAPER=off disables it, matching the SHOPBOOK_JOBS convention. The
// switch exists so that a bad threshold can be neutralised without a rollback.
func StartBroadcastReaper(ctx context.Context) {
	if os.Getenv("BROADCAST_REAPER") == "off" {
		log.Println("[broadcast-reaper] disabled via BROADCAST_REAPER=off")
		return
	}
	go func() {
		t := time.NewTicker(broadcastReapInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				reapStuckBroadcasts(ctx)
			}
		}
	}()
	log.Printf("[broadcast-reaper] started — starting>%s, live>%s, every %s",
		reapStartingAfter(), reapLiveAfter(), broadcastReapInterval)
}

// reapStuckBroadcasts closes non-terminal sessions that can no longer be alive.
//
// SysPool, like the webhook: there is no acting user, and the whole point is to
// repair rows whose owner cannot reach them.
func reapStuckBroadcasts(ctx context.Context) {
	// One statement for both cases so a session can never be half-reaped, and so
	// the unique index is released in a single transaction.
	//
	// ended_at is stamped now() rather than back-dated to the last known
	// activity: we genuinely do not know when the stream died, and inventing a
	// timestamp would put a false duration into the history. status='ended'
	// (not 'failed') because from the host's side it did start — 'failed' is
	// what the webhook records when egress reports a real failure.
	rows, err := db.SysPool.Query(ctx, `
		UPDATE broadcast_sessions
		   SET status = 'ended', ended_at = now()
		 WHERE (status = 'starting' AND started_at < now() - $1::interval)
		    OR (status = 'live'     AND started_at < now() - $2::interval)
		RETURNING id, host_id, status, COALESCE(egress_id, '')`,
		reapStartingAfter().String(), reapLiveAfter().String())
	if err != nil {
		log.Printf("[broadcast-reaper] sweep failed: %v", err)
		metrics.Inc("broadcast_reap_failed")
		return
	}
	defer rows.Close()

	type stuck struct{ id, host, was, egress string }
	var all []stuck
	for rows.Next() {
		var s stuck
		if rows.Scan(&s.id, &s.host, &s.was, &s.egress) == nil {
			all = append(all, s)
		}
	}
	rows.Close()
	if len(all) == 0 {
		return // the healthy case, and the common one
	}

	for _, s := range all {
		// The host was locked out for as long as this row survived, so say so —
		// a silent repair of a user-visible lockout is how the bug stayed
		// invisible for two days in the first place.
		log.Printf("[broadcast-reaper] closed %s (was %s, host %s) — host can broadcast again", s.id, s.was, s.host)
		metrics.Inc("broadcast_reaped")

		// Stop the transcoder if one was ever allocated. Best-effort and after
		// the row is already closed: egress may well be gone (that is usually
		// why we are here), and a failure to stop something that no longer
		// exists must not stop us reaping the rest. Same reasoning, and the
		// same call, as the normal broadcastEnd path.
		if s.egress != "" {
			if e := livekit.StopHLS(ctx, livekit.ConfigFromEnv(), s.egress); e != nil {
				log.Printf("[broadcast-reaper] egress %s did not stop cleanly: %v", s.egress, e)
				metrics.Inc("broadcast_egress_stop_failed")
			}
		}
	}
}
