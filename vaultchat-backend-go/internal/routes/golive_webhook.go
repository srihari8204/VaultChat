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
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/golive"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/livekit"
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
	Room            *struct {
		Name string `json:"name"`
	} `json:"room,omitempty"`
	Participant *struct {
		// The user id — MintArgs.Identity is set to it, so LiveKit reports it
		// back here unchanged.
		Identity string `json:"identity"`
	} `json:"participant,omitempty"`
	// The published track, on track_published / track_unpublished.
	//
	// Carries the ONE fact an HLS viewer cannot obtain for itself: the shape of
	// what is being shared. See migration 116.
	Track *goliveTrack `json:"track,omitempty"`
}

// goliveTrack is the track payload LiveKit sends with track_published and
// track_unpublished.
//
// Single-word field names throughout, so protojson's lowerCamelCase and the
// proto names coincide and the double-declaration the egress payload needs
// (see above) is not required here.
type goliveTrack struct {
	SID string `json:"sid"`
	// "SCREEN_SHARE" | "CAMERA" | "MICROPHONE" | "SCREEN_SHARE_AUDIO".
	Source string `json:"source"`
	Type   string `json:"type"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// isScreenShare reports whether this track is the VIDEO of a screen share.
//
// The audio of a screen share carries the same-ish source name and no geometry
// at all, so matching on the source alone would clear a perfectly good shape
// the moment shared audio was published or dropped.
func (t *goliveTrack) isScreenShare() bool {
	return t != nil && strings.EqualFold(t.Source, "SCREEN_SHARE") &&
		(t.Type == "" || strings.EqualFold(t.Type, "VIDEO"))
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

	// THE SHAPE OF A SCREEN SHARE, FOR THE VIEWERS WHO CANNOT SEE IT.
	//
	// Only HLS needs this — a low-latency viewer reads the same numbers off its
	// own subscription — but it is recorded for every broadcast because the
	// server cannot know which kind of viewer will arrive next, and a share that
	// started before someone joined must still be describable to them.
	case "track_published":
		if ev.Track.isScreenShare() {
			goliveShareGeometry(r, roomOf(ev), ev.Track.Width, ev.Track.Height)
		}

	case "track_unpublished":
		// The share ended. The shape goes with it, or an HLS viewer keeps their
		// phone turned for a game that stopped several minutes ago.
		if ev.Track.isScreenShare() {
			goliveShareGeometry(r, roomOf(ev), 0, 0)
		}
	}

	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// goliveShareGeometry records the shape of the screen share running in a room,
// or clears it when the share stops (w and h both 0).
//
// WHAT IT IS FOR
// --------------
// An HLS viewer receives a fixed landscape composite whatever the publisher is
// doing, so it cannot tell a shared landscape game from a shared portrait phone
// — and those want opposite treatment on a phone: one wants the panel turned,
// the other wants it left alone. A low-latency viewer reads these numbers off
// its own subscription; this is how everyone else gets them. Migration 116
// records why the alternative — making the composite match — is the dangerous
// option rather than this one.
//
// AUTHORIZATION IS THE WHERE CLAUSE, exactly as in goliveHostPresence: matched
// by ROOM NAME against a broadcast that is still running, so an event naming a
// room this server did not create updates nothing. No user is acting here, so
// there is no RLS identity to set — SysPool, like every other webhook write.
//
// Idempotent. LiveKit retries deliveries, and writing the same pair twice is a
// no-op; the status guard keeps a late delivery from reviving geometry on a
// broadcast that has already ended.
func goliveShareGeometry(r *http.Request, room string, w, h int) {
	if room == "" {
		return
	}
	// Only Go Live rooms — the same belt-and-braces as host presence, behind the
	// separate server that already cannot receive anyone else's events.
	if !strings.HasPrefix(room, golive.ConfigFromEnv().RoomPrefix) {
		return
	}
	// Nonsense geometry is treated as no geometry rather than stored: the column
	// has a CHECK that would reject it anyway, and failing a whole webhook
	// delivery over a malformed width would cost the retries that carry the
	// events that matter.
	var wp, hp any
	if w > 0 && h > 0 {
		wp, hp = w, h
	}

	ctx := r.Context()
	if err := db.SysPool.QueryRow(ctx,
		`UPDATE broadcast_sessions
		    SET share_w = $2, share_h = $3
		  WHERE room = $1 AND status IN ('starting', 'live')
		    AND (share_w IS DISTINCT FROM $2 OR share_h IS DISTINCT FROM $3)
	  RETURNING id::text`, room, wp, hp).Scan(new(string)); err != nil {
		// pgx.ErrNoRows is the ordinary case: a retry, or a room whose broadcast
		// has ended. Nothing to say about it.
		if !errors.Is(err, pgx.ErrNoRows) {
			goliveLog("SHARE_GEOMETRY_FAILED", "", room, "", "error="+err.Error())
		}
		return
	}
	if wp == nil {
		goliveLog("SHARE_ENDED", "", room, "")
	} else {
		goliveLog("SHARE_GEOMETRY", "", room, "", fmt.Sprintf("size=%dx%d", w, h))
	}
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

	// THE HOST IS BACK, BUT THE TRANSCODER IS NOT.
	//
	// While they were away the egress reported a fault. broadcast_webhook.go
	// held the session open (host inside grace) and cleared egress_id to say
	// "this stream has no transcoder". Nothing else restarts one, so without
	// this the broadcast stays 'live' with no playlist advancing — worse than
	// the failure it replaced.
	//
	// Only ever on a REJOIN, and only when egress_id IS NULL, so:
	//   • a healthy broadcast is never touched (its egress_id is set)
	//   • a deliberate End cannot resurrect — that row is 'ended', not 'live'
	//   • a second egress cannot be started for a stream that still has one
	// The broadcast id, room, host and HLS URL are all unchanged; PlaybackURL is
	// derived from the broadcast id, so a viewer's URL survives the restart.
	if joined {
		goliveRestartEgress(r, room, identity)
	}
}

// goliveRestartEgress starts a replacement transcoder for a session whose host
// has just returned and whose egress died while they were gone.
//
// Non-fatal throughout, like the original start in broadcasts.go: a broadcast
// whose egress will not start is one the host can still end and retry, and a
// webhook is the wrong place to fail loudly.
func goliveRestartEgress(r *http.Request, room, identity string) {
	ctx := r.Context()
	gocfg := golive.ConfigFromEnv()
	if !gocfg.Usable() {
		return
	}

	// Claim the restart in the same statement that finds it. Two webhooks for
	// the same rejoin would otherwise both see egress_id IS NULL and start two
	// transcoders; the sentinel makes the second find nothing.
	var bid string
	err := db.SysPool.QueryRow(ctx,
		`UPDATE broadcast_sessions
		    SET egress_id = 'restarting'
		  WHERE room = $1 AND host_id = $2::uuid
		    AND status IN ('starting', 'live')
		    AND egress_id IS NULL
		  RETURNING id::text`, room, identity).Scan(&bid)
	if err != nil {
		return // no such row (the normal case: egress is healthy)
	}

	egressID, e := livekit.StartHLS(ctx, gocfg.Config, room, bid)
	if e != nil {
		// Release the claim so a later rejoin — or the next webhook — can retry.
		// Leaving the sentinel would strand the session with no transcoder and
		// no way to acquire one.
		_, _ = db.SysPool.Exec(ctx,
			`UPDATE broadcast_sessions SET egress_id = NULL
			  WHERE id = $1::uuid AND egress_id = 'restarting'`, bid)
		goliveMetric("egress_restart_failed")
		goliveLog("EGRESS_RESTART_FAILED", bid, room, identity, "error="+e.Error())
		return
	}
	if _, err := db.SysPool.Exec(ctx,
		`UPDATE broadcast_sessions SET egress_id = $2
		  WHERE id = $1::uuid`, bid, egressID); err != nil {
		goliveLog("EGRESS_RESTART_SAVE_FAILED", bid, room, identity, "error="+err.Error())
		return
	}
	goliveMetric("egress_restarted")
	goliveLog("EGRESS_RESTARTED", bid, room, identity, "egress_id="+egressID)
}

