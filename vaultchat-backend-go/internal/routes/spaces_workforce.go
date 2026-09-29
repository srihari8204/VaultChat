// spaces_workforce.go — attendance, leave, tasks, and the server-computed
// dashboard (migration 089).
//
// ── these handlers are deliberately thin ──
//
// The dashboard is one SQL function call. The handler checks the caller and
// returns the JSONB verbatim; it does no aggregation of its own and must not
// start doing any. Two implementations of "how many children are still waiting"
// will eventually disagree, and the one on the phone is the one that ships to a
// thousand devices before anybody notices.
//
// That is also what keeps the app small: the client asks one question per
// screen and renders the answer, instead of pulling every run's manifest to add
// up six numbers locally.
//
// The E2EE boundary is untouched. Nothing here reads a position — where a
// vehicle is still travels only on the sealed ping, which this server cannot
// decrypt. This file answers "how many, how far through, who is still out".

package routes

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
)

const wfNoteMax = 300

// spaceNameCols and spaceName are how an ops screen gets a person's NAME.
//
// users.name is a legacy plaintext column and it is NULL for every account on
// this deployment — real names live in first_name_cipher/last_name_cipher and
// have to be decrypted. Selecting u.name alone therefore compiles, runs, and
// returns nobody: every ops list rendered as an anonymous row of "Member".
// Found by reading the People screen of a business space that definitely had
// two named people in it.
//
// Any query behind an ops screen must select spaceNameCols and resolve through
// spaceName, exactly as the chat member list already does.
const spaceNameCols = `u.first_name_cipher, u.last_name_cipher, u.email_cipher, u.name, u.email`

var leaveKinds = map[string]bool{
	"casual": true, "sick": true, "privilege": true, "unpaid": true, "other": true,
}
var taskPriorities = map[string]bool{"low": true, "medium": true, "high": true}

func RegisterSpaceWorkforceOnID(id *http.ServeMux) {
	id.HandleFunc("GET /chats/{id}/ops/summary", httpx.RequireAuth(opsSummary))
	id.HandleFunc("GET /chats/{id}/attendance", httpx.RequireAuth(attendanceList))
	id.HandleFunc("POST /chats/{id}/attendance/check-in", httpx.RequireAuth(attendanceCheckIn))
	id.HandleFunc("POST /chats/{id}/attendance/check-out", httpx.RequireAuth(attendanceCheckOut))
	id.HandleFunc("GET /chats/{id}/leave", httpx.RequireAuth(leaveList))
	id.HandleFunc("POST /chats/{id}/leave", httpx.RequireAuth(leaveCreate))
	id.HandleFunc("PATCH /chats/{id}/leave/{leaveId}", httpx.RequireAuth(leaveDecide))
	id.HandleFunc("GET /chats/{id}/ops/pending", httpx.RequireAuth(opsPendingPickups))
	id.HandleFunc("GET /chats/{id}/ops/people", httpx.RequireAuth(opsPeople))
	id.HandleFunc("GET /chats/{id}/leave/balance", httpx.RequireAuth(leaveBalance))
	id.HandleFunc("PATCH /chats/{id}/leave/allowance", httpx.RequireAuth(leaveAllowanceSet))
	id.HandleFunc("GET /chats/{id}/tasks", httpx.RequireAuth(wfTaskList))
	id.HandleFunc("POST /chats/{id}/tasks", httpx.RequireAuth(wfTaskCreate))
	id.HandleFunc("PATCH /chats/{id}/tasks/{taskId}", httpx.RequireAuth(wfTaskUpdate))
}

// ─── the dashboard ─────────────────────────────────────────────────────

// opsSummary returns the whole dashboard for one day as computed JSON.
//
// `day` is accepted so a report screen can look backwards; it defaults to the
// server's current date. Deliberately a DATE and not a range: a range turns one
// bounded query into an unbounded one, and every design here shows a single day.
func opsSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	// The SQL function re-checks this itself — it aggregates the whole space, so
	// it cannot trust a caller. Checking here too turns a JSON body of
	// {"error":"not_permitted"} into a real 403 with the route's own wording.
	mem := chatsRequirePerm(w, r, groups.PermViewSpaceOps,
		"You cannot see this space's operations", "Failed to load the dashboard")
	if mem == nil {
		return
	}

	day := strings.TrimSpace(r.URL.Query().Get("day"))
	var out []byte
	var err error
	if day == "" {
		err = chatsQRow(ctx, user.ID,
			`SELECT space_ops_summary($1, $2)`, []any{chatID, user.ID}, &out)
	} else {
		if _, perr := time.Parse("2006-01-02", day); perr != nil {
			httpx.Err(w, 400, "day must be YYYY-MM-DD")
			return
		}
		err = chatsQRow(ctx, user.ID,
			`SELECT space_ops_summary($1, $2, $3::date)`, []any{chatID, user.ID, day}, &out)
	}
	if err != nil {
		log.Printf("[ops summary] %v", err)
		httpx.Err(w, 500, "Failed to load the dashboard")
		return
	}
	// The payload is already JSON from Postgres. Writing the bytes through
	// avoids decoding it into a map only to re-encode it — and, more usefully,
	// means adding a figure to the dashboard is a change to ONE SQL function
	// with no matching Go struct to keep in step.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	if _, err := w.Write(out); err != nil {
		log.Printf("[ops summary] write: %v", err)
	}
}

// opsPendingPickups lists the riders still waiting, across every active run
// (School design screen 10).
//
// This is the screen a transport office opens when a parent rings, so it is
// ordered by how long the person has been waiting rather than alphabetically —
// the top of the list is who to worry about.
//
// Scoped like everything else: ops sees the space, and a guardian sees only
// riders they are linked to. Same predicate as the RLS policy, because the app
// connects as a superuser and the policy alone would not hold (see the header
// of spaces_roster.go).
func opsPendingPickups(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load pending pickups"); mem == nil {
		return
	}

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT sr.id, sr.display_name, rn.id AS run_id,
		        COALESCE(rn.vehicle_label, rn.name) AS run_name,
		        st.label AS stop_label, st.planned_at, rn.started_at, rn.status
		   FROM run_riders rr
		   JOIN runs rn        ON rn.id = rr.run_id
		   JOIN space_roster sr ON sr.id = rr.rider_id
		   LEFT JOIN run_stops st ON st.id = rr.stop_id
		  WHERE rn.chat_id = $1
		    AND rr.state = 'pending'
		    AND rn.status IN ('scheduled', 'started')
		    AND (vc_space_ops_viewer($1)
		         OR rn.driver_id = $2
		         OR space_can_view_roster($1, $2, rr.rider_id))
		  ORDER BY st.planned_at NULLS LAST, rn.started_at NULLS LAST, sr.display_name
		  LIMIT 300`,
		[]any{chatID, user.ID}, func(rows pgx.Rows) error {
			var (
				riderID, name, runID, runName, status string
				stopLabel                             *string
				plannedAt, startedAt                  *time.Time
			)
			if e := rows.Scan(&riderID, &name, &runID, &runName, &stopLabel,
				&plannedAt, &startedAt, &status); e != nil {
				return e
			}
			out = append(out, map[string]any{
				"riderId": riderID, "name": name,
				"runId": runID, "runName": runName,
				"stop": stopLabel, "plannedAt": httpx.JST(plannedAt),
				"runStatus": status, "runStartedAt": httpx.JST(startedAt),
			})
			return nil
		})
	if err != nil {
		log.Printf("[ops pending] %v", err)
		httpx.Err(w, 500, "Failed to load pending pickups")
		return
	}
	httpx.JSON(w, 200, out)
}

// opsPeople is the team list (Employee design screen 6).
//
// One query answers "who is here, who is on leave, who has not checked in" —
// the three states the design's status pills show. Computing it here rather
// than fetching members, attendance and leave separately and joining them on
// the phone is the whole point of this file.
func opsPeople(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermViewSpaceOps,
		"You cannot see this space's people", "Failed to load people")
	if mem == nil {
		return
	}

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT cm.user_id, `+spaceNameCols+`, cm.role, cm.role_key, cm.duty_state,
		        a.check_in_at, a.check_out_at,
		        EXISTS (
		          SELECT 1 FROM space_leave l
		           WHERE l.chat_id = cm.chat_id AND l.user_id = cm.user_id
		             AND l.status = 'approved'
		             AND CURRENT_DATE BETWEEN l.from_day AND l.to_day
		        ) AS on_leave
		   FROM chat_members cm
		   JOIN users u ON u.id = cm.user_id
		   LEFT JOIN space_attendance a
		          ON a.chat_id = cm.chat_id AND a.user_id = cm.user_id AND a.day = CURRENT_DATE
		  WHERE cm.chat_id = $1 AND cm.left_at IS NULL
		  ORDER BY cm.role, cm.joined_at
		  LIMIT 500`,
		[]any{chatID}, func(rows pgx.Rows) error {
			var (
				uid, role        string
				fnc, lnc, ec     *string
				legacyN, legacyE *string
				roleKey          *string
				duty             *string
				in, outAt        *time.Time
				onLeave          bool
			)
			if e := rows.Scan(&uid, &fnc, &lnc, &ec, &legacyN, &legacyE,
				&role, &roleKey, &duty, &in, &outAt, &onLeave); e != nil {
				return e
			}
			name := spaceName(fnc, lnc, ec, legacyN, legacyE)
			// One derived word, computed here so every screen says the same
			// thing. "unknown" is deliberate and is NOT "absent": no check-in
			// means nobody told us, which is different from being away.
			status := "unknown"
			switch {
			case onLeave:
				status = "on_leave"
			case in != nil && outAt == nil:
				status = "in"
			case in != nil && outAt != nil:
				status = "left"
			}
			out = append(out, map[string]any{
				"userId": uid, "name": name, "role": role, "roleKey": roleKey,
				"dutyState": duty, "status": status,
				"checkInAt": httpx.JST(in), "checkOutAt": httpx.JST(outAt),
			})
			return nil
		})
	if err != nil {
		log.Printf("[ops people] %v", err)
		httpx.Err(w, 500, "Failed to load people")
		return
	}
	httpx.JSON(w, 200, out)
}

// leaveBalance reports the space's grant and what the caller has taken.
//
// `allowance` is null when the space has never set one, and the client must
// show that as "not set" rather than as zero — "no days left" and "we were
// never told how many you get" are different answers, and only one of them is
// this server's to give.
func leaveBalance(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load balance"); mem == nil {
		return
	}

	// Another member's balance is ops-only; your own is always yours.
	target := user.ID
	if q := strings.TrimSpace(r.URL.Query().Get("userId")); q != "" && q != user.ID {
		m2 := chatsRequirePerm(w, r, groups.PermViewSpaceOps,
			"You cannot see someone else's balance", "Failed to load balance")
		if m2 == nil {
			return
		}
		target = q
	}

	var allowance, used []byte
	if err := chatsQRow(ctx, user.ID,
		`SELECT c.leave_allowance, space_leave_used($1, $2)
		   FROM chats c WHERE c.id = $1`,
		[]any{chatID, target}, &allowance, &used); err != nil {
		log.Printf("[leave balance] %v", err)
		httpx.Err(w, 500, "Failed to load balance")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	// Assembled as raw JSON so the two JSONB values pass through untouched.
	body := []byte(`{"userId":"` + target + `","allowance":`)
	if len(allowance) == 0 {
		body = append(body, []byte("null")...)
	} else {
		body = append(body, allowance...)
	}
	body = append(body, []byte(`,"used":`)...)
	if len(used) == 0 {
		body = append(body, []byte("{}")...)
	} else {
		body = append(body, used...)
	}
	body = append(body, '}')
	if _, err := w.Write(body); err != nil {
		log.Printf("[leave balance] write: %v", err)
	}
}

// leaveAllowanceSet stores the space's annual grant. Ops only — an allowance
// anyone could edit is not an allowance.
func leaveAllowanceSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequirePerm(w, r, groups.PermEditSettings,
		"You cannot change this space's settings", "Failed to set the allowance"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	allowance := map[string]int{}
	for _, k := range []string{"casual", "sick", "privilege", "unpaid"} {
		if n, ok := chatsParseInt(b[k]); ok {
			if n < 0 || n > 365 {
				httpx.Err(w, 400, "days must be between 0 and 365")
				return
			}
			allowance[k] = int(n)
		}
	}
	if len(allowance) == 0 {
		httpx.Err(w, 400, "give at least one leave type")
		return
	}
	raw, err := json.Marshal(allowance)
	if err != nil {
		httpx.Err(w, 400, "invalid allowance")
		return
	}

	if err := chatsExecU(ctx, user.ID,
		`UPDATE chats SET leave_allowance = $2::jsonb WHERE id = $1`, chatID, string(raw)); err != nil {
		log.Printf("[leave allowance] %v", err)
		httpx.Err(w, 500, "Failed to set the allowance")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "leave_allowance_set", nil, map[string]any{"allowance": allowance})
	httpx.JSON(w, 200, map[string]any{"allowance": allowance})
}

// ─── attendance ────────────────────────────────────────────────────────

func attendanceList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load attendance"); mem == nil {
		return
	}

	day := strings.TrimSpace(r.URL.Query().Get("day"))
	if day == "" {
		day = time.Now().Format("2006-01-02")
	} else if _, err := time.Parse("2006-01-02", day); err != nil {
		httpx.Err(w, 400, "day must be YYYY-MM-DD")
		return
	}

	// Your own row unless you run the space — policy space_attendance_select
	// (migration 089), spelled here because RLS is inert while the API connects
	// as the table owner.
	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT a.user_id, `+spaceNameCols+`, a.check_in_at, a.check_out_at, a.source, a.note
		   FROM space_attendance a
		   JOIN users u ON u.id = a.user_id
		  WHERE a.chat_id = $1 AND a.day = $2::date
		    AND (a.user_id = $3 OR vc_space_ops_viewer($1))
		  ORDER BY a.check_in_at NULLS LAST
		  LIMIT 500`,
		[]any{chatID, day, user.ID}, func(rows pgx.Rows) error {
			var (
				uid, source      string
				fnc, lnc, ec     *string
				legacyN, legacyE *string
				in, outAt        *time.Time
				note             *string
			)
			if e := rows.Scan(&uid, &fnc, &lnc, &ec, &legacyN, &legacyE,
				&in, &outAt, &source, &note); e != nil {
				return e
			}
			name := spaceName(fnc, lnc, ec, legacyN, legacyE)
			out = append(out, map[string]any{
				"userId": uid, "name": name, "source": source, "note": note,
				"checkInAt": httpx.JST(in), "checkOutAt": httpx.JST(outAt),
			})
			return nil
		})
	if err != nil {
		log.Printf("[attendance GET] %v", err)
		httpx.Err(w, 500, "Failed to load attendance")
		return
	}
	httpx.JSON(w, 200, map[string]any{"day": day, "records": out})
}

// attendanceCheckIn records an arrival for TODAY, for the caller only.
//
// Idempotent: checking in twice keeps the FIRST time. The second tap is a
// person wondering whether the first one worked, and moving their arrival later
// because they pressed it twice would be a small lie with real consequences on
// a late-arrivals report.
func attendanceCheckIn(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to check in"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	note := strings.TrimSpace(chatsStrOr(b["note"], ""))
	if len(note) > wfNoteMax {
		httpx.Err(w, 400, "note is too long")
		return
	}

	var in *time.Time
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO space_attendance (chat_id, user_id, day, check_in_at, source, note)
		 VALUES ($1, $2, CURRENT_DATE, NOW(), 'self', NULLIF($3, ''))
		 ON CONFLICT (chat_id, user_id, day) DO UPDATE
		   SET check_in_at = COALESCE(space_attendance.check_in_at, EXCLUDED.check_in_at),
		       note        = COALESCE(NULLIF(EXCLUDED.note, ''), space_attendance.note)
		 RETURNING check_in_at`,
		[]any{chatID, user.ID, note}, &in); err != nil {
		log.Printf("[check-in] %v", err)
		httpx.Err(w, 500, "Failed to check in")
		return
	}

	emitx.ChatEvent(chatID, "attendance_changed", map[string]any{"userId": user.ID, "kind": "in"})
	httpx.JSON(w, 200, map[string]any{"checkInAt": httpx.JST(in)})
}

// attendanceCheckOut records a departure. Unlike check-in it takes the LATEST
// time: someone who leaves, comes back and leaves again left at the later one.
func attendanceCheckOut(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to check out"); mem == nil {
		return
	}

	var out *time.Time
	err := chatsQRow(ctx, user.ID,
		`UPDATE space_attendance SET check_out_at = NOW()
		  WHERE chat_id = $1 AND user_id = $2 AND day = CURRENT_DATE
		  RETURNING check_out_at`,
		[]any{chatID, user.ID}, &out)
	if db.NoRows(err) {
		// Nothing to close. Said plainly rather than silently creating a record
		// with an exit and no arrival, which no report could interpret.
		httpx.Err(w, 409, "You have not checked in today")
		return
	}
	if err != nil {
		log.Printf("[check-out] %v", err)
		httpx.Err(w, 500, "Failed to check out")
		return
	}

	emitx.ChatEvent(chatID, "attendance_changed", map[string]any{"userId": user.ID, "kind": "out"})
	httpx.JSON(w, 200, map[string]any{"checkOutAt": httpx.JST(out)})
}

// ─── leave ─────────────────────────────────────────────────────────────

func leaveList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load leave"); mem == nil {
		return
	}

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT l.id, l.user_id, `+spaceNameCols+`, l.kind, l.from_day, l.to_day, l.reason,
		        l.status, l.decided_at
		   FROM space_leave l
		   JOIN users u ON u.id = l.user_id
		  WHERE l.chat_id = $1
		    AND (l.user_id = $2 OR vc_space_ops_viewer($1))
		  ORDER BY l.status = 'pending' DESC, l.from_day DESC
		  LIMIT 300`,
		[]any{chatID, user.ID}, func(rows pgx.Rows) error {
			var (
				lid              int64
				uid, kind, st    string
				fnc, lnc, ec     *string
				legacyN, legacyE *string
				reason           *string
				from, to         time.Time
				decided          *time.Time
			)
			if e := rows.Scan(&lid, &uid, &fnc, &lnc, &ec, &legacyN, &legacyE,
				&kind, &from, &to, &reason, &st, &decided); e != nil {
				return e
			}
			name := spaceName(fnc, lnc, ec, legacyN, legacyE)
			out = append(out, map[string]any{
				"id": lid, "userId": uid, "name": name, "kind": kind,
				"fromDay": from.Format("2006-01-02"), "toDay": to.Format("2006-01-02"),
				"reason": reason, "status": st, "decidedAt": httpx.JST(decided),
				// Inclusive: a one-day leave is one day, not zero.
				"days": int(to.Sub(from).Hours()/24) + 1,
			})
			return nil
		})
	if err != nil {
		log.Printf("[leave GET] %v", err)
		httpx.Err(w, 500, "Failed to load leave")
		return
	}
	httpx.JSON(w, 200, out)
}

func leaveCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to request leave"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	kind := strings.TrimSpace(chatsStrOr(b["kind"], "casual"))
	if !leaveKinds[kind] {
		httpx.Err(w, 400, "unknown leave type")
		return
	}
	from := strings.TrimSpace(chatsStrOr(b["fromDay"], ""))
	to := strings.TrimSpace(chatsStrOr(b["toDay"], ""))
	fd, e1 := time.Parse("2006-01-02", from)
	td, e2 := time.Parse("2006-01-02", to)
	if e1 != nil || e2 != nil {
		httpx.Err(w, 400, "fromDay and toDay must be YYYY-MM-DD")
		return
	}
	if td.Before(fd) {
		httpx.Err(w, 400, "The end date is before the start date")
		return
	}
	reason := strings.TrimSpace(chatsStrOr(b["reason"], ""))
	if len(reason) > wfNoteMax {
		httpx.Err(w, 400, "reason is too long")
		return
	}

	var id int64
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO space_leave (chat_id, user_id, kind, from_day, to_day, reason)
		 VALUES ($1, $2, $3, $4::date, $5::date, NULLIF($6, '')) RETURNING id`,
		[]any{chatID, user.ID, kind, from, to, reason}, &id); err != nil {
		log.Printf("[leave POST] %v", err)
		httpx.Err(w, 500, "Failed to request leave")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "leave_requested", nil, map[string]any{"leaveId": id, "kind": kind})
	emitx.ChatEvent(chatID, "leave_changed", map[string]any{"leaveId": id, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"id": id, "status": "pending"})
}

// leaveDecide approves or rejects (ops), or cancels (the requester).
//
// The two are NOT the same permission and are separated on purpose: cancelling
// your own pending request is your business, and deciding someone else's is the
// space's.
func leaveDecide(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	leaveID := r.PathValue("leaveId")

	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update leave")
	if mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	status := strings.TrimSpace(chatsStrOr(b["status"], ""))
	switch status {
	case "approved", "rejected":
		if !mem.can(groups.PermViewSpaceOps) {
			httpx.Err(w, 403, "Only someone who runs this space can decide leave")
			return
		}
	case "cancelled":
		// The WHERE clause below restricts a cancel to the requester's own row.
	default:
		httpx.Err(w, 400, "status must be approved, rejected or cancelled")
		return
	}

	var id int64
	q := `UPDATE space_leave
	         SET status = $3, decided_by = $4, decided_at = NOW()
	       WHERE chat_id = $1 AND id = $2::bigint AND status = 'pending'`
	args := []any{chatID, leaveID, status, user.ID}
	if status == "cancelled" {
		q += ` AND user_id = $4`
	} else {
		// NOBODY APPROVES THEIR OWN LEAVE.
		//
		// Holding view_space_ops was the only check, so an owner — who by
		// definition holds it — could approve their own request. Verified on a
		// real device: the row came back user_id = decided_by, status = approved.
		// An approval that the requester can grant themselves is not an approval,
		// it is a formality with an audit row attached.
		//
		// In the WHERE clause rather than a preceding SELECT: a separate read
		// leaves a window where two requests interleave, and this is exactly the
		// rule that must not have one. A self-approval now matches no row and
		// falls through to the same 409 as any other ineligible decision, having
		// changed nothing.
		//
		// Cancelling is deliberately NOT covered by this: withdrawing your own
		// request is yours to do, and the branch above already restricts it to
		// your own row.
		q += ` AND user_id <> $4`
	}
	q += ` RETURNING id`

	err := chatsQRow(ctx, user.ID, q, args, &id)
	if db.NoRows(err) {
		// Was it their OWN pending request? Saying so is not a leak — they wrote
		// it — and "no longer pending" would be a lie about a row still sitting
		// in front of them, sending them to retry a thing that cannot work.
		if status != "cancelled" {
			var own int
			if e := chatsQRow(ctx, user.ID,
				`SELECT 1 FROM space_leave
				  WHERE chat_id = $1 AND id = $2::bigint AND user_id = $3 AND status = 'pending'`,
				[]any{chatID, leaveID, user.ID}, &own); e == nil {
				httpx.Err(w, 403, "You cannot decide your own leave request. Someone else who runs this space has to.")
				return
			}
		}
		// Otherwise: already decided, already cancelled, or not theirs to touch —
		// one message, because distinguishing those tells a caller about rows
		// they may not be able to see.
		httpx.Err(w, 409, "That request is no longer pending")
		return
	}
	if err != nil {
		log.Printf("[leave PATCH] %v", err)
		httpx.Err(w, 500, "Failed to update leave")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "leave_"+status, nil, map[string]any{"leaveId": id})
	emitx.ChatEvent(chatID, "leave_changed", map[string]any{"leaveId": id, "status": status})
	httpx.JSON(w, 200, map[string]any{"id": id, "status": status})
}

// ─── tasks ─────────────────────────────────────────────────────────────

func wfTaskList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load tasks"); mem == nil {
		return
	}

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT t.id, t.title, t.assignee_id, `+spaceNameCols+`, t.priority, t.due_at, t.done_at, t.assigned_by
		   FROM space_tasks t
		   LEFT JOIN users u ON u.id = t.assignee_id
		  WHERE t.chat_id = $1
		  ORDER BY t.done_at NULLS FIRST, t.due_at NULLS LAST, t.id DESC
		  LIMIT 300`,
		[]any{chatID}, func(rows pgx.Rows) error {
			var (
				tid              int64
				title, priority  string
				assignee         *string
				fnc, lnc, ec     *string
				legacyN, legacyE *string
				due, done        *time.Time
				by               *string
			)
			if e := rows.Scan(&tid, &title, &assignee, &fnc, &lnc, &ec, &legacyN, &legacyE,
				&priority, &due, &done, &by); e != nil {
				return e
			}
			name := spaceName(fnc, lnc, ec, legacyN, legacyE)
			out = append(out, map[string]any{
				"id": tid, "title": title, "assigneeId": assignee, "assigneeName": name,
				"priority": priority, "dueAt": httpx.JST(due), "doneAt": httpx.JST(done),
				"assignedBy": by,
			})
			return nil
		})
	if err != nil {
		log.Printf("[tasks GET] %v", err)
		httpx.Err(w, 500, "Failed to load tasks")
		return
	}
	httpx.JSON(w, 200, out)
}

func wfTaskCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	// Assigning work to other people is an ops act. Assigning it to yourself is
	// not, and the policy lets that through — but creating one for someone else
	// goes through here.
	mem := chatsRequirePerm(w, r, groups.PermViewSpaceOps,
		"You cannot assign tasks in this space", "Failed to create task")
	if mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	title := strings.TrimSpace(chatsStrOr(b["title"], ""))
	if title == "" || len(title) > 200 {
		httpx.Err(w, 400, "title must be 1–200 characters")
		return
	}
	priority := strings.TrimSpace(chatsStrOr(b["priority"], "medium"))
	if !taskPriorities[priority] {
		httpx.Err(w, 400, "priority must be low, medium or high")
		return
	}
	var assignee *string
	if a := strings.TrimSpace(chatsStrOr(b["assigneeId"], "")); a != "" {
		assignee = &a
	}
	var due *time.Time
	if d := strings.TrimSpace(chatsStrOr(b["dueAt"], "")); d != "" {
		t, err := time.Parse(time.RFC3339, d)
		if err != nil {
			httpx.Err(w, 400, "dueAt must be an RFC3339 timestamp")
			return
		}
		due = &t
	}

	var id int64
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO space_tasks (chat_id, title, assignee_id, assigned_by, priority, due_at)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		[]any{chatID, title, assignee, user.ID, priority, due}, &id); err != nil {
		log.Printf("[tasks POST] %v", err)
		httpx.Err(w, 500, "Failed to create task")
		return
	}

	emitx.ChatEvent(chatID, "tasks_changed", map[string]any{"taskId": id, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"id": id})
}

// wfTaskUpdate marks a task done or not done — the assignee or ops, per policy
// space_tasks_write (migration 089). Spelled in the WHERE rather than left to
// RLS, which is inert while the API connects as the table owner.
func wfTaskUpdate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	taskID := r.PathValue("taskId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update task"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	done := chatsTruthy(b["done"])

	var id int64
	err := chatsQRow(ctx, user.ID,
		`UPDATE space_tasks
		    SET done_at = CASE WHEN $3::bool THEN COALESCE(done_at, NOW()) ELSE NULL END
		  WHERE chat_id = $1 AND id = $2::bigint
		    AND (assignee_id = $4 OR vc_space_ops_viewer($1))
		  RETURNING id`,
		[]any{chatID, taskID, done, user.ID}, &id)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Task not found")
		return
	}
	if err != nil {
		log.Printf("[tasks PATCH] %v", err)
		httpx.Err(w, 500, "Failed to update task")
		return
	}

	emitx.ChatEvent(chatID, "tasks_changed", map[string]any{"taskId": id, "done": done})
	httpx.JSON(w, 200, map[string]any{"id": id, "done": done})
}
