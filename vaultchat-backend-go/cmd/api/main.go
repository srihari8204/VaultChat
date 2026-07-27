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
	"vaultchat/backend-go/internal/httpx"
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

	// Go-service health (Node keeps /health; Caddy never routes this to us).
	mux.HandleFunc("GET /go-health", func(w http.ResponseWriter, r *http.Request) {
		dbOK := db.Pool.Ping(r.Context()) == nil
		redisOK := redisx.Client != nil && redisx.Client.Ping(r.Context()).Err() == nil
		status := "ok"
		if !dbOK {
			status = "degraded"
		}
		httpx.JSON(w, 200, map[string]any{"status": status, "db": dbOK, "redis": redisOK})
	})

	routes.RegisterContacts(mux)
	routes.RegisterLink(mux)
	routes.RegisterGif(mux)
	routes.RegisterStories(mux)
	routes.RegisterNav(mux)
	routes.RegisterGames(mux)
	routes.RegisterCommunities(mux)
	routes.RegisterAuth(mux)
	routes.RegisterAI(mux)
	routes.RegisterCalls(mux)
	routes.RegisterUploads(mux)
	routes.RegisterChannels(mux)
	routes.RegisterVaultbeam(mux)
	routes.RegisterUser(mux)
	routes.RegisterVaultlens(mux)
	routes.RegisterAdmin(mux)

	// Reap stale VaultBeam relay rows hourly (mirrors server.js).
	go func() {
		for range time.Tick(time.Hour) {
			if err := routes.VaultbeamSweepExpired(ctx); err != nil {
				log.Printf("[vaultbeam] sweep: %v", err)
			}
		}
	}()

	// Anything else reaching us is a proxy misconfiguration — say so loudly.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		httpx.Err(w, http.StatusNotFound, "route not migrated to go backend")
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "4000"
	}
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("[go-api] listening on :%s", port)
	log.Fatal(srv.ListenAndServe())
}
