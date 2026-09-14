// rls.go — the boot-time guard for the RLS cutover. INERT by default.
//
// WHAT IS ALREADY HERE, AND WHAT IS NOT
// -------------------------------------
// The per-transaction half of RLS enforcement exists and has for a long time:
// db.WithUser opens a transaction and runs
// `set_config('app.current_user_id', $1, true)`, which is the SET LOCAL every
// policy in 004_rls.sql reads through vc_current_user_id(). db.SysPool exists
// for the queries that have no acting user.
//
// None of it does anything, because the API connects as `vaultchat` — the
// postgres image's bootstrap SUPERUSER, which also owns every table, because
// migrations run as it. PostgreSQL exempts superusers from row-level security
// unconditionally, and table owners unless the table is FORCE ROW LEVEL
// SECURITY. So the setting is set and never consulted. See
// docs/RLS_ENFORCEMENT.md § Enforcement plan.
//
// The missing half is therefore not code, it is which role the pool connects
// as — DB_USER, an env var. Which makes the dangerous part of this change a
// deployment mistake rather than a programming one, and that is what this file
// guards.
//
// THE MISTAKE IT CATCHES
// ----------------------
// Repointing DB_USER at the restricted role and forgetting DB_SYSTEM_USER.
// SysPool then aliases Pool (see connectSystem), so every retention sweep,
// presence fan-out and invite-link lookup starts reading as a role the policies
// refuse — and a policy that refuses rows does not raise an error, it returns
// nothing. The API boots, serves, reports healthy, and quietly does nothing.
// That is far worse than a crash and much harder to attribute.
//
// The inverse mistake is just as quiet: setting DB_RLS_ENFORCE while DB_USER
// still points at a superuser. Nothing breaks, nothing is enforced, and the
// deployment now carries a flag that says otherwise.
//
// So: opt in with DB_RLS_ENFORCE=1 and the process asserts, once at boot, that
// the two roles really are what the cutover requires — and refuses to start if
// they are not. Unset (the default), this is a no-op and the pool connects
// byte-for-byte as it does today.
package db

import (
	"context"
	"fmt"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
)

// EnforcingRLS reports whether the operator has opted into the cutover checks.
//
// Anything strconv.ParseBool accepts works ("1", "true", "TRUE"). An unset or
// empty value is false — the default, and the only value any current
// deployment has. A value that is set but unparseable is TRUE, deliberately:
// somebody typed DB_RLS_ENFORCE=yes meaning to turn it on, and silently
// treating that as "off" is how a security control gets disabled by a typo.
// The cost of being wrong the other way is a refused boot with a clear message.
func EnforcingRLS() bool {
	v, ok := os.LookupEnv("DB_RLS_ENFORCE")
	if !ok || v == "" {
		return false
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return true
	}
	return b
}

// roleAttrs is one row of pg_roles, for the role a pool is connected as.
type roleAttrs struct {
	Name      string
	Super     bool
	BypassRLS bool
}

// rlsPreconditions is the whole decision, as a pure function of what was
// observed — so the reasoning can be tested on a machine with no Postgres,
// which is the only kind of machine this was written on.
//
// sysDistinct says whether SysPool is a genuinely separate pool. When it is
// false, SysPool IS Pool and `sys` is the same role as `app`.
func rlsPreconditions(app roleAttrs, sys roleAttrs, sysDistinct bool) error {
	// The request-path role must be subject to policies. Either attribute is
	// enough to exempt it from every policy in the database, FORCE or not.
	if app.Super || app.BypassRLS {
		return fmt.Errorf(
			"DB_RLS_ENFORCE is set but DB_USER connects as %q which is %s; "+
				"policies would be bypassed and nothing would be enforced. "+
				"Point DB_USER at vaultchat_app (migration 133)",
			app.Name, privileges(app))
	}

	// Ownership is the other exemption, and the one that looks fine in \du.
	// It is not checked here because it is per-table and therefore a question
	// for the database, not the process: migration 133 refuses to apply if
	// either role owns a table, and docs/RLS_ENFORCEMENT.md step 0 shows the
	// read-only query. Re-checking 170 tables on every boot buys nothing that
	// a migration-time assertion has not already bought.

	if !sysDistinct {
		return fmt.Errorf(
			"DB_RLS_ENFORCE is set but DB_SYSTEM_USER is not, so system queries "+
				"would run as %q and read zero rows silently — sweeps, presence "+
				"fan-out and invite links would stop working without erroring. "+
				"Set DB_SYSTEM_USER/DB_SYSTEM_PASS to vaultchat_sys",
			app.Name)
	}

	// The system role must be able to see everything, and must not be a
	// superuser doing it. A superuser here would work, and would also mean the
	// blast radius of a leaked system password is the whole cluster.
	if !sys.BypassRLS {
		return fmt.Errorf(
			"DB_RLS_ENFORCE is set but DB_SYSTEM_USER connects as %q which lacks "+
				"BYPASSRLS; every user-less query would read zero rows silently. "+
				"Point DB_SYSTEM_USER at vaultchat_sys (migration 133)",
			sys.Name)
	}
	if sys.Super {
		return fmt.Errorf(
			"DB_SYSTEM_USER connects as %q, a SUPERUSER; use a NOSUPERUSER "+
				"BYPASSRLS role (vaultchat_sys) so a leaked system credential is "+
				"not cluster-wide", sys.Name)
	}
	return nil
}

func privileges(r roleAttrs) string {
	switch {
	case r.Super && r.BypassRLS:
		return "a SUPERUSER with BYPASSRLS"
	case r.Super:
		return "a SUPERUSER"
	default:
		return "a BYPASSRLS role"
	}
}

// CheckRLSPreconditions asserts the cutover invariants against the live
// connections. No-op — not one query — unless DB_RLS_ENFORCE is set.
//
// Call it after Connect. A non-nil error should be fatal: the states it
// describes all produce a server that runs and is wrong, and refusing to start
// is the only failure mode of this change that anybody notices.
func CheckRLSPreconditions(ctx context.Context) error {
	if !EnforcingRLS() {
		return nil
	}
	app, err := readRoleAttrs(ctx, Pool)
	if err != nil {
		return fmt.Errorf("rls precondition (user pool): %w", err)
	}
	sysDistinct := SysPool != Pool
	sys := app
	if sysDistinct {
		if sys, err = readRoleAttrs(ctx, SysPool); err != nil {
			return fmt.Errorf("rls precondition (system pool): %w", err)
		}
	}
	return rlsPreconditions(app, sys, sysDistinct)
}

// readRoleAttrs asks the connection what it actually is, rather than trusting
// the env var that was used to open it. Those disagree more often than they
// should — pgbouncer auth_user, a PGUSER in the environment, a DSN override.
func readRoleAttrs(ctx context.Context, p *pgxpool.Pool) (roleAttrs, error) {
	var r roleAttrs
	err := p.QueryRow(ctx,
		`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
	).Scan(&r.Name, &r.Super, &r.BypassRLS)
	return r, err
}
