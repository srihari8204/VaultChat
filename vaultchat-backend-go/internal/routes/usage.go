// usage.go — aggregate screen counts, and nothing else.
//
// AUDIT F9. The product carries 195 screens against a handful of users and
// nothing can say which of them are used, so nothing can be retired and
// everything is maintained forever on the assumption that somebody might be
// opening it. This is the instrument that makes "cut this" a decision rather
// than an opinion.
//
// WHAT IT REFUSES TO LEARN
// ------------------------
// The endpoint is authenticated — a counter anyone on the internet can POST to
// is a counter that measures nothing — but the identity is used ONLY to
// rate-limit, and is never written. The row is (screen, day, views). No user,
// no device, no session, no order, no sub-day time.
//
// That is the difference between an instrument and a surveillance log in a
// product whose whole pitch is that the operator cannot see your activity. It
// can answer "does anybody open the Shelf" and it can never answer "does this
// person open the Shelf", and only the first question is anyone's business.
//
// SCREEN NAMES ARE AN ALLOW-LIST, not free text. A client sends route names;
// without a list, this endpoint would be an authenticated write-anything-you-
// like string store, and the first interesting use anyone would find for it is
// not analytics. Unknown names are dropped silently — a client one release
// ahead reporting a screen this server has not heard of is ordinary, not an
// error worth failing a request over.
package routes

import (
	"encoding/json"
	"net/http"
	"strings"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

// The screens worth counting. Deliberately the FEATURE surfaces — the ones a
// retire-or-keep decision would actually be about — rather than every route.
// Counting a modal nobody would ever cut adds rows and answers nothing.
var usageScreens = map[string]bool{
	"chats": true, "calls": true, "status": true, "profile": true, "mini": true,
	"chat": true, "contacts": true, "new-chat": true, "communities": true,
	"live": true, "navigate": true, "family": true, "finance": true,
	"shop-book": true, "encrypted-notes": true, "docscanner": true,
	"shelf": true, "games": true, "aiguardian": true, "decentralized-id": true,
	"vaultbeam": true, "media-gallery": true, "bookmarks": true, "archive-viewer": true,
	"broadcast": true, "settings": true, "chat-backup": true, "privacy-dashboard": true,
	"group-info": true, "create-group": true, "invite-link": true, "qr-contact": true,
	"emergency-sos": true, "location-sharing": true, "schedule-message": true,
	"hidden-chats": true, "blocked": true, "login-history": true, "ghost-mode": true,
	"memoryshield": true, "vaultlens": true, "story-viewer": true, "whiteboard": true,
}

// A single request cannot report more than this many distinct screens. A real
// session touches a handful; a body listing hundreds is either a bug or an
// attempt to make one request expensive.
const usageMaxScreens = 60

// Nor more than this for one screen in one batch. The client flushes every few
// minutes, so a plausible maximum is dozens. This bounds what a single hostile
// client can add to a shared counter — it cannot make the number meaningless in
// one request, and the rate limit bounds how often it may try.
const usageMaxPerScreen = 500

func RegisterUsage(mux *http.ServeMux) {
	mux.HandleFunc("POST /app/usage", httpx.RequireAuth(usagePost))
}

func usagePost(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	ctx := r.Context()

	// Twelve batches an hour is generous for a client that flushes every few
	// minutes, and it is the only thing the caller's identity is used for.
	// ConsumeSecure rather than Consume: a rate limit that fails open when Redis
	// is down is not a rate limit (audit F11).
	if !redisx.ConsumeSecure(ctx, "usage:"+user.ID, 12, 3600).Allowed {
		// 204, not 429. The client must not retry, must not queue, and must not
		// show anyone an error: dropping a usage batch costs nothing that
		// matters, and a visible failure would be the tail wagging the dog.
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var body struct {
		Counts map[string]int `json:"counts"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	type entry struct {
		screen string
		views  int
	}
	batch := make([]entry, 0, len(body.Counts))
	for name, n := range body.Counts {
		if len(batch) >= usageMaxScreens {
			break
		}
		screen := strings.TrimSpace(strings.TrimPrefix(name, "/"))
		if !usageScreens[screen] {
			continue // unknown or not worth counting — dropped, never stored
		}
		if n <= 0 {
			continue
		}
		if n > usageMaxPerScreen {
			n = usageMaxPerScreen
		}
		batch = append(batch, entry{screen, n})
	}

	for _, e := range batch {
		// SysPool: this belongs to no user by construction, which is the whole
		// design. CURRENT_DATE, not the client's clock — a device with a wrong
		// date must not be able to write counts into next year.
		if _, err := db.SysPool.Exec(ctx,
			`INSERT INTO screen_usage (screen, day, views) VALUES ($1, CURRENT_DATE, $2)
			 ON CONFLICT (screen, day) DO UPDATE SET views = screen_usage.views + EXCLUDED.views`,
			e.screen, e.views); err != nil {
			// One failed counter is not worth failing the request, and there is
			// nothing the client could usefully do about it.
			break
		}
	}

	w.WriteHeader(http.StatusNoContent)
}
