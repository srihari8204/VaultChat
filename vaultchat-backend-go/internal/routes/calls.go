// calls.go ← routes/calls.js — call wake-up (FCM) + signaling bootstrap.
// The socket layer still carries live WebRTC signaling; this is only the push
// that rings a killed/dozing device.
package routes

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/devices"
	"vaultchat/backend-go/internal/fcm"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/vault"
)

func RegisterCalls(mux *http.ServeMux) {
	mux.HandleFunc("POST /call/token", httpx.RequireAuth(callToken))
	mux.HandleFunc("POST /call/initiate", httpx.RequireAuth(callInitiate))
	mux.HandleFunc("POST /call/cancel", httpx.RequireAuth(callCancel))
}

func callerIdentity(ctx context.Context, uid string) (string, string) {
	// users.photo_url holds the profile-photo ATTACHMENT id (see uploads.go's
	// as-photo permission check) — "profile_photo_id" never existed; the old
	// Node code had the same bug, silently swallowed by this fallback.
	// THE NAME LIVES IN THE CIPHERS, NOT IN users.name.
	//
	// users.name is the legacy plaintext column and it is NULL for every
	// account created through the vault onboarding flow (/auth/profile/init
	// writes first_name_cipher/last_name_cipher and nothing else). Selecting it
	// alone compiles, runs, and returns nobody — so this function returned the
	// literal string "VaultChat user" for every caller on this deployment, and
	// that is what the callee's ring showed. Three rounds of display fixes on
	// the client could not have helped: the placeholder was arriving as data.
	//
	// Same resolution the chat member list and the ops screens use
	// (vault.IdentityFromRow), with users.name kept as the fallback for any
	// legacy Google/phone account that does have it.
	var fnc, lnc, ec, legacyName, photoID *string
	if err := db.Pool.QueryRow(ctx,
		`SELECT first_name_cipher, last_name_cipher, email_cipher, name, photo_url
		   FROM users WHERE id = $1`, uid).Scan(&fnc, &lnc, &ec, &legacyName, &photoID); err != nil {
		return "VaultChat user", ""
	}
	n := "VaultChat user"
	if nm := vault.IdentityFromRow(fnc, lnc, ec, nil, nil, nil, legacyName, nil, nil, nil, nil).Name; nm != nil && *nm != "" {
		n = *nm
	}
	dp := ""
	if photoID != nil && *photoID != "" {
		dp = "/uploads/" + *photoID
	}
	return n, dp
}

func callToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		FcmToken any `json:"fcmToken"`
		Platform any `json:"platform"`
	}
	_ = httpx.Body(r, &b)
	fcmToken := strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b.FcmToken)))
	platform := strings.ToLower(fmt.Sprintf("%v", orEmpty(b.Platform)))
	if platform == "" {
		platform = "android"
	}
	if fcmToken == "" {
		httpx.Err(w, 400, "fcmToken required")
		return
	}
	if err := devices.Register(ctx, user.ID, fcmToken, platform); err != nil {
		httpx.Err(w, 500, "Failed to register token")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func callInitiate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		CalleeID any `json:"calleeId"`
		CallID   any `json:"callId"`
		IsVideo  any `json:"isVideo"`
	}
	_ = httpx.Body(r, &b)
	calleeID := fmt.Sprintf("%v", orEmpty(b.CalleeID))
	callID := fmt.Sprintf("%v", orEmpty(b.CallID))
	isVideo := b.IsVideo == true || b.IsVideo == "true"
	if calleeID == "" || callID == "" {
		httpx.Err(w, 400, "calleeId and callId required")
		return
	}

	tokens := devices.FCMTokens(ctx, calleeID)
	if len(tokens) == 0 {
		httpx.JSON(w, 200, map[string]any{"ok": true, "delivered": false, "reason": "no_device_token"})
		return
	}

	name, dp := callerIdentity(ctx, user.ID)
	// Anonymous code chat, not yet mutually saved (migration 119). The ring is
	// the loudest place an identity can escape — it lights up a locked screen
	// with a name and a photo, outside the app entirely, where none of the
	// chat-payload masking reaches. Mask here or the whole feature is decorative.
	if chatsAnonMaskedPair(ctx, user.ID, calleeID) {
		name, dp = chatsAnonName, ""
	}
	video := "false"
	if isVideo {
		video = "true"
	}
	// The SDP offer is deliberately NOT included (F6) — same as Node.
	res := fcm.SendCallMessage(tokens, map[string]string{
		"type":        "incoming_call",
		"callId":      callID,
		"callerId":    user.ID,
		"callerName":  name,
		"callerDpUrl": dp,
		"isVideo":     video,
		"ts":          fmt.Sprintf("%d", time.Now().UnixMilli()),
	}, 30000)

	if len(res.Dead) > 0 {
		_, _ = db.Pool.Exec(ctx,
			`UPDATE devices SET fcm_token = NULL WHERE fcm_token = ANY($1::text[])`, res.Dead)
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "delivered": res.OK})
}

func callCancel(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		CalleeID any `json:"calleeId"`
		CallID   any `json:"callId"`
	}
	_ = httpx.Body(r, &b)
	calleeID := fmt.Sprintf("%v", orEmpty(b.CalleeID))
	callID := fmt.Sprintf("%v", orEmpty(b.CallID))
	if calleeID == "" || callID == "" {
		httpx.Err(w, 400, "calleeId and callId required")
		return
	}
	if tokens := devices.FCMTokens(ctx, calleeID); len(tokens) > 0 {
		fcm.SendCallMessage(tokens, map[string]string{
			"type":   "call_cancelled",
			"callId": callID,
			"ts":     fmt.Sprintf("%d", time.Now().UnixMilli()),
		}, 30000)
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
