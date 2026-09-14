// tools/dbsetup — provision the DISPOSABLE test database on port 15499.
//
// TEMPORARY TEST INFRASTRUCTURE. Not part of the application. It exists because
// this machine has no psql binary and Docker Desktop will not start, while a
// bare Postgres cluster is already listening on 15499 — the port
// internal/routes/auth_onboarding_flow_test.go designates for scratch use and
// warns must never be confused with 15432, the production tunnel.
//
// SAFETY: refuses to run against any port other than 15499, and refuses any
// database name that is not the scratch name passed in. It creates a database
// and applies migrations; it never drops one.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

func main() {
	host := env("DB_HOST", "127.0.0.1")
	port := env("DB_PORT", "")
	user := env("DB_USER", "vaultchat")
	pass := env("DB_PASS", "")
	name := env("DB_NAME", "vaultchat")
	migDir := env("MIGRATIONS", "")

	// Hard refusal. 15432 is an SSH tunnel to production Postgres and this tool
	// writes; there is no argument that should ever point it there.
	if port != "15499" {
		fatal("refusing to run against port %q — this tool is only for the scratch cluster on 15499", port)
	}
	if migDir == "" {
		fatal("set MIGRATIONS to the migrations directory")
	}

	ctx := context.Background()
	admin := fmt.Sprintf("postgres://%s:%s@%s:%s/postgres?sslmode=disable", user, pass, host, port)
	c, err := pgx.Connect(ctx, admin)
	if err != nil {
		fatal("connect to the postgres database: %v", err)
	}
	var exists bool
	if err := c.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&exists); err != nil {
		fatal("probe for %s: %v", name, err)
	}
	if !exists {
		// Identifier, so it cannot be parameterised; the name is restricted
		// rather than escaped.
		for _, r := range name {
			if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyz0123456789_", r) {
				fatal("refusing to create a database with the name %q", name)
			}
		}
		if _, err := c.Exec(ctx, "CREATE DATABASE "+name); err != nil {
			fatal("create database %s: %v", name, err)
		}
		fmt.Printf("created database %s\n", name)
	} else {
		fmt.Printf("database %s already exists\n", name)
	}
	_ = c.Close(ctx)

	dsn := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable", user, pass, host, port, name)
	d, err := pgx.Connect(ctx, dsn)
	if err != nil {
		fatal("connect to %s: %v", name, err)
	}
	defer d.Close(ctx)

	files, err := filepath.Glob(filepath.Join(migDir, "*.sql"))
	if err != nil || len(files) == 0 {
		fatal("no migrations found in %s (%v)", migDir, err)
	}
	sort.Strings(files)

	applied, failed := 0, 0
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			fatal("read %s: %v", f, err)
		}
		// Simple protocol: each file is sent whole, as psql would. A migration
		// that fails is REPORTED and skipped rather than aborting the run — the
		// set spans years and some later files depend on roles or extensions a
		// bare cluster does not have, and one such gap must not block every
		// table the concurrency tests need.
		if _, err := d.Exec(ctx, string(b)); err != nil {
			failed++
			msg := err.Error()
			if len(msg) > 140 {
				msg = msg[:140]
			}
			fmt.Printf("  SKIP %-34s %s\n", filepath.Base(f), msg)
			continue
		}
		applied++
	}
	fmt.Printf("\nmigrations: %d applied, %d skipped, %d total\n", applied, failed, len(files))

	var tables int
	if err := d.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`).Scan(&tables); err == nil {
		fmt.Printf("public tables now present: %d\n", tables)
	}
	for _, t := range []string{"users", "chats", "chat_members", "messages"} {
		var ok bool
		_ = d.QueryRow(ctx, `SELECT to_regclass('public.'||$1) IS NOT NULL`, t).Scan(&ok)
		fmt.Printf("  %-14s %v\n", t, ok)
	}
	var fn bool
	_ = d.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname='vc_bump_unread')`).Scan(&fn)
	fmt.Printf("  %-14s %v\n", "vc_bump_unread", fn)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func fatal(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "dbsetup: "+f+"\n", a...)
	os.Exit(1)
}
