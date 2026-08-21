// space_items.go — shared item finder (migration 114).
//
// Pools BLE tag sightings inside a space so any member's phone can answer
// "where are my keys". See the migration header for why this is worth a
// server side at all.
//
// Authorization is membership, enforced in EVERY handler — RLS is inert in
// this deployment (superuser connection), so these checks are the boundary.
// Deliberately NOT modelled on the location policy's per-family-type matrix:
// an item is a household object, not a person, and the space's own membership
// is the whole rule.

package routes

import (
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
)

const (
	itemsMax        = 60               // per space; a household is not a warehouse
	itemSightSlop   = 2 * time.Minute  // device clocks lie a little
	itemNameMax     = 80
	itemBleMax      = 64
)

func RegisterSpaceItemsOnID(id *http.ServeMux) {
	id.HandleFunc("GET /chats/{id}/items", httpx.RequireAuth(itemsList))
	id.HandleFunc("POST /chats/{id}/items", httpx.RequireAuth(itemsRegister))
	id.HandleFunc("POST /chats/{id}/items/sighting", httpx.RequireAuth(itemsSighting))
	id.HandleFunc("POST /chats/{id}/items/forget", httpx.RequireAuth(itemsForget))
}

type itemRow struct {
	ID         int64    `json:"id"`
	BleID      string   `json:"bleId"`
	Name       string   `json:"name"`
	Icon       string   `json:"icon"`
	OwnerID    string   `json:"ownerId"`
	LastSeenAt *int64   `json:"lastSeenAt"`
	LastSeenBy *string  `json:"lastSeenBy"`
	Lat        *float64 `json:"lat"`
	Lng        *float64 `json:"lng"`
	Place      *string  `json:"placeName"`
}

// itemValid is the pure request gate — see space_items_test.go.
func itemValid(bleID, name string) bool {
	b := strings.TrimSpace(bleID)
	n := strings.TrimSpace(name)
	if b == "" || len(b) > itemBleMax {
		return false
	}
	if n == "" || len(n) > itemNameMax {
		return false
	}
	return true
}

// itemSightingFresh rejects a sighting stamped in the future (beyond clock
// slop) or older than an hour — a stale report would overwrite a newer one
// and move the answer backwards.
func itemSightingFresh(ts int64, now time.Time) bool {
	t := time.UnixMilli(ts)
	if t.After(now.Add(itemSightSlop)) {
		return false
	}
	return !t.Before(now.Add(-1 * time.Hour))
}

// GET /chats/{id}/items — every item in the space with its newest sighting.
func itemsList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load items"); mem == nil {
		return
	}

	out := []itemRow{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT id, ble_id, name, icon, owner_id,
		        (EXTRACT(EPOCH FROM last_seen_at)*1000)::bigint, last_seen_by, lat, lng, place_name
		   FROM space_items WHERE chat_id = $1
		  ORDER BY last_seen_at DESC NULLS LAST, id DESC LIMIT $2`,
		[]any{chatID, itemsMax}, func(rows pgx.Rows) error {
			var m itemRow
			if e := rows.Scan(&m.ID, &m.BleID, &m.Name, &m.Icon, &m.OwnerID,
				&m.LastSeenAt, &m.LastSeenBy, &m.Lat, &m.Lng, &m.Place); e != nil {
				return e
			}
			out = append(out, m)
			return nil
		})
	if err != nil {
		log.Printf("[items list] %v", err)
		httpx.Err(w, 500, "Failed to load items")
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": out})
}

// POST /chats/{id}/items {bleId, name, icon} — register (or rename) a tag.
func itemsRegister(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to save item"); mem == nil {
		return
	}

	var body struct {
		BleID string `json:"bleId"`
		Name  string `json:"name"`
		Icon  string `json:"icon"`
	}
	if err := httpx.Body(r, &body); err != nil || !itemValid(body.BleID, body.Name) {
		httpx.Err(w, 400, "bleId and name required")
		return
	}
	icon := strings.TrimSpace(body.Icon)
	if icon == "" {
		icon = "key"
	}

	var count int
	_ = chatsQRow(ctx, user.ID, `SELECT COUNT(*) FROM space_items WHERE chat_id=$1`, []any{chatID}, &count)
	if count >= itemsMax {
		httpx.Err(w, 409, "Too many items in this space")
		return
	}

	// ON CONFLICT updates the NAME but never the owner: re-pairing a tag
	// someone else registered renames the shared entry, it does not seize it.
	var id int64
	err := chatsQRow(ctx, user.ID,
		`INSERT INTO space_items (chat_id, owner_id, ble_id, name, icon)
		 VALUES ($1,$2,$3,$4,$5)
		 ON CONFLICT (chat_id, ble_id) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon
		 RETURNING id`,
		[]any{chatID, user.ID, strings.TrimSpace(body.BleID), strings.TrimSpace(body.Name), icon}, &id)
	if err != nil {
		log.Printf("[items register] %v", err)
		httpx.Err(w, 500, "Failed to save item")
		return
	}
	emitx.ToRooms([]string{"chat:" + chatID}, "space_item", map[string]any{"chatId": chatID, "id": id})
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": id})
}

// POST /chats/{id}/items/sighting {bleId, ts, lat?, lng?, placeName?}
//
// "I heard this tag, here." Only ever moves the answer FORWARD: an older
// report cannot overwrite a newer one, so two phones reporting out of order
// still leave the freshest sighting standing.
func itemsSighting(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to record sighting"); mem == nil {
		return
	}

	var body struct {
		BleID string   `json:"bleId"`
		Ts    int64    `json:"ts"`
		Lat   *float64 `json:"lat"`
		Lng   *float64 `json:"lng"`
		Place *string  `json:"placeName"`
	}
	if err := httpx.Body(r, &body); err != nil || strings.TrimSpace(body.BleID) == "" {
		httpx.Err(w, 400, "bleId required")
		return
	}
	if body.Ts == 0 {
		body.Ts = time.Now().UnixMilli()
	}
	if !itemSightingFresh(body.Ts, time.Now()) {
		// Not an error: a queued sighting from an hour ago is simply no longer
		// news, and pretending it failed would make clients retry it forever.
		httpx.JSON(w, 200, map[string]any{"ok": true, "applied": false})
		return
	}

	var id int64
	err := chatsQRow(ctx, user.ID,
		`UPDATE space_items
		    SET last_seen_at = to_timestamp($3/1000.0), last_seen_by = $2,
		        lat = $4, lng = $5, place_name = NULLIF($6,'')
		  WHERE chat_id = $1 AND ble_id = $7
		    AND (last_seen_at IS NULL OR last_seen_at < to_timestamp($3/1000.0))
		 RETURNING id`,
		[]any{chatID, user.ID, body.Ts, body.Lat, body.Lng,
			strings.TrimSpace(deref(body.Place)), strings.TrimSpace(body.BleID)}, &id)
	if db.NoRows(err) {
		// Either the tag is not registered here, or a newer sighting already
		// stands. Both are "nothing to do", not failures.
		httpx.JSON(w, 200, map[string]any{"ok": true, "applied": false})
		return
	}
	if err != nil {
		log.Printf("[items sighting] %v", err)
		httpx.Err(w, 500, "Failed to record sighting")
		return
	}
	emitx.ToRooms([]string{"chat:" + chatID}, "space_item_seen", map[string]any{
		"chatId": chatID, "bleId": strings.TrimSpace(body.BleID), "by": user.ID, "ts": body.Ts,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true, "applied": true})
}

// POST /chats/{id}/items/forget {bleId} — owner-only removal.
func itemsForget(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to remove item"); mem == nil {
		return
	}
	var body struct {
		BleID string `json:"bleId"`
	}
	if err := httpx.Body(r, &body); err != nil || strings.TrimSpace(body.BleID) == "" {
		httpx.Err(w, 400, "bleId required")
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`DELETE FROM space_items WHERE chat_id=$1 AND ble_id=$2 AND owner_id=$3`,
		chatID, strings.TrimSpace(body.BleID), user.ID); err != nil {
		log.Printf("[items forget] %v", err)
		httpx.Err(w, 500, "Failed to remove item")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
