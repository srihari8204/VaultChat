package jobs

import (
	"context"
	"hash/fnv"
	"log"

	"github.com/jackc/pgx/v5/pgxpool"

	"vaultchat/backend-go/internal/db"
)

// RunLocked runs one tick of the named background job only if no other copy
// of the service is running that job right now (openspec:
// microservices-prepare, "Every job runs once").
//
// The lock is a TRANSACTION-SCOPED advisory lock held in a transaction that
// stays open for the whole run, for the same reason as EnsurePartitionWindow:
// behind PgBouncer's transaction pooling a session lock would be left on a
// server connection already handed to someone else. fn does its own queries
// on the pool exactly as before; only the lock lives in the held transaction,
// and ending it releases the lock even if fn panics or the process dies.
//
// A copy that does not get the lock skips the tick. That is not an error: the
// job is already running, and the next tick comes round anyway.
//
// The lock is taken on db.Pool, NOT db.SysPool, because the jobs themselves
// work on SysPool. When DB_SYSTEM_USER splits the pools, SysPool is 8
// connections: a dozen jobs ticking together would each hold one for its lock
// and then wait forever for another to do the work. On separate pools that
// cannot happen. On the default shared pool of 30 it cannot either: there are
// at most seventeen jobs, so lock holders never fill the pool, and a job
// waiting for a work connection is only waiting for requests to finish.
func RunLocked(ctx context.Context, name string, fn func(context.Context)) {
	runLocked(ctx, db.Pool, name, fn)
}

func runLocked(ctx context.Context, pool *pgxpool.Pool, name string, fn func(context.Context)) bool {
	tx, err := pool.Begin(ctx)
	if err != nil {
		log.Printf("[jobs] %s: lock begin: %v", name, err)
		return false
	}
	defer tx.Rollback(ctx) //nolint:errcheck — releases the lock; nothing was written

	var got bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, JobLockKey(name)).Scan(&got); err != nil {
		log.Printf("[jobs] %s: lock: %v", name, err)
		return false
	}
	if !got {
		return false
	}
	fn(ctx)
	return true
}

// JobLockKey is the advisory-lock key for a job: 64-bit FNV-1a of
// "vc:job:<name>", so the job's name stays the only thing to keep unique.
func JobLockKey(name string) int64 {
	h := fnv.New64a()
	h.Write([]byte("vc:job:" + name))
	return int64(h.Sum64())
}
