// spaces_ops.go — incidents, visitor passes, shift windows and audience-
// targeted announcements (migration 087).
//
// ── an honest limit on "targeted announcement" ──
//
// An announcement is an ordinary E2EE message in the space's chat, so every
// member's device RECEIVES the ciphertext and can decrypt it — that is what
// being in the chat means. Addressing one to a run or a department therefore
// scopes DELIVERY-INTENT and NOTIFICATION, not readability: only the audience is
// pushed and only the audience displays it, but a determined member of the same
// space could read it out of their own local store.
//
// This is stated in the spec rather than papered over. Cryptographic targeting
// would mean a sub-chat with its own sender keys per audience, which is a
// different and much larger feature. What this gives is the operational
// behaviour people actually ask for — "don't buzz the whole school for a Bus 4
// delay" — without pretending to a confidentiality property it does not have.

package routes

import (
	"context"
	"crypto/rand"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/workx"
)

const (
	incidentNoteMax = 4096 // ciphertext
	visitorNameMax  = 120
)

var incidentCategories = map[string]bool{
	// 'sos' is the driver's panic control (migration 088). Same table as every
	// other incident — it has a reporter, a run, a status and a resolution — but
	// its own wording and its own notification channel downstream, so a driver's
	// emergency does not arrive looking like a blocked road.
	"sos":       true,
	"breakdown": true, "accident": true, "route_blocked": true,
	"medical": true, "behaviour": true, "other": true,
}

func RegisterSpaceOpsOnID(id *http.ServeMux) {
	id.HandleFunc("GET /chats/{id}/incidents", httpx.RequireAuth(incidentList))
	id.HandleFunc("POST /chats/{id}/incidents", httpx.RequireAuth(incidentCreate))
	id.HandleFunc("PATCH /chats/{id}/incidents/{incidentId}", httpx.RequireAuth(incidentPatch))
	id.HandleFunc("GET /chats/{id}/visitor-passes", httpx.RequireAuth(visitorPassList))
	id.HandleFunc("POST /chats/{id}/visitor-passes", httpx.RequireAuth(visitorPassCreate))
	id.HandleFunc("POST /chats/{id}/visitor-passes/redeem", httpx.RequireAuth(visitorPassRedeem))
	id.HandleFunc("DELETE /chats/{id}/visitor-passes/{passId}", httpx.RequireAuth(visitorPassRevoke))
	id.HandleFunc("GET /chats/{id}/shift", httpx.RequireAuth(shiftGet))
	id.HandleFunc("PATCH /chats/{id}/shift", httpx.RequireAuth(shiftSet))
}

// ─── announcement audience ─────────────────────────────────────────────

// ─── incidents ─────────────────────────────────────────────────────────

func incidentList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load incidents"); mem == nil {
		return
	}

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		// Mirrors space_incidents_select. Load-bearing while the API connects as a
		// superuser and RLS is bypassed — see the header of spaces_roster.go.
		`SELECT id, run_id, reporter_id, category, note, media_ref, status,
		        created_at, resolved_at, pressed_at
		   FROM space_incidents
		  WHERE chat_id = $1
		    AND (vc_space_ops_viewer($1)
		         OR reporter_id = $2
		         OR (run_id IS NOT NULL AND vc_run_visible(run_id)))
		  ORDER BY created_at DESC
		  LIMIT 200`,
		[]any{chatID, user.ID}, func(rows pgx.Rows) error {
			var (
				id, category, status         string
				runID, reporter, note, media *string
				createdAt                    time.Time
				resolvedAt, pressedAt        *time.Time
			)
			if e := rows.Scan(&id, &runID, &reporter, &category, &note, &media, &status,
				&createdAt, &resolvedAt, &pressedAt); e != nil {
				return e
			}
			// pressedAt (migration 146): when an SOS was pressed, null when
			// the client did not say; createdAt is when it reached the server.
			out = append(out, map[string]any{
				"id": id, "runId": runID, "reporterId": reporter, "category": category,
				"note": note, "mediaRef": media, "status": status,
				"createdAt": httpx.JSTime(createdAt), "resolvedAt": httpx.JST(resolvedAt),
				"pressedAt": httpx.JST(pressedAt),
			})
			return nil
		})
	if err != nil {
		log.Printf("[incidents GET] %v", err)
		httpx.Err(w, 500, "Failed to load incidents")
		return
	}
	httpx.JSON(w, 200, out)
}

func incidentCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermReportIncident,
		"You cannot report incidents in this space", "Failed to file incident")
	if mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)

	category := strings.TrimSpace(chatsStrOr(b["category"], "other"))
	if !incidentCategories[category] {
		httpx.Err(w, 400, "unknown incident category")
		return
	}
	note := chatsStrOr(b["note"], "")
	if len(note) > incidentNoteMax {
		httpx.Err(w, 400, "note is too long")
		return
	}
	var runID *string
	if rid := strings.TrimSpace(chatsStrOr(b["runId"], "")); rid != "" {
		runID = &rid
	}
	var media *string
	if m := strings.TrimSpace(chatsStrOr(b["mediaRef"], "")); m != "" {
		media = &m
	}
	// Optional, migration 146; older clients send neither. clientKey makes a
	// repeated request (an answer lost on a bad signal) one incident;
	// pressedAt/pressedClock say when a late SOS was actually pressed.
	clientKey, ok := incidentClientKey(b["clientKey"])
	if !ok {
		httpx.Err(w, 400, "clientKey is invalid")
		return
	}
	now := time.Now()
	pressedAt := incidentPressedAt(b["pressedAt"], now)
	pressedClock := incidentClock(b["pressedClock"])

	// An SOS for a run that has finished still reaches the office, but not the
	// riders' guardians as "an emergency on this run": their children's trip
	// is over. Unknown run or lookup error: as before, nothing is skipped.
	runEnded := false
	if category == "sos" && runID != nil {
		var st string
		if err := chatsQRow(ctx, user.ID,
			`SELECT status FROM runs WHERE id = $1 AND chat_id = $2`,
			[]any{*runID, chatID}, &st); err == nil {
			runEnded = st == "completed" || st == "cancelled"
		}
	}

	var id string
	err := chatsQRow(ctx, user.ID,
		`INSERT INTO space_incidents
		        (chat_id, run_id, reporter_id, category, note, media_ref, client_key, pressed_at)
		 VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, NULLIF($7, ''), $8)
		 ON CONFLICT (chat_id, reporter_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
		 RETURNING id`,
		[]any{chatID, runID, user.ID, category, note, media, clientKey, pressedAt}, &id)
	if db.NoRows(err) && clientKey != "" {
		// Already filed under this key: the same answer, and nobody is pushed twice.
		if err = chatsQRow(ctx, user.ID,
			`SELECT id FROM space_incidents WHERE chat_id = $1 AND reporter_id = $2 AND client_key = $3`,
			[]any{chatID, user.ID, clientKey}, &id); err == nil {
			httpx.JSON(w, 200, incidentCreated(id, true, runEnded))
			return
		}
	}
	if err != nil {
		log.Printf("[incident POST] %v", err)
		httpx.Err(w, 500, "Failed to file incident")
		return
	}

	if runID != nil {
		runLog(ctx, user.ID, *runID, "incident_filed", &id, user.ID, "",
			map[string]any{"category": category})
	}
	chatsAudit(ctx, user.ID, chatID, "incident_filed", nil,
		map[string]any{"incidentId": id, "category": category})
	// Push to the people who run the space (S5.6 escalation / S5.8). An incident
	// that only lands in a list is an incident nobody sees until someone happens
	// to look, which for a breakdown with children aboard is not good enough.
	// Off the request path: a driver at the roadside waits for the write, never
	// for Expo.
	when := ""
	if category == "sos" {
		when = sosPressedWhen(pressedAt, pressedClock, now)
	}
	staffDetail := when
	if runEnded {
		staffDetail += " — the run had already finished"
	}
	workx.Submit(func() { opsNotifyStaff(chatID, category, runID, staffDetail) })
	// An SOS on a run also reaches the riders' guardians, on the sos channel —
	// the spec's "any emergency" names them, and staff-only left a parent as
	// the last to know. Scoped exactly like every run push: guardians linked to
	// a rider on THAT run, never the whole space. Not once the run is over.
	if category == "sos" && runID != nil && !runEnded {
		rid := *runID
		workx.Submit(func() {
			runNotifyRunWide(chatID, rid, "run_emergency", sosRunWideText(when))
		})
	}
	// Category and run only. The note is ciphertext and does not belong in a
	// socket payload any more than a message body does.
	emitx.ChatEvent(chatID, "incident_filed", map[string]any{
		"incidentId": id, "category": category, "runId": runID, "by": user.ID,
	})
	httpx.JSON(w, 200, incidentCreated(id, false, runEnded))
}

// incidentCreated is the POST answer. `duplicate` and `runEnded` are added
// only when true, so an older client sees exactly {id}.
func incidentCreated(id string, duplicate, runEnded bool) map[string]any {
	out := map[string]any{"id": id}
	if duplicate {
		out["duplicate"] = true
	}
	if runEnded {
		out["runEnded"] = true
	}
	return out
}

var incidentKeyRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// incidentClientKey reads the optional idempotency key: absent or empty is
// "" (no dedupe); anything else must look like a client-minted id.
func incidentClientKey(v any) (string, bool) {
	k := strings.TrimSpace(chatsStrOr(v, ""))
	if k == "" {
		return "", true
	}
	return k, incidentKeyRe.MatchString(k)
}

// incidentPressedAt reads the optional press time (RFC 3339). A time ahead of
// the server (a phone clock running fast) is taken as now; one more than a day
// old, or unreadable, is ignored.
func incidentPressedAt(v any, now time.Time) *time.Time {
	t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(chatsStrOr(v, "")))
	if err != nil || now.Sub(t) > 24*time.Hour {
		return nil
	}
	if t.After(now) {
		t = now
	}
	return &t
}

var incidentClockRe = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

// incidentClock reads the optional "HH:MM" the phone pressed it at, in the
// phone's own time — the server knows no space time zone to format one in.
func incidentClock(v any) string {
	c := strings.TrimSpace(chatsStrOr(v, ""))
	if !incidentClockRe.MatchString(c) {
		return ""
	}
	return c
}

// sosLateAfter: an SOS delivered later than this after its press says when
// it was pressed, so a late alert does not read as happening now.
const sosLateAfter = 2 * time.Minute

// sosPressedWhen is " (pressed at 08:14, 26 min ago)" for a late SOS, "" for
// a timely one or one with no press time.
func sosPressedWhen(pressedAt *time.Time, clock string, now time.Time) string {
	if pressedAt == nil || now.Sub(*pressedAt) < sosLateAfter {
		return ""
	}
	ago := sosAgo(now.Sub(*pressedAt))
	if clock != "" {
		return fmt.Sprintf(" (pressed at %s, %s)", clock, ago)
	}
	return fmt.Sprintf(" (pressed %s)", ago)
}

func sosAgo(d time.Duration) string {
	m := int(d / time.Minute)
	if m < 60 {
		return fmt.Sprintf("%d min ago", m)
	}
	if m%60 == 0 {
		return fmt.Sprintf("%d h ago", m/60)
	}
	return fmt.Sprintf("%d h %d min ago", m/60, m%60)
}

func sosRunWideText(when string) string {
	if when == "" {
		return "An emergency has been reported on this run"
	}
	return "An emergency was reported on this run" + when
}

func incidentPatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	incidentID := r.PathValue("incidentId")

	// Closing an incident is an ops act: a driver who could resolve their own
	// breakdown report could also make it disappear.
	if mem := chatsRequirePerm(w, r, groups.PermViewSpaceOps,
		"You cannot manage incidents in this space", "Failed to update incident"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	status := strings.TrimSpace(chatsStrOr(b["status"], ""))
	if status != "ack" && status != "resolved" && status != "open" {
		httpx.Err(w, 400, "status must be open, ack or resolved")
		return
	}

	var id string
	err := chatsQRow(ctx, user.ID,
		`UPDATE space_incidents
		    SET status = $3,
		        resolved_at = CASE WHEN $3 = 'resolved' THEN NOW() ELSE NULL END
		  WHERE chat_id = $1 AND id = $2
		  RETURNING id`,
		[]any{chatID, incidentID, status}, &id)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Incident not found")
		return
	}
	if err != nil {
		log.Printf("[incident PATCH] %v", err)
		httpx.Err(w, 500, "Failed to update incident")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "incident_"+status, nil, map[string]any{"incidentId": id})
	emitx.ChatEvent(chatID, "incident_changed", map[string]any{"incidentId": id, "status": status})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// opsNotifyStaff pushes an incident to the people who run the space.
//
// Audience is RANK — moderator and above — matching vc_space_ops_viewer, so the
// people who get woken up are exactly the people the incident list is visible
// to. A permission-resolved audience would be more precise and would mean a
// second copy of the permission model in a place mirrorcheck cannot see; that
// trade is documented at vc_space_ops_viewer and applies identically here.
//
// The body names the CATEGORY and the vehicle, never the note: the note is
// ciphertext this server cannot read, and a push is not the place to start.
// detail is appended to the body: when a late SOS was pressed, and whether
// its run had already finished ("" for everything else).
func opsNotifyStaff(chatID, category string, runID *string, detail string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	vehicle := ""
	if runID != nil {
		if err := db.SysPool.QueryRow(ctx,
			`SELECT COALESCE(vehicle_label, name) FROM runs WHERE id = $1`, *runID).Scan(&vehicle); err != nil {
			log.Printf("[ops notify] vehicle: %v", err)
		}
	}

	rows, err := db.SysPool.Query(ctx,
		`SELECT d.push_token
		   FROM devices d
		   JOIN chat_members cm ON cm.user_id = d.user_id AND cm.chat_id = $1
		  WHERE cm.left_at IS NULL
		    AND cm.role IN ('moderator', 'admin', 'owner')
		    AND d.push_token IS NOT NULL`,
		chatID)
	if err != nil {
		log.Printf("[ops notify] tokens: %v", err)
		return
	}
	tokens := []string{}
	for rows.Next() {
		var t *string
		if err := rows.Scan(&t); err == nil && t != nil {
			tokens = append(tokens, *t)
		}
	}
	rows.Close()
	if len(tokens) == 0 {
		return
	}

	title := "Incident reported"
	if vehicle != "" {
		title = vehicle
	}
	// An SOS gets its own title and its own Android channel, so ops can give it
	// a distinct sound and it is not silenced along with routine incidents. The
	// channel is a real separation, not a louder string.
	channel := "default"
	if category == "sos" {
		channel = "sos"
		if vehicle != "" {
			title = "EMERGENCY · " + vehicle
		} else {
			title = "EMERGENCY"
		}
	}
	chatsSendExpoPush(ctx, tokens, title, incidentText(category)+detail,
		map[string]any{"type": "incident", "category": category, "chatId": chatID}, channel)
}

func incidentText(category string) string {
	switch category {
	case "sos":
		return "A driver has raised an emergency alert"
	case "breakdown":
		return "A vehicle has broken down"
	case "accident":
		return "An accident has been reported"
	case "route_blocked":
		return "A route is blocked"
	case "medical":
		return "A medical incident has been reported"
	case "behaviour":
		return "A behaviour incident has been reported"
	default:
		return "An incident has been reported"
	}
}

// ─── visitor passes ────────────────────────────────────────────────────

// visitorCode mints a 6-character code from crypto/rand.
//
// crypto/rand, not math/rand: this code IS the credential that opens a building
// door. The alphabet omits I, O, 0 and 1 because it gets read aloud and typed by
// someone standing at a gate.
func visitorCode() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	out := make([]byte, 6)
	for i := range out {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			return "", err
		}
		out[i] = alphabet[n.Int64()]
	}
	return string(out), nil
}

func visitorPassList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load passes"); mem == nil {
		return
	}

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		// The code is a credential that opens a door, so a pass is visible to ops
		// and to its host and to nobody else. Mirrors visitor_passes_select.
		`SELECT id, host_id, visitor_name, code, valid_from, valid_to, redeemed_at, exited_at
		   FROM visitor_passes
		  WHERE chat_id = $1 AND valid_to > NOW() - INTERVAL '7 days'
		    AND (vc_space_ops_viewer($1) OR host_id = $2)
		  ORDER BY valid_to DESC LIMIT 200`,
		[]any{chatID, user.ID}, func(rows pgx.Rows) error {
			var (
				id, name, code   string
				host             *string
				from, to         time.Time
				redeemed, exited *time.Time
			)
			if e := rows.Scan(&id, &host, &name, &code, &from, &to, &redeemed, &exited); e != nil {
				return e
			}
			out = append(out, map[string]any{
				"id": id, "hostId": host, "visitorName": name, "code": code,
				"validFrom": httpx.JSTime(from), "validTo": httpx.JSTime(to),
				"redeemedAt": httpx.JST(redeemed), "exitedAt": httpx.JST(exited),
			})
			return nil
		})
	if err != nil {
		log.Printf("[visitor passes GET] %v", err)
		httpx.Err(w, 500, "Failed to load passes")
		return
	}
	httpx.JSON(w, 200, out)
}

func visitorPassCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermManageRoster,
		"You cannot issue visitor passes in this space", "Failed to issue pass")
	if mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	name := strings.TrimSpace(chatsStrOr(b["visitorName"], ""))
	if name == "" || len(name) > visitorNameMax {
		httpx.Err(w, 400, "visitorName must be 1–120 characters")
		return
	}
	validTo := time.Now().Add(8 * time.Hour)
	if v := strings.TrimSpace(chatsStrOr(b["validTo"], "")); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			httpx.Err(w, 400, "validTo must be an RFC3339 timestamp")
			return
		}
		validTo = t
	}
	if !validTo.After(time.Now()) {
		httpx.Err(w, 400, "validTo must be in the future")
		return
	}
	host := user.ID
	if h := strings.TrimSpace(chatsStrOr(b["hostId"], "")); h != "" {
		host = h
	}

	code, err := visitorCode()
	if err != nil {
		log.Printf("[visitor pass code] %v", err)
		httpx.Err(w, 500, "Failed to issue pass")
		return
	}

	var id string
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO visitor_passes (chat_id, host_id, visitor_name, code, valid_to, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		[]any{chatID, host, name, code, validTo, user.ID}, &id); err != nil {
		log.Printf("[visitor pass POST] %v", err)
		httpx.Err(w, 500, "Failed to issue pass")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "visitor_pass_issued", &host, map[string]any{"passId": id})
	httpx.JSON(w, 200, map[string]any{"id": id, "code": code, "validTo": httpx.JSTime(validTo)})
}

// visitorPassRevoke withdraws a pass nobody has used yet (wrong day, visit
// cancelled, code sent to the wrong person). Same gate as issuing one. A
// redeemed pass is the record of who came in, so it stays: 409. The row is
// deleted, which also frees its code; the audit entry keeps the trail.
func visitorPassRevoke(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	passID := r.PathValue("passId")

	mem := chatsRequirePerm(w, r, groups.PermManageRoster,
		"You cannot revoke visitor passes in this space", "Failed to revoke pass")
	if mem == nil {
		return
	}
	if !isUUID(passID) {
		httpx.Err(w, 404, "Pass not found")
		return
	}

	var redeemed bool
	err := chatsQRow(ctx, user.ID,
		`SELECT redeemed_at IS NOT NULL FROM visitor_passes WHERE chat_id = $1 AND id = $2`,
		[]any{chatID, passID}, &redeemed)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Pass not found")
		return
	}
	if err != nil {
		log.Printf("[visitor revoke] %v", err)
		httpx.Err(w, 500, "Failed to revoke pass")
		return
	}
	if redeemed {
		httpx.Err(w, 409, "This pass has already been used")
		return
	}

	// Conditional, like redeem: a pass presented at the gate between the read
	// above and this delete is admitted, not silently erased.
	var id string
	err = chatsQRow(ctx, user.ID,
		`DELETE FROM visitor_passes WHERE chat_id = $1 AND id = $2 AND redeemed_at IS NULL RETURNING id`,
		[]any{chatID, passID}, &id)
	if db.NoRows(err) {
		httpx.Err(w, 409, "This pass has already been used")
		return
	}
	if err != nil {
		log.Printf("[visitor revoke] %v", err)
		httpx.Err(w, 500, "Failed to revoke pass")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "visitor_pass_revoked", nil, map[string]any{"passId": id})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// visitorPassRedeem consumes a pass ONCE.
//
// The single-use guarantee is a conditional UPDATE, not a read-then-write: two
// people presenting the same code at two gates simultaneously is exactly the
// case a check-then-set loses. Whoever's UPDATE matches the row first gets it;
// the other gets nothing back and is refused.
func visitorPassRedeem(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermManageRoster,
		"You cannot admit visitors in this space", "Failed to redeem pass")
	if mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	code := strings.ToUpper(strings.TrimSpace(chatsStrOr(b["code"], "")))
	if code == "" {
		httpx.Err(w, 400, "code required")
		return
	}
	exit := chatsTruthy(b["exit"])

	if exit {
		var id string
		err := chatsQRow(ctx, user.ID,
			`UPDATE visitor_passes SET exited_at = NOW()
			  WHERE chat_id = $1 AND code = $2 AND redeemed_at IS NOT NULL AND exited_at IS NULL
			  RETURNING id`,
			[]any{chatID, code}, &id)
		if db.NoRows(err) {
			httpx.Err(w, 409, "No open visit for that code")
			return
		}
		if err != nil {
			log.Printf("[visitor exit] %v", err)
			httpx.Err(w, 500, "Failed to record exit")
			return
		}
		chatsAudit(ctx, user.ID, chatID, "visitor_exited", nil, map[string]any{"passId": id})
		httpx.JSON(w, 200, map[string]any{"ok": true})
		return
	}

	var id, name string
	var host *string
	err := chatsQRow(ctx, user.ID,
		`UPDATE visitor_passes SET redeemed_at = NOW()
		  WHERE chat_id = $1 AND code = $2
		    AND redeemed_at IS NULL
		    AND NOW() BETWEEN valid_from AND valid_to
		  RETURNING id, visitor_name, host_id`,
		[]any{chatID, code}, &id, &name, &host)
	if db.NoRows(err) {
		// One message for expired, already-used and never-existed. Distinguishing
		// them turns the endpoint into a code oracle.
		httpx.Err(w, 409, "That pass is not valid")
		return
	}
	if err != nil {
		log.Printf("[visitor redeem] %v", err)
		httpx.Err(w, 500, "Failed to redeem pass")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "visitor_admitted", host, map[string]any{"passId": id})
	if host != nil {
		emitx.ChatEvent(chatID, "visitor_arrived", map[string]any{
			"passId": id, "hostId": *host, "visitorName": name,
		})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": id, "visitorName": name, "hostId": host})
}

// ─── shift window ──────────────────────────────────────────────────────

// shiftGet reads the window back, in the same shape PATCH takes ("" = unset).
// Readable by whoever may set it (edit_settings) or judge attendance against
// it (view_space_ops — the attendance screen); not by every member.
func shiftGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	// Any CURRENT member may read the shift (read-only): it is the window
	// their own attendance is judged against. Left members and outsiders get
	// 403. Only edit_settings may change it (shiftSet); canEdit says which.
	mem := chatsRequireMem(w, r, 403, "You cannot see this space's shift", "Failed to load shift")
	if mem == nil {
		return
	}
	var start, end string
	var grace, delay int
	if err := chatsQRow(ctx, user.ID,
		`SELECT COALESCE(to_char(shift_start, 'HH24:MI'), ''), COALESCE(to_char(shift_end, 'HH24:MI'), ''),
		        shift_grace_minutes, run_delay_threshold_minutes
		   FROM chats WHERE id = $1`,
		[]any{chatID}, &start, &end, &grace, &delay); err != nil {
		log.Printf("[shift GET] %v", err)
		httpx.Err(w, 500, "Failed to load shift")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"shiftStart": start, "shiftEnd": end,
		"shiftGraceMinutes": grace, "runDelayThresholdMinutes": delay,
		"canEdit": mem.can(groups.PermEditSettings),
	})
}

// shiftSet configures the window attendance is judged against.
//
// Three columns is the entire server-side footprint of the attendance feature.
// Everything else — present, late, left-early, unknown — is DERIVED on device
// from safe-zone entry/exit events that already exist, because the server
// cannot read a location and will not be given one.
func shiftSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequirePerm(w, r, groups.PermEditSettings,
		"You cannot change this space's settings", "Failed to set shift"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	start := strings.TrimSpace(chatsStrOr(b["shiftStart"], ""))
	end := strings.TrimSpace(chatsStrOr(b["shiftEnd"], ""))
	grace, ok := chatsParseInt(b["shiftGraceMinutes"])
	if !ok {
		grace = 10
	}
	if grace < 0 || grace > 240 {
		httpx.Err(w, 400, "shiftGraceMinutes must be between 0 and 240")
		return
	}
	// The run-delay threshold rides the same settings write: both are "how much
	// lateness this space tolerates", and this endpoint already carries the
	// PermEditSettings gate. Omitted → keep the current value.
	delay, hasDelay := chatsParseInt(b["runDelayThresholdMinutes"])
	if hasDelay && (delay < 1 || delay > 240) {
		httpx.Err(w, 400, "runDelayThresholdMinutes must be between 1 and 240")
		return
	}

	// Postgres parses the TIME; passing NULL clears it. Times are LOCAL to the
	// workplace by design — "09:00" every day, not an instant in UTC.
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chats
		    SET shift_start = NULLIF($2, '')::time,
		        shift_end   = NULLIF($3, '')::time,
		        shift_grace_minutes = $4,
		        run_delay_threshold_minutes = COALESCE(NULLIF($5, 0), run_delay_threshold_minutes)
		  WHERE id = $1`,
		chatID, start, end, grace, delay); err != nil {
		if strings.Contains(err.Error(), "invalid input syntax") {
			httpx.Err(w, 400, "shiftStart and shiftEnd must be HH:MM times")
			return
		}
		log.Printf("[shift PATCH] %v", err)
		httpx.Err(w, 500, "Failed to set shift")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "shift_set", nil, map[string]any{
		"start": start, "end": end, "grace": grace,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
