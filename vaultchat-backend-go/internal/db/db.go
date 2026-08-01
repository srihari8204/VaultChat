// Package db — shared pgx pool against the SAME Postgres as the Node backend.
// Env names identical to Node's db.js (DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASS).
package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var Pool *pgxpool.Pool

// NoRows reports whether err is pgx's no-result sentinel. Routes must map it
// (and ONLY it) to Node's 404s — any other DB error stays a 500, so an outage
// never masquerades as "not found" and makes clients purge local state.
func NoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// WithUser mirrors Node db.withUser: a transaction with app.current_user_id
// set so the RLS policies (004_rls.sql) see the caller.
//
// P2.3: set_config($1, $2, true) replaces the old string-interpolated
// `SET LOCAL` — it takes real bind parameters (no quote-escaping, no
// SQLi-shaped string build) and is transaction-scoped (is_local=true), which
// is exactly what PgBouncer transaction pooling requires: the setting dies
// with the txn, so the pooled server connection is never left tainted.
func WithUser(ctx context.Context, userID string, fn func(pgx.Tx) error) error {
	if userID == "" {
		return errors.New("withUser requires a userId")
	}
	tx, err := Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck — no-op after Commit
	if _, err := tx.Exec(ctx, "SELECT set_config('app.current_user_id', $1, true)", userID); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func Connect(ctx context.Context) error {
	// P2.3: default_query_exec_mode=exec avoids named prepared statements,
	// which PgBouncer transaction pooling cannot track across server
	// connections. Direct-to-Postgres deploys may set
	// DB_QUERY_EXEC_MODE=cache_statement to restore pgx statement caching.
	dsn := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?pool_max_conns=%s&default_query_exec_mode=%s",
		env("DB_USER", "vaultchat_user"), env("DB_PASS", ""),
		env("DB_HOST", "127.0.0.1"), env("DB_PORT", "5432"),
		env("DB_NAME", "vaultchat"), env("DB_POOL_MAX", "30"),
		env("DB_QUERY_EXEC_MODE", "exec"))
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return err
	}
	cfg.MaxConnIdleTime = 30 * time.Second
	Pool, err = pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return err
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return Pool.Ping(pingCtx)
}
