// vaultchat-backend-go — the strangler backend (Phase 2).
//
// Serves ONLY the routes Caddy sends it; shares the same Postgres/Redis as
// Node. Route registration below is the Go-side counterpart of the Caddyfile
// blocks — a path must exist in BOTH to be live.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/jobs"
	"vaultchat/backend-go/internal/metrics"
	"vaultchat/backend-go/internal/realtime"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/routes"
)

// Build provenance, set by the linker (-ldflags -X) in the Dockerfile.
//
// "What is running in production?" had no answer. The box builds from a working
// tree hundreds of commits behind its own git HEAD with hundreds of modified
// files copied over it, so a commit SHA baked in here would name a commit that
// is NOT what compiled — a confident lie is worse than no answer.
//
// So buildSource is a fingerprint of the source that was actually compiled
// (see the Dockerfile, and scripts/fingerprint-go.sh to recompute it from any
// checkout). Comparing one string against GET /build answers the question.
//
// Empty means someone built without the Dockerfile; /build says so rather than
// pretending.
var (
	buildSource = ""
	buildTime   = ""
)

// buildInfo reports provenance, saying "unknown" rather than guessing. An empty
// value means the binary was NOT built by the Dockerfile, and during an
// incident that distinction is the whole point: "I don't know what this is" is
// actionable, a blank field looks like a display bug.
func buildInfo() map[string]any {
	source, built := buildSource, buildTime
	if source == "" {
		source = "unknown — built outside the Dockerfile, provenance unavailable"
	}
	if built == "" {
		built = "unknown"
	}
	return map[string]any{"source": source, "builtAt": built}
}

func main() {
	// JWT_SECRET is read lazily, per request, by httpx.VerifyAccess and by the
	// HLS ticket HMAC. Go's os.Getenv returns "" for an unset variable rather
	// than failing, so an env_file that lost this line does not crash the
	// container — it starts a server whose HS256 key is the empty string, where
	// a token anyone can mint verifies against every RequireAuth route. That is
	// a total auth bypass presenting as a healthy deploy, which is exactly the
	// failure a boot check is for.
	//
	// Refuse to start on EMPTY only. A length rule here would be a footgun of
	// its own: it could refuse to start on a secret that is short but real and
	// already in production, turning a hardening change into an outage. Short
	// secrets get a loud line in the log instead.
	if os.Getenv("JWT_SECRET") == "" {
		log.Fatal("[boot] JWT_SECRET is empty — refusing to start: every authenticated route would accept forged tokens")
	}
	if len(os.Getenv("JWT_SECRET")) < 32 {
		log.Printf("[boot] WARNING: JWT_SECRET is under 32 chars — brute-forceable offline; rotate to 32+ random bytes")
	}

	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		log.Fatalf("[db] %v", err)
	}
	redisx.Connect()

	mux := http.NewServeMux()

	// Health — Node's exact shape (status/db/redis/uptime), served by Go so a
	// Node-less prod keeps its monitoring probe. /go-health kept as an alias
	// for the strangler period.
	start := time.Now()

	// AUDIT F14: the probes are bounded. They used to inherit the request
	// context, so a database wedged rather than down left the health handler
	// hanging as long as the client would wait — the one request that must
	// always answer.
	const probeTimeout = 2 * time.Second
	probe := func(r *http.Request) (dbOK, redisOK bool) {
		ctx, cancel := context.WithTimeout(r.Context(), probeTimeout)
		defer cancel()
		dbOK = db.Pool.Ping(ctx) == nil
		redisOK = redisx.Client != nil && redisx.Client.Ping(ctx).Err() == nil
		return
	}

	// LIVENESS — "this process is running". Always 200, because a restart does
	// not fix a database outage and an orchestrator must not loop on one.
	// Node's exact shape (status/db/redis/uptime) is preserved for the existing
	// monitoring probe; `status` now tells the truth about Redis, which it did
	// not before — a Redis outage still reported "ok".
	health := func(w http.ResponseWriter, r *http.Request) {
		dbOK, redisOK := probe(r)
		status := "ok"
		if !dbOK || !redisOK {
			status = "degraded"
		}
		httpx.JSON(w, 200, map[string]any{
			"status": status, "db": dbOK, "redis": redisOK,
			"uptime": time.Since(start).Seconds(),
		})
	}
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("GET /go-health", health)

	// READINESS — "this process can serve requests". 503 when it cannot, so
	// status-code monitoring stops going green through an outage, which is the
	// actual F14 complaint.
	//
	// The database is required: without it nothing works. Redis is NOT, and
	// that is a deliberate call — the limiter falls back in-process
	// (redisx.ConsumeSecure, F11) and the socket layer fails open to local
	// maps, so a Redis outage is a degradation, not an outage. It is reported
	// either way so an alert can fire on the body without taking the service
	// out of the load balancer.
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, r *http.Request) {
		dbOK, redisOK := probe(r)
		code := 200
		if !dbOK {
			code = http.StatusServiceUnavailable
		}
		httpx.JSON(w, code, map[string]any{
			"ready": dbOK, "db": dbOK, "redis": redisOK,
			"uptime": time.Since(start).Seconds(),
		})
	})

	// PROVENANCE — "which source is this binary?" Unauthenticated on purpose:
	// it is the first thing you need during an incident, when you may not have
	// a token, and it discloses nothing an attacker can use — a hash of source
	// they cannot invert and a timestamp.
	mux.HandleFunc("GET /build", func(w http.ResponseWriter, r *http.Request) {
		info := buildInfo()
		info["uptime"] = time.Since(start).Seconds()
		httpx.JSON(w, 200, info)
	})

	routes.RegisterContacts(mux)
	routes.RegisterAppVersion(mux) // GET /app/version — the minimum-build gate
	routes.RegisterLink(mux)
	routes.RegisterGif(mux)
	routes.RegisterStories(mux)
	routes.RegisterNav(mux)
	routes.RegisterGames(mux) // VaultGames mini-app launch token
	routes.RegisterCommunities(mux)
	routes.RegisterAuth(mux)
	routes.RegisterCalls(mux)
	routes.RegisterCallSessions(mux)
	routes.RegisterBroadcasts(mux)
	routes.RegisterBroadcastSocial(mux)
	// Egress lifecycle → broadcast status. Under /internal/, which Caddy 404s
	// from outside, and signature-verified on top of that.
	routes.RegisterBroadcastWebhook(mux)
	// Go Live runs its OWN LiveKit deployment (internal/golive), so it needs its
	// own receiver — deliveries are signed with a different project's secret and
	// the calling receiver above would reject them, correctly. Also carries the
	// host-presence events the calling one has no reason to handle.
	routes.RegisterGoLiveWebhook(mux)
	// GET /golive/health — Go Live's own liveness. Reports the Go Live LiveKit
	// only; a failure here can never mark the calling LiveKit unhealthy.
	routes.RegisterGoLive(mux)
	// Polls: the one thing the UNBOUNDED audience writes to. Live tallies come
	// from Redis sets, the durable record from Postgres — same split the viewer
	// and like counts already use.
	routes.RegisterGoLivePolls(mux)
	// Shareable Private Live invitations. The link IS the access mechanism —
	// the host does not pick invitees up front. Redeeming writes an ordinary
	// broadcast_invites row, so every existing gate applies unchanged.
	routes.RegisterGoLiveInvites(mux)
	routes.RegisterUploads(mux)
	routes.RegisterChannels(mux)
	routes.RegisterVaultbeam(mux)
	routes.RegisterUser(mux)
	routes.RegisterAdmin(mux)
	routes.RegisterChats(mux)
	routes.RegisterChatInvitations(mux) // Groups & Circles: /invitations (invitee side)
	// Chat codes: open a direct chat with someone whose number you do not have.
	// Redeeming goes through directChatEnsure, the same path POST /chats uses.
	routes.RegisterChatCodes(mux)
	routes.RegisterChatMembership(mux) // Groups & Circles: in-app accept (invitee side)
	routes.RegisterShopBook(mux)
	routes.RegisterShopBookStock(mux)
	routes.RegisterShopBookBilling(mux)
	routes.RegisterShopBookDocuments(mux)
	routes.RegisterShopBookPayments(mux)
	routes.RegisterShopBookKhata(mux) // walk-in customers (migration 111)
	routes.RegisterShopBookPurchases(mux)
	routes.RegisterShopBookReturns(mux)
	routes.RegisterShopBookVerify(mux)
	routes.RegisterShopBookAdmin(mux)
	routes.RegisterShopBookAdmin2(mux)

	// ── Realtime (Phase 2 Step 5): Go owns the Socket.IO layer ──────────
	hub := realtime.New()
	mux.Handle("/socket.io/", hub.Handler())

	// Point emitx at the local hub so Go-served routes emit IN-PROCESS
	// instead of bridging to Node. The admin firehose mirror that Node's
	// broadcastNewMessage/broadcastChatEvent add on top of the pure
	// fanOutToChat is composed here (FanOutToChat stays a pure port).
	emitx.LocalToUids = func(uids []string, event string, payload any) {
		for _, u := range uids {
			hub.EmitToUid(u, event, payload)
		}
	}
	emitx.LocalToRooms = hub.EmitToRooms
	emitx.LocalBroadcast = hub.EmitBroadcast
	emitx.LocalFanOutChat = func(ctx context.Context, chatID, event string, payload any, senderID string) {
		broadcastChat(ctx, hub, chatID, event, payload, senderID)
	}

	// Reverse bridge: Go owns sockets, so an in-network Node process can POST
	// here to reach clients. Same key-guarded shape as Node's /internal/*;
	// Caddy refuses /internal/* from outside, so only in-network callers reach
	// these.
	//
	// Its only consumer was the VaultLens QueueEvents listener, which has been
	// removed. Kept because it is generic transport, not VaultLens code: the
	// legacy Node API still emits through it if that profile is ever started,
	// and it is the escape hatch any future out-of-process worker would use.
	// Retiring it is a separate decision from deleting VaultLens.
	internalKey := os.Getenv("INTERNAL_EMIT_KEY")
	guard := func(r *http.Request) bool {
		return internalKey != "" && r.Header.Get("X-Internal-Key") == internalKey
	}
	mux.HandleFunc("POST /internal/emit", func(w http.ResponseWriter, r *http.Request) {
		if !guard(r) {
			httpx.Err(w, http.StatusForbidden, "forbidden")
			return
		}
		var b struct {
			Rooms     []string `json:"rooms"`
			UserIds   []string `json:"userIds"`
			Event     string   `json:"event"`
			Payload   any      `json:"payload"`
			Broadcast bool     `json:"broadcast"`
		}
		_ = httpx.Body(r, &b)
		if b.Event == "" {
			httpx.Err(w, http.StatusBadRequest, "event required")
			return
		}
		if b.Broadcast {
			hub.EmitBroadcast(b.Event, b.Payload)
			httpx.JSON(w, 200, map[string]any{"ok": true, "broadcast": true})
			return
		}
		if len(b.Rooms) > 0 {
			hub.EmitToRooms(b.Rooms, b.Event, b.Payload)
		}
		for _, u := range b.UserIds {
			hub.EmitToUid(u, b.Event, b.Payload)
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "rooms": len(b.Rooms) + len(b.UserIds)})
	})
	mux.HandleFunc("POST /internal/chat-event", func(w http.ResponseWriter, r *http.Request) {
		if !guard(r) {
			httpx.Err(w, http.StatusForbidden, "forbidden")
			return
		}
		var b struct {
			Kind    string `json:"kind"`
			ChatId  string `json:"chatId"`
			Event   string `json:"event"`
			Payload any    `json:"payload"`
		}
		_ = httpx.Body(r, &b)
		if b.ChatId == "" {
			httpx.Err(w, http.StatusBadRequest, "chatId required")
			return
		}
		switch b.Kind {
		case "new_message":
			broadcastChat(r.Context(), hub, b.ChatId, "new_message", b.Payload, senderOf(b.Payload))
		case "chat_event":
			if b.Event == "" {
				httpx.Err(w, http.StatusBadRequest, "bad kind")
				return
			}
			broadcastChat(r.Context(), hub, b.ChatId, b.Event, b.Payload, "")
		default:
			httpx.Err(w, http.StatusBadRequest, "bad kind")
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true})
	})

	// Reap expired VaultBeam relay objects: ONCE AT STARTUP, then hourly.
	//
	// time.Tick(time.Hour) does not deliver until a full hour has elapsed, so
	// the first sweep used to land at start + 1h. A go-api that restarts more
	// often than that - a crash loop, a rolling deploy, an operator cycling the
	// container - would therefore never reach its first tick, and expired R2
	// relay objects would accumulate with the 24h ceiling silently unenforced.
	//
	// Running the SAME function once before entering the loop closes that hole.
	// The interval is unchanged, the sweep is unchanged, and there is still
	// exactly one scheduler - `sweep` is a name for the existing call, not a
	// second implementation.
	go func() {
		sweep := func() {
			if err := routes.VaultbeamSweepExpired(ctx); err != nil {
				log.Printf("[vaultbeam] sweep: %v", err)
			}
		}
		sweep()
		for range time.Tick(time.Hour) {
			sweep()
		}
	}()

	// The periodic jobs that lived in Node's server.js — sweepers + the
	// scheduled-messages worker — so a Node-less prod loses nothing.
	jobs.StartAll(ctx)
	routes.StartShopBookJobs(ctx)
	// Releases hosts locked out by a broadcast whose egress died without ever
	// sending a terminal webhook. broadcast_one_active_per_host is a UNIQUE
	// index over the non-terminal statuses, so a single wedged row stops that
	// account going live again permanently — see broadcast_reaper.go.
	routes.StartBroadcastReaper(ctx)
	// Host-disconnect grace period. Separate from the reaper above because it
	// acts on a signal that one does not have — host_left_at, written by the Go
	// Live webhook — which is what makes a 90-second verdict safe where the
	// reaper could only justify twelve hours.
	routes.StartGoLiveHostSweep(ctx)
	// Retention observability: how many bodies exist, and how many are past
	// their deadline. `message_bodies_overdue` should sit at ~0 — a non-zero
	// value that persists is the signal that the expiry sweep has stopped and
	// the three-hour guarantee is silently not being met.
	routes.RegisterBodyGauges()
	// pgxpool already counts these; this only exposes them, and only at scrape
	// time. See internal/db/metrics.go for why there is no query tracer.
	db.RegisterPoolGauges()

	// Anything else reaching us is a proxy misconfiguration — say so loudly.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		httpx.Err(w, http.StatusNotFound, "route not migrated to go backend")
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "4000"
	}
	// Prometheus scrape target (in-network only — Caddy 404s /internal/*).
	mux.HandleFunc("GET /internal/metrics", metrics.Handler)
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           metrics.Wrap(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("[go-api] listening on :%s", port)
	log.Fatal(srv.ListenAndServe())
}

// broadcastChat = Node's broadcastNewMessage / broadcastChatEvent: the pure
// hub.FanOutToChat (block-list + ghost filtering) PLUS the privacy-safe admin
// firehose mirror. One definition shared by the local emitx hook and the
// reverse /internal/chat-event bridge so both paths behave identically.
func broadcastChat(ctx context.Context, hub *realtime.Hub, chatID, event string, payload any, senderID string) {
	// TODO(step4-fanout): the EVENT_BUS=kafka path (decoupled delivery via the
	// fanout worker) is off in the prod shape; FanOutToChat runs in-process.
	hub.FanOutToChat(ctx, chatID, event, payload, senderID)
	m, _ := payload.(map[string]any)
	if event == "new_message" {
		var sender any
		if senderID != "" {
			sender = senderID
		}
		var typ, msgID any
		if m != nil {
			typ, msgID = m["type"], m["id"]
		}
		hub.EmitToRooms([]string{"admin"}, "admin:event", map[string]any{
			"event": "new_message", "chatId": chatID, "senderId": sender,
			"type": typ, "messageId": msgID, "ts": time.Now().UnixMilli(),
		})
		return
	}
	hub.EmitToRooms([]string{"admin"}, "admin:event", map[string]any{
		"event": event, "chatId": chatID, "ts": time.Now().UnixMilli(),
	})
}

// senderOf extracts payload.senderId (Node's `payload?.senderId ?? null`).
func senderOf(payload any) string {
	if m, ok := payload.(map[string]any); ok {
		if s, ok := m["senderId"].(string); ok {
			return s
		}
	}
	return ""
}
