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

// SysPool is the pool for queries that do NOT belong to any one user.
//
// WHY THIS EXISTS
// ---------------
// RLS is written against `app.current_user_id`, so every policy asks "what may
// THIS user see". Some queries have no such user and never will:
//
//	retention sweeps        (internal/jobs)      — no actor, by definition
//	presence fan-out        (internal/realtime)  — computes who to NOTIFY, which
//	                                               is deliberately other people's
//	                                               memberships, not the actor's
//	invite-link lookup      (routes/chats.go)    — resolves a chat the caller is
//	                                               NOT yet a member of; that is
//	                                               the entire point of an invite
//	cross-user story access (routes/uploads.go)  — reads another user's story
//
// Those are not oversights to be converted to WithUser; binding a user would
// make them return the wrong answer, or nothing at all. 004_rls.sql anticipated
// exactly this and solved it once with a SECURITY DEFINER helper
// (vc_chat_member_ids), but the pattern was never extended to the rest.
//
// So system queries get an explicit, greppable identity instead of quietly
// sharing the user pool. Marking a query `SysPool` is a claim — "this is
// server-internal and must see all rows" — that a reviewer can check, which is
// the thing `db.Pool` at 280 call sites cannot offer.
//
// FALLBACK IS THE DEFAULT, AND DELIBERATE
// ---------------------------------------
// With no DB_SYSTEM_USER configured, SysPool IS Pool. Nothing changes: same
// role, same connections, same behaviour, byte for byte. That is what makes
// this safe to land before anyone has provisioned anything.
//
// It only becomes meaningful when BOTH steps are taken (see
// docs/RLS_ENFORCEMENT.md):
//  1. a DB role with BYPASSRLS exists and DB_SYSTEM_USER/DB_SYSTEM_PASS point
//     at it, and
//  2. migration 068 sets FORCE ROW LEVEL SECURITY on the policy-bearing tables.
//
// Until then this is documentation that compiles.
var SysPool *pgxpool.Pool

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
	if err := Pool.Ping(pingCtx); err != nil {
		return err
	}
	return connectSystem(ctx)
}

// connectSystem opens the SysPool. Absent DB_SYSTEM_USER it aliases Pool, so
// this is a no-op on every deployment that has not opted in.
//
// A failure here is FATAL rather than a silent fallback, and that is the point:
// if an operator configured a system role, they did it because RLS is (or is
// about to be) enforced. Quietly demoting to the user role would leave every
// sweep and fan-out reading zero rows — a backend that boots, serves, and is
// wrong. Refusing to start is the honest failure.
func connectSystem(ctx context.Context) error {
	user := env("DB_SYSTEM_USER", "")
	if user == "" {
		SysPool = Pool
		return nil
	}
	dsn := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?pool_max_conns=%s&default_query_exec_mode=%s",
		user, env("DB_SYSTEM_PASS", ""),
		env("DB_HOST", "127.0.0.1"), env("DB_PORT", "5432"),
		env("DB_NAME", "vaultchat"),
		// Smaller by default: system work is sweeps and fan-out, not request
		// traffic, and it should not be able to starve the user pool.
		env("DB_SYSTEM_POOL_MAX", "8"),
		env("DB_QUERY_EXEC_MODE", "exec"))
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return fmt.Errorf("system pool config: %w", err)
	}
	cfg.MaxConnIdleTime = 30 * time.Second
	SysPool, err = pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("system pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := SysPool.Ping(pingCtx); err != nil {
		return fmt.Errorf("system pool ping: %w", err)
	}
	return nil
}
