package routes

import (
	"context"
	"log"
	"net/http"
	"strconv"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/services"
	"vaultchat/backend-go/internal/vault"
	"vaultchat/backend-go/internal/workx"
)

// Core's endpoints for feature services (openspec: microservices-prepare,
// "Core offers notifications and user names to services"). Only core holds
// the push credentials and VAULTCHAT_MASTER_KEY, so a feature service that
// needs to wake a phone or show a name asks core rather than holding either.
//
// Both sit under /internal/, which Caddy refuses from the internet, and both
// require an internal key on top (services.InternalCaller).

const (
	internalNotifyMaxUsers = 1000
	internalCardsMaxUsers  = 500
	internalPushTimeout    = 30 * time.Second
)

// RegisterCoreInternal mounts the endpoints. emitToUids delivers an event to
// every connected device of each user; main passes the realtime hub's.
func RegisterCoreInternal(mux *http.ServeMux, emitToUids func(uids []string, event string, payload any)) {
	mux.HandleFunc("POST /internal/notify", func(w http.ResponseWriter, r *http.Request) {
		internalNotify(w, r, emitToUids)
	})
	mux.HandleFunc("POST /internal/users/cards", internalUserCards)
}

// POST /internal/notify — the body emitx.NotifyUsers already sends:
// {userIds, event, payload, socket, push?: {title, body, data}}.
// socket=true means the caller had no socket hub, so core emits the event; the
// push goes to every registered device of each user, as sbNotify's does.
func internalNotify(w http.ResponseWriter, r *http.Request, emitToUids func([]string, string, any)) {
	caller, ok := services.InternalCaller(r)
	if !ok {
		httpx.Err(w, http.StatusForbidden, "forbidden")
		return
	}
	var b struct {
		UserIds []string `json:"userIds"`
		Event   string   `json:"event"`
		Payload any      `json:"payload"`
		Socket  bool     `json:"socket"`
		Push    *struct {
			Title string         `json:"title"`
			Body  string         `json:"body"`
			Data  map[string]any `json:"data"`
		} `json:"push"`
	}
	if err := httpx.Body(r, &b); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !internalValidUserIDs(w, b.UserIds, internalNotifyMaxUsers) {
		return
	}
	if b.Event == "" {
		httpx.Err(w, http.StatusBadRequest, "event required")
		return
	}
	if b.Socket && emitToUids != nil {
		emitToUids(b.UserIds, b.Event, b.Payload)
	}
	if b.Push != nil && (b.Push.Title != "" || b.Push.Body != "") {
		uids, title, body, data := b.UserIds, b.Push.Title, b.Push.Body, b.Push.Data
		// Expo is a network round trip with retries; the caller's bridge
		// client gives up after 3 s, so the push runs on the shared bounded
		// pool rather than on the request.
		workx.Submit(func() {
			ctx, cancel := context.WithTimeout(context.Background(), internalPushTimeout)
			defer cancel()
			tokens, err := internalPushTokens(ctx, uids)
			if err != nil {
				log.Printf("[internal/notify] %s: push tokens: %v", caller, err)
				return
			}
			chatsSendExpoPush(ctx, tokens, title, body, data, "default")
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func internalPushTokens(ctx context.Context, uids []string) ([]string, error) {
	rows, err := db.SysPool.Query(ctx,
		`SELECT push_token FROM devices
		  WHERE user_id = ANY($1::uuid[]) AND push_token IS NOT NULL`, uids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tokens := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		tokens = append(tokens, t)
	}
	return tokens, rows.Err()
}

// POST /internal/users/cards {userIds} → {cards: [{id, vaultId, name}]}.
// Names are stored encrypted, so this is the one place a service gets a
// display name. Deleted and unknown users are simply absent.
func internalUserCards(w http.ResponseWriter, r *http.Request) {
	if _, ok := services.InternalCaller(r); !ok {
		httpx.Err(w, http.StatusForbidden, "forbidden")
		return
	}
	var b struct {
		UserIds []string `json:"userIds"`
	}
	if err := httpx.Body(r, &b); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	if !internalValidUserIDs(w, b.UserIds, internalCardsMaxUsers) {
		return
	}
	type card struct {
		ID      string  `json:"id"`
		VaultID *string `json:"vaultId"`
		Name    string  `json:"name"`
	}
	ctx := r.Context()
	rows, err := db.SysPool.Query(ctx,
		`SELECT id::text, vault_id, first_name_cipher, last_name_cipher, name
		   FROM users WHERE id = ANY($1::uuid[]) AND is_deleted = FALSE`, b.UserIds)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	defer rows.Close()
	cards := []card{}
	for rows.Next() {
		var c card
		var fnc, lnc, legacy *string
		if err := rows.Scan(&c.ID, &c.VaultID, &fnc, &lnc, &legacy); err != nil {
			httpx.Err(w, http.StatusInternalServerError, "lookup failed")
			return
		}
		if nm := vault.IdentityFromRow(fnc, lnc, nil, nil, nil, nil, legacy, nil, nil, nil, nil).Name; nm != nil {
			c.Name = *nm
		}
		cards = append(cards, c)
	}
	if rows.Err() != nil {
		httpx.Err(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"cards": cards})
}

// internalValidUserIDs answers 400 unless ids is 1..max well-formed UUIDs, so
// a bad id is the caller's error rather than a cast failure in the query.
func internalValidUserIDs(w http.ResponseWriter, ids []string, max int) bool {
	if len(ids) == 0 || len(ids) > max {
		httpx.Err(w, http.StatusBadRequest, "userIds must hold 1 to "+strconv.Itoa(max)+" ids")
		return false
	}
	for _, id := range ids {
		if !isUUID(id) {
			httpx.Err(w, http.StatusBadRequest, "userIds must be UUIDs")
			return false
		}
	}
	return true
}
