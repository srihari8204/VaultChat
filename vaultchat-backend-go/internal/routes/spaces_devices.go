// spaces_devices.go — tracked devices, their events, and theft-protection
// commands (migration 091).
//
// ── the one thing to know before editing this file ──
//
// NO ENDPOINT HERE ACCEPTS A COORDINATE, and none should be added.
//
// A device's position travels sealed on the live-location channel, which this
// server relays and cannot read. What these handlers deal in is identity, proof
// of life, and what happened — never where. `heartbeat` takes a timestamp and a
// battery level and nothing else, deliberately: the moment one of these accepts
// a lat/lng, this database holds the live position of a family's car in the
// clear, and every other privacy claim in the product becomes decoration.
//
// Third-party GPS trackers therefore cannot feed this. That is a product
// decision about plaintext location, not an oversight — see the header of
// migration 091.

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

const deviceLabelMax = 80

var deviceKinds = map[string]bool{
	"phone": true, "car": true, "bike": true, "bag": true,
	"pet": true, "vehicle": true, "other": true,
}

var deviceEventKinds = map[string]bool{
	"overspeed": true, "left_zone": true, "entered_zone": true, "low_battery": true,
	"shock": true, "disconnected": true, "moved": true, "powered_off": true, "other": true,
}

// Actions a device can be asked to perform. Every one needs Device Admin on the
// handset — the server only records the request.
var deviceActions = map[string]bool{
	"lock": true, "ring": true, "message": true, "photo": true, "wipe": true, "locate": true,
}

func RegisterSpaceDevicesOnID(id *http.ServeMux) {
	id.HandleFunc("GET /chats/{id}/devices", httpx.RequireAuth(deviceList))
	id.HandleFunc("POST /chats/{id}/devices", httpx.RequireAuth(deviceCreate))
	id.HandleFunc("PATCH /chats/{id}/devices/{deviceId}", httpx.RequireAuth(devicePatch))
	id.HandleFunc("POST /chats/{id}/devices/{deviceId}/heartbeat", httpx.RequireAuth(deviceHeartbeat))
	id.HandleFunc("GET /chats/{id}/devices/{deviceId}/events", httpx.RequireAuth(deviceEvents))
	id.HandleFunc("POST /chats/{id}/devices/{deviceId}/events", httpx.RequireAuth(deviceEventCreate))
	id.HandleFunc("GET /chats/{id}/devices/{deviceId}/commands", httpx.RequireAuth(deviceCommandList))
	id.HandleFunc("POST /chats/{id}/devices/{deviceId}/commands", httpx.RequireAuth(deviceCommandIssue))
	id.HandleFunc("PATCH /chats/{id}/devices/{deviceId}/commands/{cmdId}", httpx.RequireAuth(deviceCommandAck))
}

// ─── devices ───────────────────────────────────────────────────────────

func deviceList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load devices"); mem == nil {
		return
	}

	// RLS returns the caller's own devices unless they run the space, so one
	// query serves an owner and an administrator without branching here.
	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT d.id, d.owner_id, `+spaceNameCols+`, d.label, d.kind, d.identifier,
		        d.last_seen_at, d.battery, d.app_backed,
		        space_device_stale(d.last_seen_at) AS stale,
		        (SELECT COUNT(*) FROM space_device_events e
		          WHERE e.device_id = d.id AND e.at > NOW() - INTERVAL '24 hours') AS events_24h
		   FROM space_devices d
		   LEFT JOIN users u ON u.id = d.owner_id
		  WHERE d.chat_id = $1 AND d.archived_at IS NULL
		  ORDER BY d.label
		  LIMIT 300`,
		[]any{chatID}, func(rows pgx.Rows) error {
			var (
				did, label, kind string
				owner, ident     *string
				fnc, lnc, ec     *string
				legacyN, legacyE *string
				lastSeen         *time.Time
				battery          *int16
				appBacked, stale bool
				events24h        int64
			)
			if e := rows.Scan(&did, &owner, &fnc, &lnc, &ec, &legacyN, &legacyE,
				&label, &kind, &ident,
				&lastSeen, &battery, &appBacked, &stale, &events24h); e != nil {
				return e
			}
			name := spaceName(fnc, lnc, ec, legacyN, legacyE)
			out = append(out, map[string]any{
				"id": did, "ownerId": owner, "ownerName": name,
				"label": label, "kind": kind, "identifier": ident,
				"lastSeenAt": httpx.JST(lastSeen), "battery": battery,
				// appBacked FALSE means commands will never run: the client must
				// not offer a Lock button that reports success into a void.
				"appBacked": appBacked, "stale": stale, "events24h": events24h,
			})
			return nil
		})
	if err != nil {
		log.Printf("[devices GET] %v", err)
		httpx.Err(w, 500, "Failed to load devices")
		return
	}
	httpx.JSON(w, 200, out)
}

func deviceCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to add device"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	label := strings.TrimSpace(chatsStrOr(b["label"], ""))
	if label == "" || len(label) > deviceLabelMax {
		httpx.Err(w, 400, "label must be 1–80 characters")
		return
	}
	kind := strings.TrimSpace(chatsStrOr(b["kind"], "other"))
	if !deviceKinds[kind] {
		httpx.Err(w, 400, "unknown device kind")
		return
	}
	var ident *string
	if s := strings.TrimSpace(chatsStrOr(b["identifier"], "")); s != "" {
		ident = &s
	}
	// You register your own device. The RLS policy allows ops to register a
	// shared asset too, but the owner defaults to the caller rather than to
	// nobody — an unowned device is one nobody is answerable for.
	owner := user.ID
	appBacked := chatsTruthy(b["appBacked"])

	var id string
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO space_devices (chat_id, owner_id, label, kind, identifier, app_backed)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		[]any{chatID, owner, label, kind, ident, appBacked}, &id); err != nil {
		log.Printf("[devices POST] %v", err)
		httpx.Err(w, 500, "Failed to add device")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "device_added", &owner, map[string]any{"deviceId": id, "kind": kind})
	httpx.JSON(w, 200, map[string]any{"id": id})
}

func devicePatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	deviceID := r.PathValue("deviceId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update device"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)

	var label *string
	if raw, ok := b["label"]; ok {
		s := strings.TrimSpace(chatsStrOr(raw, ""))
		if s == "" || len(s) > deviceLabelMax {
			httpx.Err(w, 400, "label must be 1–80 characters")
			return
		}
		label = &s
	}
	var archived *bool
	if raw, ok := b["archived"]; ok {
		v := chatsTruthy(raw)
		archived = &v
	}
	if label == nil && archived == nil {
		httpx.Err(w, 400, "Nothing to update")
		return
	}

	var id string
	err := chatsQRow(ctx, user.ID,
		`UPDATE space_devices
		    SET label = COALESCE($3, label),
		        archived_at = CASE
		                        WHEN $4::bool IS NULL THEN archived_at
		                        WHEN $4::bool THEN COALESCE(archived_at, NOW())
		                        ELSE NULL
		                      END
		  WHERE chat_id = $1 AND id = $2
		  RETURNING id`,
		[]any{chatID, deviceID, label, archived}, &id)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Device not found")
		return
	}
	if err != nil {
		log.Printf("[devices PATCH] %v", err)
		httpx.Err(w, 500, "Failed to update device")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// deviceHeartbeat records proof of life. NO POSITION — see the file header.
//
// Battery is accepted because it is a property of the device that a person
// genuinely needs (the design's "Battery 92%"), and it says nothing about where
// anybody is.
func deviceHeartbeat(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	deviceID := r.PathValue("deviceId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to record heartbeat"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	var battery *int
	if n, ok := chatsParseInt(b["battery"]); ok {
		if n < 0 || n > 100 {
			httpx.Err(w, 400, "battery must be 0–100")
			return
		}
		v := int(n)
		battery = &v
	}

	// Only the device's owner reports for it: a heartbeat from anyone else is a
	// claim about somebody else's phone being alive.
	var id string
	err := chatsQRow(ctx, user.ID,
		`UPDATE space_devices
		    SET last_seen_at = NOW(),
		        battery = COALESCE($4, battery)
		  WHERE chat_id = $1 AND id = $2 AND owner_id = $3
		  RETURNING id`,
		[]any{chatID, deviceID, user.ID, battery}, &id)
	if db.NoRows(err) {
		httpx.Err(w, 403, "That is not your device")
		return
	}
	if err != nil {
		log.Printf("[device heartbeat] %v", err)
		httpx.Err(w, 500, "Failed to record heartbeat")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ─── events ────────────────────────────────────────────────────────────

func deviceEvents(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	deviceID := r.PathValue("deviceId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load device history"); mem == nil {
		return
	}

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT id, kind, text, at, detail
		   FROM space_device_events
		  WHERE device_id = $1
		  ORDER BY at DESC
		  LIMIT 300`,
		[]any{deviceID}, func(rows pgx.Rows) error {
			var (
				eid    int64
				kind   string
				text   *string
				at     time.Time
				detail map[string]any
			)
			if e := rows.Scan(&eid, &kind, &text, &at, &detail); e != nil {
				return e
			}
			out = append(out, map[string]any{
				"id": eid, "kind": kind, "text": text,
				"at": httpx.JSTime(at), "detail": detail,
			})
			return nil
		})
	if err != nil {
		log.Printf("[device events GET] %v", err)
		httpx.Err(w, 500, "Failed to load device history")
		return
	}
	httpx.JSON(w, 200, out)
}

// deviceEventCreate files an alert the DEVICE detected.
//
// Detection is on-device for the same reason it is for a run: the server cannot
// read a position, so it cannot judge speed or a zone crossing. The text is
// written by the detector and must carry the fact, never a coordinate — the
// same rule lib/spaces/detect.ts follows.
func deviceEventCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	deviceID := r.PathValue("deviceId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to record event"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	kind := strings.TrimSpace(chatsStrOr(b["kind"], ""))
	if !deviceEventKinds[kind] {
		httpx.Err(w, 400, "unknown event kind")
		return
	}
	text := strings.TrimSpace(chatsStrOr(b["text"], ""))
	if len(text) > 300 {
		httpx.Err(w, 400, "text is too long")
		return
	}

	var id int64
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO space_device_events (device_id, chat_id, kind, text)
		 SELECT $1, $2, $3, NULLIF($4, '')
		  WHERE EXISTS (SELECT 1 FROM space_devices d
		                 WHERE d.id = $1 AND d.chat_id = $2 AND d.owner_id = $5)
		 RETURNING id`,
		[]any{deviceID, chatID, kind, text, user.ID}, &id); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 403, "That is not your device")
			return
		}
		log.Printf("[device event POST] %v", err)
		httpx.Err(w, 500, "Failed to record event")
		return
	}

	emitx.ChatEvent(chatID, "device_event", map[string]any{
		"deviceId": deviceID, "kind": kind,
	})
	httpx.JSON(w, 200, map[string]any{"id": id})
}

// ─── theft protection ──────────────────────────────────────────────────

func deviceCommandList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	deviceID := r.PathValue("deviceId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load commands"); mem == nil {
		return
	}

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT id, action, payload, issued_at, delivered_at, executed_at, result
		   FROM space_device_commands
		  WHERE device_id = $1
		  ORDER BY issued_at DESC
		  LIMIT 100`,
		[]any{deviceID}, func(rows pgx.Rows) error {
			var (
				cid             int64
				action, result  string
				payload         *string
				issued          time.Time
				delivered, exec *time.Time
			)
			if e := rows.Scan(&cid, &action, &payload, &issued, &delivered, &exec, &result); e != nil {
				return e
			}
			out = append(out, map[string]any{
				"id": cid, "action": action, "payload": payload, "result": result,
				"issuedAt":    httpx.JSTime(issued),
				"deliveredAt": httpx.JST(delivered), "executedAt": httpx.JST(exec),
			})
			return nil
		})
	if err != nil {
		log.Printf("[device commands GET] %v", err)
		httpx.Err(w, 500, "Failed to load commands")
		return
	}
	httpx.JSON(w, 200, out)
}

// deviceCommandIssue queues a remote action.
//
// It records an INTENT. Every one of these needs Device Admin on the handset to
// actually happen, so the response deliberately reports 'issued' and never
// 'done' — a Lock button that claims success while the phone is off in a drawer
// is worse than one that says it is waiting.
func deviceCommandIssue(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	deviceID := r.PathValue("deviceId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to send the command"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	action := strings.TrimSpace(chatsStrOr(b["action"], ""))
	if !deviceActions[action] {
		httpx.Err(w, 400, "unknown action")
		return
	}
	payload := strings.TrimSpace(chatsStrOr(b["payload"], ""))
	if len(payload) > 300 {
		httpx.Err(w, 400, "message is too long")
		return
	}

	// Refuse outright for a device no VaultChat client backs. The command would
	// sit unread forever and the owner would believe their phone was locked.
	var appBacked bool
	if err := chatsQRow(ctx, user.ID,
		`SELECT app_backed FROM space_devices
		  WHERE id = $1 AND chat_id = $2 AND owner_id = $3`,
		[]any{deviceID, chatID, user.ID}, &appBacked); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 403, "That is not your device")
			return
		}
		log.Printf("[device command] lookup: %v", err)
		httpx.Err(w, 500, "Failed to send the command")
		return
	}
	if !appBacked {
		httpx.Err(w, 409,
			"This device does not run VaultChat, so it cannot receive remote commands")
		return
	}

	var id int64
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO space_device_commands (device_id, chat_id, action, payload, issued_by)
		 VALUES ($1, $2, $3, NULLIF($4, ''), $5) RETURNING id`,
		[]any{deviceID, chatID, action, payload, user.ID}, &id); err != nil {
		log.Printf("[device command POST] %v", err)
		httpx.Err(w, 500, "Failed to send the command")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "device_command_"+action, nil,
		map[string]any{"deviceId": deviceID, "commandId": id})
	// Deliberately NOT broadcast on the space's socket. "Lock my phone" is the
	// owner's private business, and the only channel available here fans out to
	// every member — announcing that someone has lost their phone to their whole
	// office would be a poor way to help them. The device collects it from
	// GET /commands on its next connection instead.
	httpx.JSON(w, 200, map[string]any{"id": id, "result": "issued"})
}

// deviceCommandAck is written by the DEVICE when it has acted.
//
// The server never writes 'executed' for itself. An unacknowledged command
// stays 'issued' forever, which is the truth: nobody knows whether it ran.
func deviceCommandAck(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	deviceID := r.PathValue("deviceId")
	cmdID := r.PathValue("cmdId")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update the command"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	result := strings.TrimSpace(chatsStrOr(b["result"], ""))
	switch result {
	case "delivered", "executed", "failed", "cancelled":
	default:
		httpx.Err(w, 400, "result must be delivered, executed, failed or cancelled")
		return
	}

	var id int64
	err := chatsQRow(ctx, user.ID,
		`UPDATE space_device_commands c
		    SET result = $4,
		        delivered_at = CASE WHEN $4 IN ('delivered','executed')
		                            THEN COALESCE(c.delivered_at, NOW()) ELSE c.delivered_at END,
		        executed_at  = CASE WHEN $4 = 'executed'
		                            THEN COALESCE(c.executed_at, NOW()) ELSE c.executed_at END
		   FROM space_devices d
		  WHERE c.id = $3::bigint AND c.device_id = $2 AND d.id = c.device_id
		    AND d.chat_id = $1 AND d.owner_id = $5
		    AND c.result IN ('issued', 'delivered')
		  RETURNING c.id`,
		[]any{chatID, deviceID, cmdID, result, user.ID}, &id)
	if db.NoRows(err) {
		httpx.Err(w, 409, "That command is not open")
		return
	}
	if err != nil {
		log.Printf("[device command PATCH] %v", err)
		httpx.Err(w, 500, "Failed to update the command")
		return
	}
	httpx.JSON(w, 200, map[string]any{"id": id, "result": result})
}
