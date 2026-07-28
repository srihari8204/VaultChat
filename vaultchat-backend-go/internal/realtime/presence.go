package realtime

import (
	"log"
	"time"

	"github.com/zishang520/socket.io/v2/socket"

	"vaultchat/backend-go/internal/db"
)

// GHOST_COLS — the allowlisted ghost_mode columns (server.js GHOST_COLS). The
// column name is interpolated into SQL, so it MUST come from this set.
var ghostCols = map[string]bool{
	"hide_online":    true,
	"hide_typing":    true,
	"hide_read":      true,
	"hide_last_seen": true,
}

// ── Multi-device socket tracking (server.js trackSocket/untrackSocket) ──

func (h *Hub) trackSocket(s *socket.Socket) {
	d := sd(s)
	if d == nil || d.uid == "" {
		return
	}
	h.pmu.Lock()
	set := h.userSockets[d.uid]
	wasEmpty := len(set) == 0
	if set == nil {
		set = map[string]struct{}{}
		h.userSockets[d.uid] = set
	}
	set[string(s.Id())] = struct{}{}
	h.pmu.Unlock()
	if wasEmpty {
		go h.onUserOnline(d.uid) // first socket → presence online
	}
}

func (h *Hub) untrackSocket(s *socket.Socket) {
	d := sd(s)
	if d == nil || d.uid == "" {
		return
	}
	h.pmu.Lock()
	set := h.userSockets[d.uid]
	if set == nil {
		h.pmu.Unlock()
		return
	}
	delete(set, string(s.Id()))
	last := len(set) == 0
	if last {
		delete(h.userSockets, d.uid)
	}
	h.pmu.Unlock()
	if last {
		go h.onUserOffline(d.uid) // last socket → presence offline
	}
}

// ── Presence (server.js onUserOnline/onUserOffline/broadcastPresence) ──

func (h *Hub) onUserOnline(uid string) {
	if _, err := db.Pool.Exec(bg,
		`UPDATE users SET online = TRUE WHERE id = $1 AND COALESCE(online, FALSE) = FALSE`, uid); err != nil {
		log.Printf("[presence on] %v", err)
		return
	}
	h.broadcastPresence(uid, map[string]any{"userId": uid, "online": true, "lastSeenAt": nil})
}

func (h *Hub) onUserOffline(uid string) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if _, err := db.Pool.Exec(bg,
		`UPDATE users SET online = FALSE, last_seen_at = NOW() WHERE id = $1`, uid); err != nil {
		log.Printf("[presence off] %v", err)
		return
	}
	h.broadcastPresence(uid, map[string]any{"userId": uid, "online": false, "lastSeenAt": now})
}

func (h *Hub) broadcastPresence(uid string, payload map[string]any) {
	// Respect last_seen_visible: blank lastSeenAt if the user hid it.
	var visible *bool
	if err := db.Pool.QueryRow(bg, `SELECT last_seen_visible FROM users WHERE id = $1`, uid).Scan(&visible); err != nil {
		log.Printf("[broadcastPresence] %v", err)
		return
	}
	if visible != nil && !*visible {
		payload["lastSeenAt"] = nil
	}
	// Distinct other-users this user shares any live chat with.
	rows, err := db.Pool.Query(bg,
		`SELECT DISTINCT cm2.user_id
		   FROM chat_members cm1
		   JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id
		  WHERE cm1.user_id = $1
		    AND cm2.user_id <> $1
		    AND cm1.left_at IS NULL
		    AND cm2.left_at IS NULL`, uid)
	if err != nil {
		log.Printf("[broadcastPresence] %v", err)
		return
	}
	var mates []string
	for rows.Next() {
		var m string
		if rows.Scan(&m) == nil {
			mates = append(mates, m)
		}
	}
	rows.Close()

	ghosted := h.loadGhostTargets(uid, "hide_online")
	for _, m := range mates {
		if ghosted[m] {
			continue
		}
		h.EmitToUid(m, "presence_changed", payload)
	}
}

// loadGhostTargets: target users `senderId` has ghosted for `column` — the
// recipients to SKIP when fanning senderId's signals (server.js).
func (h *Hub) loadGhostTargets(senderID, column string) map[string]bool {
	out := map[string]bool{}
	if senderID == "" || !ghostCols[column] {
		return out
	}
	rows, err := db.Pool.Query(bg,
		`SELECT target_id FROM ghost_mode WHERE owner_id = $1 AND `+column+` = TRUE`, senderID)
	if err != nil {
		log.Printf("[loadGhostTargets] %v", err)
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var t string
		if rows.Scan(&t) == nil {
			out[t] = true
		}
	}
	return out
}

// loadGhostOwners: owners who have hidden `column` FROM `targetId` (server.js).
func (h *Hub) loadGhostOwners(targetID, column string) map[string]bool {
	out := map[string]bool{}
	if targetID == "" || !ghostCols[column] {
		return out
	}
	rows, err := db.Pool.Query(bg,
		`SELECT owner_id FROM ghost_mode WHERE target_id = $1 AND `+column+` = TRUE`, targetID)
	if err != nil {
		log.Printf("[loadGhostOwners] %v", err)
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var o string
		if rows.Scan(&o) == nil {
			out[o] = true
		}
	}
	return out
}
