// cluster.go — Redis-backed cross-node state (P2.1).
//
// With REDIS_ADAPTER=1 the Socket.IO Redis adapter (server.go) makes room
// emits reach sockets on every node — but three pieces of state were still
// process-local and would lie under >1 replica:
//
//   - presence   : "is uid online anywhere?" drove hasLiveSocket (call wake
//                  push suppression!) and first/last-socket online/offline
//                  transitions. Local maps only see THIS node's sockets.
//   - OnlineCount: admin metric — must count the whole cluster.
//   - call roster: join_call listed peers via FetchSockets on the local
//                  adapter; peers on another node were invisible.
//
// Layout (all keys live in the shared Redis the compose stack already runs):
//
//   vc:node:hb:<node>     STRING, EX nodeTTL — heartbeat, refreshed every 5s
//   vc:nodes              SET of node ids ever seen (janitor work-list)
//   vc:pres:<uid>         HASH node → local socket count for that node
//   vc:pres:online        SET of uids with ≥1 socket on ≥1 live node
//   vc:roster:<node>      SET of uids this node currently tracks (crash sweep)
//   vc:call:<chatId>      SET of uids in the call room (TTL-refreshed)
//
// A node's fields are only trusted while its heartbeat key exists; readers
// skip (and lazily delete) fields of dead nodes, so a crashed node's users
// stop counting as online within nodeTTL even before the janitor runs. The
// janitor (one node at a time, via SET NX lock) adopts dead nodes' rosters,
// clears their fields, and flips users offline in Postgres.
//
// Everything is fail-open: Redis down ⇒ helpers report "not cluster" and the
// callers fall back to the process-local maps (single-node behavior).
package realtime

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"os"
	"time"

	"vaultchat/backend-go/internal/redisx"
)

const (
	nodeTTL     = 15 * time.Second
	nodeBeat    = 5 * time.Second
	janitorTick = 60 * time.Second
	callTTL     = 6 * time.Hour
)

var nodeID = func() string {
	host, _ := os.Hostname()
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	if host == "" {
		host = "node"
	}
	return host + "-" + hex.EncodeToString(b)
}()

// ClusterEnabled — REDIS_ADAPTER=1 and a live Redis client. Checked at every
// call site (not cached) so a Redis outage degrades to local behavior.
func ClusterEnabled() bool {
	return os.Getenv("REDIS_ADAPTER") == "1" && redisx.Client != nil
}

// startCluster arms the heartbeat + janitor and clears any state left by a
// previous crash of THIS node identity's host (best-effort: node ids include a
// random suffix, so self-recovery mostly matters for the janitor path).
func (h *Hub) startCluster() {
	c := redisx.Client
	c.Set(bg, "vc:node:hb:"+nodeID, "1", nodeTTL)
	c.SAdd(bg, "vc:nodes", nodeID)
	go func() {
		t := time.NewTicker(nodeBeat)
		defer t.Stop()
		for range t.C {
			c.Set(bg, "vc:node:hb:"+nodeID, "1", nodeTTL)
		}
	}()
	go func() {
		t := time.NewTicker(janitorTick)
		defer t.Stop()
		for range t.C {
			h.janitor()
		}
	}()
	log.Printf("[cluster] redis adapter on — node %s", nodeID)
}

func nodeAlive(node string) bool {
	n, err := redisx.Client.Exists(bg, "vc:node:hb:"+node).Result()
	return err == nil && n > 0
}

// clusterTrackFirst — this node just got uid's FIRST local socket. Registers
// the node's claim and reports whether uid was globally offline before (i.e.
// whether the caller should fire the online transition).
func clusterTrackFirst(uid string) (wasGlobalOffline bool) {
	c := redisx.Client
	fields, _ := c.HGetAll(bg, "vc:pres:"+uid).Result()
	live := false
	for node := range fields {
		if node == nodeID {
			continue
		}
		if nodeAlive(node) {
			live = true
		} else {
			c.HDel(bg, "vc:pres:"+uid, node) // lazy sweep of a dead node's field
		}
	}
	c.HSet(bg, "vc:pres:"+uid, nodeID, "1")
	c.SAdd(bg, "vc:roster:"+nodeID, uid)
	if !live {
		c.SAdd(bg, "vc:pres:online", uid)
	}
	return !live
}

// clusterUntrackLast — this node just lost uid's LAST local socket. Withdraws
// the claim and reports whether uid is now globally offline.
func clusterUntrackLast(uid string) (isGlobalOffline bool) {
	c := redisx.Client
	c.HDel(bg, "vc:pres:"+uid, nodeID)
	c.SRem(bg, "vc:roster:"+nodeID, uid)
	fields, _ := c.HGetAll(bg, "vc:pres:"+uid).Result()
	for node := range fields {
		if nodeAlive(node) {
			return false
		}
		c.HDel(bg, "vc:pres:"+uid, node)
	}
	c.SRem(bg, "vc:pres:online", uid)
	return true
}

// clusterHasLive — does uid have a socket on any LIVE node?
func clusterHasLive(uid string) bool {
	c := redisx.Client
	fields, err := c.HGetAll(bg, "vc:pres:"+uid).Result()
	if err != nil {
		return false
	}
	for node := range fields {
		if nodeAlive(node) {
			return true
		}
		c.HDel(bg, "vc:pres:"+uid, node)
	}
	return false
}

func clusterOnlineCount() int {
	n, err := redisx.Client.SCard(bg, "vc:pres:online").Result()
	if err != nil {
		return 0
	}
	return int(n)
}

// ── Call rosters ────────────────────────────────────────────────────────

func clusterCallJoin(chatID, uid string) {
	c := redisx.Client
	c.SAdd(bg, "vc:call:"+chatID, uid)
	c.Expire(bg, "vc:call:"+chatID, callTTL)
}

func clusterCallLeave(chatID, uid string) {
	redisx.Client.SRem(bg, "vc:call:"+chatID, uid)
}

func clusterCallRoster(chatID, me string) []string {
	members, err := redisx.Client.SMembers(bg, "vc:call:"+chatID).Result()
	if err != nil {
		return []string{}
	}
	out := make([]string, 0, len(members))
	for _, m := range members {
		if m != "" && m != me {
			out = append(out, m)
		}
	}
	return out
}

// ── Janitor — adopt state of crashed nodes ──────────────────────────────

func (h *Hub) janitor() {
	c := redisx.Client
	if c == nil {
		return
	}
	// One node at a time: SET NX lock slightly shorter than the tick.
	ok, err := c.SetNX(bg, "vc:janitor:lock", nodeID, janitorTick-5*time.Second).Result()
	if err != nil || !ok {
		return
	}
	nodes, err := c.SMembers(bg, "vc:nodes").Result()
	if err != nil {
		return
	}
	for _, node := range nodes {
		if node == nodeID || nodeAlive(node) {
			continue
		}
		// Dead node: withdraw its presence claims; users with no other live
		// node flip offline (DB + broadcast so peers' UIs update).
		uids, _ := c.SMembers(bg, "vc:roster:"+node).Result()
		for _, uid := range uids {
			c.HDel(bg, "vc:pres:"+uid, node)
			if !clusterHasLive(uid) {
				c.SRem(bg, "vc:pres:online", uid)
				h.onUserOffline(uid)
			}
		}
		c.Del(bg, "vc:roster:"+node)
		c.SRem(bg, "vc:nodes", node)
		log.Printf("[cluster janitor] swept dead node %s (%d users)", node, len(uids))
	}
}
