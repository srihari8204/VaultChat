// golive.go — Go Live: audience authorization, isolated logging, health.
//
// The broadcast handlers themselves stay in broadcasts.go; what lives here is
// everything that makes Go Live a SEPARATE tier rather than a feature of the
// calling stack:
//
//	goliveMayWatch  the private-broadcast gate, enforced in Go as well as RLS
//	goliveLog       [GOLIVE]-namespaced events, never mixed into call logs
//	goliveHealth    GET /golive/health — Go Live's own liveness, which cannot
//	                report the CALLING LiveKit as unhealthy and is not affected
//	                by it either
//
// WHY THE GO CHECK EXISTS WHEN RLS ALREADY HAS ONE
// ------------------------------------------------
// docs/RLS_ENFORCEMENT.md records that this deployment's database role can
// bypass row-level security, so a policy is a second gate and not a guarantee.
// Private Live is an access-control feature: if the only enforcement is a policy
// that may be inert, the feature does not exist. Same two-gate rule
// broadcastSetHLS and broadcastEnd already follow.
package routes

import (
	"context"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/golive"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/livekit"
	"vaultchat/backend-go/internal/metrics"
)

func RegisterGoLive(mux *http.ServeMux) {
	// Unauthenticated, like GET /health: a monitor cannot hold a user session,
	// and the response deliberately carries no URL, key or hostname — only
	// whether each of Go Live's three dependencies answered.
	mux.HandleFunc("GET /golive/health", goliveHealth)
}

// ── isolated logging ──────────────────────────────────────────────────
//
// Every Go Live line starts with [GOLIVE] and carries the ids needed to follow
// one broadcast end to end. Grepping [GOLIVE] must return the whole story of the
// broadcasting tier and NOTHING from calling — that is the observability
// requirement, and a shared prefix would quietly break it.
//
// key=value rather than prose so a log shipper can index it without a regex per
// message.
func goliveLog(event, broadcastID, room, userID string, extra ...string) {
	var b strings.Builder
	b.WriteString("[GOLIVE] event=")
	b.WriteString(event)
	if broadcastID != "" {
		b.WriteString(" broadcast_id=")
		b.WriteString(broadcastID)
	}
	if room != "" {
		b.WriteString(" room_id=")
		b.WriteString(room)
	}
	if userID != "" {
		b.WriteString(" user_id=")
		b.WriteString(userID)
	}
	for _, e := range extra {
		if e != "" {
			b.WriteString(" ")
			b.WriteString(e)
		}
	}
	log.Print(b.String())
}

// goliveMetric namespaces counters the same way the logs are namespaced, so a
// dashboard can show Go Live's health without a single calling metric in it.
func goliveMetric(name string) { metrics.Inc("golive_" + name) }

// ── audience authorization ────────────────────────────────────────────

// goliveMayWatch decides whether uid may receive this broadcast.
//
// PUBLIC   anyone authenticated. That is what the mode means.
// PRIVATE  the host, or someone the host invited (broadcast_invites, 082).
//
// The invitation does NOT need to be accepted. seen_at gates PUBLISHING (the
// co-host promotion in broadcastToken); requiring it to watch would mean a
// viewer had to accept an invite they can only see by opening the stream.
//
// Fails CLOSED: an unreadable database, an unknown visibility value, or an empty
// user id all deny. The thing being defaulted is access to someone's private
// stream, so the only safe default is no.
func goliveMayWatch(ctx context.Context, uid string, b *broadcast) bool {
	if uid == "" || b == nil {
		return false
	}
	if b.HostID == uid {
		return true
	}
	if b.Visibility == "public" {
		return true
	}
	if b.Visibility != "private" {
		return false // unrecognised — deny rather than guess
	}
	// No database means no way to establish the invitation, and this function
	// decides who may watch a private stream. Deny. Without this the nil pool
	// panics inside db.WithUser, which on a degraded server turns an
	// authorization question into a crashed request handler.
	if db.Pool == nil {
		return false
	}
	var invited bool
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT TRUE FROM broadcast_invites
			  WHERE broadcast_id = $1 AND invitee_id = $2`, b.ID, uid).Scan(&invited)
	})
	return err == nil && invited
}

// goliveAudienceSQL is the audience rule as a SQL predicate, for handlers that
// have an id but no loaded row.
//
// $1 is the broadcast id and $2 the acting user. Kept as ONE constant so the
// rule cannot drift between the listing, the chat and the heartbeat — three
// copies of an access-control predicate is how one of them ends up subtly wider
// than the others.
const goliveAudienceSQL = `
	SELECT TRUE FROM broadcast_sessions b
	 WHERE b.id = $1
	   AND (b.visibility = 'public'
	        OR b.host_id = $2
	        OR EXISTS (SELECT 1 FROM broadcast_invites i
	                    WHERE i.broadcast_id = b.id AND i.invitee_id = $2))`

// goliveMayWatchID is goliveMayWatch for a caller holding only an id.
//
// One indexed query rather than "load the broadcast, then check it": the viewer
// heartbeat runs every 3 s for every member of an unbounded audience, and a
// second round trip there is the difference between a stream and an outage at
// scale.
func goliveMayWatchID(ctx context.Context, uid, id string) bool {
	if uid == "" || id == "" || db.Pool == nil {
		return false // fail closed — see goliveMayWatch
	}
	var ok bool
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, goliveAudienceSQL, id, uid).Scan(&ok)
	})
	return err == nil && ok
}

// ── stage roles ───────────────────────────────────────────────────────

// goliveStageRole is who this user is ON THE STAGE of one broadcast.
//
//	host      the owner. Always may publish.
//	speaker   invited AND accepted — a co-host. May publish.
//	audience  everyone else. Watches HLS; the grant refuses their camera at the
//	          media server, not in the UI.
//
// ONE function, because two callers need the same answer and they must not
// drift: /broadcasts/{id} advertises the role so the client knows whether to
// join the room at all, and /broadcasts/{id}/token mints the grant. If those
// ever disagreed, a client would either sit in HLS holding publish rights it
// never used, or try to publish with an audience token and be refused by
// LiveKit with no explanation. The token endpoint remains the authority — this
// is read fresh on every call, so a revoked co-host is audience again on their
// next mint.
//
// Fails CLOSED to audience: an unreadable database or a missing pool denies
// publishing rather than granting it.
func goliveStageRole(ctx context.Context, uid, broadcastID, hostID string) livekit.Role {
	if uid == "" {
		return livekit.RoleAudience
	}
	if hostID == uid {
		return livekit.RoleHost
	}
	if db.Pool == nil {
		return livekit.RoleAudience
	}
	// seen_at IS NOT NULL — the invitation must have been ACCEPTED. Being
	// invited is not the same as agreeing to appear: an unaccepted invite must
	// not put someone's camera on a stage in front of an unbounded audience.
	var accepted bool
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT TRUE FROM broadcast_invites
			  WHERE broadcast_id = $1 AND invitee_id = $2 AND seen_at IS NOT NULL`,
			broadcastID, uid).Scan(&accepted)
	})
	if err == nil && accepted {
		if !goliveStageHasRoom(ctx, uid, broadcastID) {
			// The stage is full. Audience, not an error: they can still watch,
			// and a refused token would read as "the broadcast is broken".
			goliveMetric("stage_full_demoted")
			goliveLog("STAGE_FULL", broadcastID, "", uid, "cap="+strconv.Itoa(goliveMaxStage))
			return livekit.RoleAudience
		}
		return livekit.RoleSpeaker
	}
	return livekit.RoleAudience
}

// goliveMaxStage is the product rule: at most this many HUMANS publishing at
// once, host included.
//
// WHY IT IS ENFORCED HERE AND NOT BY THE ROOM
// -------------------------------------------
// It used to be livekit.yaml's max_participants, which counts EVERY member of
// the room and cannot tell a publisher from a spectator. That was fine while
// the audience watched HLS and never joined, and it broke the moment low-latency
// viewers did: a room capped at 20 would have let 20 viewers lock a co-host out
// of a stage that was, by any meaningful measure, empty.
//
// A cap on publishers is what the rule actually meant, and publishing is gated
// by the TOKEN — an audience grant has canPublish=false — so the token is the
// correct place to count. The room cap still exists as a backstop, set high
// enough to hold the stage plus a low-latency audience.
const goliveMaxStage = 20

// goliveStageHasRoom decides whether this accepted co-host still gets a seat.
//
// BY ACCEPTANCE TIME, NOT BY WHO ASKS FIRST. Counting "how many are on stage
// right now" would make the answer depend on reconnect order — the same person
// admitted or refused across a network blip, and two co-hosts racing on a token
// refresh able to sum to 21. Ranking by seen_at is stable: a given co-host gets
// the same answer every time until the roster itself changes.
//
// The host is not in broadcast_invites and always holds seat 1, hence -1.
//
// Fails OPEN to a seat on a database error, deliberately. This runs on every
// token mint; failing closed would silently empty the stage of an entire
// broadcast the moment the database hiccupped, which is a far worse outcome
// than briefly allowing a 21st publisher.
func goliveStageHasRoom(ctx context.Context, uid, broadcastID string) bool {
	if db.Pool == nil {
		return true
	}
	var ahead int
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM broadcast_invites
			  WHERE broadcast_id = $1
			    AND seen_at IS NOT NULL
			    AND seen_at < (SELECT seen_at FROM broadcast_invites
			                    WHERE broadcast_id = $1 AND invitee_id = $2)`,
			broadcastID, uid).Scan(&ahead)
	})
	if err != nil {
		return true
	}
	return ahead < goliveMaxStage-1
}

// goliveCanPublish mirrors the grant: everything except audience may send media.
// Kept next to the role so the two cannot drift apart either.
func goliveCanPublish(r livekit.Role) bool { return r != livekit.RoleAudience }

// goliveRedact strips what an unauthorized caller must not receive.
//
// Called instead of refusing outright on the metadata reads, because a 404 on
// every private broadcast makes an invited viewer's own stream unfindable the
// moment a request races the invitation. The playback ticket is the capability
// that actually matters — broadcast_hls.go accepts it as the credential, with no
// further check — so removing it is what enforces the boundary; the title and
// viewer count are not secrets worth a second code path.
//
// The handlers that GRANT something (token, chat, watch) refuse outright
// instead; see their call sites.
func goliveRedact(ctx context.Context, uid string, b *broadcast) {
	if b == nil || goliveMayWatch(ctx, uid, b) {
		return
	}
	b.HLSURL = nil
	goliveMetric("watch_denied")
}

// ── health ────────────────────────────────────────────────────────────

// goliveHealth answers for GO LIVE ONLY.
//
// Three dependencies, reported separately so an operator can see WHICH one is
// down: the Go Live API (this process — if it answers at all, that half is up),
// the Go Live LiveKit, and Postgres.
//
// It never pings the calling LiveKit, and the calling cluster's state can never
// appear in this response. That is the isolation requirement stated as code: a
// Go Live media failure produces GOLIVE_UNHEALTHY here and changes nothing about
// how calling reports itself.
//
// 503 on unhealthy so a load balancer or uptime monitor sees it without parsing
// the body.
func goliveHealth(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cfg := golive.ConfigFromEnv()

	configured := cfg.Configured()
	// An overlap is reported as its own failure rather than folded into
	// "unhealthy": the symptom (Go Live works fine) would otherwise hide a
	// configuration that has silently re-coupled the two tiers.
	overlap := cfg.SameProjectAsCalls()

	lkOK, lkErr := false, ""
	if configured {
		if err := cfg.Ping(ctx); err != nil {
			lkErr = err.Error()
		} else {
			lkOK = true
		}
	} else {
		lkErr = "GOLIVE_LIVEKIT_* is not configured"
	}

	dbOK := db.Pool != nil && db.Pool.Ping(ctx) == nil

	healthy := configured && !overlap && lkOK && dbOK
	status := "GOLIVE_HEALTHY"
	code := 200
	if !healthy {
		status = "GOLIVE_UNHEALTHY"
		code = 503
		goliveMetric("health_unhealthy")
	}

	httpx.JSON(w, code, map[string]any{
		"status": status,
		"golive": map[string]any{
			"api":        true, // this handler answered
			"configured": configured,
			// True means Go Live is sharing the CALLING cluster's credentials —
			// the one misconfiguration that undoes the whole separation.
			"sharesCallingProject": overlap,
			"livekit":              map[string]any{"ok": lkOK, "error": lkErr},
			"database":             map[string]any{"ok": dbOK},
			"roomPrefix":           cfg.RoomPrefix,
		},
	})
}
