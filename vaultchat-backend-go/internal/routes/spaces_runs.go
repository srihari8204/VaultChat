// spaces_runs.go — the run engine's HTTP surface (migration 086).
//
// A run is a scheduled multi-stop trip: a driver, an ordered stop list and a
// manifest. School bus, school drop, office cab and generic group trip are the
// same rows with different configuration.
//
// ── two rules that shape every handler here ──
//
// 1. A DRIVER SEES ONE MANIFEST. Not "sees the space and we hide the rest" —
//    the driver's queries return their own runs, because the RLS policies in 086
//    scope by driver_id, and the route refuses anything else. A filtered-on-
//    device dashboard is not a scope.
//
// 2. NO COORDINATES FOR PEOPLE OR VEHICLES. Live position is the driver
//    device's ordinary sealed ping tagged with a run id, relayed by the socket
//    server; nothing in this file stores or reads one. What is recorded here is
//    state transitions with timestamps, which is what a manifest and a replay
//    need.

package routes

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/workx"
)

const (
	runNameMax  = 120
	runStopsMax = 200 // a route, not a world tour
	runNoteMax  = 500
)

// errRiderNotOnRoster rolls the manifest back when it names someone this space
// does not have. Carried as a sentinel because the rejection happens inside the
// transaction, where the only way out is an error.
var errRiderNotOnRoster = errors.New("rider not on roster")

// runEventDetail builds the jsonb payload for a run event.
//
// TEXT, not a Go map. pgx cannot encode map[string]any for a jsonb parameter —
// it fails with "cannot find encode plan" — and because that INSERT sits inside
// the rider-state transaction, the whole transaction rolled back. Marking a
// child PICKED UP therefore answered 500 and left them 'pending', every single
// time, on every run: the driver workflow did not work in production at all.
//
// Third instance of this exact trap (migration 069's params, then chatsAudit).
// pgx will not stop you passing a map, and the failure is at execute time.
func runEventDetail(note string) string {
	b, err := json.Marshal(map[string]any{"note": note})
	if err != nil {
		// A note that will not marshal must not cost the driver their pickup.
		return `{}`
	}
	return string(b)
}

var runKinds = map[string]bool{
	"school_pickup": true, "school_drop": true,
	"cab_pickup": true, "cab_drop": true, "generic": true,
}

// Rider states, mirroring the CHECK in 086. The map is the set a CLIENT may
// ask for: 'pending' is the initial state and is not a transition anyone
// requests, and 'cancelled' is set by the manifest editor, not the driver.
var runRiderStates = map[string]bool{
	"boarded": true, "dropped": true, "absent": true, "no_show": true,
}

var runDutyStates = map[string]bool{
	"on_duty": true, "on_break": true, "off_duty": true,
}

func RegisterSpaceRunsOnID(id *http.ServeMux) {
	id.HandleFunc("GET /chats/{id}/runs", httpx.RequireAuth(runsList))
	id.HandleFunc("POST /chats/{id}/runs", httpx.RequireAuth(runCreate))
	id.HandleFunc("GET /chats/{id}/runs/{runId}", httpx.RequireAuth(runGet))
	id.HandleFunc("PATCH /chats/{id}/runs/{runId}", httpx.RequireAuth(runPatch))
	id.HandleFunc("PUT /chats/{id}/runs/{runId}/stops", httpx.RequireAuth(runStopsSet))
	id.HandleFunc("POST /chats/{id}/runs/{runId}/stops/{stopId}/arrive", httpx.RequireAuth(runStopArrive))
	id.HandleFunc("PUT /chats/{id}/runs/{runId}/riders", httpx.RequireAuth(runRidersSet))
	id.HandleFunc("POST /chats/{id}/runs/{runId}/riders/{riderId}/state", httpx.RequireAuth(runRiderState))
	id.HandleFunc("POST /chats/{id}/runs/{runId}/ping", httpx.RequireAuth(runPing))
	id.HandleFunc("GET /chats/{id}/runs/{runId}/events", httpx.RequireAuth(runEvents))
	id.HandleFunc("PATCH /chats/{id}/duty", httpx.RequireAuth(runDutySet))
}

type runSummary struct {
	ID           string        `json:"id"`
	Kind         string        `json:"kind"`
	Name         string        `json:"name"`
	DriverID     *string       `json:"driverId"`
	VehicleLabel *string       `json:"vehicleLabel"`
	ScheduledAt  *httpx.JSTime `json:"scheduledAt"`
	Status       string        `json:"status"`
	StartedAt    *httpx.JSTime `json:"startedAt"`
	CompletedAt  *httpx.JSTime `json:"completedAt"`
	RequireCode  bool          `json:"requireCode"`
	// Stale is the ONE alert the server can raise for itself: an active run that
	// has stopped reporting. Every other detection — overspeed, deviation, long
	// stop — happens on the driver's device, because the server cannot read a
	// position. Absence is different: it needs no plaintext, and it is precisely
	// what a vanished device cannot report about itself.
	Stale bool `json:"stale"`
}

func runScan(rows pgx.Rows) (runSummary, error) {
	var (
		s                             runSummary
		scheduled, started, completed *time.Time
		driverID, vehicle             *string
	)
	err := rows.Scan(&s.ID, &s.Kind, &s.Name, &driverID, &vehicle,
		&scheduled, &s.Status, &started, &completed, &s.RequireCode, &s.Stale)
	s.DriverID, s.VehicleLabel = driverID, vehicle
	s.ScheduledAt, s.StartedAt, s.CompletedAt = httpx.JST(scheduled), httpx.JST(started), httpx.JST(completed)
	return s, err
}

// Staleness is DERIVED in the query, never stored. A stored "is stale" flag
// needs something to keep it true, and a background sweep that falls over
// leaves every bus looking healthy — the exact failure the flag exists to catch.
// Computed on read, it cannot be stale about staleness.
const runCols = `id, kind, name, driver_id, vehicle_label, scheduled_at, status,
                 started_at, completed_at, require_code,
                 (status = 'started'
                  AND (last_ping_at IS NULL OR last_ping_at < NOW() - INTERVAL '3 minutes')
                 ) AS stale`

// runPing is the driver device's heartbeat: proof of life, and nothing else.
//
// It carries NO position. The position is in the sealed socket ping the same
// device is already sending, which this server cannot read. All this row says is
// "the phone on Bus 01 was still talking at 08:41" — which is exactly enough to
// notice when it stops.
func runPing(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	runID := r.PathValue("runId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to record ping"); mem == nil {
		return
	}

	// Only the assigned driver's device is proof of life for this run.
	var id string
	err := chatsQRow(ctx, user.ID,
		`UPDATE runs SET last_ping_at = NOW()
		  WHERE id = $1 AND chat_id = $2 AND driver_id = $3 AND status = 'started'
		  RETURNING id`,
		[]any{runID, chatID, user.ID}, &id)
	if db.NoRows(err) {
		httpx.Err(w, 409, "You are not driving that run")
		return
	}
	if err != nil {
		log.Printf("[run ping] %v", err)
		httpx.Err(w, 500, "Failed to record ping")
		return
	}
	// The heartbeat doubles as the delay clock. The client's isDelayed() can
	// only tell a guardian who is looking at the screen; this evaluates the
	// same threshold server-side and reaches the ones who are not. Dedup via
	// run_events makes a ping every few seconds mean one push per stop, ever.
	uid := user.ID
	workx.Submit(func() { runCheckDelays(chatID, runID, uid) })
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// runsList returns the runs the caller may see. RLS does the scoping: ops sees
// the timetable, a driver sees their own runs, a guardian sees the runs their
// linked riders are on.
func runsList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load runs"); mem == nil {
		return
	}

	// `active=1` is what the driver screen and every dashboard actually want.
	active := r.URL.Query().Get("active") == "1"
	out := []runSummary{}
	err := chatsQueryU(ctx, user.ID,
		// vc_run_visible mirrors the runs_select policy. Load-bearing while the
		// API connects as a superuser and RLS is bypassed — see the header of
		// spaces_roster.go.
		`SELECT `+runCols+`
		   FROM runs
		  WHERE chat_id = $1
		    AND ($2::bool IS NOT TRUE OR status IN ('scheduled', 'started'))
		    AND vc_run_visible(id)
		  ORDER BY COALESCE(scheduled_at, created_at) DESC
		  LIMIT 200`,
		[]any{chatID, active}, func(rows pgx.Rows) error {
			s, err := runScan(rows)
			if err != nil {
				return err
			}
			out = append(out, s)
			return nil
		})
	if err != nil {
		log.Printf("[runs GET] %v", err)
		httpx.Err(w, 500, "Failed to load runs")
		return
	}
	httpx.JSON(w, 200, out)
}

// runGet returns one run with its stops and the manifest rows the caller may
// see — which for a guardian is their own child's row and nobody else's.
func runGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	runID := r.PathValue("runId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load run"); mem == nil {
		return
	}

	var run runSummary
	var scheduled, started, completed *time.Time
	err := chatsQRow(ctx, user.ID,
		`SELECT `+runCols+` FROM runs
		  WHERE chat_id = $1 AND id = $2 AND vc_run_visible(id)`,
		[]any{chatID, runID},
		&run.ID, &run.Kind, &run.Name, &run.DriverID, &run.VehicleLabel,
		&scheduled, &run.Status, &started, &completed, &run.RequireCode, &run.Stale)
	if db.NoRows(err) {
		// 404, not 403: a run the caller may not see and a run that does not
		// exist must be indistinguishable, or the id space becomes an oracle for
		// "which buses run at this school".
		httpx.Err(w, 404, "Run not found")
		return
	}
	if err != nil {
		log.Printf("[run GET] %v", err)
		httpx.Err(w, 500, "Failed to load run")
		return
	}
	run.ScheduledAt, run.StartedAt, run.CompletedAt = httpx.JST(scheduled), httpx.JST(started), httpx.JST(completed)

	stops := []map[string]any{}
	if err := chatsQueryU(ctx, user.ID,
		`SELECT id, seq, label, lat, lng, planned_at, arrived_at
		   FROM run_stops WHERE run_id = $1 ORDER BY seq`,
		[]any{runID}, func(rows pgx.Rows) error {
			var (
				id, label            string
				seq                  int32
				lat, lng             *float64
				plannedAt, arrivedAt *time.Time
			)
			if e := rows.Scan(&id, &seq, &label, &lat, &lng, &plannedAt, &arrivedAt); e != nil {
				return e
			}
			stops = append(stops, map[string]any{
				"id": id, "seq": seq, "label": label, "lat": lat, "lng": lng,
				"plannedAt": httpx.JST(plannedAt), "arrivedAt": httpx.JST(arrivedAt),
			})
			return nil
		}); err != nil {
		log.Printf("[run GET stops] %v", err)
		httpx.Err(w, 500, "Failed to load run")
		return
	}

	riders := []map[string]any{}
	if err := chatsQueryU(ctx, user.ID,
		// Per RIDER, not per run: a guardian who can see the bus still sees only
		// their own child's row on it. This is the line that stops the run screen
		// from being a roster of every child at the stop, and with RLS bypassed it
		// is the ONLY thing enforcing it.
		`SELECT rr.rider_id, rr.stop_id, rr.state, rr.state_at, rr.note, sr.display_name
		   FROM run_riders rr
		   JOIN space_roster sr ON sr.id = rr.rider_id
		   JOIN runs r ON r.id = rr.run_id
		  WHERE rr.run_id = $1
		    AND (r.driver_id = $2
		         OR vc_space_ops_viewer(r.chat_id)
		         OR space_can_view_roster(r.chat_id, $2, rr.rider_id))
		  ORDER BY sr.display_name`,
		[]any{runID, user.ID}, func(rows pgx.Rows) error {
			var (
				riderID, state, name string
				stopID, note         *string
				stateAt              *time.Time
			)
			if e := rows.Scan(&riderID, &stopID, &state, &stateAt, &note, &name); e != nil {
				return e
			}
			riders = append(riders, map[string]any{
				"riderId": riderID, "stopId": stopID, "state": state,
				"stateAt": httpx.JST(stateAt), "note": note, "displayName": name,
			})
			return nil
		}); err != nil {
		log.Printf("[run GET riders] %v", err)
		httpx.Err(w, 500, "Failed to load run")
		return
	}

	// The threshold this run's "running late" badge should agree with. Without
	// this the client's isDelayed() only ever had the compile-time default
	// (10), so an admin who set the space's threshold to 30 via shiftSet saw
	// the on-screen badge fire at 10 while the server's own push fired at 30 —
	// two guardian-facing surfaces disagreeing about the same fact. Found by
	// review; thin-client violation (the client had no way to learn the truth).
	var thresholdMin int
	if err := chatsQRow(ctx, user.ID,
		`SELECT run_delay_threshold_minutes FROM chats WHERE id = $1`,
		[]any{chatID}, &thresholdMin); err != nil {
		thresholdMin = 10 // matches the column's own DEFAULT and the client's fallback
	}

	httpx.JSON(w, 200, map[string]any{
		"run": run, "stops": stops, "riders": riders,
		"delayThresholdMinutes": thresholdMin,
	})
}

func runCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermManageRuns,
		"You cannot manage runs in this space", "Failed to create run")
	if mem == nil {
		return
	}
	if !mem.isTypedGroup() {
		httpx.Err(w, 400, "Only a typed space has runs")
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)

	name := strings.TrimSpace(chatsStrOr(b["name"], ""))
	if name == "" || len(name) > runNameMax {
		httpx.Err(w, 400, "name must be 1–120 characters")
		return
	}
	kind := strings.TrimSpace(chatsStrOr(b["kind"], "generic"))
	if !runKinds[kind] {
		httpx.Err(w, 400, "unknown run kind")
		return
	}
	var driverID *string
	if d := strings.TrimSpace(chatsStrOr(b["driverId"], "")); d != "" {
		if !runDriverIsMember(ctx, w, user.ID, chatID, d, "Failed to create run") {
			return
		}
		driverID = &d
	}
	var vehicle *string
	if v := strings.TrimSpace(chatsStrOr(b["vehicleLabel"], "")); v != "" {
		vehicle = &v
	}
	var scheduled *time.Time
	if s := strings.TrimSpace(chatsStrOr(b["scheduledAt"], "")); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			httpx.Err(w, 400, "scheduledAt must be an RFC3339 timestamp")
			return
		}
		scheduled = &t
	}
	requireCode := chatsTruthy(b["requireCode"])

	var id string
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO runs (chat_id, kind, name, driver_id, vehicle_label, scheduled_at,
		                   require_code, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
		[]any{chatID, kind, name, driverID, vehicle, scheduled, requireCode, user.ID},
		&id); err != nil {
		log.Printf("[run POST] %v", err)
		httpx.Err(w, 500, "Failed to create run")
		return
	}

	runLog(ctx, user.ID, id, "run_created", nil, user.ID, "", map[string]any{"kind": kind})
	chatsAudit(ctx, user.ID, chatID, "run_created", nil, map[string]any{"runId": id, "name": name})
	emitx.ChatEvent(chatID, "runs_changed", map[string]any{"runId": id, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"id": id})
}

// runDriverIsMember rejects a driver who is not in the space. Without it a run
// could name any user id, and reassignment would become a way to hand a stranger
// the manifest.
func runDriverIsMember(ctx context.Context, w http.ResponseWriter, uid, chatID, driverID, errMsg string) bool {
	var one int
	err := chatsQRow(ctx, uid,
		`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		[]any{chatID, driverID}, &one)
	if db.NoRows(err) {
		httpx.Err(w, 400, "That driver is not in this space")
		return false
	}
	if err != nil {
		log.Printf("[run driver check] %v", err)
		httpx.Err(w, 500, errMsg)
		return false
	}
	return true
}

// runPatch handles the two mutations a run's header supports: a status
// transition and a reassignment.
//
// They carry DIFFERENT permissions and that separation is the point. A driver
// may start and complete the run they are on (drive_run); only ops may hand a
// run to somebody else (manage_runs). Collapsing them would let a driver
// reassign their route to a colleague mid-morning.
func runPatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	runID := r.PathValue("runId")

	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update run")
	if mem == nil {
		return
	}

	var curStatus string
	var curDriver *string
	err := chatsQRow(ctx, user.ID,
		`SELECT status, driver_id FROM runs WHERE chat_id = $1 AND id = $2`,
		[]any{chatID, runID}, &curStatus, &curDriver)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Run not found")
		return
	}
	if err != nil {
		log.Printf("[run PATCH load] %v", err)
		httpx.Err(w, 500, "Failed to update run")
		return
	}
	isDriver := curDriver != nil && *curDriver == user.ID
	isOps := mem.can(groups.PermManageRuns)

	var b map[string]any
	_ = httpx.Body(r, &b)

	// ── reassignment ──
	if raw, present := b["driverId"]; present {
		if !isOps {
			httpx.Err(w, 403, "Only run management can reassign a run")
			return
		}
		newDriver := strings.TrimSpace(chatsStrOr(raw, ""))
		var driverID *string
		if newDriver != "" {
			if !runDriverIsMember(ctx, w, user.ID, chatID, newDriver, "Failed to update run") {
				return
			}
			driverID = &newDriver
		}
		if err := chatsExecU(ctx, user.ID,
			`UPDATE runs SET driver_id = $3 WHERE chat_id = $1 AND id = $2`,
			chatID, runID, driverID); err != nil {
			if strings.Contains(err.Error(), "uq_runs_one_active_driver") {
				httpx.Err(w, 409, "That driver already has a run in progress")
				return
			}
			log.Printf("[run PATCH driver] %v", err)
			httpx.Err(w, 500, "Failed to update run")
			return
		}
		// The outgoing driver, the incoming driver and every guardian on the run
		// all need to know. The socket event is the fan-out; the run event is the
		// record.
		runLog(ctx, user.ID, runID, "driver_changed", nil, user.ID, "", map[string]any{
			"from": curDriver, "to": driverID,
		})
		chatsAudit(ctx, user.ID, chatID, "run_driver_changed", driverID, map[string]any{"runId": runID})
		emitx.ChatEvent(chatID, "runs_changed", map[string]any{"runId": runID, "by": user.ID})
		// The comment above always promised this fan-out; until now only the
		// socket event delivered it. The push closes the closed-app hole for
		// exactly the three parties the spec names: outgoing driver, incoming
		// driver, and the riders' guardians (extraUsers reaches the drivers).
		outgoing, incoming := "", ""
		if curDriver != nil {
			outgoing = *curDriver
		}
		if driverID != nil {
			incoming = *driverID
		}
		workx.Submit(func() {
			runNotifyRunWide(chatID, runID, "run_driver_changed", "The driver for this run has changed", outgoing, incoming)
		})
	}

	// ── status ──
	if raw, present := b["status"]; present {
		status := strings.TrimSpace(chatsStrOr(raw, ""))
		if !isOps && !(isDriver && (status == "started" || status == "completed")) {
			httpx.Err(w, 403, "You cannot change this run's status")
			return
		}
		if isDriver && !isOps && !mem.can(groups.PermDriveRun) {
			httpx.Err(w, 403, "You cannot drive this run")
			return
		}
		// The transition itself is validated by the trigger in 086 — including
		// the ordering — so an invalid one is a 409 rather than a silent write.
		if err := chatsExecU(ctx, user.ID,
			`UPDATE runs SET status = $3 WHERE chat_id = $1 AND id = $2`,
			chatID, runID, status); err != nil {
			if strings.Contains(err.Error(), "run_status_transition_invalid") {
				httpx.Err(w, 409, "That run cannot go from "+curStatus+" to "+status)
				return
			}
			if strings.Contains(err.Error(), "uq_runs_one_active_driver") {
				httpx.Err(w, 409, "You already have a run in progress")
				return
			}
			if strings.Contains(err.Error(), "runs_status_check") {
				httpx.Err(w, 400, "unknown run status")
				return
			}
			log.Printf("[run PATCH status] %v", err)
			httpx.Err(w, 500, "Failed to update run")
			return
		}
		runLog(ctx, user.ID, runID, "run_"+status, nil, user.ID, "", nil)
		emitx.ChatEvent(chatID, "runs_changed", map[string]any{
			"runId": runID, "status": status, "by": user.ID,
		})
		// The socket event above reaches open apps; the push reaches parents.
		// Spec: guardians are notified on run started and on arrival at the
		// destination — which for the run as a whole is completion.
		if status == "started" {
			workx.Submit(func() { runNotifyRunWide(chatID, runID, "run_started", "The run has started") })
		} else if status == "completed" {
			workx.Submit(func() { runNotifyRunWide(chatID, runID, "run_completed", "The run has been completed") })
			// Bound the throttle map's lifetime to the run's: nothing else ever
			// removes an entry, and a completed run will never be checked again.
			runDelayCheckedAt.Delete(runID)
		}
	}

	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// runStopsSet replaces the stop list wholesale.
//
// Replace rather than patch: stops are an ORDERED sequence, and incremental
// edits to a sequence are where off-by-one reordering bugs live. The client
// sends the list it wants; the server makes that true.
func runStopsSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	runID := r.PathValue("runId")

	if mem := chatsRequirePerm(w, r, groups.PermManageRuns,
		"You cannot manage runs in this space", "Failed to set stops"); mem == nil {
		return
	}

	var b struct {
		Stops []struct {
			Label     string   `json:"label"`
			Lat       *float64 `json:"lat"`
			Lng       *float64 `json:"lng"`
			PlannedAt *string  `json:"plannedAt"`
		} `json:"stops"`
	}
	_ = httpx.Body(r, &b)
	if len(b.Stops) > runStopsMax {
		httpx.Err(w, 400, "too many stops")
		return
	}

	if err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var owned int
		if err := tx.QueryRow(ctx,
			`SELECT 1 FROM runs WHERE id = $1 AND chat_id = $2`, runID, chatID).Scan(&owned); err != nil {
			return err
		}
		// One transaction: a half-replaced stop list is a route that goes
		// somewhere nobody planned.
		if _, err := tx.Exec(ctx, `DELETE FROM run_stops WHERE run_id = $1`, runID); err != nil {
			return err
		}
		for i, s := range b.Stops {
			label := strings.TrimSpace(s.Label)
			if label == "" {
				label = "Stop"
			}
			var planned *time.Time
			if s.PlannedAt != nil && *s.PlannedAt != "" {
				t, err := time.Parse(time.RFC3339, *s.PlannedAt)
				if err != nil {
					return err
				}
				planned = &t
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO run_stops (run_id, seq, label, lat, lng, planned_at)
				 VALUES ($1, $2, $3, $4, $5, $6)`,
				runID, i, label, s.Lat, s.Lng, planned); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "Run not found")
			return
		}
		log.Printf("[run stops PUT] %v", err)
		httpx.Err(w, 500, "Failed to set stops")
		return
	}

	emitx.ChatEvent(chatID, "runs_changed", map[string]any{"runId": runID, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "stops": len(b.Stops)})
}

// runStopArrive marks the vehicle as having reached a stop — the ARRIVED step
// that sits between "driving" and "picked up".
//
// It matters on its own, separately from the pickups that follow it, because it
// is the moment a parent needs to be at the kerb. Without it the first thing a
// parent hears is that their child is already aboard, which is too late to be
// useful, and a stop where nobody was waiting leaves no record that the bus
// actually turned up.
//
// ── WHO MAY DO THIS ──
//
// The ASSIGNED DRIVER of a started run, or someone who manages runs. Not any
// member: "the bus is here" is a claim about the physical world, and a claim
// only the person driving is in a position to make. The driver check is part of
// the UPDATE's WHERE clause rather than a separate read, so two devices racing
// cannot both win.
//
// ── NO COORDINATE IS ACCEPTED ──
//
// Arrival is a TIME, not a place. The stop already knows where it is; the phone
// says when it got there. Taking a lat/lng here would put a vehicle's real
// position in the clear in this database, which is the one thing this whole
// subsystem is built not to do — see the header of spaces_devices.go.
func runStopArrive(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	runID := r.PathValue("runId")
	stopID := r.PathValue("stopId")

	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to record arrival")
	if mem == nil {
		return
	}

	// Idempotent: COALESCE keeps the FIRST arrival time. A driver tapping twice,
	// or a retry after a dropped connection, must not quietly move the record of
	// when the bus actually turned up.
	var arrivedAt time.Time
	var firstTime bool
	err := chatsQRow(ctx, user.ID,
		`WITH prev AS (SELECT arrived_at FROM run_stops WHERE id = $1)
		 UPDATE run_stops st
		    SET arrived_at = COALESCE(st.arrived_at, NOW())
		   FROM runs rn, prev
		  WHERE st.id = $1 AND st.run_id = $2 AND rn.id = $2 AND rn.chat_id = $3
		    AND rn.status = 'started'
		    AND (rn.driver_id = $4 OR vc_space_ops_viewer($3))
		  RETURNING st.arrived_at, prev.arrived_at IS NULL`,
		[]any{stopID, runID, chatID, user.ID}, &arrivedAt, &firstTime)
	if db.NoRows(err) {
		// Deliberately one message for three cases. Distinguishing "not your run"
		// from "no such stop" would let anyone enumerate another school's routes.
		httpx.Err(w, 409, "You cannot mark that stop as reached on a run that is under way")
		return
	}
	if err != nil {
		log.Printf("[stop arrive] %v", err)
		httpx.Err(w, 500, "Failed to record arrival")
		return
	}

	var label string
	if e := chatsQRow(ctx, user.ID,
		`SELECT label FROM run_stops WHERE id = $1`, []any{stopID}, &label); e != nil {
		label = "the stop"
	}
	// Only the FIRST arrival is an event. The timestamp is idempotent, but the
	// log was not: a driver tapping twice wrote "the bus reached this stop"
	// twice, which is a false record of the trip and would double every parent
	// notification. Idempotent has to mean the whole effect, not just the column.
	if firstTime {
		if e := chatsExecU(ctx, user.ID,
			`INSERT INTO run_events (run_id, kind, ref_id, actor_id, detail)
			 VALUES ($1, 'stop_arrived', $2, $3, $4)`,
			runID, stopID, user.ID, `{"label":`+strconv.Quote(label)+`}`); e != nil {
			log.Printf("[stop arrive] event: %v", e)
		}
		emitx.ChatEvent(chatID, "runs_changed", map[string]any{"runId": runID, "by": user.ID})
		workx.Submit(func() { runNotifyStopArrival(chatID, runID, stopID, label) })
		// Reaching stop N is what makes stop N+1 "approaching" — the only
		// position-free way to warn the next stop, and the server holds no
		// position by design.
		workx.Submit(func() { runNotifyNextStop(chatID, runID, stopID) })
	}

	httpx.JSON(w, 200, map[string]any{"ok": true, "arrivedAt": httpx.JSTime(arrivedAt)})
}

// runNotifyStopArrival tells the people waiting at ONE stop that the vehicle is
// there. Scoped to that stop's own pending riders, then through each rider's
// guardian links — the same path runNotifyGuardians uses, so a parent hears
// about their child's stop and no other.
func runNotifyStopArrival(chatID, runID, stopID, label string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	rows, err := db.SysPool.Query(ctx,
		`SELECT rider_id FROM run_riders
		  WHERE run_id = $1 AND stop_id = $2 AND state = 'pending'`,
		runID, stopID)
	if err != nil {
		log.Printf("[stop arrive notify] riders: %v", err)
		return
	}
	riders := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			riders = append(riders, id)
		}
	}
	rows.Close()

	var vehicle string
	if err := db.SysPool.QueryRow(ctx,
		`SELECT COALESCE(vehicle_label, name) FROM runs WHERE id = $1`, runID).Scan(&vehicle); err != nil {
		vehicle = "Your run"
	}
	for _, riderID := range riders {
		runNotifyGuardians(chatID, runID, riderID, "stop_arrived", vehicle+" has reached "+label)
	}
}

// runRidersSet replaces the manifest.
//
// Existing rider STATE is preserved across a manifest edit: adding a child to a
// route at 09:00 must not un-board the children already on the bus.
func runRidersSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	runID := r.PathValue("runId")

	if mem := chatsRequirePerm(w, r, groups.PermManageRuns,
		"You cannot manage runs in this space", "Failed to set manifest"); mem == nil {
		return
	}

	var b struct {
		Riders []struct {
			RiderID string  `json:"riderId"`
			StopID  *string `json:"stopId"`
		} `json:"riders"`
	}
	_ = httpx.Body(r, &b)

	if err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var owned int
		if err := tx.QueryRow(ctx,
			`SELECT 1 FROM runs WHERE id = $1 AND chat_id = $2`, runID, chatID).Scan(&owned); err != nil {
			return err
		}
		keep := make([]string, 0, len(b.Riders))
		for _, rd := range b.Riders {
			if rd.RiderID == "" {
				continue
			}
			// The rider must be on THIS space's roster; the subselect is what
			// stops a manifest from naming a child at another school.
			//
			// The rows-affected check is what makes that rejection VISIBLE. This
			// used to report `len(b.Riders)` regardless, so a manifest naming a
			// child who was not on the roster answered "12 riders assigned" while
			// storing eleven — and the missing child was noticed by nobody until
			// the bus left without them. A rejected rider now fails the whole
			// manifest rather than being quietly dropped from it.
			tag, err := tx.Exec(ctx,
				`INSERT INTO run_riders (run_id, rider_id, stop_id)
				 SELECT $1, $2, $3
				  WHERE EXISTS (SELECT 1 FROM space_roster
				                 WHERE id = $2 AND chat_id = $4 AND archived_at IS NULL)
				 ON CONFLICT (run_id, rider_id) DO UPDATE SET stop_id = EXCLUDED.stop_id`,
				runID, rd.RiderID, rd.StopID, chatID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errRiderNotOnRoster
			}
			keep = append(keep, rd.RiderID)
		}
		_, err := tx.Exec(ctx,
			`DELETE FROM run_riders WHERE run_id = $1 AND NOT (rider_id = ANY($2::uuid[]))`,
			runID, keep)
		return err
	}); err != nil {
		if errors.Is(err, errRiderNotOnRoster) {
			httpx.Err(w, 400, "Everyone on a run must be on this space's roster first")
			return
		}
		if db.NoRows(err) {
			httpx.Err(w, 404, "Run not found")
			return
		}
		log.Printf("[run riders PUT] %v", err)
		httpx.Err(w, 500, "Failed to set manifest")
		return
	}

	emitx.ChatEvent(chatID, "runs_changed", map[string]any{"runId": runID, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "riders": len(b.Riders)})
}

// runRiderState is the driver's one write: boarded, dropped, absent, no_show.
//
// IDEMPOTENT on a client-supplied transitionId. A driver marking a child boarded
// on a moving bus with two bars of signal WILL retry, and two boarding events
// for one child turn the manifest from a record into a story. The unique index
// on (run_id, transition_id) makes the retry a no-op at the database level, not
// at the handler's discretion.
func runRiderState(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	runID := r.PathValue("runId")
	riderID := r.PathValue("riderId")

	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update rider")
	if mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	state := strings.TrimSpace(chatsStrOr(b["state"], ""))
	if !runRiderStates[state] {
		httpx.Err(w, 400, "state must be boarded, dropped, absent or no_show")
		return
	}
	transitionID := strings.TrimSpace(chatsStrOr(b["transitionId"], ""))
	code := strings.TrimSpace(chatsStrOr(b["code"], ""))
	note := strings.TrimSpace(chatsStrOr(b["note"], ""))
	if len(note) > runNoteMax {
		httpx.Err(w, 400, "note is too long")
		return
	}

	var (
		driverID    *string
		runStatus   string
		requireCode bool
	)
	if err := chatsQRow(ctx, user.ID,
		`SELECT driver_id, status, require_code FROM runs WHERE id = $1 AND chat_id = $2`,
		[]any{runID, chatID}, &driverID, &runStatus, &requireCode); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "Run not found")
			return
		}
		log.Printf("[rider state load] %v", err)
		httpx.Err(w, 500, "Failed to update rider")
		return
	}

	// Only the assigned driver or ops may move a rider. Holding drive_run is not
	// enough on its own — it must be THIS run.
	isDriver := driverID != nil && *driverID == user.ID
	if !(isDriver && mem.can(groups.PermDriveRun)) && !mem.can(groups.PermManageRuns) {
		httpx.Err(w, 403, "You cannot mark riders on this run")
		return
	}
	if runStatus != "started" {
		httpx.Err(w, 409, "That run is not in progress")
		return
	}

	// Handover verification, when the run asks for it. Checked SERVER-side
	// against the roster entry: a client that skips the prompt is refused.
	if requireCode && (state == "boarded" || state == "dropped") {
		var want *string
		if err := chatsQRow(ctx, user.ID,
			`SELECT handover_code FROM space_roster WHERE id = $1 AND chat_id = $2`,
			[]any{riderID, chatID}, &want); err != nil && !db.NoRows(err) {
			log.Printf("[rider state code] %v", err)
			httpx.Err(w, 500, "Failed to update rider")
			return
		}
		if want != nil && *want != "" && code != *want {
			httpx.Err(w, 403, "Handover code does not match")
			return
		}
	}

	var applied bool
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		// The event goes in FIRST. Its unique index is the idempotency gate, so
		// on a retry the insert affects nothing and the state update below is
		// skipped — rather than the state being rewritten with a second actor and
		// a later timestamp.
		if transitionID != "" {
			tag, err := tx.Exec(ctx,
				`INSERT INTO run_events (run_id, kind, ref_id, actor_id, transition_id, detail)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (run_id, transition_id) WHERE transition_id IS NOT NULL DO NOTHING`,
				runID, "rider_"+state, riderID, user.ID, transitionID,
				runEventDetail(note))
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return nil // already applied; a retry, not a new transition
			}
		} else {
			if _, err := tx.Exec(ctx,
				`INSERT INTO run_events (run_id, kind, ref_id, actor_id, detail)
				 VALUES ($1, $2, $3, $4, $5)`,
				runID, "rider_"+state, riderID, user.ID,
				runEventDetail(note)); err != nil {
				return err
			}
		}
		applied = true
		_, err := tx.Exec(ctx,
			`UPDATE run_riders
			    SET state = $3, state_at = NOW(), actor_id = $4,
			        note = NULLIF($5, '')
			  WHERE run_id = $1 AND rider_id = $2`,
			runID, riderID, state, user.ID, note)
		return err
	})
	if err != nil {
		log.Printf("[rider state] %v", err)
		httpx.Err(w, 500, "Failed to update rider")
		return
	}

	if applied {
		// Content-free: the rider id is enough for entitled clients to refetch.
		// The socket event fans out to a room, and a room is the wrong
		// granularity for a child's name.
		emitx.ChatEvent(chatID, "run_rider_changed", map[string]any{
			"runId": runID, "state": state, "by": user.ID,
		})
		// The push IS addressed per user, so it can say who it is about — to the
		// people a link path actually reaches. Off the request path: a driver at
		// a kerb waits for the database write, never for Expo.
		vehicle := "Your run"
		if err := chatsQRow(ctx, user.ID,
			`SELECT COALESCE(vehicle_label, name) FROM runs WHERE id = $1`,
			[]any{runID}, &vehicle); err != nil {
			log.Printf("[rider state] vehicle label: %v", err)
		}
		workx.Submit(func() { runNotifyGuardians(chatID, runID, riderID, state, vehicle) })
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "applied": applied})
}

// runEvents is the replay: the run's own append-only log.
//
// This is the honest half of "route replay". The road-level breadcrumb only
// exists on a device that received the sealed pings live; what the server can
// always answer is when the bus reached each stop and what happened to each
// rider, with times and actors.
func runEvents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	runID := r.PathValue("runId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load run history"); mem == nil {
		return
	}

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT id, kind, ref_id, actor_id, at, detail
		   FROM run_events
		  WHERE run_id = $1 AND vc_run_visible($1)
		  ORDER BY at, id LIMIT 2000`,
		[]any{runID}, func(rows pgx.Rows) error {
			var (
				id             int64
				kind           string
				refID, actorID *string
				at             time.Time
				detail         map[string]any
			)
			if e := rows.Scan(&id, &kind, &refID, &actorID, &at, &detail); e != nil {
				return e
			}
			out = append(out, map[string]any{
				"id": id, "kind": kind, "refId": refID, "actorId": actorID,
				"at": httpx.JSTime(at), "detail": detail,
			})
			return nil
		})
	if err != nil {
		log.Printf("[run events GET] %v", err)
		httpx.Err(w, 500, "Failed to load run history")
		return
	}
	httpx.JSON(w, 200, out)
}

// runDutySet records the caller's own duty state for this space.
//
// Your own only. A dispatcher marking a driver "on duty" from the office is a
// dispatcher asserting something about somebody else's day; if that is ever
// wanted it should be a request the driver accepts, not a write.
func runDutySet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to set duty state"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	duty := strings.TrimSpace(chatsStrOr(b["dutyState"], ""))
	var stored *string
	if duty != "" {
		if !runDutyStates[duty] {
			httpx.Err(w, 400, "dutyState must be on_duty, on_break or off_duty")
			return
		}
		stored = &duty
	}

	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET duty_state = $3 WHERE chat_id = $1 AND user_id = $2`,
		chatID, user.ID, stored); err != nil {
		log.Printf("[duty PATCH] %v", err)
		httpx.Err(w, 500, "Failed to set duty state")
		return
	}
	emitx.ChatEvent(chatID, "duty_changed", map[string]any{"userId": user.ID, "dutyState": duty})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// runNotifyGuardians pushes a rider's state change to the people entitled to
// know about THAT rider (Spaces & Operations, S5.8).
//
// ── why the recipient set is computed here and not on the socket ──
//
// The socket event this accompanies is deliberately content-free: it names the
// run and the new state, never the rider, because it fans out to a room and a
// room is the wrong granularity for a child's name. The push is the opposite —
// it is addressed per user, so it can and must say who it is about.
//
// The recipient set is the REVERSE of the visibility walk: everyone who has a
// link path TO this rider, which is their guardians plus anyone supervising
// those guardians. Depth-bounded exactly like space_visible_roster, and for the
// same reason.
//
// This is the query that makes "a notification never names an unlinked rider"
// true. It is not a filter applied to a broadcast; there is no broadcast.
// pushTokensFor returns the push tokens for members of chatID among userIDs
// who have not left and have not muted the chat. Identical query, previously
// duplicated between runNotifyGuardians and runNotifyRunWide — the next
// change to token-eligibility rules (a new opt-out, dead-token pruning) now
// lands once instead of needing two synchronized edits.
func pushTokensFor(ctx context.Context, chatID string, userIDs []string) ([]string, error) {
	rows, err := db.SysPool.Query(ctx,
		`SELECT d.push_token
		   FROM devices d
		   JOIN chat_members cm ON cm.user_id = d.user_id AND cm.chat_id = $2
		  WHERE d.user_id = ANY($1::uuid[])
		    AND cm.left_at IS NULL
		    AND cm.muted = FALSE
		    AND d.push_token IS NOT NULL`,
		userIDs, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tokens := []string{}
	for rows.Next() {
		var t *string
		if err := rows.Scan(&t); err == nil && t != nil {
			tokens = append(tokens, *t)
		}
	}
	return tokens, nil
}

func runNotifyGuardians(chatID, runID, riderID, state, vehicle string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var riderName string
	if err := db.SysPool.QueryRow(ctx,
		`SELECT display_name FROM space_roster WHERE id = $1 AND chat_id = $2`,
		riderID, chatID).Scan(&riderName); err != nil {
		log.Printf("[run notify] rider %s: %v", riderID, err)
		return
	}

	rows, err := db.SysPool.Query(ctx,
		`WITH RECURSIVE up AS (
		   SELECT l.subject_id, 1 AS depth
		     FROM space_links l
		    WHERE l.chat_id = $1 AND l.object_id = $2
		   UNION
		   SELECT l.subject_id, up.depth + 1
		     FROM up
		     JOIN space_links l ON l.chat_id = $1 AND l.object_id = up.subject_id
		    WHERE up.depth < 6
		 )
		 SELECT DISTINCT r.user_id
		   FROM up
		   JOIN space_roster r ON r.id = up.subject_id
		  WHERE r.user_id IS NOT NULL AND r.archived_at IS NULL`,
		chatID, riderID)
	if err != nil {
		log.Printf("[run notify] recipients: %v", err)
		return
	}
	recipients := []string{}
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err == nil {
			recipients = append(recipients, uid)
		}
	}
	rows.Close()
	if len(recipients) == 0 {
		return // nobody is linked to this rider; there is no one to tell
	}

	tokens, err := pushTokensFor(ctx, chatID, recipients)
	if err != nil {
		log.Printf("[run notify] tokens: %v", err)
		return
	}
	if len(tokens) == 0 {
		return
	}

	body := runNotifyText(riderName, state, vehicle)
	chatsSendExpoPush(ctx, tokens, vehicle, body,
		map[string]any{"type": "run_rider", "chatId": chatID, "runId": runID}, "default")
}

// runNotifyText is the sentence a guardian actually reads.
//
// Plain language, and it names the ONE rider this push is about. "Not present"
// rather than "absent": a child who was not at the stop is a fact to follow up,
// and the phrasing should not accuse anyone before anyone has looked.
func runNotifyText(rider, state, vehicle string) string {
	switch state {
	case "boarded":
		return rider + " is on board " + vehicle
	case "dropped":
		return rider + " has been dropped off"
	case "absent":
		return rider + " was not at the stop"
	case "no_show":
		return rider + " did not travel today"
	// The two run-progress states. `vehicle` carries the stop context here
	// ("Bus 7 · next stop Market Road") because the sentence needs it and the
	// caller already had to look it up.
	case "approaching":
		return rider + "'s stop is next — " + vehicle
	case "delayed":
		return rider + "'s ride is running late — " + vehicle
	default:
		return rider + ": " + state
	}
}

// runNotifyRunWide pushes ONE message about the run as a whole — started,
// completed, driver changed, emergency — to every guardian linked to any rider
// on it, plus any extraUsers (the outgoing and incoming driver on a
// reassignment). Guardians of two siblings on the same bus get one push, not
// two: recipients are deduped at the user level.
//
// This closes the closed-app hole the spec audit found: these events used to
// fan out only as emitx socket events, which reach nobody whose app is not
// open — and "the bus started without my child" is precisely the message for a
// parent who is not watching the screen.
func runNotifyRunWide(chatID, runID, kind, body string, extraUsers ...string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var vehicle string
	if err := db.SysPool.QueryRow(ctx,
		`SELECT COALESCE(vehicle_label, name) FROM runs WHERE id = $1`, runID).Scan(&vehicle); err != nil {
		vehicle = "Your run"
	}

	// Every guardian of every rider on the run — the same recursive link walk
	// runNotifyGuardians does for one rider, widened to the manifest and
	// deduped. Scoping property preserved: only people LINKED to a rider on
	// this run are reached, never the whole space.
	rows, err := db.SysPool.Query(ctx,
		`WITH RECURSIVE up AS (
		   SELECT l.subject_id, 1 AS depth
		     FROM run_riders rr
		     JOIN space_links l ON l.chat_id = $1 AND l.object_id = rr.rider_id
		    WHERE rr.run_id = $2
		   UNION
		   SELECT l.subject_id, up.depth + 1
		     FROM up
		     JOIN space_links l ON l.chat_id = $1 AND l.object_id = up.subject_id
		    WHERE up.depth < 6
		 )
		 SELECT DISTINCT r.user_id
		   FROM up
		   JOIN space_roster r ON r.id = up.subject_id
		  WHERE r.user_id IS NOT NULL AND r.archived_at IS NULL`,
		chatID, runID)
	if err != nil {
		log.Printf("[run-wide notify] recipients: %v", err)
		return
	}
	seen := map[string]bool{}
	recipients := []string{}
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err == nil && !seen[uid] {
			seen[uid] = true
			recipients = append(recipients, uid)
		}
	}
	rows.Close()
	for _, uid := range extraUsers {
		if uid != "" && !seen[uid] {
			seen[uid] = true
			recipients = append(recipients, uid)
		}
	}
	if len(recipients) == 0 {
		return
	}

	tokens, err := pushTokensFor(ctx, chatID, recipients)
	if err != nil {
		log.Printf("[run-wide notify] tokens: %v", err)
		return
	}
	if len(tokens) == 0 {
		return
	}

	// An emergency rides the sos channel like incidents do — a real separation
	// with its own sound, not a louder string.
	channel := "default"
	if kind == "run_emergency" {
		channel = "sos"
	}
	chatsSendExpoPush(ctx, tokens, vehicle, body,
		map[string]any{"type": kind, "chatId": chatID, "runId": runID}, channel)
}

// runNotifyNextStop warns the NEXT stop's pending riders that the vehicle is
// approaching, at the moment it arrives at the stop before theirs. The server
// holds no position — by design — so "approaching" is derived from the stop
// sequence, which it does hold: reaching stop N is the fact that makes stop
// N+1 next.
func runNotifyNextStop(chatID, runID, arrivedStopID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var nextStopID, nextLabel string
	err := db.SysPool.QueryRow(ctx,
		`SELECT n.id, n.label
		   FROM run_stops cur
		   JOIN run_stops n ON n.run_id = cur.run_id AND n.seq > cur.seq
		  WHERE cur.id = $1 AND n.arrived_at IS NULL
		  ORDER BY n.seq
		  LIMIT 1`, arrivedStopID).Scan(&nextStopID, &nextLabel)
	if err != nil {
		return // last stop, or nothing pending — no one to warn
	}

	rows, err := db.SysPool.Query(ctx,
		`SELECT rider_id FROM run_riders
		  WHERE run_id = $1 AND stop_id = $2 AND state = 'pending'`,
		runID, nextStopID)
	if err != nil {
		log.Printf("[next stop notify] riders: %v", err)
		return
	}
	riders := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			riders = append(riders, id)
		}
	}
	rows.Close()
	if len(riders) == 0 {
		return // nobody pending at the next stop — nothing to warn, no vehicle lookup needed
	}

	var vehicle string
	if err := db.SysPool.QueryRow(ctx,
		`SELECT COALESCE(vehicle_label, name) FROM runs WHERE id = $1`, runID).Scan(&vehicle); err != nil {
		vehicle = "Your run"
	}
	for _, riderID := range riders {
		runNotifyGuardians(chatID, runID, riderID, "approaching", vehicle+" · next stop "+nextLabel)
	}
}

// runCheckDelays is the server-side half of "run delayed beyond threshold".
// The client's isDelayed() can only tell a guardian who is LOOKING; this runs
// on the driver's heartbeat ping and reaches the ones who are not.
//
// No position is used — the server has none, by design. A stop is overdue when
// its planned_at has passed by more than the space's threshold and the vehicle
// has not arrived, which is derivable entirely from state the server holds.
// run_events(kind='run_delayed', ref_id=stop) is the dedup ledger: the insert
// is the claim, and only the heartbeat that wins the insert sends the push, so
// a ping every few seconds still means one notification per stop, ever.
// runDelayCheckedAt throttles runCheckDelays per run. This session's own
// change made concurrent heartbeats routine — a 60s foreground timer AND a new
// 15s background pingRun for the same driver — so a threshold measured in
// MINUTES was being evaluated up to 5x/minute per active run, almost always
// finding nothing. Purely a query-cost throttle, not a correctness mechanism:
// the ON CONFLICT in the INSERT below is what actually prevents a duplicate
// push, so a multi-replica deployment (each with its own copy of this map) is
// still correct, just slightly less throttled — never incorrect.
var runDelayCheckedAt sync.Map // runID -> time.Time of the last check

const runDelayCheckMinInterval = 60 * time.Second

func runCheckDelays(chatID, runID, actorID string) {
	if last, ok := runDelayCheckedAt.Load(runID); ok {
		if time.Since(last.(time.Time)) < runDelayCheckMinInterval {
			return
		}
	}
	runDelayCheckedAt.Store(runID, time.Now())

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Predicate mirrored verbatim in migrations/tests/121_run_delay_threshold_test.sql
	// — if you change one, change both.
	rows, err := db.SysPool.Query(ctx,
		`SELECT st.id, st.label
		   FROM run_stops st
		   JOIN runs r ON r.id = st.run_id
		  WHERE st.run_id = $1
		    AND r.status = 'started'
		    AND st.arrived_at IS NULL
		    AND st.planned_at IS NOT NULL
		    AND st.planned_at < NOW() - make_interval(
		          mins => (SELECT run_delay_threshold_minutes FROM chats WHERE id = r.chat_id))
		    AND NOT EXISTS (
		          SELECT 1 FROM run_events e
		           WHERE e.run_id = st.run_id AND e.kind = 'run_delayed' AND e.ref_id = st.id)`,
		runID)
	if err != nil {
		log.Printf("[run delay] overdue: %v", err)
		return
	}
	type overdue struct{ id, label string }
	stops := []overdue{}
	for rows.Next() {
		var o overdue
		if err := rows.Scan(&o.id, &o.label); err == nil {
			stops = append(stops, o)
		}
	}
	rows.Close()
	if len(stops) == 0 {
		return
	}

	// Hoisted out of the loop: runID is invariant across every overdue stop in
	// this sweep, so re-querying it per stop (as this used to) was N identical
	// queries for one delay-check pass.
	var vehicle string
	if err := db.SysPool.QueryRow(ctx,
		`SELECT COALESCE(vehicle_label, name) FROM runs WHERE id = $1`, runID).Scan(&vehicle); err != nil {
		vehicle = "Your run"
	}

	for _, st := range stops {
		// The insert IS the lock — but "INSERT ... WHERE NOT EXISTS" is NOT
		// atomic under READ COMMITTED: two concurrent heartbeats (the
		// foreground driver screen pings every 60s, the background task pings
		// every 15s — both can land in the same instant) can both evaluate
		// NOT EXISTS as true before either commits, and both insert, and both
		// notify. Found by review, after this file shipped both heartbeat
		// sources in the same change.
		//
		// The actual lock is the existing partial unique index
		// uq_run_events_transition ON (run_id, transition_id) — reused here
		// with a synthesized, deterministic transition_id rather than a new
		// migration. ON CONFLICT DO NOTHING is atomic: the database itself
		// admits only one of the two concurrent inserts.
		var eventID int64
		err := db.SysPool.QueryRow(ctx,
			`INSERT INTO run_events (run_id, kind, ref_id, actor_id, transition_id)
			 VALUES ($1, 'run_delayed', $2, $3, $4)
			 ON CONFLICT (run_id, transition_id) WHERE transition_id IS NOT NULL DO NOTHING
			 RETURNING id`, runID, st.id, actorID, "delayed:"+st.id).Scan(&eventID)
		if err != nil {
			// ErrNoRows is the expected "another heartbeat already claimed this
			// stop" outcome. ANY OTHER error is a real fault and must be logged,
			// not silently swallowed: an earlier version of this statement
			// omitted the partial index's WHERE predicate and failed with
			// "no unique or exclusion constraint matching the ON CONFLICT
			// specification" on every call — and because that was treated as a
			// lost race, delay notifications were dead with zero trace.
			if !db.NoRows(err) {
				log.Printf("[run delay] claim stop %s: %v", st.id, err)
			}
			continue
		}
		emitx.ChatEvent(chatID, "runs_changed", map[string]any{"runId": runID})

		// Affected guardians: this stop's own pending riders. As the delay
		// swallows later stops they become overdue in turn, each with its own
		// one-shot notification.
		riders, err := db.SysPool.Query(ctx,
			`SELECT rider_id FROM run_riders
			  WHERE run_id = $1 AND stop_id = $2 AND state = 'pending'`, runID, st.id)
		if err != nil {
			continue
		}
		ids := []string{}
		for riders.Next() {
			var id string
			if err := riders.Scan(&id); err == nil {
				ids = append(ids, id)
			}
		}
		riders.Close()

		for _, riderID := range ids {
			runNotifyGuardians(chatID, runID, riderID, "delayed", vehicle+" · "+st.label)
		}
	}
}

// runLog appends to the run's event log. Best-effort like chatsAudit: losing a
// log line is bad, failing the driver's tap because logging hiccuped is worse.
func runLog(ctx context.Context, uid, runID, kind string, refID *string, actorID, transitionID string, detail map[string]any) {
	var tid *string
	if transitionID != "" {
		tid = &transitionID
	}
	if err := chatsExecU(ctx, uid,
		`INSERT INTO run_events (run_id, kind, ref_id, actor_id, transition_id, detail)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		runID, kind, refID, actorID, tid, detail); err != nil {
		log.Printf("[run log] %s on %s: %v", kind, runID, err)
	}
}
