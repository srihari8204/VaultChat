// spaces_locations.go — the all-space location platform (migration 103).
//
// ARCHITECTURE DECISION REVERSAL (owner-directed, 2026-08-14). Earlier space
// modules refused to store a person's coordinates and said so loudly in their
// headers; that decision is superseded FOR SPACE LOCATION DATA. The boundary
// is now AUTHORIZATION, enforced HERE, in SQL, on every read — because RLS is
// inert in this deployment (superuser connection; see spaces_roster.go) the
// WHERE clause in this file is the only thing between a viewer and another
// person's position. Every read composes the same predicates the rest of the
// ops schema already trusts: vc_space_ops_viewer, space_can_view_roster,
// vc_run_visible.
//
// One store, one ingest, one policy — the space TYPE only changes which
// predicate grants visibility (see locVisibleWhere / locCanSee):
//   family/generic  every active member sees every active member (cap 10 for
//                   family, enforced by the migration-070 member trigger)
//   school          self · ops (rank floor) · linked guardians/teachers ·
//                   the driver of a started run the viewer may watch
//   office/business self · ops · linked supervisors · active-run driver
//   transport       self · ops · active-run driver
//
// The sealed E2EE relay (live_location_update) keeps working unchanged;
// clients that publish here do so additively.

package routes

import (
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

const (
	locBatchMax   = 120             // points per upload; a background queue flush
	locFutureSlop = 2 * time.Minute // device clocks lie a little; more is a replay
	locMaxAge     = 7 * 24 * time.Hour
	locSpeedMax   = 150.0 // m/s — faster than any car; rejects corrupt fixes
	locHistoryMax = 500   // rows per history page
)

func RegisterSpaceLocationsOnID(id *http.ServeMux) {
	// Full paths: the /chats/{id}/ subtree forward re-matches the whole URL.
	id.HandleFunc("POST /chats/{id}/locations", httpx.RequireAuth(locIngest))
	id.HandleFunc("POST /chats/{id}/locations/start", httpx.RequireAuth(locStart))
	id.HandleFunc("POST /chats/{id}/locations/stop", httpx.RequireAuth(locStop))
	id.HandleFunc("GET /chats/{id}/locations/latest", httpx.RequireAuth(locLatest))
	id.HandleFunc("GET /chats/{id}/locations/history", httpx.RequireAuth(locHistory))
}

// ── pure policy ───────────────────────────────────────────────────────
//
// locCanSee is the decision table, kept pure so spaces_locations_policy_test.go
// can walk every (space family × viewer relationship) combination without a
// database. The SQL in locVisibleWhere grants exactly these rules; the WHERE
// clause is the enforcement, this function is its testable specification.

type locViewer struct {
	IsSelf   bool // viewer is the target
	IsMember bool // active membership in the space (left_at IS NULL)
	IsOps    bool // rank ≥ moderator (the vc_space_ops_viewer floor)
	Linked   bool // space_links walk reaches the target (guardian/supervisor/teacher)
	RunLink  bool // target is the driver of a STARTED run the viewer may watch
}

func locCanSee(spaceFamily string, v locViewer) bool {
	if !v.IsMember {
		return false // non-members and removed members see nothing, ever
	}
	if v.IsSelf {
		return true // your own position is always yours
	}
	switch spaceFamily {
	case "family", "generic":
		return true // mutual: every member sees every member (spec: N-1 each)
	case "school", "office", "transport":
		return v.IsOps || v.Linked || v.RunLink
	default:
		// An unknown space family fails CLOSED for non-self reads.
		return false
	}
}

// locVisibleWhere returns the SQL predicate enforcing locCanSee for rows
// aliased `sl`, with $1 = chat id and $2 = viewer user id. The caller has
// already proven the VIEWER's active membership (chatsRequireMem).
func locVisibleWhere(spaceFamily string) string {
	switch spaceFamily {
	case "family", "generic":
		// Always-true, but $2 must still APPEAR: pgx rejects a statement that
		// binds more parameters than the SQL references, and leaves $2 untyped
		// in EXISTS subqueries otherwise.
		return "$2::uuid IS NOT NULL"
	default: // school / office / transport / unknown → only the explicit grants
		return `(
		    sl.user_id = $2
		 OR vc_space_ops_viewer($1)
		 OR EXISTS (
		      SELECT 1 FROM space_roster tr
		      WHERE tr.chat_id = $1 AND tr.user_id = sl.user_id
		        AND space_can_view_roster($1, $2, tr.id))
		 OR EXISTS (
		      SELECT 1 FROM runs rn
		      WHERE rn.chat_id = $1 AND rn.driver_id = sl.user_id
		        AND rn.status = 'started' AND vc_run_visible(rn.id)))`
	}
}

// locSpaceFamily mirrors lib/spaces/layout.ts familyOf() — substring rules,
// duplicated deliberately (Go cannot import the client) and pinned against
// drift by the policy test.
func locSpaceFamily(groupType string) string {
	t := strings.ToLower(strings.TrimSpace(groupType))
	if t == "" {
		return "generic"
	}
	if strings.Contains(t, "transport") && !strings.Contains(t, "school") {
		return "transport"
	}
	if strings.Contains(t, "school") || strings.Contains(t, "college") {
		return "school"
	}
	if strings.Contains(t, "office") || strings.Contains(t, "business") || strings.Contains(t, "colleague") {
		return "office"
	}
	if t == "family" {
		return "family"
	}
	return "generic"
}

func locMemFamily(mem *chatsMem) string {
	gt := ""
	if mem.GroupType != nil {
		gt = *mem.GroupType
	}
	return locSpaceFamily(gt)
}

// ── ingest ────────────────────────────────────────────────────────────

type locPoint struct {
	Lat    float64  `json:"lat"`
	Lng    float64  `json:"lng"`
	Ts     int64    `json:"ts"` // epoch ms of the FIX
	Acc    *float64 `json:"acc"`
	Alt    *float64 `json:"alt"`
	Spd    *float64 `json:"spd"`
	Hdg    *float64 `json:"hdg"`
	Bat    *int16   `json:"bat"`
	Source string   `json:"src"`
}

func locValidPoint(p locPoint, now time.Time) bool {
	if p.Lat < -90 || p.Lat > 90 || p.Lng < -180 || p.Lng > 180 {
		return false
	}
	if p.Lat == 0 && p.Lng == 0 {
		return false // the null-island fix is a failed provider, not a place
	}
	ts := time.UnixMilli(p.Ts)
	if ts.After(now.Add(locFutureSlop)) || ts.Before(now.Add(-locMaxAge)) {
		return false
	}
	if p.Spd != nil && (*p.Spd < 0 || *p.Spd > locSpeedMax || math.IsNaN(*p.Spd)) {
		return false
	}
	if p.Acc != nil && (*p.Acc < 0 || math.IsNaN(*p.Acc)) {
		return false
	}
	return true
}

// POST /chats/{id}/locations  {points:[…]} — batched, deduplicated, validated.
// Uploading is the act of sharing: there is no server-side sharing flag to
// desync from the client's. A client that stops sharing stops uploading.
func locIngest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	rl := redisx.Consume(ctx, "locingest:"+user.ID, 30, 60)
	if !rl.Allowed {
		httpx.Err(w, 429, "Too many location uploads", map[string]any{"retryAfter": rl.ResetInSec})
		return
	}

	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to store location")
	if mem == nil {
		return
	}

	var body struct {
		Points []locPoint `json:"points"`
	}
	if err := httpx.Body(r, &body); err != nil || len(body.Points) == 0 {
		httpx.Err(w, 400, "points[] required")
		return
	}
	if len(body.Points) > locBatchMax {
		httpx.Err(w, 400, "Too many points in one batch")
		return
	}

	deviceID := strings.TrimSpace(r.Header.Get("X-Device-Id"))
	now := time.Now()

	// Stamped from the member row so history keeps the truth of the moment —
	// "was this fix during duty" must not depend on present-tense state.
	// The same read enforces the EXPLICIT sharing stop (migration 104): after
	// /locations/stop the server refuses uploads, so a stale background task
	// or a buggy client cannot keep publishing someone who said no.
	dutyState := ""
	var sharingEnabled *bool
	_ = chatsQRow(ctx, user.ID,
		`SELECT COALESCE(duty_state,''), location_sharing_enabled
		   FROM chat_members WHERE chat_id=$1 AND user_id=$2`,
		[]any{chatID, user.ID}, &dutyState, &sharingEnabled)
	if sharingEnabled != nil && !*sharingEnabled {
		httpx.Err(w, 409, "Location sharing is off")
		return
	}

	accepted := 0
	var newest *locPoint
	for i := range body.Points {
		p := body.Points[i]
		if !locValidPoint(p, now) {
			continue
		}
		src := p.Source
		if src != "gps" && src != "network" && src != "fused" && src != "manual" {
			src = "gps"
		}
		// RETURNING id turns the conflict-skip into a detectable no-row: an
		// offline re-upload of the same fix counts as received, not accepted.
		var insertedID int64
		err := chatsQRow(ctx, user.ID,
			`INSERT INTO space_locations
			   (chat_id, user_id, device_id, lat, lng, accuracy_m, altitude_m,
			    speed_mps, heading_deg, battery, ts, source, duty_state)
			 VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9,$10,to_timestamp($11/1000.0),$12,NULLIF($13,''))
			 ON CONFLICT (chat_id, user_id, ts) DO NOTHING
			 RETURNING id`,
			[]any{chatID, user.ID, deviceID, p.Lat, p.Lng, p.Acc, p.Alt,
				p.Spd, p.Hdg, p.Bat, p.Ts, src, dutyState}, &insertedID)
		if db.NoRows(err) {
			continue // duplicate — already stored
		}
		if err != nil {
			log.Printf("[locations POST] %v", err)
			httpx.Err(w, 500, "Failed to store location")
			return
		}
		accepted++
		if newest == nil || p.Ts > newest.Ts {
			newest = &body.Points[i]
		}
	}

	// One realtime event per batch — the newest accepted point. The room is
	// the audience for family/generic (mutual visibility); for the gated
	// space families the event carries NO coordinate — just "fresh data for
	// this member exists" — so viewers refetch /latest under the real policy.
	if newest != nil {
		fam := locMemFamily(mem)
		payload := map[string]any{"chatId": chatID, "userId": user.ID, "ts": newest.Ts}
		if fam == "family" || fam == "generic" {
			payload["lat"] = newest.Lat
			payload["lng"] = newest.Lng
			if newest.Spd != nil {
				payload["spd"] = *newest.Spd
			}
			if newest.Bat != nil {
				payload["bat"] = *newest.Bat
			}
			if newest.Acc != nil {
				payload["acc"] = *newest.Acc
			}
		}
		emitx.ToRooms([]string{"chat:" + chatID}, "space_location", payload)
	}

	httpx.JSON(w, 200, map[string]any{"accepted": accepted, "received": len(body.Points)})
}

// locSetSharing records the member's OWN explicit sharing choice (migration
// 104) and tells the room. Only the authenticated member's row is touched —
// there is deliberately no admin variant: consent cannot be granted for
// someone else (spec §9), and the ingest guard makes the server, not the
// client, the thing that stops a stale publisher after an explicit stop.
func locSetSharing(w http.ResponseWriter, r *http.Request, enabled bool) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed"); mem == nil {
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members
		    SET location_sharing_enabled = $3, location_sharing_changed_at = NOW()
		  WHERE chat_id = $1 AND user_id = $2`,
		chatID, user.ID, enabled); err != nil {
		log.Printf("[locations sharing] %v", err)
		httpx.Err(w, 500, "Failed")
		return
	}
	now := time.Now().UnixMilli()
	emitx.ToRooms([]string{"chat:" + chatID}, "space_location_sharing",
		map[string]any{"chatId": chatID, "userId": user.ID, "sharing": enabled, "ts": now})
	if !enabled {
		// Compatibility with clients that predate the sharing event: the old
		// stop event still clears their live marker.
		emitx.ToRooms([]string{"chat:" + chatID}, "space_location_stop",
			map[string]any{"chatId": chatID, "userId": user.ID})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "sharing": enabled})
}

// POST /chats/{id}/locations/start — the member (re-)enabled sharing. The
// old last-known point does NOT become live from this: only a fresh fix does.
func locStart(w http.ResponseWriter, r *http.Request) { locSetSharing(w, r, true) }

// POST /chats/{id}/locations/stop — the member stopped sharing. Stored
// history and the last-known point are UNTOUCHED (nothing is deleted); only
// live visibility changes, and further uploads are refused until /start.
func locStop(w http.ResponseWriter, r *http.Request) { locSetSharing(w, r, false) }

// ── reads ─────────────────────────────────────────────────────────────

// GET /chats/{id}/locations/latest — newest point per VISIBLE active member.
func locLatest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load locations")
	if mem == nil {
		return
	}

	type row struct {
		UserID string   `json:"userId"`
		Lat    float64  `json:"lat"`
		Lng    float64  `json:"lng"`
		Acc    *float64 `json:"acc"`
		Spd    *float64 `json:"spd"`
		Hdg    *float64 `json:"hdg"`
		Bat    *int16   `json:"bat"`
		Ts     int64    `json:"ts"`
		Duty   *string  `json:"dutyState"`
		// null = never explicitly set (legacy: uploading implied sharing);
		// false = EXPLICIT stop → the viewer renders "sharing off · last
		// known", never LIVE, from this same last-known row.
		Sharing *bool `json:"sharingEnabled"`
	}
	out := []row{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT sl.user_id, sl.lat, sl.lng, sl.accuracy_m, sl.speed_mps, sl.heading_deg,
		        sl.battery, (EXTRACT(EPOCH FROM sl.ts)*1000)::bigint, sl.duty_state,
		        cm.location_sharing_enabled
		   FROM space_locations_latest sl
		   JOIN chat_members cm ON cm.chat_id = sl.chat_id AND cm.user_id = sl.user_id
		                        AND cm.left_at IS NULL
		  WHERE sl.chat_id = $1 AND `+locVisibleWhere(locMemFamily(mem)),
		[]any{chatID, user.ID}, func(rows pgx.Rows) error {
			var m row
			if e := rows.Scan(&m.UserID, &m.Lat, &m.Lng, &m.Acc, &m.Spd, &m.Hdg, &m.Bat, &m.Ts, &m.Duty, &m.Sharing); e != nil {
				return e
			}
			out = append(out, m)
			return nil
		})
	if err != nil {
		log.Printf("[locations latest] %v", err)
		httpx.Err(w, 500, "Failed to load locations")
		return
	}
	httpx.JSON(w, 200, map[string]any{"members": out})
}

// GET /chats/{id}/locations/history?userId=&from=&to=&limit= — one member's
// track, policy-gated once against the target, paginated newest-first.
func locHistory(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load history")
	if mem == nil {
		return
	}

	q := r.URL.Query()
	target := strings.TrimSpace(q.Get("userId"))
	if target == "" {
		target = user.ID
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit < 1 || limit > locHistoryMax {
		limit = 200
	}

	// One policy check against the TARGET, not per row.
	allowed := false
	err := chatsQRow(ctx, user.ID,
		`SELECT EXISTS (
		    SELECT 1 FROM chat_members cm
		    WHERE cm.chat_id = $1 AND cm.user_id = $3 AND cm.left_at IS NULL
		      AND `+strings.ReplaceAll(locVisibleWhere(locMemFamily(mem)), "sl.user_id", "cm.user_id")+`)`,
		[]any{chatID, user.ID, target}, &allowed)
	if err != nil {
		log.Printf("[locations history] policy: %v", err)
		httpx.Err(w, 500, "Failed to load history")
		return
	}
	if !allowed {
		httpx.Err(w, 403, "Not shared with you")
		return
	}

	type row struct {
		Lat float64  `json:"lat"`
		Lng float64  `json:"lng"`
		Spd *float64 `json:"spd"`
		Acc *float64 `json:"acc"`
		Bat *int16   `json:"bat"`
		Ts  int64    `json:"ts"`
	}
	args := []any{chatID, target}
	where := `sl.chat_id = $1 AND sl.user_id = $2`
	if v, e := strconv.ParseInt(q.Get("from"), 10, 64); e == nil {
		args = append(args, v)
		where += ` AND sl.ts >= to_timestamp($` + strconv.Itoa(len(args)) + `/1000.0)`
	}
	if v, e := strconv.ParseInt(q.Get("to"), 10, 64); e == nil {
		args = append(args, v)
		where += ` AND sl.ts < to_timestamp($` + strconv.Itoa(len(args)) + `/1000.0)`
	}
	args = append(args, limit)
	out := []row{}
	err = chatsQueryU(ctx, user.ID,
		`SELECT sl.lat, sl.lng, sl.speed_mps, sl.accuracy_m, sl.battery,
		        (EXTRACT(EPOCH FROM sl.ts)*1000)::bigint
		   FROM space_locations sl WHERE `+where+
			` ORDER BY sl.ts DESC LIMIT $`+strconv.Itoa(len(args)),
		args, func(rows pgx.Rows) error {
			var m row
			if e := rows.Scan(&m.Lat, &m.Lng, &m.Spd, &m.Acc, &m.Bat, &m.Ts); e != nil {
				return e
			}
			out = append(out, m)
			return nil
		})
	if err != nil {
		log.Printf("[locations history] %v", err)
		httpx.Err(w, 500, "Failed to load history")
		return
	}
	httpx.JSON(w, 200, map[string]any{"userId": target, "points": out})
}
