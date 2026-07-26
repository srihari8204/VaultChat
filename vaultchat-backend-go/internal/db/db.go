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

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func Connect(ctx context.Context) error {
	dsn := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?pool_max_conns=%s",
		env("DB_USER", "vaultchat_user"), env("DB_PASS", ""),
		env("DB_HOST", "127.0.0.1"), env("DB_PORT", "5432"),
		env("DB_NAME", "vaultchat"), env("DB_POOL_MAX", "30"))
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
