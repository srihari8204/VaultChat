package realtime

import (
	"context"
	"log"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/workx"
)

// GHOST_COLS — the allowlisted ghost_mode columns (server.js GHOST_COLS). The
// column name is interpolated into SQL, so it MUST come from this set.
var ghostCols = map[string]bool{
	"hide_online":    true,
	"hide_typing":    true,
	"hide_read":      true,
	"hide_last_seen": true,
}

// ── Multi-device session tracking ──
//
// trackSocket/untrackSocket — the Socket.IO adapters that unwrapped a
// *socket.Socket into (uid, id) — are gone with Socket.IO. The identity pair
// below is what always did the work, and CC-Wire calls it directly
// (ccwire.go trackIdentity, ccwire_messages.go untrackIdentity).

func (h *Hub) trackIdentity(uid, id string) {
	if uid == "" {
		return
	}
	h.pmu.Lock()
	if h.userSockets == nil {
		h.userSockets = map[string]map[string]struct{}{}
	}
	set := h.userSockets[uid]
	wasEmpty := len(set) == 0
	if set == nil {
		set = map[string]struct{}{}
		h.userSockets[uid] = set
	}
	set[id] = struct{}{}
	h.pmu.Unlock()
	if wasEmpty {
		// First LOCAL socket. Single-node that IS the online transition; in a
		// cluster the user may already be online via another node — register
		// this node's claim in Redis and only fire the transition if the user
		// was globally offline (P2.1). Pool-submitted, not raw-spawned: a
		// reconnect storm must not fork one goroutine per flip (P2.2).
		workx.Submit(func() {
			if ClusterEnabled() {
				if clusterTrackFirst(uid) {
					h.onUserOnline(uid)
				}
				return
			}
			h.onUserOnline(uid)
		})
	}
}

func (h *Hub) untrackIdentity(uid, id string) {
	if uid == "" {
		return
	}
	h.pmu.Lock()
	set := h.userSockets[uid]
	if set == nil {
		h.pmu.Unlock()
		return
	}
	delete(set, id)
	last := len(set) == 0
	if last {
		delete(h.userSockets, uid)
	}
	h.pmu.Unlock()
	if last {
		// Last LOCAL socket — mirror of trackSocket: withdraw this node's
		// claim; fire offline only when no live node still has the user.
		workx.Submit(func() {
			if ClusterEnabled() {
				if clusterUntrackLast(uid) {
					h.onUserOffline(uid)
				}
				return
			}
			h.onUserOffline(uid)
		})
	}
}

// ── Presence (server.js onUserOnline/onUserOffline/broadcastPresence) ──

func (h *Hub) onUserOnline(uid string) {
	if _, err := db.SysPool.Exec(bg,
		`UPDATE users SET online = TRUE WHERE id = $1 AND COALESCE(online, FALSE) = FALSE`, uid); err != nil {
		log.Printf("[presence on] %v", err)
		return
	}
	h.broadcastPresence(uid, map[string]any{"userId": uid, "online": true, "lastSeenAt": nil})
}

func (h *Hub) onUserOffline(uid string) {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if _, err := db.SysPool.Exec(bg,
		`UPDATE users SET online = FALSE, last_seen_at = NOW() WHERE id = $1`, uid); err != nil {
		log.Printf("[presence off] %v", err)
		return
	}
	h.broadcastPresence(uid, map[string]any{"userId": uid, "online": false, "lastSeenAt": now})
}

func (h *Hub) broadcastPresence(uid string, payload map[string]any) {
	// Respect last_seen_visible: blank lastSeenAt if the user hid it.
	var visible *bool
	if err := db.SysPool.QueryRow(bg, `SELECT last_seen_visible FROM users WHERE id = $1`, uid).Scan(&visible); err != nil {
		log.Printf("[broadcastPresence] %v", err)
		return
	}
	if visible != nil && !*visible {
		payload["lastSeenAt"] = nil
	}
	// Distinct other-users this user shares any live chat with.
	rows, err := db.SysPool.Query(bg,
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
func (h *Hub) loadGhostTargets(senderID, column string, parents ...context.Context) map[string]bool {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	out := map[string]bool{}
	if senderID == "" || !ghostCols[column] {
		return out
	}
	rows, err := db.SysPool.Query(ctx,
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
func (h *Hub) loadGhostOwners(targetID, column string, parents ...context.Context) map[string]bool {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	out := map[string]bool{}
	if targetID == "" || !ghostCols[column] {
		return out
	}
	rows, err := db.SysPool.Query(ctx,
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
