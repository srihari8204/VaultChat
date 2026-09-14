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

	"github.com/redis/go-redis/v9"

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
	c.Set(bg, keyPrefix+"node:hb:"+nodeID, "1", nodeTTL)
	c.SAdd(bg, keyPrefix+"nodes", nodeID)
	go func() {
		t := time.NewTicker(nodeBeat)
		defer t.Stop()
		for range t.C {
			c.Set(bg, keyPrefix+"node:hb:"+nodeID, "1", nodeTTL)
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
	n, err := redisx.Client.Exists(bg, keyPrefix+"node:hb:"+node).Result()
	return err == nil && n > 0
}

// ── Presence transitions — one atomic Lua script per operation ──────────
//
// These used to be HGETALL → decide → HSET/SREM over several round trips, and
// two replicas could interleave inside that gap: B's trackFirst read "A is
// live" and therefore skipped the online SADD, while A's untrackLast ran to
// completion in between and flipped the user offline in Postgres and to every
// contact. End state: a connected, messaging user marked offline forever —
// the janitor only sweeps DEAD nodes, so nothing healed it.
//
// The hash stays the single membership authority; the scripts just make
// "inspect the claims, update mine, decide the transition" one round trip, so
// no other replica's claim can appear or vanish mid-decision.
//
// The heartbeat keys are read inside the script without being declared in
// KEYS. That is fine here (one Redis instance / one slot owner — these keys
// were never hash-tagged, so Redis Cluster was never supported by this layout)
// and it is what lets the liveness check share the decision's atomicity.
var (
	// KEYS: pres hash, roster set, online set. ARGV: uid, node, key prefix.
	//
	// ARGV[3] exists so a test can run THIS script — byte for byte, not a
	// reimplementation — against scoped keys. The heartbeat keys are built
	// inside Lua and so cannot come through KEYS; passing the prefix is what
	// lets the liveness check follow the same scope as the rest of the run.
	// Production passes keyPrefix, which is unchanged.
	// Returns 1 when uid was globally OFFLINE before this claim.
	trackFirstScript = redis.NewScript(`
local live = false
for _, n in ipairs(redis.call('HKEYS', KEYS[1])) do
  if n ~= ARGV[2] then
    if redis.call('EXISTS', ARGV[3] .. 'node:hb:' .. n) == 1 then
      live = true
    else
      redis.call('HDEL', KEYS[1], n)
    end
  end
end
redis.call('HSET', KEYS[1], ARGV[2], '1')
redis.call('SADD', KEYS[2], ARGV[1])
if live then return 0 end
redis.call('SADD', KEYS[3], ARGV[1])
return 1`)

	// Same KEYS/ARGV. Returns 1 when uid is globally offline AFTER the
	// withdrawal (caller fires the offline transition).
	untrackLastScript = redis.NewScript(`
redis.call('HDEL', KEYS[1], ARGV[2])
redis.call('SREM', KEYS[2], ARGV[1])
for _, n in ipairs(redis.call('HKEYS', KEYS[1])) do
  if redis.call('EXISTS', ARGV[3] .. 'node:hb:' .. n) == 1 then return 0 end
  redis.call('HDEL', KEYS[1], n)
end
redis.call('SREM', KEYS[3], ARGV[1])
return 1`)
)

// keyPrefix is "vc:" in production and is NEVER changed at runtime. A test may
// point it at an exclusive, unpredictable scope so a run cannot touch the live
// presence keyspace — `vc:pres:online` in particular is a GLOBAL set, so
// synthetic user ids alone do not isolate anything.
var keyPrefix = "vc:"

func presenceKeys(uid, node string) []string {
	return []string{keyPrefix + "pres:" + uid, keyPrefix + "roster:" + node, keyPrefix + "pres:online"}
}

// clusterTrackFirst — this node just got uid's FIRST local socket. Registers
// the node's claim and reports whether uid was globally offline before (i.e.
// whether the caller should fire the online transition).
func clusterTrackFirst(uid string) (wasGlobalOffline bool) { return clusterClaim(uid, nodeID) }

// clusterClaim registers `node`'s claim on uid. Split out from
// clusterTrackFirst only so tests can drive two node identities in one process.
func clusterClaim(uid, node string) bool {
	n, err := trackFirstScript.Run(bg, redisx.Client, presenceKeys(uid, node), uid, node, keyPrefix).Int()
	if err != nil {
		// Fail open the way the rest of this file does: treat it as the online
		// transition so a Redis hiccup cannot leave a connected user offline.
		log.Printf("[cluster] trackFirst %s: %v", uid, err)
		return true
	}
	return n == 1
}

// clusterUntrackLast — this node just lost uid's LAST local socket. Withdraws
// the claim and reports whether uid is now globally offline.
func clusterUntrackLast(uid string) (isGlobalOffline bool) { return clusterWithdraw(uid, nodeID) }

// clusterWithdraw drops `node`'s claim on uid. Shared by the disconnect path
// (node = this node) and the janitor (node = a dead node it is adopting) —
// the janitor had the same read-decide-write gap against a live replica's
// trackFirst, so it takes the same script rather than its own sequence.
func clusterWithdraw(uid, node string) bool {
	n, err := untrackLastScript.Run(bg, redisx.Client, presenceKeys(uid, node), uid, node, keyPrefix).Int()
	if err != nil {
		log.Printf("[cluster] untrackLast %s: %v", uid, err)
		return false // never announce an offline we could not record
	}
	return n == 1
}

// clusterHasLive — does uid have a socket on any LIVE node?
func clusterHasLive(uid string) bool {
	c := redisx.Client
	fields, err := c.HGetAll(bg, keyPrefix+"pres:"+uid).Result()
	if err != nil {
		return false
	}
	for node := range fields {
		if nodeAlive(node) {
			return true
		}
		c.HDel(bg, keyPrefix+"pres:"+uid, node)
	}
	return false
}

func clusterOnlineCount() int {
	n, err := redisx.Client.SCard(bg, keyPrefix+"pres:online").Result()
	if err != nil {
		return 0
	}
	return int(n)
}

// ── Call rosters ────────────────────────────────────────────────────────

func clusterCallJoin(chatID, uid string) {
	c := redisx.Client
	c.SAdd(bg, keyPrefix+"call:"+chatID, uid)
	c.Expire(bg, keyPrefix+"call:"+chatID, callTTL)
}

func clusterCallLeave(chatID, uid string) {
	redisx.Client.SRem(bg, keyPrefix+"call:"+chatID, uid)
}

func clusterCallRoster(chatID, me string) []string {
	members, err := redisx.Client.SMembers(bg, keyPrefix+"call:"+chatID).Result()
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
			if clusterWithdraw(uid, node) {
				h.onUserOffline(uid)
			}
		}
		c.Del(bg, "vc:roster:"+node)
		c.SRem(bg, "vc:nodes", node)
		log.Printf("[cluster janitor] swept dead node %s (%d users)", node, len(uids))
	}
}
