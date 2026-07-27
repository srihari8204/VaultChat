// Package realtime is the Go port of the Socket.IO server in
// vaultchat-backend/server.js — JWT-authed handshake, multi-device presence,
// chat/typing/receipt relays, WebRTC + VaultBeam + call signaling, live
// location, ephemeral chat viewers, and the in-memory games platform.
//
// It owns all sockets once the single-node proxy flip cuts realtime over from
// Node. Emit payloads are shaped byte-for-byte like Node's emits (the library
// JSON-marshals whatever map/struct we pass). No Redis adapter, no Kafka — the
// cutover is atomic and fan-out is in-process (EVENT_BUS off in prod).
package realtime

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/zishang520/engine.io/v2/types"
	"github.com/zishang520/socket.io/v2/socket"

	"vaultchat/backend-go/internal/httpx"
)

// Default is set by New() so the orchestrator's /internal/* bridge handlers
// (added in main.go, not here) can reach the live hub.
var Default *Hub

var bg = context.Background()

var bearerRe = regexp.MustCompile(`(?i)^Bearer\s+(.+)$`)

// sockData is the per-socket user context (server.js socket.data). uid/email/
// admin are written once in the auth middleware and read-only afterwards;
// gameRoomID + liveLocOk are mutated by handlers so they take mu.
type sockData struct {
	uid   string
	email string
	admin bool

	mu         sync.Mutex
	gameRoomID string
	liveLocOk  map[string]bool
}

func sd(s *socket.Socket) *sockData {
	d, _ := s.Data().(*sockData)
	return d
}

// Hub wraps the Socket.IO server plus the process-local presence + games state.
type Hub struct {
	io *socket.Server

	// presence: uid → set(socketId), mirrors server.js userSockets. Guards
	// online-count too — OnlineCount == len(userSockets), matching admin.js.
	pmu         sync.Mutex
	userSockets map[string]map[string]struct{}

	// games: ephemeral in-memory coins/rooms/queue (server.js io.game*).
	gmu         sync.Mutex
	gamePlayers map[string]*gamePlayer
	gameRooms   map[string]*gameRoom
	gameQueue   map[string]*queueEntry
}

// New constructs the Socket.IO server, registers the JWT/admin-key auth
// middleware and every connection handler, and starts the chat-viewer sweep.
func New() *Hub {
	opts := socket.DefaultServerOptions()
	// The client is websocket-only (server.js relies on the default upgrade but
	// the RN client never long-polls); pin the transport to skip HTTP polling.
	opts.SetTransports(types.NewSet("websocket"))
	// 2 MB, same as server.js maxHttpBufferSize (encrypted media metadata).
	opts.SetMaxHttpBufferSize(2 * 1024 * 1024)
	opts.SetPingInterval(10 * time.Second) // server.js pingInterval 10000
	opts.SetPingTimeout(5 * time.Second)   // server.js pingTimeout 5000

	io := socket.NewServer(nil, opts)
	h := &Hub{
		io:          io,
		userSockets: map[string]map[string]struct{}{},
		gamePlayers: map[string]*gamePlayer{},
		gameRooms:   map[string]*gameRoom{},
		gameQueue:   map[string]*queueEntry{},
	}

	// JWT handshake middleware — runs before 'connection' (server.js io.use).
	io.Of("/", nil).Use(func(s *socket.Socket, next func(*socket.ExtendedError)) {
		auth, _ := s.Handshake().Auth.(map[string]any)

		// Admin console authenticates with the admin key (not a user JWT).
		if adminKey, _ := auth["adminKey"].(string); adminKey != "" {
			if k := os.Getenv("ADMIN_KEY"); k != "" && safeKeyEqual(adminKey, k) {
				s.SetData(&sockData{uid: "admin", admin: true})
				next(nil)
				return
			}
		}

		token, _ := auth["token"].(string)
		if token == "" {
			token = bearerToken(s.Handshake().Headers)
		}
		if token == "" {
			next(socket.NewExtendedError("auth_required", nil))
			return
		}
		sub, email, err := httpx.VerifyAccess(token)
		if err != nil {
			// httpx.VerifyAccess returns "token_expired" | "invalid_token",
			// the exact connect_error names server.js sends.
			next(socket.NewExtendedError(err.Error(), nil))
			return
		}
		s.SetData(&sockData{uid: sub, email: email, liveLocOk: map[string]bool{}})
		next(nil)
	})

	io.On("connection", func(args ...any) {
		s := args[0].(*socket.Socket)
		h.onConnection(s)
	})

	h.startViewerSweep()

	Default = h
	return h
}

// Handler returns the /socket.io HTTP handler to mount.
func (h *Hub) Handler() http.Handler { return h.io.ServeHandler(nil) }

func (h *Hub) onConnection(s *socket.Socket) {
	d := sd(s)
	if d == nil {
		return
	}
	// Admin console socket — firehose room only, not counted online, no
	// per-user handlers (server.js connection admin branch).
	if d.admin {
		s.Join(socket.Room("admin"))
		s.Emit("ready", map[string]any{"admin": true})
		return
	}

	h.trackSocket(s)
	s.Join(socket.Room("user:" + d.uid))
	s.Emit("ready", map[string]any{"uid": d.uid})

	h.registerChatHandlers(s)
	h.registerSignalHandlers(s)
	h.registerGameHandlers(s)

	// Disconnect cleanup. 'disconnecting' still has the socket's rooms
	// populated (the library empties them before 'disconnect'); we read call
	// rooms there. Everything keyed off socket.data survives to 'disconnect'.
	s.On("disconnecting", func(_ ...any) {
		for _, room := range s.Rooms().Keys() {
			if r := string(room); len(r) > 5 && r[:5] == "call:" {
				s.To(room).Emit("call_peer_left", map[string]any{"chatId": r[5:], "uid": d.uid})
			}
		}
	})
	s.On("disconnect", func(_ ...any) {
		h.untrackSocket(s)
		h.onGameDisconnect(s)
	})
}

// EmitToUid emits to every device of a user (room user:<uid>) — server.js
// emitToUid.
func (h *Hub) EmitToUid(uid, event string, payload any) {
	h.io.To(socket.Room("user:"+uid)).Emit(event, payload)
}

// EmitToRooms emits to explicit socket rooms (chat:<id>, channel:<id>, admin…).
func (h *Hub) EmitToRooms(rooms []string, event string, payload any) {
	if len(rooms) == 0 {
		return
	}
	rs := make([]socket.Room, len(rooms))
	for i, r := range rooms {
		rs[i] = socket.Room(r)
	}
	h.io.To(rs...).Emit(event, payload)
}

// EmitBroadcast emits to every connected socket (admin /broadcast, announcements).
func (h *Hub) EmitBroadcast(event string, payload any) {
	h.io.Emit(event, payload)
}

// OnlineCount is the number of distinct online users — matches Node's
// admin.js getOnlineCount() == userSockets.size.
func (h *Hub) OnlineCount() int {
	h.pmu.Lock()
	defer h.pmu.Unlock()
	return len(h.userSockets)
}

// hasLiveSocket reports whether a user currently has any connected socket on
// this node (single-node: equivalent to server.js io.in(user:x).fetchSockets()).
func (h *Hub) hasLiveSocket(uid string) bool {
	h.pmu.Lock()
	defer h.pmu.Unlock()
	return len(h.userSockets[uid]) > 0
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
