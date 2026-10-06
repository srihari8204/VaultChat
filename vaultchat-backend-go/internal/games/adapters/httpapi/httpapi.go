// Package httpapi is Games' inbound adapter (openspec: hexagonal-architecture):
// the /games/* endpoints. It decodes requests, calls the application service
// and maps its errors onto the existing status codes and messages.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"vaultchat/backend-go/internal/games/app"
	"vaultchat/backend-go/internal/games/domain"
	"vaultchat/backend-go/internal/httpx"
)

type handlers struct{ svc *app.Service }

func Register(mux *http.ServeMux, svc *app.Service) {
	h := handlers{svc}
	mux.HandleFunc("POST /games/launch-token", httpx.RequireAuth(h.launchToken))
	// Signed by the games server, not a user session: see app.Service.Notify.
	mux.HandleFunc("POST /games/notify", h.notify)
	mux.HandleFunc("POST /games/device-token", httpx.RequireAuth(h.deviceToken))
	mux.HandleFunc("GET /games/tables", httpx.RequireAuth(h.liveTables))
	mux.HandleFunc("DELETE /games/tables", httpx.RequireAuth(h.forgetTable))
	mux.HandleFunc("POST /games/matches", httpx.RequireAuth(h.openMatch))
	mux.HandleFunc("GET /games/matches", httpx.RequireAuth(h.getMatch))
	mux.HandleFunc("POST /games/matches/deal", httpx.RequireAuth(h.advanceMatch))
	mux.HandleFunc("POST /games/voice-token", httpx.RequireAuth(h.voiceToken))
}

// fail writes err as the endpoint's answer. storeMsg is the endpoint's own 500
// message, since each one has always named what failed.
func fail(w http.ResponseWriter, err error, storeMsg string) {
	switch {
	case errors.Is(err, app.ErrUserNotFound):
		httpx.Err(w, http.StatusNotFound, "User not found")
	case errors.Is(err, app.ErrNoVaultID):
		httpx.Err(w, http.StatusConflict, "User has no VaultID")
	case errors.Is(err, app.ErrGameAndRoom):
		httpx.Err(w, http.StatusBadRequest, "game and room required")
	default:
		httpx.Err(w, http.StatusInternalServerError, storeMsg)
	}
}

func (h handlers) launchToken(w http.ResponseWriter, r *http.Request) {
	lt, err := h.svc.LaunchToken(r.Context(), httpx.UserFrom(r).ID)
	if errors.Is(err, app.ErrLaunchNotConfigured) {
		httpx.Err(w, http.StatusServiceUnavailable, "Games launch is not configured")
		return
	}
	if err != nil {
		fail(w, err, "Failed to mint launch token")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"token":     lt.Token,
		"nonce":     lt.Nonce,
		"exp":       lt.Exp,
		"expiresIn": int(domain.LaunchTTL.Seconds()),
	})
}

func (h handlers) voiceToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Game string `json:"game"`
		Room string `json:"room"`
		// Not a security boundary — a client could always claim to be a player —
		// it is how a spectator opts into listen-only, enforced by the media
		// server for the honest case.
		Spectator bool `json:"spectator"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	vt, err := h.svc.VoiceToken(r.Context(), httpx.UserFrom(r).ID, body.Game, body.Room, body.Spectator)
	switch {
	case errors.Is(err, app.ErrUnknownGame):
		httpx.Err(w, http.StatusBadRequest, "Unknown game")
	case errors.Is(err, app.ErrVoiceNotConfigured):
		// Distinguishable from a failure on purpose: "voice is unavailable
		// here" rather than "voice failed", so the player does not retry forever.
		httpx.Err(w, http.StatusServiceUnavailable, "Table voice is not configured")
	case errors.Is(err, app.ErrSign):
		httpx.Err(w, http.StatusServiceUnavailable, "Could not mint a voice token")
	case err != nil:
		fail(w, err, "Could not mint a voice token")
	default:
		httpx.JSON(w, 200, map[string]any{
			"ok":       true,
			"token":    vt.Token,
			"url":      vt.URL,
			"room":     vt.Room,
			"identity": vt.Identity,
			"role":     vt.Role,
		})
	}
}

// notify answers the games server. STATUS CODES ARE THE RETRY CONTRACT:
//
//	400/401 — this delivery is broken; retrying it changes nothing.
//	503     — we are misconfigured; retrying later is correct.
//	502     — we tried to push and the transport failed; retry.
//	200     — accepted, INCLUDING "recipient has no device registered", which is
//	          a fact about the recipient that no retry can change.
func (h handlers) notify(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Event string `json:"event"`
	}
	_ = httpx.Body(r, &b) // an unreadable body is an empty event: 400 below
	res, err := h.svc.Notify(r.Context(), b.Event)
	switch {
	case errors.Is(err, app.ErrNotifyNotConfigured):
		httpx.Err(w, http.StatusServiceUnavailable, "Games notify is not configured")
	case errors.Is(err, app.ErrNoEvent):
		httpx.Err(w, http.StatusBadRequest, "event required")
	case errors.Is(err, app.ErrBadSignature):
		httpx.Err(w, http.StatusUnauthorized, "bad event signature")
	case errors.Is(err, app.ErrSubAndJTI):
		httpx.Err(w, http.StatusBadRequest, "sub and jti required")
	case errors.Is(err, app.ErrDedupe):
		httpx.Err(w, http.StatusInternalServerError, "dedupe failed")
	case errors.Is(err, app.ErrPushFailed):
		httpx.Err(w, http.StatusBadGateway, "push delivery failed")
	case err != nil:
		httpx.Err(w, http.StatusInternalServerError, "notify failed")
	case res.Deduped:
		httpx.JSON(w, 200, map[string]any{"ok": true, "deduped": true})
	case !res.Delivered:
		httpx.JSON(w, 200, map[string]any{"ok": true, "delivered": false, "reason": res.Reason})
	default:
		httpx.JSON(w, 200, map[string]any{"ok": true, "delivered": true, "sent": res.Sent})
	}
}

func (h handlers) liveTables(w http.ResponseWriter, r *http.Request) {
	tables, err := h.svc.LiveTables(r.Context(), httpx.UserFrom(r).ID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "Failed to load tables")
		return
	}
	out := make([]map[string]any, 0, len(tables))
	for _, t := range tables {
		out = append(out, map[string]any{
			"game": t.Game, "room": t.Room, "yourTurn": t.YourTurn,
			"title": t.Title, "body": t.Body, "updatedAt": t.UpdatedAt.UTC().Format(time.RFC3339),
		})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "tables": out})
}

func (h handlers) forgetTable(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if err := h.svc.ForgetTable(r.Context(), httpx.UserFrom(r).ID, q.Get("game"), q.Get("room")); err != nil {
		fail(w, err, "Failed to remove the table")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (h handlers) deviceToken(w http.ResponseWriter, r *http.Request) {
	var b struct {
		FcmToken   string `json:"fcmToken"`
		Platform   string `json:"platform"`
		Unregister bool   `json:"unregister"`
	}
	_ = httpx.Body(r, &b)
	err := h.svc.DeviceToken(r.Context(), httpx.UserFrom(r).ID, b.FcmToken, b.Platform, b.Unregister)
	switch {
	case errors.Is(err, app.ErrTokenRequired):
		httpx.Err(w, http.StatusBadRequest, "fcmToken required")
	case err != nil && b.Unregister:
		httpx.Err(w, http.StatusInternalServerError, "Failed to unregister token")
	case err != nil:
		httpx.Err(w, http.StatusInternalServerError, "Failed to register token")
	default:
		httpx.JSON(w, 200, map[string]any{"ok": true, "registered": !b.Unregister})
	}
}

// matchJSON is the one shape every match response uses. Both limits are
// published so the app renders "83 / 101" and "deal 2 of 6" without knowing
// the rules — the thin-client rule.
func matchJSON(m domain.Match) map[string]any {
	scores := m.Scores
	if scores == nil {
		scores = map[string]domain.Score{}
	}
	return map[string]any{
		"ok": true,
		"match": map[string]any{
			"id":          m.ID,
			"tableId":     m.TableID,
			"variant":     string(m.Variant),
			"status":      m.Status,
			"dealsPlayed": m.DealsPlayed,
			"poolLimit":   m.Variant.PoolLimit(),
			"dealsTotal":  m.Variant.DealsTotal(),
			"scores":      scores,
		},
	}
}

func (h handlers) openMatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TableID  string `json:"tableId"`
		Variant  string `json:"variant"`
		Practice bool   `json:"practice"`
	}
	if err := httpx.Body(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "Invalid body")
		return
	}
	m, err := h.svc.OpenMatch(r.Context(), httpx.UserFrom(r).ID, body.TableID, body.Variant, body.Practice)
	switch {
	case errors.Is(err, app.ErrTableAndVariant):
		httpx.Err(w, http.StatusBadRequest, "A table and a known variant are required")
	case errors.Is(err, app.ErrPracticeOnly):
		httpx.Err(w, http.StatusBadRequest, "Pool and Deals matches run on practice tables only")
	case err != nil:
		fail(w, err, "Failed to open match")
	default:
		httpx.JSON(w, 200, matchJSON(m))
	}
}

// getMatch: "no match" is a 200 with match:null, not a 404 — the app asks on
// every board open, and an error for the ordinary case would make a normal
// state indistinguishable from a broken backend.
func (h handlers) getMatch(w http.ResponseWriter, r *http.Request) {
	m, err := h.svc.RunningMatch(r.Context(), r.URL.Query().Get("tableId"))
	switch {
	case errors.Is(err, app.ErrTableIDRequired):
		httpx.Err(w, http.StatusBadRequest, "tableId is required")
	case err != nil:
		httpx.Err(w, http.StatusInternalServerError, "Failed to read match")
	case m == nil:
		httpx.JSON(w, 200, map[string]any{"ok": true, "match": nil})
	default:
		httpx.JSON(w, 200, matchJSON(*m))
	}
}

func (h handlers) advanceMatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MatchID   string              `json:"matchId"`
		DealIndex int                 `json:"dealIndex"`
		Results   []domain.DealResult `json:"results"`
	}
	if err := httpx.Body(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "Invalid body")
		return
	}
	m, err := h.svc.AdvanceMatch(r.Context(), httpx.UserFrom(r).ID, body.MatchID, body.DealIndex, body.Results)
	switch {
	case errors.Is(err, app.ErrMatchAndResults):
		httpx.Err(w, http.StatusBadRequest, "A match and its deal results are required")
	case errors.Is(err, app.ErrMatchNotFound):
		httpx.Err(w, http.StatusNotFound, "No such match")
	case err != nil:
		fail(w, err, "Failed to advance match")
	default:
		// The id the caller sent, exactly as before.
		m.ID = body.MatchID
		httpx.JSON(w, 200, matchJSON(m))
	}
}
