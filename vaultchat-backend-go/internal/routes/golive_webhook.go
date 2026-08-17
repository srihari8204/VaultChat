// golive_webhook.go — the Go Live LiveKit's own event receiver.
//
// WHY THIS IS NOT /internal/livekit/webhook
// -----------------------------------------
// That endpoint verifies deliveries against the CALLING project's secret
// (livekit.ConfigFromEnv). Go Live runs a SEPARATE LiveKit deployment with
// separate credentials, so its events are signed with a different key and would
// be rejected there — correctly. Two isolated media servers need two receivers;
// sharing one would mean sharing a secret, which is the coupling the split
// exists to remove.
//
// The existing receiver is left exactly as it is. Nothing about calling changes.
//
// WHAT THIS DOES THAT THE OTHER ONE DOES NOT
// ------------------------------------------
// Host presence. A broadcast whose host walked out of the room is over, but
// egress keeps running and reports nothing — so without participant tracking the
// only thing that ever closed such a session was the 12-hour backstop, and every
// viewer sat on a frozen playlist under a LIVE banner until then.
//
// participant_left on the HOST starts a grace clock (host_left_at); a rejoin
// clears it. The clock is a COLUMN, not a timer: the case this exists for is a
// host whose app was killed, which is also the case that coincides with backend
// restarts. A timestamp survives a restart; a goroutine does not. The sweep that
// acts on it is golive_reaper.go.
package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/golive"
	"vaultchat/backend-go/internal/httpx"
)

func RegisterGoLiveWebhook(mux *http.ServeMux) {
	// Under /internal/, which Caddy answers 404 for from outside, so this is
	// in-network only even before the signature check runs — same placement as
	// the calling receiver.
	mux.HandleFunc("POST /internal/golive/webhook", goliveWebhook)
}

// goliveEgressInfo is the egress payload, whichever spelling it arrived under.
type goliveEgressInfo struct {
	EgressID string `json:"egressId"`
	RoomName string `json:"roomName"`
	Status   string `json:"status"`
}

// goliveEgressInfoProto is the same thing under proto names.
type goliveEgressInfoProto struct {
	EgressID string `json:"egress_id"`
	RoomName string `json:"room_name"`
	Status   string `json:"status"`
}

// goliveEvent is the subset of LiveKit's WebhookEvent Go Live acts on.
//
// WHY THE EGRESS PAYLOAD IS DECLARED TWICE
// ----------------------------------------
// LiveKit marshals webhook bodies with protojson, which emits lowerCamelCase —
// "egressInfo" / "egressId" / "roomName". This receiver originally declared only
// the proto-name spelling ("egress_info" / "egress_id"), so on v1.13.5 the
// egress payload never bound: EgressInfo stayed nil, the handler broke out of
// its case and still answered 200, and 'starting' was never moved to 'live'.
// Every delivery looked healthy from the SFU side (200 OK) while doing nothing.
//
// encoding/json matches field names case-INSENSITIVELY but does not bridge an
// underscore, so "egressId" and "egress_id" cannot be served by one tag. Both
// spellings are therefore declared and egress() prefers whichever arrived —
// which also means a future LiveKit that switches to proto names (or a rollback
// to an older build) keeps working instead of silently breaking the same way.
type goliveEvent struct {
	Event           string                 `json:"event"`
	EgressInfo      *goliveEgressInfo      `json:"egressInfo,omitempty"`
	EgressInfoProto *goliveEgressInfoProto `json:"egress_info,omitempty"`
	Room *struct {
		Name string `json:"name"`
	} `json:"room,omitempty"`
	Participant *struct {
		// The user id — MintArgs.Identity is set to it, so LiveKit reports it
		// back here unchanged.
		Identity string `json:"identity"`
	} `json:"participant,omitempty"`
}

// egress returns the egress payload under whichever spelling LiveKit used, or
// nil when the event carries none.
func (e goliveEvent) egress() *goliveEgressInfo {
	if e.EgressInfo != nil && e.EgressInfo.EgressID != "" {
		return e.EgressInfo
	}
	if e.EgressInfoProto != nil && e.EgressInfoProto.EgressID != "" {
		return &goliveEgressInfo{
			EgressID: e.EgressInfoProto.EgressID,
			RoomName: e.EgressInfoProto.RoomName,
			Status:   e.EgressInfoProto.Status,
		}
	}
	return nil
}

func goliveWebhook(w http.ResponseWriter, r *http.Request) {
	cfg := golive.ConfigFromEnv()
	if !cfg.Usable() {
		// Nothing to verify a signature against — or a config that has been
		// pointed at the calling project, in which case accepting deliveries here
		// would let calling's media server drive broadcast state. 503: a server
		// that cannot check, not a caller that failed a check.
		httpx.Err(w, http.StatusServiceUnavailable, "Go Live is not configured")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, webhookMaxBody))
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, "unreadable body")
		return
	}
	// Reused verbatim from the calling receiver — it already takes the config as
	// a parameter, so verifying against a different project needed no change to
	// it. Signature AND body hash, both required.
	if !verifyLivekitSignature(cfg.Config, r.Header.Get("Authorization"), body) {
		goliveMetric("webhook_rejected")
		httpx.Err(w, http.StatusUnauthorized, "bad signature")
		return
	}

	var ev goliveEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		httpx.Err(w, http.StatusBadRequest, "bad payload")
		return
	}

	switch ev.Event {
	case "egress_started", "egress_updated":
		eg := ev.egress()
		if eg == nil {
			break
		}
		// EGRESS_ACTIVE is the state that means segments are being produced.
		// Anything earlier is still "not yet watchable".
		if eg.Status != "EGRESS_ACTIVE" {
			httpx.JSON(w, 200, map[string]any{"ok": true, "waiting": eg.Status})
			return
		}
		markBroadcastLive(r, eg.EgressID)
		goliveLog("EGRESS_ACTIVE", "", eg.RoomName, "", "egress_id="+eg.EgressID)

	case "egress_ended", "egress_failed":
		eg := ev.egress()
		if eg == nil {
			break
		}
		markBroadcastEgressGone(r, eg.EgressID, eg.Status)
		goliveLog("EGRESS_GONE", "", eg.RoomName, "", "status="+eg.Status)

	case "participant_joined":
		goliveHostPresence(r, roomOf(ev), identityOf(ev), true)

	case "participant_left":
		goliveHostPresence(r, roomOf(ev), identityOf(ev), false)
	}

	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func roomOf(ev goliveEvent) string {
	if ev.Room != nil {
		return strings.TrimSpace(ev.Room.Name)
	}
	return ""
}

func identityOf(ev goliveEvent) string {
	if ev.Participant != nil {
		return strings.TrimSpace(ev.Participant.Identity)
	}
	return ""
}

// goliveHostPresence starts or clears the host's grace clock.
//
// The WHERE clause is the authorization, exactly as in markBroadcastLive: the
// row is matched by ROOM NAME and its own host_id, so an event naming a room
// this server did not create finds nothing, and a participant who is not the
// host can never move the clock. Audience members join and leave constantly;
// only the host's presence decides whether a broadcast is still happening.
//
// SysPool because a webhook has no acting user for an RLS policy to read.
//
// Idempotent in both directions: LiveKit retries deliveries, and setting
// host_left_at to now() twice, or clearing an already-NULL column, is a no-op
// that changes nothing about when the sweep fires. The `IS NULL` / `IS NOT NULL`
// guards keep RowsAffected honest so the log only fires on a real transition —
// a retry storm must not read as the host flapping.
func goliveHostPresence(r *http.Request, room, identity string, joined bool) {
	if room == "" || identity == "" {
		return
	}
	// Only Go Live rooms. A room name from any other namespace is not ours and
	// must never reach this UPDATE — belt and braces behind the separate server.
	if !strings.HasPrefix(room, golive.ConfigFromEnv().RoomPrefix) {
		return
	}

	// NOT EVERY PARTICIPANT IS A USER.
	//
	// The egress worker joins the room it is recording, with its own egress id as
	// the identity ("EG_MSQLSeWoothd"). host_id is a uuid column, so that reached
	// the UPDATE as `$2::uuid` and Postgres rejected the whole statement:
	//
	//	[GOLIVE] event=HOST_PRESENCE_FAILED user_id=EG_MSQLSeWoothd
	//	  error=ERROR: invalid input syntax for type uuid (SQLSTATE 22P02)
	//
	// Harmless in effect — it is caught below — but it fired on EVERY egress join
	// and leave, so the log filled with failures that were not failures, which is
	// how a real one gets missed. The cast was also the only thing rejecting it,
	// and relying on a type error for filtering is not filtering.
	//
	// A future SIP or agent participant would be the same shape. Anything that is
	// not a user id simply is not the host.
	if !isUUID(identity) {
		return
	}

	sql := `UPDATE broadcast_sessions
	           SET host_left_at = now()
	         WHERE room = $1 AND host_id = $2::uuid
	           AND status IN ('starting', 'live') AND host_left_at IS NULL`
	event := "HOST_DISCONNECTED"
	if joined {
		sql = `UPDATE broadcast_sessions
		          SET host_left_at = NULL
		        WHERE room = $1 AND host_id = $2::uuid
		          AND status IN ('starting', 'live') AND host_left_at IS NOT NULL`
		event = "HOST_RECONNECTED"
	}

	ct, err := db.SysPool.Exec(r.Context(), sql, room, identity)
	if err != nil {
		// A non-host identity is not a uuid mismatch — identities here are user
		// ids — but a malformed one would fail the cast. Logged, never fatal: a
		// presence update is a safety net, not the broadcast itself.
		goliveLog("HOST_PRESENCE_FAILED", "", room, identity, "error="+err.Error())
		return
	}
	if ct.RowsAffected() > 0 {
		if joined {
			goliveMetric("host_reconnected")
		} else {
			goliveMetric("host_disconnected")
		}
		goliveLog(event, "", room, identity)
	}
}

// isUUID reports whether s is shaped like a canonical UUID.
//
// Shape only — this is a filter for "could this be a user id", not validation.
// The database is still the authority on whether the id exists and whether it
// is the host; this just keeps non-user participants (egress, and any future
// SIP or agent joiner) from reaching a uuid-typed column at all.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}
