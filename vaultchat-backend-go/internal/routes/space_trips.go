// space_trips.go — server-backed family trips (migration 113).
//
// The trip — a destination the circle chose to share — lives here instead of
// inside an E2EE chat message, so discovering it never depends on decrypting
// group history (the path that silently breaks when a member pair's
// sender-key session wedges). Space activities are exempt from E2EE by owner
// directive; see the migration header.
//
// Deliberately small: create, end, read-active. Member ETAs are ephemeral and
// keep riding the socket relay (trip_update) — nothing about a member's
// progress is stored. Authorization is enforced HERE in every handler
// because RLS is inert in this deployment (superuser connection).

package routes

import (
	"log"
	"net/http"
	"strings"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
)

// A trip older than this is over whether or not anyone ended it. Mirrors
// TRIP_TTL_MS in lib/groups/trips.ts — move them together.
const tripTTL = 8 * time.Hour

func RegisterSpaceTripsOnID(id *http.ServeMux) {
	id.HandleFunc("POST /chats/{id}/trip", httpx.RequireAuth(tripStart))
	id.HandleFunc("POST /chats/{id}/trip/end", httpx.RequireAuth(tripEnd))
	id.HandleFunc("GET /chats/{id}/trip", httpx.RequireAuth(tripGet))
}

type tripRow struct {
	ID        int64   `json:"id"`
	ChatID    string  `json:"chatId"`
	Name      string  `json:"destinationName"`
	Lat       float64 `json:"lat"`
	Lng       float64 `json:"lng"`
	StartedBy string  `json:"startedBy"`
	LeaderID  *string `json:"leaderId"`
	StartedAt int64   `json:"startedAt"` // epoch ms
}

// tripValid is the pure request gate — see space_trips_test.go.
func tripValid(name string, lat, lng float64) bool {
	n := strings.TrimSpace(name)
	if n == "" || len(n) > 200 {
		return false
	}
	if lat < -90 || lat > 90 || lng < -180 || lng > 180 {
		return false
	}
	if lat == 0 && lng == 0 {
		return false // null island is a failed geocode, not a meeting place
	}
	return true
}

// tripActiveSince returns the newest started_at instant that still counts as
// active — the SQL filter and the client TTL agree through this one value.
func tripActiveSince(now time.Time) time.Time { return now.Add(-tripTTL) }

// POST /chats/{id}/trip {destinationName, lat, lng, leader?} — start the
// space's trip. One active trip per space: a second start while one is live
// answers 409 with the existing trip, so a racing family converges instead
// of forking.
func tripStart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to start trip"); mem == nil {
		return
	}

	var body struct {
		DestinationName string  `json:"destinationName"`
		Lat             float64 `json:"lat"`
		Lng             float64 `json:"lng"`
		Leader          bool    `json:"leader"` // "everyone follows my route"
	}
	if err := httpx.Body(r, &body); err != nil || !tripValid(body.DestinationName, body.Lat, body.Lng) {
		httpx.Err(w, 400, "destinationName, lat, lng required")
		return
	}

	// Expire-by-marking first, so a stale never-ended trip cannot block the
	// partial unique index forever.
	_ = chatsExecU(ctx, user.ID,
		`UPDATE space_trips SET ended_at = NOW()
		  WHERE chat_id = $1 AND ended_at IS NULL AND started_at < $2`,
		chatID, tripActiveSince(time.Now()))

	var leader *string
	if body.Leader {
		leader = &user.ID
	}
	var t tripRow
	err := chatsQRow(ctx, user.ID,
		`INSERT INTO space_trips (chat_id, destination_name, lat, lng, started_by, leader_id)
		 VALUES ($1,$2,$3,$4,$5,$6)
		 RETURNING id, chat_id, destination_name, lat, lng, started_by, leader_id,
		           (EXTRACT(EPOCH FROM started_at)*1000)::bigint`,
		[]any{chatID, strings.TrimSpace(body.DestinationName), body.Lat, body.Lng, user.ID, leader},
		&t.ID, &t.ChatID, &t.Name, &t.Lat, &t.Lng, &t.StartedBy, &t.LeaderID, &t.StartedAt)
	if err != nil {
		if db.IsUniqueViolation(err) {
			// A live trip already exists — hand it back so the caller joins it.
			if cur := tripActive(r, chatID, user.ID); cur != nil {
				httpx.JSON(w, 409, map[string]any{"error": "A trip is already running", "trip": cur})
				return
			}
		}
		log.Printf("[trip start] %v", err)
		httpx.Err(w, 500, "Failed to start trip")
		return
	}

	emitx.ToRooms([]string{"chat:" + chatID}, "space_trip", map[string]any{"chatId": chatID, "trip": t})
	httpx.JSON(w, 200, map[string]any{"trip": t})
}

// POST /chats/{id}/trip/end — over for the whole space. Starter only: ending
// everyone's trip is the one mutation here that outlives its author.
func tripEnd(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to end trip"); mem == nil {
		return
	}

	var tripID int64
	err := chatsQRow(ctx, user.ID,
		`UPDATE space_trips SET ended_at = NOW(), ended_by = $2
		  WHERE chat_id = $1 AND ended_at IS NULL AND started_by = $2
		 RETURNING id`,
		[]any{chatID, user.ID}, &tripID)
	if db.NoRows(err) {
		// No live trip of THEIRS. Distinguish "nothing to end" (idempotent ok)
		// from "someone else's trip" (forbidden), so a double-tap on END never
		// errors while a non-starter still cannot end it.
		if cur := tripActive(r, chatID, user.ID); cur != nil {
			httpx.Err(w, 403, "Only the member who started the trip can end it")
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "ended": false})
		return
	}
	if err != nil {
		log.Printf("[trip end] %v", err)
		httpx.Err(w, 500, "Failed to end trip")
		return
	}

	emitx.ToRooms([]string{"chat:" + chatID}, "space_trip_end",
		map[string]any{"chatId": chatID, "tripId": tripID, "endedBy": user.ID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "ended": true, "tripId": tripID})
}

// GET /chats/{id}/trip — the space's live trip, or {"trip": null}.
func tripGet(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load trip"); mem == nil {
		return
	}
	httpx.JSON(w, 200, map[string]any{"trip": tripActive(r, chatID, user.ID)})
}

// tripActive reads the space's live (unended, inside-TTL) trip, or nil.
func tripActive(r *http.Request, chatID, userID string) *tripRow {
	var t tripRow
	err := chatsQRow(r.Context(), userID,
		`SELECT id, chat_id, destination_name, lat, lng, started_by, leader_id,
		        (EXTRACT(EPOCH FROM started_at)*1000)::bigint
		   FROM space_trips
		  WHERE chat_id = $1 AND ended_at IS NULL AND started_at >= $2
		  ORDER BY started_at DESC LIMIT 1`,
		[]any{chatID, tripActiveSince(time.Now())},
		&t.ID, &t.ChatID, &t.Name, &t.Lat, &t.Lng, &t.StartedBy, &t.LeaderID, &t.StartedAt)
	if err != nil {
		if !db.NoRows(err) {
			log.Printf("[trip active] %v", err)
		}
		return nil
	}
	return &t
}
