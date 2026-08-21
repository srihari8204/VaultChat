// broadcast_webhook.go — LiveKit egress lifecycle → broadcast status.
//
// THE DEFECT THIS CLOSES
// ----------------------
// A broadcast was created as 'starting' and nothing ever moved it to 'live'.
// broadcastStart stored a deterministic hls_url the moment egress was
// requested, but the status transition lived only in POST /broadcasts/{id}/hls
// — and nothing called it. There was no webhook receiver anywhere in the repo
// and nothing polled egress. So waitForPlaylist (which requires status=='live'
// AND hlsUrl) always ran its 60s timeout and every broadcast failed, even on a
// perfectly healthy LiveKit + egress deployment. This was the fatal link.
//
// WHY A WEBHOOK AND NOT A TIMER
// -----------------------------
// "Egress was requested" is not "the stream is watchable". Flipping to 'live'
// on request would send viewers to a playlist that does not exist yet — the
// first segment is written seconds later, and a failed egress would never
// correct it. LiveKit already emits the fact we need; the only honest source of
// "there is something to play" is the egress service saying so.
//
// AUTHENTICATION IS THE WHOLE POINT
// ---------------------------------
// This endpoint changes what every viewer of a stream plays, so an unverified
// caller here is worse than the bug it fixes. LiveKit signs each delivery with
// the project's API secret:
//
//	Authorization: <JWT>, signed HS256 with the API secret,
//	  iss    = API key
//	  sha256 = base64(SHA-256(raw body))
//
// Both halves are checked: the signature proves it came from something holding
// the secret, and the body hash proves the payload was not swapped after
// signing. A request failing either is dropped without touching the database.
//
// Mounted under /internal/, which Caddy answers 404 for from outside, so this
// is reachable only in-network even before the signature check runs.
package routes

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/livekit"
	"vaultchat/backend-go/internal/metrics"
)

func RegisterBroadcastWebhook(mux *http.ServeMux) {
	mux.HandleFunc("POST /internal/livekit/webhook", livekitWebhook)
}

// Bodies are small JSON; the cap stops a bad actor who is already in-network
// from streaming an unbounded body into memory.
const webhookMaxBody = 1 << 20

// livekitEvent is the subset of LiveKit's WebhookEvent this cares about.
// Field names are LiveKit's wire contract.
type livekitEvent struct {
	Event      string `json:"event"`
	EgressInfo *struct {
		EgressID  string `json:"egress_id"`
		RoomName  string `json:"room_name"`
		Status    string `json:"status"`
		StartedAt int64  `json:"started_at,string"`
	} `json:"egress_info,omitempty"`
}

func livekitWebhook(w http.ResponseWriter, r *http.Request) {
	cfg := livekit.ConfigFromEnv()
	if !cfg.Configured() {
		// No keys means no way to verify a signature, and an unverifiable
		// caller must never be trusted. 503 rather than 401: this is a server
		// that cannot check, not a caller that failed a check.
		httpx.Err(w, http.StatusServiceUnavailable, "livekit is not configured")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, webhookMaxBody))
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, "unreadable body")
		return
	}
	if !verifyLivekitSignature(cfg, r.Header.Get("Authorization"), body) {
		metrics.Inc("broadcast_webhook_rejected")
		httpx.Err(w, http.StatusUnauthorized, "bad signature")
		return
	}

	var ev livekitEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		httpx.Err(w, http.StatusBadRequest, "bad payload")
		return
	}
	if ev.EgressInfo == nil || strings.TrimSpace(ev.EgressInfo.EgressID) == "" {
		// Room and participant events also arrive here; they are not errors,
		// they are simply not ours. 200 so LiveKit does not retry them.
		httpx.JSON(w, 200, map[string]any{"ok": true, "ignored": ev.Event})
		return
	}

	// The egress id is the join key, NOT anything in the URL or the body's own
	// idea of which broadcast this is. broadcastStart wrote egress_id when it
	// started the job, so only a session this server actually started can be
	// matched — an event naming an unknown egress simply finds no row.
	switch ev.Event {
	case "egress_started", "egress_updated":
		// EGRESS_ACTIVE is the state that means segments are being produced.
		// Anything earlier ('starting') is still the same "not yet watchable"
		// condition the bug was about, so it is deliberately not enough.
		if ev.EgressInfo.Status != "EGRESS_ACTIVE" {
			httpx.JSON(w, 200, map[string]any{"ok": true, "waiting": ev.EgressInfo.Status})
			return
		}
		markBroadcastLive(r, ev.EgressInfo.EgressID)
	case "egress_ended", "egress_failed":
		markBroadcastEgressGone(r, ev.EgressInfo.EgressID, ev.EgressInfo.Status)
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// markBroadcastLive flips 'starting' → 'live' for the session owning this
// egress job. Uses SysPool: a webhook has no acting user, so there is no
// app.current_user_id for an RLS policy to read — binding one would make the
// update match nothing. The WHERE clause is the authorization: it can only
// touch a row this server created and only while it is still starting.
func markBroadcastLive(r *http.Request, egressID string) {
	ct, err := db.SysPool.Exec(r.Context(),
		`UPDATE broadcast_sessions
		    SET status = 'live'
		  WHERE egress_id = $1 AND status = 'starting'`, egressID)
	if err != nil {
		log.Printf("[broadcast] webhook could not mark live for egress %s: %v", egressID, err)
		return
	}
	// Zero rows is the NORMAL case for a repeat: LiveKit retries deliveries,
	// and egress_updated fires more than once. The status guard makes the
	// second one a no-op rather than an error, which is what idempotent means
	// here.
	if ct.RowsAffected() > 0 {
		metrics.Inc("broadcast_live")
		log.Printf("[broadcast] live via egress %s", egressID)
	}
}

// markBroadcastEgressGone records that the transcoder stopped.
//
// A stream whose egress died is NOT watchable, and leaving it 'live' sends
// every viewer to a playlist that has stopped advancing. 'failed' is only used
// when the host has not already ended it — a normal host-ended broadcast also
// produces egress_ended, and that one must stay 'ended'.
func markBroadcastEgressGone(r *http.Request, egressID, status string) {
	// THE HOST MAY SIMPLY BE RECONNECTING.
	//
	// When a host's network drops, the egress loses its publisher and reports a
	// fault within seconds. Terminating here made that the end of the broadcast
	// — measured on device: a 20s outage killed the stream permanently even
	// though the client's transport recovered moments later.
	//
	// The system already knows how to wait. golive_webhook.go stamps
	// host_left_at when the host leaves and clears it when they return, and
	// golive_reaper.go ends the session only if they stay gone past hostGrace().
	// That verdict never got a chance: this UPDATE moved the row out of
	// ('starting','live') first, so the rejoin path could no longer match it and
	// the grace window was dead code for exactly the case it was written for.
	//
	// So: if the host is inside their grace window, do NOT end the broadcast.
	// Clear egress_id instead — the transcoder really is gone, and a NULL is
	// what tells the rejoin path to start a fresh one. The reaper still ends
	// this row if the host never comes back, so nothing leaks.
	//
	// Scoped by DATA, not by caller: host_left_at is only ever set for Go Live
	// rooms, so an ordinary broadcast (NULL) still terminates immediately,
	// exactly as before.
	ct, err := db.SysPool.Exec(r.Context(),
		`UPDATE broadcast_sessions
		    SET egress_id = NULL
		  WHERE egress_id = $1 AND status IN ('starting', 'live')
		    AND host_left_at IS NOT NULL
		    AND host_left_at > now() - $2::interval`,
		egressID, hostGrace().String())
	if err == nil && ct.RowsAffected() > 0 {
		metrics.Inc("broadcast_egress_grace")
		log.Printf("[broadcast] egress %s gone while host is within grace — holding session open", egressID)
		return
	}

	if _, err := db.SysPool.Exec(r.Context(),
		`UPDATE broadcast_sessions
		    SET status = 'failed', ended_at = now()
		  WHERE egress_id = $1 AND status IN ('starting', 'live')`, egressID); err != nil {
		log.Printf("[broadcast] webhook could not close egress %s: %v", egressID, err)
		return
	}
	metrics.Inc("broadcast_egress_" + strings.ToLower(status))
}

// verifyLivekitSignature checks LiveKit's Authorization JWT and that the body
// matches the sha256 claim it carries.
//
// Both are required. The signature alone proves only that SOMETHING holding the
// secret signed SOMETHING; without binding the body, a captured header could be
// replayed over a different payload.
func verifyLivekitSignature(cfg livekit.Config, authz string, body []byte) bool {
	tok := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(authz), "Bearer "))
	if tok == "" {
		return false
	}
	parsed, err := jwt.Parse(tok, func(t *jwt.Token) (any, error) {
		return []byte(cfg.APISecret), nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || !parsed.Valid {
		return false
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return false
	}
	if iss, _ := claims["iss"].(string); iss != cfg.APIKey {
		return false
	}
	want, _ := claims["sha256"].(string)
	if want == "" {
		return false
	}
	sum := sha256.Sum256(body)
	// LiveKit emits standard base64. Accept the raw-URL form too rather than
	// rejecting a valid delivery over an encoding detail.
	return want == base64.StdEncoding.EncodeToString(sum[:]) ||
		want == base64.RawStdEncoding.EncodeToString(sum[:])
}
