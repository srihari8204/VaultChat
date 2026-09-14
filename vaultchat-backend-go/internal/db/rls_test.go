// rls_test.go — the cutover reasoning, tested without a database.
//
// The dangerous states this file pins are exactly the ones that do NOT produce
// an error at runtime: a server that boots, serves, and reads zero rows. There
// is no Postgres on the machine this was written on, so the decision was kept
// as a pure function of the observed role attributes and tested here. The parts
// that genuinely need a database (do the policies hold?) live in
// scripts/test-call-rls.sh and syspool_test.go.
package db

import (
	"strings"
	"testing"
)

func TestEnforcingRLSDefaultsOff(t *testing.T) {
	// Constraint 1 of the whole change: unset means today's behaviour, exactly.
	t.Setenv("DB_RLS_ENFORCE", "")
	if EnforcingRLS() {
		t.Fatal("empty DB_RLS_ENFORCE must be off")
	}
}

func TestEnforcingRLSParsing(t *testing.T) {
	for _, tc := range []struct {
		val  string
		want bool
	}{
		{"1", true}, {"true", true}, {"TRUE", true}, {"t", true},
		{"0", false}, {"false", false}, {"f", false},
		// Set-but-unparseable is ON: somebody meant to enable it. Treating a
		// typo as "off" is how a security control gets silently disabled.
		{"yes", true}, {"on", true}, {"enabled", true},
	} {
		t.Setenv("DB_RLS_ENFORCE", tc.val)
		if got := EnforcingRLS(); got != tc.want {
			t.Errorf("DB_RLS_ENFORCE=%q: got %v, want %v", tc.val, got, tc.want)
		}
	}
}

var (
	superuser  = roleAttrs{Name: "vaultchat", Super: true, BypassRLS: true}
	appRole    = roleAttrs{Name: "vaultchat_app"}
	sysRole    = roleAttrs{Name: "vaultchat_sys", BypassRLS: true}
	superSys   = roleAttrs{Name: "vaultchat", Super: true, BypassRLS: true}
	plainSys   = roleAttrs{Name: "vaultchat_app"}
	bypassOnly = roleAttrs{Name: "reporting", BypassRLS: true}
)

func TestRLSPreconditionsHappyPath(t *testing.T) {
	if err := rlsPreconditions(appRole, sysRole, true); err != nil {
		t.Fatalf("the intended end state must pass: %v", err)
	}
}

func TestRLSPreconditionsRejectsPrivilegedAppRole(t *testing.T) {
	// Today's configuration with the flag switched on. This is the deployment
	// that would otherwise claim to enforce RLS and enforce nothing.
	for _, app := range []roleAttrs{superuser, bypassOnly} {
		err := rlsPreconditions(app, sysRole, true)
		if err == nil {
			t.Fatalf("%s must be refused as the request-path role", app.Name)
		}
		if !strings.Contains(err.Error(), "DB_USER") {
			t.Errorf("error should name the var to change, got: %v", err)
		}
	}
}

func TestRLSPreconditionsRejectsMissingSystemRole(t *testing.T) {
	// The flip everyone gets wrong: DB_USER repointed, DB_SYSTEM_USER forgotten.
	// SysPool aliases Pool, so sysDistinct is false and `sys` is the app role.
	err := rlsPreconditions(appRole, appRole, false)
	if err == nil {
		t.Fatal("a non-distinct SysPool under enforcement must be refused")
	}
	if !strings.Contains(err.Error(), "DB_SYSTEM_USER") {
		t.Errorf("error should name DB_SYSTEM_USER, got: %v", err)
	}
	// The failure mode is the point of the message: this is not an outage, it
	// is silence, so the message has to say so.
	if !strings.Contains(err.Error(), "zero rows") {
		t.Errorf("error should describe the silent failure, got: %v", err)
	}
}

func TestRLSPreconditionsRejectsSystemRoleWithoutBypass(t *testing.T) {
	// A separate pool is not enough — a distinct role that still obeys policies
	// leaves every sweep reading nothing, which looks identical to "no work to
	// do".
	err := rlsPreconditions(appRole, plainSys, true)
	if err == nil {
		t.Fatal("a system role without BYPASSRLS must be refused")
	}
	if !strings.Contains(err.Error(), "BYPASSRLS") {
		t.Errorf("error should name BYPASSRLS, got: %v", err)
	}
}

func TestRLSPreconditionsRejectsSuperuserSystemRole(t *testing.T) {
	// Works, and makes a leaked system password cluster-wide. Refused because
	// "it works" is what would make it stick.
	if err := rlsPreconditions(appRole, superSys, true); err == nil {
		t.Fatal("a SUPERUSER system role must be refused")
	}
}

// The app role is checked before the system role: with the flag on and today's
// DB_USER, the operator must be told about DB_USER, not sent chasing
// DB_SYSTEM_USER.
func TestRLSPreconditionsReportsAppRoleFirst(t *testing.T) {
	err := rlsPreconditions(superuser, superuser, false)
	if err == nil || !strings.Contains(err.Error(), "DB_USER") {
		t.Fatalf("want the DB_USER diagnosis first, got: %v", err)
	}
}
