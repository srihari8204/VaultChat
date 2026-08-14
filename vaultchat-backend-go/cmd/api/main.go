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

func main() {
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
	health := func(w http.ResponseWriter, r *http.Request) {
		dbOK := db.Pool.Ping(r.Context()) == nil
		redisOK := redisx.Client != nil && redisx.Client.Ping(r.Context()).Err() == nil
		status := "ok"
		if !dbOK {
			status = "degraded"
		}
		httpx.JSON(w, 200, map[string]any{
			"status": status, "db": dbOK, "redis": redisOK,
			"uptime": time.Since(start).Seconds(),
		})
	}
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("GET /go-health", health)

	routes.RegisterContacts(mux)
	routes.RegisterLink(mux)
	routes.RegisterGif(mux)
	routes.RegisterStories(mux)
	routes.RegisterNav(mux)
	routes.RegisterCommunities(mux)
	routes.RegisterAuth(mux)
	routes.RegisterCalls(mux)
	routes.RegisterCallSessions(mux)
	routes.RegisterBroadcasts(mux)
	routes.RegisterBroadcastSocial(mux)
	// Egress lifecycle → broadcast status. Under /internal/, which Caddy 404s
	// from outside, and signature-verified on top of that.
	routes.RegisterBroadcastWebhook(mux)
	routes.RegisterUploads(mux)
	routes.RegisterChannels(mux)
	routes.RegisterVaultbeam(mux)
	routes.RegisterUser(mux)
	routes.RegisterAdmin(mux)
	routes.RegisterChats(mux)
	routes.RegisterChatInvitations(mux) // Groups & Circles: /invitations (invitee side)
	routes.RegisterChatMembership(mux)  // Groups & Circles: in-app accept (invitee side)
	routes.RegisterShopBook(mux)
	routes.RegisterShopBookStock(mux)
	routes.RegisterShopBookBilling(mux)
	routes.RegisterShopBookPayments(mux)
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

	// Reap stale VaultBeam relay rows hourly (mirrors server.js).
	go func() {
		for range time.Tick(time.Hour) {
			if err := routes.VaultbeamSweepExpired(ctx); err != nil {
				log.Printf("[vaultbeam] sweep: %v", err)
			}
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
	// Retention observability: how many bodies exist, and how many are past
	// their deadline. `message_bodies_overdue` should sit at ~0 — a non-zero
	// value that persists is the signal that the expiry sweep has stopped and
	// the three-hour guarantee is silently not being met.
	routes.RegisterBodyGauges()

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
