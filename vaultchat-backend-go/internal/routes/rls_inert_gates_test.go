// rls_inert_gates_test.go — the handlers that used to delegate authorization to
// an RLS policy that never runs.
//
// The API connects as `vaultchat`, which is both SUPERUSER and the owner of
// every table, and PostgreSQL exempts both from row-level security. So a
// handler whose only gate was "the policy limits this" had no gate at all: the
// comment described a rule the database was not applying. See internal/db/rls.go.
//
// Each case below pins the predicate INSIDE the handler's own query, in the
// style of leaveselfapprove_test.go — a check somewhere else can be routed
// around, so the test pins where it lives. Comments are stripped first: the
// prose above a query describes the rule, and matching that prose instead of
// the SQL is exactly the mistake this file exists to catch.
package routes

import (
	"strings"
	"testing"
)

func stripLineComments(src string) string {
	var b strings.Builder
	for _, line := range strings.Split(src, "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}

// funcBody returns the source of one top-level function, comments stripped.
func funcBody(t *testing.T, file, fn string) string {
	t.Helper()
	src := stripLineComments(mustRead(t, file))
	i := strings.Index(src, "func "+fn+"(")
	if i < 0 {
		t.Fatalf("%s: %s vanished", file, fn)
	}
	rest := src[i+1:]
	if j := strings.Index(rest, "\nfunc "); j >= 0 {
		return rest[:j]
	}
	return rest
}

// Migration 066, calls_select: USING (vc_is_chat_member(chat_id)) — widened by
// the same call_invites arm mayJoinCall admits, so an invited guest who is not
// in the chat is not locked out of the call they are legitimately on.
//
// The query is a package const shared by callLoad's eight callers, so it is
// pinned there; GET /calls/{id} is the one caller with no second check.
func TestCallSelectRequiresChatMembershipOrInvite(t *testing.T) {
	src := stripLineComments(mustRead(t, "call_sessions.go"))
	for _, want := range []string{
		"vc_is_chat_member(chat_id)",
		"FROM call_invites i",
		"i.invitee_id = vc_current_user_id()",
	} {
		if !strings.Contains(src, want) {
			t.Fatalf("callSelect lost %q: GET /calls/{id} returns any call's "+
				"metadata and full roster to any authenticated caller", want)
		}
	}
	if strings.Contains(src, "FROM calls WHERE id = $1`") {
		t.Fatal("callSelect is unqualified again")
	}
}

func TestRLSInertHandlersGateInSQL(t *testing.T) {
	cases := []struct {
		file, fn, policy string
		want             []string
	}{
		// Migration 091, space_devices_select / _write:
		// member AND (owner_id = me OR vc_space_ops_viewer(chat_id)).
		{"spaces_devices.go", "deviceList", "091 space_devices_select",
			[]string{"d.owner_id = $2 OR vc_space_ops_viewer($1)"}},
		{"spaces_devices.go", "devicePatch", "091 space_devices_write",
			[]string{"owner_id = $5 OR vc_space_ops_viewer($1)"}},

		// Migration 091, space_device_events_select / space_device_commands_select:
		// EXISTS a device in this chat that is mine, or I run the space.
		{"spaces_devices.go", "deviceEvents", "091 space_device_events_select",
			[]string{"FROM space_devices d", "d.owner_id = $3 OR vc_space_ops_viewer(d.chat_id)"}},
		{"spaces_devices.go", "deviceCommandList", "091 space_device_commands_select",
			[]string{"FROM space_devices d", "d.owner_id = $3 OR vc_space_ops_viewer(d.chat_id)"}},

		// Migration 089, space_attendance_select / space_leave_select / space_tasks_write.
		{"spaces_workforce.go", "attendanceList", "089 space_attendance_select",
			[]string{"a.user_id = $3 OR vc_space_ops_viewer($1)"}},
		{"spaces_workforce.go", "leaveList", "089 space_leave_select",
			[]string{"l.user_id = $2 OR vc_space_ops_viewer($1)"}},
		{"spaces_workforce.go", "wfTaskUpdate", "089 space_tasks_write",
			[]string{"assignee_id = $4 OR vc_space_ops_viewer($1)"}},
	}

	for _, c := range cases {
		body := funcBody(t, c.file, c.fn)
		for _, want := range c.want {
			if !strings.Contains(body, want) {
				t.Errorf("%s: %s lost its gate (policy %s): no %q in the query",
					c.file, c.fn, c.policy, want)
			}
		}
	}
}

// Denial must not become an existence oracle: a device, task or call that is
// not yours must answer exactly as one that does not exist. These handlers say
// so by reusing the not-found wording rather than inventing a "forbidden" one.
func TestRLSInertHandlersDoNotLeakExistence(t *testing.T) {
	for _, c := range []struct{ file, fn, want string }{
		{"call_sessions.go", "callLoad", "Call not found"},
		{"spaces_devices.go", "devicePatch", "Device not found"},
		{"spaces_workforce.go", "wfTaskUpdate", "Task not found"},
	} {
		if !strings.Contains(funcBody(t, c.file, c.fn), c.want) {
			t.Errorf("%s: %s no longer answers %q for a row it may not see", c.file, c.fn, c.want)
		}
	}
}
