// partitions.go — hourly partition management for message_bodies.
//
// SCOPE OF THIS FILE, DELIBERATELY NARROW
// ---------------------------------------
// It CREATES partitions ahead of time. It does not drop any.
//
// Dropping is irreversible, and the rollout gates it behind the sender-outbox
// work (a recipient offline past the window currently has no recovery path, so
// dropping today would be silent data loss). Writing the drop path here now
// would mean landing irreversible code that nobody exercises until much later —
// so it lands with its own tests, at its own step, and this file stays the
// half that can only ever add.
//
// Creation still matters on its own: a missing partition makes the INSERT fail,
// and that INSERT is inside the message-send transaction. A send must never 500
// because a maintenance job was late, which is why there are two independent
// guarantees below (a wide look-ahead, and on-demand creation in the writer).
package jobs

import (
	"context"
	"log"
	"os"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/metrics"
)

// How far ahead to keep partitions. 48h means the worker can be dead for two
// full days before a send is at risk — far longer than any deploy or restart,
// and the partitions are empty until written to, so the slack is nearly free.
const partitionAheadHours = 48

// One hour behind as well: a message committing right on the hour boundary can
// carry a created_at in the previous hour.
const partitionBehindHours = 1

// Advisory-lock key for partition maintenance. Arbitrary but FIXED — every
// replica must contend on the same number for the lock to mean anything.
const partitionLockKey int64 = 0x564D42_50 // "VMB_P"

const partitionInterval = 15 * time.Minute

func partitionsEnabled() bool { return os.Getenv("MESSAGE_BODY_PARTITIONS") != "0" }

// bodyStoreEnabled mirrors routes.bodiesEnabled().
//
// Duplicated rather than exported across packages because internal/routes
// already imports internal/jobs (for BodyExpiresAt), so reaching back the other
// way would be an import cycle. One env var, read in two places, is the cheaper
// of the two problems — and it is the flag that must gate media retention too:
// the media key lives inside the message body, so blob lifetime and body
// lifetime have to switch over together or the key expires while the blob it
// unlocks lingers.
func bodyStoreEnabled() bool { return os.Getenv("MESSAGE_BODIES") == "1" }

// StartPartitionMaintenance keeps the message_bodies partition window ahead of
// the clock. Fires once at boot, then on a ticker, like the other jobs.
func StartPartitionMaintenance(ctx context.Context) {
	if !partitionsEnabled() {
		log.Println("[partitions] disabled (MESSAGE_BODY_PARTITIONS=0)")
		return
	}
	go func() {
		EnsurePartitionWindow(ctx)
		t := time.NewTicker(partitionInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				EnsurePartitionWindow(ctx)
			}
		}
	}()
	log.Printf("[partitions] maintenance every %s (+%dh ahead)", partitionInterval, partitionAheadHours)
}

// EnsurePartitionWindow creates every hourly partition from `partitionBehindHours`
// back to `partitionAheadHours` forward. Idempotent: the SQL helper is
// CREATE TABLE IF NOT EXISTS, so a full re-run is a no-op and a partially
// completed run simply finishes next tick.
//
// TRANSACTION-SCOPED advisory lock, not a session one. go-api reaches Postgres
// through PgBouncer in transaction pooling mode, where a session-level
// pg_advisory_lock would be left held on a server connection that has already
// been handed to someone else — the classic way to wedge a pool. The xact
// variant is released by COMMIT, which is the only thing that is true in both
// pooled and direct configurations.
func EnsurePartitionWindow(ctx context.Context) {
	tx, err := db.SysPool.Begin(ctx)
	if err != nil {
		metrics.Inc("partition_operation_failures_total")
		log.Printf("[partitions] begin: %v", err)
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var got bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, partitionLockKey).Scan(&got); err != nil {
		metrics.Inc("partition_operation_failures_total")
		log.Printf("[partitions] lock: %v", err)
		return
	}
	if !got {
		// Another replica is already doing exactly this work. Not an error, and
		// deliberately not retried — the next tick is 15 minutes away and the
		// window is 48 hours wide.
		return
	}

	created := 0
	for h := -partitionBehindHours; h <= partitionAheadHours; h++ {
		at := time.Now().UTC().Add(time.Duration(h) * time.Hour)
		var name string
		if err := tx.QueryRow(ctx,
			`SELECT vc_message_bodies_ensure_partition($1)`, at).Scan(&name); err != nil {
			metrics.Inc("partition_operation_failures_total")
			log.Printf("[partitions] ensure %s: %v", at.Format("2006010215"), err)
			return // leave the rest for the next tick rather than half-committing
		}
		created++
	}

	if err := tx.Commit(ctx); err != nil {
		metrics.Inc("partition_operation_failures_total")
		log.Printf("[partitions] commit: %v", err)
		return
	}
	metrics.Add("partition_create_total", uint64(created))
}

// EnsurePartitionFor creates the single partition covering ts, on demand.
//
// The backstop for the writer. The window above is wide enough that this should
// never fire, but "should never" is not a guarantee a message send can rest on:
// if the maintenance job has been failing unnoticed, every send would 500 with a
// no-partition-found error, and the user-visible symptom would be that
// messaging is down. One extra round trip on a path that is already failing is
// a good trade for that not happening.
//
// Uses its own short transaction so it can be called from a failed send's
// retry without inheriting that transaction's state.
func EnsurePartitionFor(ctx context.Context, ts time.Time) error {
	var name string
	err := db.SysPool.QueryRow(ctx, `SELECT vc_message_bodies_ensure_partition($1)`, ts).Scan(&name)
	if err != nil {
		metrics.Inc("partition_operation_failures_total")
		return err
	}
	metrics.Inc("partition_create_total")
	log.Printf("[partitions] on-demand create %s", name)
	return nil
}

// DropExpiredPartitions reclaims partitions whose window has fully passed.
//
// ELIGIBILITY, AND WHY IT IS NOT "OLDER THAN THREE HOURS"
// ------------------------------------------------------
// A partition covers [H, H+1). Bodies inside it were created across that whole
// hour, so the LAST one to expire does so at H+1h+TTL. Dropping at H+TTL would
// therefore destroy bodies that are still inside their retention window — the
// one thing this must never do (§21). The floor is H+1h+TTL, plus a safety
// margin so a clock skew between replicas cannot shave it.
//
// The partition is ALSO required to be empty. It nearly always is by then:
// sweepExpiredBodies deletes to the second and ACK deletion usually got there
// first, so this reclaims space from an already-drained table rather than
// racing the sweep for the rows. Requiring both conditions means the drop can
// never be the thing that removes a live body — deletion is always a DELETE
// that respected the deadline, and the drop only takes the empty shell.
//
// Non-empty aged partitions are logged rather than forced, because a partition
// that is past its window and still holding rows means the expiry sweep has
// stopped — a condition to alert on, not to paper over by dropping data.
func DropExpiredPartitions(ctx context.Context) {
	if !partitionsEnabled() {
		return
	}
	// H + 1h (partition span) + TTL + 15m margin.
	cutoff := time.Now().UTC().Add(-(time.Hour + bodyTTL() + 15*time.Minute))

	tx, err := db.SysPool.Begin(ctx)
	if err != nil {
		metrics.Inc("partition_operation_failures_total")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var got bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, partitionLockKey).Scan(&got); err != nil || !got {
		// Held by another replica, or unreadable. Either way this tick does
		// nothing — a missed drop costs disk, never correctness.
		return
	}

	// Ask the catalog which partitions exist and what range each covers, rather
	// than reconstructing names from the clock. Parsing the real bound is what
	// makes this safe against a partition created by an older or newer version
	// of the naming scheme.
	rows, err := tx.Query(ctx,
		`SELECT c.relname,
		        (regexp_match(pg_get_expr(c.relpartbound, c.oid),
		                      'TO \(''([^'']+)''\)'))[1]::timestamptz AS upper_bound
		   FROM pg_class c
		   JOIN pg_inherits i ON i.inhrelid = c.oid
		  WHERE i.inhparent = 'public.message_bodies'::regclass`)
	if err != nil {
		metrics.Inc("partition_operation_failures_total")
		log.Printf("[partitions] list: %v", err)
		return
	}
	type part struct {
		name  string
		upper time.Time
	}
	var candidates []part
	for rows.Next() {
		var p part
		if rows.Scan(&p.name, &p.upper) == nil && p.upper.Before(cutoff) {
			candidates = append(candidates, p)
		}
	}
	rows.Close()

	dropped, stuck := 0, 0
	for _, p := range candidates {
		var empty bool
		if err := tx.QueryRow(ctx,
			`SELECT NOT EXISTS (SELECT 1 FROM `+pgQuoteIdent(p.name)+` LIMIT 1)`).Scan(&empty); err != nil {
			metrics.Inc("partition_operation_failures_total")
			log.Printf("[partitions] probe %s: %v", p.name, err)
			return
		}
		if !empty {
			// Past its window AND still holding rows: the expiry sweep is not
			// keeping up, or has been failing. Say so loudly; do not drop.
			stuck++
			log.Printf("[partitions] %s is past its window but NOT EMPTY — expiry sweep may be failing; not dropping", p.name)
			continue
		}
		if _, err := tx.Exec(ctx, `DROP TABLE IF EXISTS `+pgQuoteIdent(p.name)); err != nil {
			metrics.Inc("partition_operation_failures_total")
			log.Printf("[partitions] drop %s: %v", p.name, err)
			return
		}
		dropped++
	}

	if err := tx.Commit(ctx); err != nil {
		metrics.Inc("partition_operation_failures_total")
		log.Printf("[partitions] commit: %v", err)
		return
	}
	if dropped > 0 {
		metrics.Add("partition_drop_total", uint64(dropped))
		log.Printf("[partitions] dropped %d empty expired partition(s)", dropped)
	}
	if stuck > 0 {
		metrics.Add("partition_drop_blocked_total", uint64(stuck))
	}
}

// pgQuoteIdent double-quotes an identifier for interpolation into DDL.
//
// Partition names come from our own catalog query, not from user input, so this
// is belt-and-braces rather than the primary control — but DROP TABLE with a
// string-built name is exactly the shape that becomes a real hole the day
// someone makes the name configurable.
func pgQuoteIdent(s string) string {
	out := make([]byte, 0, len(s)+2)
	out = append(out, '"')
	for i := 0; i < len(s); i++ {
		if s[i] == '"' {
			out = append(out, '"')
		}
		out = append(out, s[i])
	}
	return string(append(out, '"'))
}

// PartitionCount reports how many message_bodies partitions currently exist, so
// the growth the retention step is meant to bound is observable BEFORE that step
// lands. A number that climbs without limit here is the early warning that
// partitions are being created and never reclaimed.
func PartitionCount(ctx context.Context) int {
	var n int
	if err := db.SysPool.QueryRow(ctx,
		`SELECT count(*)::int FROM pg_inherits
		  WHERE inhparent = 'public.message_bodies'::regclass`).Scan(&n); err != nil {
		return -1
	}
	return n
}

// RegisterPartitionGauge exposes the partition count to /internal/metrics.
// Sampled at scrape time like the other gauges, with a short cache so a busy
// scrape interval cannot turn a dashboard into a catalog query per second.
func RegisterPartitionGauge() {
	var (
		last  time.Time
		cache float64
	)
	metrics.SetGauge("message_body_partitions", func() float64 {
		if time.Since(last) < 30*time.Second {
			return cache
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cache = float64(PartitionCount(ctx))
		last = time.Now()
		return cache
	})
}

// bodyTTL is the server-side lifetime of a message body.
//
// The database enforces the 3-hour CEILING (message_bodies_ttl_cap), so this
// can only ever be equal to or shorter than the hard guarantee — a
// misconfiguration here cannot extend retention, only shorten it. That
// asymmetry is the point: the guarantee lives in the schema, the knob lives
// here.
func bodyTTL() time.Duration {
	if v, ok := httpx.ParseIntPrefix(os.Getenv("MESSAGE_BODY_TTL_SECONDS")); ok && v > 0 {
		d := time.Duration(v) * time.Second
		if d < 3*time.Hour {
			return d
		}
	}
	return 3 * time.Hour
}

// BodyExpiresAt is the single place the body deadline is computed. Takes the
// message's SERVER-generated created_at — never a client timestamp, and never
// time.Now() at some later point, so a retry, an edit, a reconnect or a resend
// all resolve to the same deadline as the original insert.
func BodyExpiresAt(createdAt time.Time) time.Time { return createdAt.Add(bodyTTL()) }
