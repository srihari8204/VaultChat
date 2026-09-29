// vaultchat-backend-go — the strangler backend (Phase 2).
//
// Serves ONLY the routes Caddy sends it; shares the same Postgres/Redis as
// Node. Route registration below is the Go-side counterpart of the Caddyfile
// blocks — a path must exist in BOTH to be live.
package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/jobs"
	"vaultchat/backend-go/internal/metrics"
	"vaultchat/backend-go/internal/realtime"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/routes"
	"vaultchat/backend-go/internal/services"
	"vaultchat/backend-go/internal/storage"
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
	// The Go toolchain that compiled this, because it is a patching question
	// nobody could answer without running `strings` on the binary. The
	// Dockerfile builds from the floating `golang:1.26-alpine` tag and the
	// deploy does not pass --pull, so production silently stays on whichever
	// base layer the box cached — 1.26.5 was live while 1.26.6 carried
	// standard-library fixes, and nothing anywhere said so.
	return map[string]any{"source": source, "builtAt": built, "go": runtime.Version()}
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
	if err := services.Load(); err != nil {
		log.Fatalf("[boot] %v", err)
	}
	log.Printf("[boot] services: %s", strings.Join(services.List(), ", "))
	if services.Enabled(services.Core) {
		if os.Getenv("JWT_SECRET") == "" {
			log.Fatal("[boot] JWT_SECRET is empty — refusing to start: every authenticated route would accept forged tokens")
		}
		if len(os.Getenv("JWT_SECRET")) < 32 {
			log.Printf("[boot] WARNING: JWT_SECRET is under 32 chars — brute-forceable offline; rotate to 32+ random bytes")
		}
	} else if os.Getenv("NODE_INTERNAL_URL") == "" || os.Getenv("INTERNAL_EMIT_KEY") == "" {
		// Without core this process holds no sockets; every live event goes to
		// core's /internal/emit. emitx drops the post silently when either is
		// unset, which would ship a service whose users never hear anything.
		log.Fatal("[boot] SERVICES excludes core but NODE_INTERNAL_URL or INTERNAL_EMIT_KEY is unset — " +
			"refusing to start: live events would have nowhere to go")
	}

	// REQUIRE_OBJECT_STORE — the guard that makes multi-replica safe.
	//
	// uploads.go has two write paths: an object store when storage.Enabled()
	// (S3_ENDPOINT + S3_ACCESS_KEY both set), and a local-disk fallback when it
	// is not. The fallback is correct for dev and for a single-box self-host,
	// and it is quietly catastrophic behind a Deployment: each replica writes to
	// its own ephemeral filesystem, so an upload succeeds on the pod that
	// received it and 404s from every other one. Nothing errors. It presents as
	// "some images don't load", intermittently, in proportion to replica count.
	//
	// Misconfiguration is the realistic way this happens — an S3_* key that did
	// not reach the pod — and the symptom points nowhere near the cause. So the
	// chart sets this and the process refuses to start rather than serving a
	// storage layer that silently loses files.
	if os.Getenv("REQUIRE_OBJECT_STORE") == "1" && !storage.Enabled() {
		log.Fatal("[boot] REQUIRE_OBJECT_STORE=1 but S3_ENDPOINT/S3_ACCESS_KEY are unset — " +
			"refusing to start: uploads would land on a single replica's local disk and 404 from the rest")
	}

	// Cancellable so the shutdown path can stop the in-process schedulers
	// (jobs.StartAll, the reapers, the VaultBeam sweep) rather than leaving them
	// mid-query while the process exits.
	ctx, cancel := context.WithCancel(context.Background())
	if err := db.Connect(ctx); err != nil {
		log.Fatalf("[db] %v", err)
	}
	redisx.Connect()

	// draining flips on SIGTERM so /ready reports 503 immediately, rather than
	// waiting for the next probe interval to discover the pod is going away.
	// The kubelet needs a failed readiness check to pull the pod from the
	// Service endpoints, and ingress-nginx needs that endpoint change to update
	// its own backend list; every second between the signal and the first 503 is
	// a second of requests still being routed to a process that is shutting down.
	var draining atomic.Bool

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
		if draining.Load() {
			httpx.JSON(w, http.StatusServiceUnavailable, map[string]any{
				"ready": false, "draining": true,
				"uptime": time.Since(start).Seconds(),
			})
			return
		}
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

	// LIVEZ — the probe-free liveness endpoint.
	//
	// /health is already safe to use as a liveness probe: it returns 200
	// unconditionally, because restarting a pod does not fix a database
	// outage. What it is not is FREE — it pings Postgres and Redis on every
	// call with a 2s bound, so a kubelet probe configured with the default
	// timeoutSeconds: 1 will time out and restart a pod whose only problem is
	// a slow database. That is the same cluster-wide restart storm the
	// always-200 contract was written to prevent, arriving through the probe
	// timeout instead of the status code.
	//
	// This endpoint touches nothing. If the goroutine scheduler can run this
	// handler, the process is alive, which is the entire question a liveness
	// probe asks. Readiness stays on /ready, which is where dependency health
	// belongs.
	mux.HandleFunc("GET /livez", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, map[string]any{
			"alive": true, "uptime": time.Since(start).Seconds(),
		})
	})

	registerRoutes(mux) // routes.go: each service this process runs

	// The phone's one live connection, and the bridge other services reach it
	// through, belong to core. A process without core holds no sockets: emitx
	// hooks stay nil, so its emits post to core's /internal/emit.
	var hub *realtime.Hub
	if services.Enabled(services.Core) {
		// ── Realtime: CC-Wire for the app, SSE for the admin console. ──
		// Socket.IO is gone. /socket.io/ is no longer mounted and SOCKET_IO_ENABLED
		// no longer does anything — the app dropped socket.io-client entirely and
		// the admin console streams GET /admin/events (internal/realtime/admin_sse.go).
		hub = realtime.New()
		realtime.RegisterCCWire(mux, hub)   // CC-Wire v1 listener, no-op unless CCWIRE_WS=1
		realtime.RegisterAdminSSE(mux, hub) // admin firehose, x-admin-key per request

		// Logout must invalidate parked CC-Wire resume sessions: a resume token
		// that outlives the refresh token it was issued under would silently
		// restore a session the user just ended.
		routes.OnSessionRevoked = func(uid string) { hub.InvalidateResume(uid) }

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
	}

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
	if services.Enabled(services.Core) {
		go func() {
			sweep := func() {
				jobs.RunLocked(ctx, "vaultbeam-sweep", func(ctx context.Context) {
					if err := routes.VaultbeamSweepExpired(ctx); err != nil {
						log.Printf("[vaultbeam] sweep: %v", err)
					}
				})
			}
			sweep()
			for range time.Tick(time.Hour) {
				sweep()
			}
		}()
	}

	// The periodic jobs that lived in Node's server.js — sweepers + the
	// scheduled-messages worker — so a Node-less prod loses nothing.
	jobs.StartAll(ctx) // each job starts only with the service that owns it
	if services.Enabled(services.ShopBook) {
		routes.StartShopBookJobs(ctx)
	}
	// Releases hosts locked out by a broadcast whose egress died without ever
	// sending a terminal webhook. broadcast_one_active_per_host is a UNIQUE
	// index over the non-terminal statuses, so a single wedged row stops that
	// account going live again permanently — see broadcast_reaper.go.
	if services.Enabled(services.GoLive) {
		routes.StartBroadcastReaper(ctx)
	}
	// Host-disconnect grace period. Separate from the reaper above because it
	// acts on a signal that one does not have — host_left_at, written by the Go
	// Live webhook — which is what makes a 90-second verdict safe where the
	// reaper could only justify twelve hours.
	if services.Enabled(services.GoLive) {
		routes.StartGoLiveHostSweep(ctx)
	}
	// Retention observability: how many bodies exist, and how many are past
	// their deadline. `message_bodies_overdue` should sit at ~0 — a non-zero
	// value that persists is the signal that the expiry sweep has stopped and
	// the three-hour guarantee is silently not being met.
	if services.Enabled(services.Core) {
		routes.RegisterBodyGauges()
	}
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

	// ── orderly shutdown ────────────────────────────────────────────────
	//
	// This used to be log.Fatal(srv.ListenAndServe()), which has no SIGTERM
	// path at all: the process died mid-request and every WebSocket went with
	// it, unclosed. On one long-lived box that cost a few seconds at deploy
	// time and nobody noticed. Under an orchestrator it is a different thing
	// entirely — every rolling update, every autoscale-down and every node
	// drain terminates pods, so this path runs constantly rather than
	// occasionally, and each time it drops live conversations.
	//
	// The sequence, in order, and each step is load-bearing:
	//
	//  1. A grace delay BEFORE anything stops. The load balancer learns a pod
	//     is going away from its own health checks, which lag the SIGTERM by
	//     design; accepting normally through that window is what keeps the
	//     requests already in flight toward us from being refused. Sized by
	//     SHUTDOWN_DRAIN_DELAY and meant to exceed the readiness interval.
	//  2. Drain the realtime hub, so clients are told to reconnect instead of
	//     discovering it via a ping timeout.
	//  3. srv.Shutdown, which stops accepting and waits out in-flight requests.
	//  4. Cancel the root context, stopping the background schedulers.
	//
	// The whole thing is bounded by SHUTDOWN_TIMEOUT and must stay below the
	// pod's terminationGracePeriodSeconds, or the kubelet SIGKILLs us partway
	// through and none of the above happened.
	var wtServer io.Closer
	if hub != nil {
		var wtErr error
		if wtServer, wtErr = realtime.StartCCWireWebTransport(hub); wtErr != nil {
			log.Fatalf("[go-api] WebTransport setup failed: %v", wtErr)
		}
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		log.Fatalf("[go-api] listen failed: %v", err)
	case sig := <-stop:
		log.Printf("[go-api] %s received — draining", sig)
	}

	// Announce unreadiness BEFORE the grace delay, not after: the delay exists
	// to give this 503 time to propagate through the endpoints controller and
	// the ingress, and a delay that starts before the signal is pointless.
	draining.Store(true)

	if d := envDuration("SHUTDOWN_DRAIN_DELAY", 5*time.Second); d > 0 {
		log.Printf("[go-api] holding %s for load-balancer deregistration", d)
		time.Sleep(d)
	}

	total := envDuration("SHUTDOWN_TIMEOUT", 45*time.Second)
	shutCtx, shutCancel := context.WithTimeout(context.Background(), total)
	defer shutCancel()

	if wtServer != nil {
		_ = wtServer.Close()
	}
	if hub != nil {
		hub.Shutdown(10 * time.Second)
	}

	if err := srv.Shutdown(shutCtx); err != nil {
		log.Printf("[go-api] shutdown: in-flight requests did not finish in %s: %v", total, err)
	}
	cancel()
	log.Println("[go-api] stopped")
}

// envDuration reads a Go duration ("30s", "2m") and falls back to def when the
// variable is unset or unparseable. Deliberately forgiving: a typo in a
// shutdown tunable must not stop the server from starting.
func envDuration(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		log.Printf("[go-api] %s=%q is not a duration, using %s", key, v, def)
		return def
	}
	return d
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
