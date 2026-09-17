// Package realtime is the Go port of the Socket.IO server in
// vaultchat-backend/server.js — JWT-authed handshake, multi-device presence,
// chat/typing/receipt relays, WebRTC + VaultBeam + call signaling, live
// location, and ephemeral chat viewers.
//
// It owns all sockets once the single-node proxy flip cuts realtime over from
// Node. Emit payloads are shaped byte-for-byte like Node's emits (the library
// JSON-marshals whatever map/struct we pass).
//
// Scale-out (P2.1): with REDIS_ADAPTER=1 the Socket.IO Redis adapter
// (zishang520/socket.io-go-redis — same wire format as Node's
// @socket.io/redis-adapter) carries room emits across every replica, and
// presence/rosters move to Redis (cluster.go), so N nodes serve one logical
// hub. Flag off (default) ⇒ the original single-node in-process behavior,
// which is also the rollback: scale replicas to 1 and unset the flag.
package realtime

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"regexp"
	"sync"
	"time"

	"vaultchat/backend-go/internal/metrics"
)

// Default is set by New() so the orchestrator's /internal/* bridge handlers
// (added in main.go, not here) can reach the live hub.
var Default *Hub

var bg = context.Background()

var bearerRe = regexp.MustCompile(`(?i)^Bearer\s+(.+)$`)

// sockData is the per-socket user context (server.js socket.data). uid/email/
// admin are written once in the auth middleware and read-only afterwards;
// chatMemberOk is mutated by handlers so it takes mu.
type sockData struct {
	uid   string
	email string
	admin bool

	mu           sync.Mutex
	chatMemberOk map[string]cachedPerm
	// Spaces & Operations (S2.8): per-socket cache of run entitlement, keyed
	// "view:<runId>" / "drive:<runId>". Separate from chatMemberOk because a run is
	// visible to a SUBSET of a space — being in the chat is not enough.
	runOk map[string]cachedPerm
	// Per-socket cache of "may I address a per-peer relay to this uid",
	// keyed by peer uid. See peerAllowed: TTL-bounded, no generation, and
	// lazily created so the package's DB-free tests can build a sockData
	// without it.
	peerOk map[string]cachedPerm
}

// ── permission caching, and why it needs a generation ──────────────────
//
// AUDIT F02: chatMemberOk was a plain bool cached for the SOCKET'S LIFETIME.
// Removing someone from a group invalidated the Redis roster (which stops
// fan-out reaching them) but nothing touched the decision their live socket
// was already holding, so a removed member's connection stayed authorised to
// publish into the chat — live-location updates, call signalling — until they
// happened to reconnect. On a phone that can be hours.
//
// Rather than hunt down every connected socket on every membership change,
// each chat carries a generation counter. An entry is only usable if it was
// decided at the CURRENT generation, so one bump invalidates every socket's
// copy at once, in O(1), with no registry walk and no lock ordering to get
// wrong.
//
// ponytail: the counter is per-process. A second replica would not see the
// bump, which is what permTTL is for — a bounded worst case instead of an
// unbounded one. Scale-out needs this published over the same Redis channel
// the adapter already uses.
const permTTL = 30 * time.Second

type cachedPerm struct {
	ok  bool
	gen uint64
	at  time.Time
}

var (
	permGenMu sync.Mutex
	permGen   = map[string]uint64{}
)

// permGenerationOf reads a chat's current permission generation.
func permGenerationOf(chatID string) uint64 {
	permGenMu.Lock()
	defer permGenMu.Unlock()
	return permGen[chatID]
}

// BumpChatPermissions invalidates every socket's cached decision for this chat.
// Called from InvalidateChatMembers, so any code path that already knew to
// refresh the roster now also drops stale authorisation.
func BumpChatPermissions(chatID string) {
	permGenMu.Lock()
	permGen[chatID]++
	permGenMu.Unlock()
}

// fresh reports whether a cached decision may still be used.
func (c cachedPerm) fresh(gen uint64) bool {
	return c.gen == gen && time.Since(c.at) < permTTL
}

// sd() unwrapped a *socket.Socket's Data() into *sockData. CC-Wire sessions
// carry their *sockData directly (ccwireSession.d), so nothing needs it.

// Hub wraps the Socket.IO server plus the process-local presence state.
type Hub struct {
	// presence: uid → set(socketId), mirrors server.js userSockets. Guards
	// online-count too — OnlineCount == len(userSockets), matching admin.js.
	pmu         sync.Mutex
	userSockets map[string]map[string]struct{}

	// CC-Wire sessions, by uid. NOT a second roster: who is in a chat is still
	// decided once, by chatMemberIDs in FanOutToChat, and this map only says
	// which of those uids also has a CC-Wire socket open. Nil until one
	// connects, which requires CCWIRE_WS=1 (ccwire_messages.go).
	cwmu       sync.Mutex
	cwSessions map[string]map[*ccwireSession]struct{}
	cwBusClose func()

	// Admin firehose over SSE (admin_sse.go). Fed from the same EmitToRooms /
	// EmitBroadcast call sites as the Socket.IO "admin" room, so the two cannot
	// drift while both exist.
	adminSSE adminSSE

	// resume holds sessions parked across a disconnect (ccwire_resume.go).
	// Process-local and bounded: a restart invalidates every token, which is
	// why resume must never be a correctness dependency.
	resume *resumeStore
}

// New constructs the Socket.IO server, registers the JWT/admin-key auth
// middleware and every connection handler, and starts the chat-viewer sweep.
func New() *Hub {
	// Socket.IO's server options, Redis adapter and *socket.Server were
	// constructed here. The adapter is not replaced: CC-Wire carries its own
	// cross-node fan-out (publishCCWire / startCCWireCluster), which never used
	// the Socket.IO pub/sub wire format.
	h := &Hub{
		userSockets: map[string]map[string]struct{}{},
		resume:      newResumeStore(),
	}

	// Live readers rather than counters we would have to keep in sync — the
	// hub already owns this state, and a scrape-time read cannot drift from it.
	// OnlineCount takes pmu (or hits Redis in cluster mode), which is why
	// metrics.Handler reads gauges outside its own lock.
	metrics.SetGauge("sockets_online", func() float64 { return float64(h.OnlineCount()) })
	// Per-process gauges. sockets_local is the HPA signal — see LocalSockets for
	// why sockets_online cannot be used for that.
	metrics.SetGauge("sockets_local", func() float64 { return float64(h.LocalSockets()) })
	metrics.SetGauge("users_local", func() float64 { return float64(h.LocalUsers()) })
	// Parked (disconnected but resumable) sessions. Bounded by
	// maxParkedSessions; watching this is how the bound is known to hold.
	metrics.SetGauge("ccwire_resume_parked_sessions", func() float64 {
		if h.resume == nil {
			return 0
		}
		return float64(h.resume.len())
	})

	// The Socket.IO JWT/admin-key handshake middleware and the "connection"
	// binding were here. CC-Wire authenticates its own upgrade
	// (httpx.RequireAuth in ccwire.go) and the admin console now authenticates
	// per-request with x-admin-key on GET /admin/events (admin_sse.go).

	h.startViewerSweep()
	h.startResumeSweep()
	h.startCCWireCluster()
	if ClusterEnabled() {
		h.startCluster() // heartbeat + dead-node janitor (cluster.go)
	}

	Default = h
	return h
}

// LocalUsers and LocalSockets are the counts for THIS process only.
//
// They exist because OnlineCount() is not a per-process number. Under
// REDIS_ADAPTER=1 — which is production — it returns clusterOnlineCount(), a
// Redis SCARD over vc:pres:online, so every replica reports the identical
// fleet-wide figure. That is exactly right for an admin dashboard and exactly
// wrong for an autoscaler: a Pods-type HPA metric averages the value across
// pods, so the average of N identical fleet totals is the fleet total, and the
// HPA computes desired = current x (fleet / target) and jumps straight to
// maxReplicas on the first evaluation. The failure is invisible in a one-pod
// test, where the fleet total and the local count are the same number.
//
// LocalSockets, not LocalUsers, is the autoscaling signal: the cost of a pod is
// open connections, and a user with four devices is four connections.
func (h *Hub) LocalUsers() int {
	h.pmu.Lock()
	defer h.pmu.Unlock()
	return len(h.userSockets)
}

func (h *Hub) LocalSockets() int {
	h.pmu.Lock()
	defer h.pmu.Unlock()
	n := 0
	for _, set := range h.userSockets {
		n += len(set)
	}
	return n
}

// Shutdown drains the realtime layer for an orderly process exit.
//
// Order matters. DisconnectSockets(true) sends every client a real disconnect
// with close=true, which socket.io-client treats as "reconnect now" and retries
// within its backoff floor. Without it the sockets simply die with the process
// and each client waits out a ping timeout first — on a rolling update that is
// tens of seconds of dead air per pod, which is exactly the window a message
// gets dropped in.
//
// Close is then given a bounded wait: it is the library's own teardown and a
// hung one must not outlive the pod's grace period. A timeout here is logged
// and ignored, because the process is going away regardless.
func (h *Hub) Shutdown(wait time.Duration) {
	// CC-Wire sessions FIRST, and before the h.io nil check below: they live in
	// their own registry, they are not Socket.IO sockets, and DisconnectSockets
	// does not reach them. Until this existed they were simply dropped when the
	// process exited, so every deploy looked like a network fault to a CC-Wire
	// client. Placed above the early return because a hub with no Socket.IO
	// server can still be serving CC-Wire.
	h.ccwireShutdown(wait)
	if h.cwBusClose != nil {
		h.cwBusClose()
	}

	// Socket.IO's DisconnectSockets/Close were here. ccwireShutdown above is
	// the whole shutdown path now.
}

// onConnection — the Socket.IO connection handler — was here. It joined
// user:/admin rooms, registered the chat and signal handlers and cleaned up
// call rooms on disconnect. CC-Wire does all of that in ccwire_messages.go
// against its own session, which is why this could go without a replacement.

// EmitToUid emits to every device of a user (room user:<uid>) — server.js
// emitToUid.
func (h *Hub) EmitToUid(uid, event string, payload any) {
	h.emitToUidIn("", uid, event, payload)
}

func (h *Hub) emitToUidContext(ctx context.Context, uid, event string, payload any) {
	h.emitToUidInContext(ctx, "", uid, event, payload)
}

// emitToUidIn is EmitToUid plus the chat the event belongs to, and it is THE
// LEAF of the one fan-out both transports share.
//
// FanOutToChat decides the audience — the Redis-cached member roster, minus
// blockers, minus ghost-mode targets — and then calls this once per surviving
// uid. Putting the CC-Wire delivery HERE rather than beside FanOutToChat is
// what stops the second transport from growing a second roster: a CC-Wire
// client is reached because the shared fan-out already decided to reach that
// user, never because CC-Wire computed its own list.
//
// chatID is what the Socket.IO payloads do not all carry (a receipt payload is
// {userId, lastReadMessageId} and nothing else) while the CC-Wire Receipt body
// requires it. It is "" for the handful of EmitToUid callers that are not
// chat-scoped; those events have no CC-Wire body and are not translated.
//
// The Socket.IO emit is unchanged and goes first. The nil guard is for the
// package's DB-free tests, which build a bare &Hub{}; production always has io.
func (h *Hub) emitToUidIn(chatID, uid, event string, payload any) {
	h.emitToUidInContext(bg, chatID, uid, event, payload)
}

func (h *Hub) emitToUidInContext(ctx context.Context, chatID, uid, event string, payload any) {
	if ctx.Err() != nil {
		return
	}
	h.ccwireDeliver(chatID, uid, event, payload, ctx)
}

// EmitToRooms emits to explicit socket rooms (chat:<id>, channel:<id>, admin…).
func (h *Hub) EmitToRooms(rooms []string, event string, payload any) {
	if len(rooms) == 0 {
		return
	}
	h.ccwireRooms(rooms, "", event, payload)
	for _, r := range rooms {
		if r == "admin" {
			h.publishAdmin(event, payload)
			break
		}
	}
}

// EmitBroadcast emits to every connected socket (admin /broadcast, announcements).
func (h *Hub) EmitBroadcast(event string, payload any) {
	h.ccwireRooms(nil, "", event, payload)
	// A broadcast reaches every socket, which includes the admin console.
	h.publishAdmin(event, payload)
}

// OnlineCount is the number of distinct online users — matches Node's
// admin.js getOnlineCount() == userSockets.size. Cluster mode counts the
// whole fleet via the vc:pres:online set (cluster.go).
func (h *Hub) OnlineCount() int {
	if ClusterEnabled() {
		return clusterOnlineCount()
	}
	h.pmu.Lock()
	defer h.pmu.Unlock()
	return len(h.userSockets)
}

// hasLiveSocket reports whether a user currently has any connected socket —
// on this node (single-node) or on any live node (cluster). This gates the
// call wake push, so cluster correctness here is what stops a callee on
// replica B from getting a redundant push when ringing via replica A.
func (h *Hub) hasLiveSocket(uid string) bool {
	h.pmu.Lock()
	local := len(h.userSockets[uid]) > 0
	h.pmu.Unlock()
	if local {
		return true // fast path — a local socket is proof enough in any mode
	}
	if ClusterEnabled() {
		return clusterHasLive(uid)
	}
	return false
}

// safeKeyEqual mirrors server.js safeKeyEqual: constant-time sha256 compare.
func safeKeyEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

func bearerToken(headers map[string][]string) string {
	for k, v := range headers {
		if len(v) == 0 {
			continue
		}
		if k == "Authorization" || k == "authorization" {
			m := bearerRe.FindStringSubmatch(v[0])
			if m != nil {
				return m[1]
			}
		}
	}
	return ""
}
