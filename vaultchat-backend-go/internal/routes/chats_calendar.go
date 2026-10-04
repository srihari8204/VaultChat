// chats_calendar.go — shared group calendar (Groups & Circles, G4.3).
//
// The server is a dumb store here by design. `payload` is ciphertext it must
// never parse; the only thing it understands is the month bucket it filters on
// and a coarse repeat_until so a finished recurrence stops being shipped to
// every client forever. Recurrence expansion, ordering and reminders all happen
// on-device (lib/groups/calendar.ts).
//
// See migration 072 for the schema and for what the server does and does not
// learn from it.

package routes

import (
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
)

// Mirrors the CHECK in migration 072. Validated here too so a bad bucket gets a
// 400 with a reason rather than a constraint violation surfacing as a 500.
var calMonthKeyRe = regexp.MustCompile(`^[0-9]{4}-(0[1-9]|1[0-2])$`)

// A month range the UI can ask for in one call. Twelve months covers a year
// view; beyond that a client should page, and an unbounded list would let one
// request scan the whole table.
const calMaxMonths = 12

// Ciphertext for one event. Generous, because it carries title, notes and
// location sealed together, but bounded so a single row cannot be abused.
const calMaxPayload = 16 * 1024

func RegisterChatCalendarOnID(id *http.ServeMux) {
	id.HandleFunc("GET /chats/{id}/events", httpx.RequireAuth(calendarList))
	id.HandleFunc("POST /chats/{id}/events", httpx.RequireAuth(calendarCreate))
	id.HandleFunc("PATCH /chats/{id}/events/{eventId}", httpx.RequireAuth(calendarUpdate))
	id.HandleFunc("DELETE /chats/{id}/events/{eventId}", httpx.RequireAuth(calendarDelete))
}

// calendarList returns the events for a set of month buckets PLUS every
// recurring event, which is the single query the calendar UI makes.
func calendarList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	// Reading the calendar is open to any member: it is the group's shared
	// diary, not privileged data.
	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load events"); mem == nil {
		return
	}

	months := []string{}
	for _, m := range strings.Split(r.URL.Query().Get("months"), ",") {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		if !calMonthKeyRe.MatchString(m) {
			httpx.Err(w, 400, "months must be YYYY-MM values")
			return
		}
		months = append(months, m)
		if len(months) > calMaxMonths {
			httpx.Err(w, 400, "too many months requested")
			return
		}
	}

	out := []map[string]any{}
	// A recurring event whose repeat has already ended is filtered out here so
	// dead repeats stop travelling to every client on every fetch.
	err := chatsQueryU(ctx, user.ID,
		`SELECT id, created_by, COALESCE(updated_by, created_by), month_key, payload, repeat_until, created_at, updated_at
		   FROM group_events
		  WHERE chat_id = $1
		    AND deleted_at IS NULL
		    AND (month_key = ANY($2::text[])
		         OR (month_key IS NULL AND (repeat_until IS NULL OR repeat_until >= NOW())))
		  ORDER BY id`,
		[]any{chatID, months}, func(rows pgx.Rows) error {
			var (
				id                   int64
				createdBy, updatedBy *string
				monthKey             *string
				payload              string
				repeatUntil          *time.Time
				createdAt, updatedAt time.Time
			)
			if e := rows.Scan(&id, &createdBy, &updatedBy, &monthKey, &payload, &repeatUntil, &createdAt, &updatedAt); e != nil {
				return e
			}
			out = append(out, map[string]any{
				// updatedBy: whose sender key sealed the CURRENT payload (an admin
				// may edit another member's event; migration 143).
				"id": id, "createdBy": createdBy, "updatedBy": updatedBy, "monthKey": monthKey,
				"payload": payload, "repeatUntil": httpx.JST(repeatUntil),
				"createdAt": httpx.JSTime(createdAt), "updatedAt": httpx.JSTime(updatedAt),
			})
			return nil
		})
	if err != nil {
		log.Printf("[events GET] %v", err)
		httpx.Err(w, 500, "Failed to load events")
		return
	}
	httpx.JSON(w, 200, out)
}

// calReadBody pulls and validates the writable fields shared by create/update.
func calReadBody(w http.ResponseWriter, r *http.Request) (payload string, monthKey *string, repeatUntil *time.Time, ok bool) {
	var b map[string]any
	_ = httpx.Body(r, &b)

	payload = strings.TrimSpace(chatsStrOr(b["payload"], ""))
	if payload == "" {
		httpx.Err(w, 400, "payload required")
		return "", nil, nil, false
	}
	if len(payload) > calMaxPayload {
		httpx.Err(w, 400, "event is too large")
		return "", nil, nil, false
	}

	if mk := strings.TrimSpace(chatsStrOr(b["monthKey"], "")); mk != "" {
		if !calMonthKeyRe.MatchString(mk) {
			httpx.Err(w, 400, "monthKey must be YYYY-MM")
			return "", nil, nil, false
		}
		monthKey = &mk
	}
	// No monthKey means a recurring event, which is fetched on every range
	// query regardless of month.

	if ru := strings.TrimSpace(chatsStrOr(b["repeatUntil"], "")); ru != "" {
		t, err := time.Parse(time.RFC3339, ru)
		if err != nil {
			httpx.Err(w, 400, "repeatUntil must be an RFC3339 timestamp")
			return "", nil, nil, false
		}
		repeatUntil = &t
	}
	return payload, monthKey, repeatUntil, true
}

func calendarCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	// Any member may add to the shared calendar — that is what makes it shared.
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to create event")
	if mem == nil {
		return
	}
	if mem.ChatType != "group" {
		httpx.Err(w, 400, "Only group chats have a calendar")
		return
	}

	payload, monthKey, repeatUntil, ok := calReadBody(w, r)
	if !ok {
		return
	}

	var id int64
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO group_events (chat_id, created_by, updated_by, month_key, payload, repeat_until)
		 VALUES ($1, $2, $2, $3, $4, $5) RETURNING id`,
		[]any{chatID, user.ID, monthKey, payload, repeatUntil}, &id); err != nil {
		log.Printf("[events POST] %v", err)
		httpx.Err(w, 500, "Failed to create event")
		return
	}

	// Tell the group something changed, WITHOUT saying what: the event id is
	// enough for other clients to refetch and decrypt for themselves.
	emitx.ChatEvent(chatID, "calendar_changed", map[string]any{"id": id, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"id": id})
}

// calMayEdit: the person who added an event can change it; so can anyone the
// group trusts with its settings. Everyone else cannot silently rewrite someone
// else's entry in a shared diary.
func calMayEdit(mem *chatsMem, uid string, owner *string) bool {
	if owner != nil && *owner == uid {
		return true
	}
	return mem.can(groups.PermEditSettings)
}

func calendarUpdate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update event")
	if mem == nil {
		return
	}
	eventID, ok := httpx.ParseIntPrefix(r.PathValue("eventId"))
	if !ok {
		httpx.Err(w, 400, "invalid event id")
		return
	}

	var owner *string
	err := chatsQRow(ctx, user.ID,
		`SELECT created_by FROM group_events WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL`,
		[]any{eventID, chatID}, &owner)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Event not found")
		return
	}
	if err != nil {
		log.Printf("[events PATCH] %v", err)
		httpx.Err(w, 500, "Failed to update event")
		return
	}
	if !calMayEdit(mem, user.ID, owner) {
		httpx.Err(w, 403, "You can only change events you added")
		return
	}

	payload, monthKey, repeatUntil, ok2 := calReadBody(w, r)
	if !ok2 {
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE group_events SET payload = $1, month_key = $2, repeat_until = $3, updated_by = $6
		  WHERE id = $4 AND chat_id = $5 AND deleted_at IS NULL`,
		payload, monthKey, repeatUntil, eventID, chatID, user.ID); err != nil {
		log.Printf("[events PATCH] %v", err)
		httpx.Err(w, 500, "Failed to update event")
		return
	}
	emitx.ChatEvent(chatID, "calendar_changed", map[string]any{"id": eventID, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": eventID, "updatedBy": user.ID})
}

func calendarDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to delete event")
	if mem == nil {
		return
	}
	eventID, ok := httpx.ParseIntPrefix(r.PathValue("eventId"))
	if !ok {
		httpx.Err(w, 400, "invalid event id")
		return
	}

	var owner *string
	err := chatsQRow(ctx, user.ID,
		`SELECT created_by FROM group_events WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL`,
		[]any{eventID, chatID}, &owner)
	if db.NoRows(err) {
		// Already gone: report success so a retried delete is not an error.
		httpx.JSON(w, 200, map[string]any{"ok": true, "id": eventID})
		return
	}
	if err != nil {
		log.Printf("[events DELETE] %v", err)
		httpx.Err(w, 500, "Failed to delete event")
		return
	}
	if !calMayEdit(mem, user.ID, owner) {
		httpx.Err(w, 403, "You can only remove events you added")
		return
	}

	// Soft delete: other devices need to learn the row is gone, and a hard
	// delete would simply make it vanish from their next fetch with no signal.
	if err := chatsExecU(ctx, user.ID,
		`UPDATE group_events SET deleted_at = NOW() WHERE id = $1 AND chat_id = $2`,
		eventID, chatID); err != nil {
		log.Printf("[events DELETE] %v", err)
		httpx.Err(w, 500, "Failed to delete event")
		return
	}
	emitx.ChatEvent(chatID, "calendar_changed", map[string]any{"id": eventID, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": eventID})
}
