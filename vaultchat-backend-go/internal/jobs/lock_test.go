package jobs

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestJobLockKey(t *testing.T) {
	if JobLockKey("media-retention") != JobLockKey("media-retention") {
		t.Fatal("key must be stable")
	}
	if JobLockKey("media-retention") == JobLockKey("broadcast-retention") {
		t.Fatal("different jobs must get different keys")
	}
	if JobLockKey("x") == partitionLockKey {
		t.Fatal("job keys must not collide with the partition lock")
	}
}

// Two copies ticking together: the one that finds the lock held skips.
// Needs a real Postgres (TEST_PG_URL), like the other DB-backed job tests.
func TestRunLockedSkipsWhileHeld(t *testing.T) {
	url := os.Getenv("TEST_PG_URL")
	if url == "" {
		t.Skip("TEST_PG_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	ranInner := false
	ranOuter := runLocked(ctx, pool, "lock-test", func(ctx context.Context) {
		// A second copy tries the same job while the first is still running.
		if runLocked(ctx, pool, "lock-test", func(context.Context) { ranInner = true }) {
			t.Error("second copy got the lock while the first held it")
		}
		// A different job is not blocked.
		if !runLocked(ctx, pool, "lock-test-other", func(context.Context) {}) {
			t.Error("a different job must not share the lock")
		}
	})
	if !ranOuter || ranInner {
		t.Fatalf("outer ran=%v inner ran=%v, want true/false", ranOuter, ranInner)
	}
	// Released at the end of the run: the next tick gets it.
	if !runLocked(ctx, pool, "lock-test", func(context.Context) {}) {
		t.Fatal("lock not released after the run")
	}
}
