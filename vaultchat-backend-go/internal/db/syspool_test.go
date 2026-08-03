// syspool_test.go — the two things SysPool must do.
//
// Skipped unless CALL_TEST_DB=1 with DB_* pointing at a scratch database, like
// the routes integration test.
//
// WHY THIS IS WORTH A TEST
// -----------------------
// The fallback is the dangerous half. SysPool aliasing Pool when unconfigured is
// what makes this safe to land on a deployment that has provisioned nothing —
// but it is also exactly the state in which enforcing RLS breaks every sweep and
// fan-out silently. A test that pins both halves is what stops someone
// "simplifying" the fallback away, or assuming it does more than it does.
package db

import (
	"context"
	"os"
	"testing"
)

func TestSysPoolFallsBackToUserPool(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	// Explicitly unset: with no system role configured, SysPool must BE Pool —
	// same pointer, not merely an equivalent pool. Anything else is a second set
	// of connections nobody asked for.
	t.Setenv("DB_SYSTEM_USER", "")
	ctx := context.Background()
	if err := Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if SysPool != Pool {
		t.Fatal("with no DB_SYSTEM_USER, SysPool must be the very same pool as Pool")
	}
}

func TestSysPoolBypassesRLS(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" || os.Getenv("DB_SYSTEM_USER") == "" {
		t.Skip("set CALL_TEST_DB=1 and DB_SYSTEM_USER (a BYPASSRLS role) to run")
	}
	ctx := context.Background()
	if err := Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if SysPool == Pool {
		t.Fatal("DB_SYSTEM_USER is set, so SysPool must be a distinct pool")
	}

	// The query every background sweep and fan-out is shaped like: no
	// app.current_user_id, reading a policy-bearing table. Under FORCE the user
	// pool sees nothing — which is the failure this whole mechanism exists to
	// prevent — while the system pool sees the rows.
	var viaUser, viaSys int
	if err := Pool.QueryRow(ctx, `SELECT count(*) FROM chat_members`).Scan(&viaUser); err != nil {
		t.Fatalf("user pool count: %v", err)
	}
	if err := SysPool.QueryRow(ctx, `SELECT count(*) FROM chat_members`).Scan(&viaSys); err != nil {
		t.Fatalf("system pool count: %v", err)
	}
	if viaSys == 0 {
		t.Skip("no chat_members rows in this database — nothing to distinguish")
	}
	if viaUser != 0 {
		t.Skipf("RLS is not enforced here (user pool saw %d rows); apply 068 to exercise this", viaUser)
	}
	t.Logf("unbound read: user pool saw %d rows, system pool saw %d", viaUser, viaSys)
}
