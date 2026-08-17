// broadcasts.go — live broadcast sessions (migration 079).
//
// The third communication mode, and the only one that is NOT end-to-end
// encrypted: viewers are unbounded and receive HLS from a CDN, so there is no
// key exchange that could reach them. Every response therefore carries an
// explicit `e2ee` field rather than leaving the client to infer it — an
// accidental padlock over an unencrypted stream is the worst bug this file
// could ship.
//
// WHAT LIVES WHERE
//   Postgres  metadata only: who is live, title, playback URL, history.
//   Redis     the live viewer count. A per-join UPDATE on a row every viewer
//             also reads is a hot-row lock convoy at exactly the moment a
//             stream goes viral; viewer_count here is a periodic SNAPSHOT so
//             the historical record survives a Redis flush.
//   MinIO/CDN the media. No bytes of video pass through this file.
//
// RLS (079) is the real authority on who may write: the policies allow INSERT
// only as yourself and UPDATE only by the host, so a mistake here cannot
// produce a broadcast owned by someone else.

package routes

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/golive"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/livekit"
	"vaultchat/backend-go/internal/redisx"
)

func RegisterBroadcasts(mux *http.ServeMux) {
	mux.HandleFunc("POST /broadcasts", httpx.RequireAuth(broadcastStart))
	mux.HandleFunc("GET /broadcasts/live", httpx.RequireAuth(broadcastListLive))
	mux.HandleFunc("GET /broadcasts/{id}", httpx.RequireAuth(broadcastGet))
	mux.HandleFunc("POST /broadcasts/{id}/end", httpx.RequireAuth(broadcastEnd))
	// Called by the egress worker once a playlist exists. Separate from the
	// generic update so "publishing the URL" cannot be used to rewrite a
	// stream's identity.
	mux.HandleFunc("POST /broadcasts/{id}/hls", httpx.RequireAuth(broadcastSetHLS))
	// A broadcast is not a call, so it cannot reuse /calls/{id}/sfu-token — that
	// handler resolves membership from call_participants, which has no row here.
	mux.HandleFunc("POST /broadcasts/{id}/token", httpx.RequireAuth(broadcastToken))
	mux.HandleFunc("POST /broadcasts/{id}/watch", httpx.RequireAuth(broadcastWatch))
	mux.HandleFunc("POST /broadcasts/{id}/unwatch", httpx.RequireAuth(broadcastUnwatch))
	mux.HandleFunc("GET /broadcasts/{id}/chat", httpx.RequireAuth(broadcastChatList))
	mux.HandleFunc("POST /broadcasts/{id}/chat", httpx.RequireAuth(broadcastChatPost))
	// Playback relay. NOT RequireAuth on purpose — a video player cannot attach
	// an Authorization header to the segment requests it generates itself, so
	// the query ticket is the credential. See broadcast_hls.go.
	mux.HandleFunc("GET /broadcasts/{id}/hls/{file...}", broadcastHLS)
}

type broadcast struct {
	ID     string  `json:"id"`
	HostID string  `json:"hostId"`
	ChatID *string `json:"chatId,omitempty"`
	Title  string  `json:"title"`
	Status string  `json:"status"`
	// Optional, shown under the title. Separate from title because a title is a
	// headline and this is not: the listing renders one, the player renders both.
	Description string `json:"description"`
	// 'public' or 'private' (migration 105). Sent to the client so the UI renders
	// the audience rule from data rather than from what it thinks it requested.
	Visibility string `json:"visibility"`
	// The CALLER's own stage role: host | speaker | audience. Computed per
	// request, never stored — it is a fact about who is asking, not about the
	// broadcast. Only GET /broadcasts/{id} populates it; omitted elsewhere so a
	// listing does not run an invite lookup per row.
	MyRole      string     `json:"myRole,omitempty"`
	HLSURL      *string    `json:"hlsUrl,omitempty"`
	Room        string     `json:"room"`
	E2EE        bool       `json:"e2ee"`
	ViewerCount int        `json:"viewerCount"`
	PeakViewers int        `json:"peakViewers"`
	StartedAt   time.Time  `json:"startedAt"`
	EndedAt     *time.Time `json:"endedAt,omitempty"`
}

const broadcastCols = `id::text, host_id::text, chat_id::text, title, description, status, visibility,
	                   hls_url, room, e2ee, viewer_count, peak_viewers, started_at, ended_at`

func scanBroadcast(row pgx.Row) (*broadcast, error) {
	var b broadcast
	if err := row.Scan(&b.ID, &b.HostID, &b.ChatID, &b.Title, &b.Description, &b.Status, &b.Visibility,
		&b.HLSURL, &b.Room, &b.E2EE, &b.ViewerCount, &b.PeakViewers,
		&b.StartedAt, &b.EndedAt); err != nil {
		return nil, err
	}
	// Hand out a TICKETED url, derived from the id, whenever a playlist exists.
	//
	// Minted here because every read path funnels through this one function —
	// start, list, get, token, set-hls and end — so one place covers all six and
	// none can drift. Deriving it from b.ID also means the stored hls_url is no
	// longer what a viewer fetches, which neutralises the arbitrary-URL write in
	// broadcastSetHLS without having to remove that endpoint (its real job is
	// the starting→live transition).
	if b.HLSURL != nil && *b.HLSURL != "" {
		u := broadcastHLSURL(b.ID)
		b.HLSURL = &u
	}
	return &b, nil
}

// POST /broadcasts — go live.
func broadcastStart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	var body struct {
		Title       string `json:"title"`
		Description string `json:"description"`
		ChatID      string `json:"chatId"`
		Visibility  string `json:"visibility"`
		// Optional Zoom-style passcode for a Private Live. Plaintext on the way
		// in and hashed before it is stored; never returned by any handler.
		Passcode string `json:"passcode"`
	}
	_ = httpx.Body(r, &body)

	title := strings.TrimSpace(body.Title)
	if len(title) > 200 {
		title = title[:200]
	}
	desc := strings.TrimSpace(body.Description)
	if len(desc) > 1000 {
		desc = desc[:1000]
	}
	var chatID *string
	if c := strings.TrimSpace(body.ChatID); c != "" {
		chatID = &c
	}
	// Anything that is not exactly "private" is public. Whitelisting rather than
	// rejecting unknown values keeps an older client — which sends no visibility
	// at all — on the behaviour it was written for, while a typo can only ever
	// make a stream MORE open than intended, never less. The reverse default
	// would silently hide streams whose hosts meant them to be seen.
	visibility := "public"
	if strings.TrimSpace(strings.ToLower(body.Visibility)) == "private" {
		visibility = "private"
	}

	// A passcode only means anything on a PRIVATE live. On a public one the
	// stream is in everyone's listing by definition, so accepting a passcode
	// there would imply a protection that does not exist. Dropped, not rejected:
	// the host's intent was "private", and the fix is the visibility toggle.
	//
	// Hashed here, before the row is written, so the plaintext never reaches the
	// database layer at all.
	var passcodeHash *string
	if pc := strings.TrimSpace(body.Passcode); pc != "" && visibility == "private" {
		if len(pc) > 64 {
			pc = pc[:64]
		}
		h, herr := bcrypt.GenerateFromPassword([]byte(pc), bcrypt.DefaultCost)
		if herr != nil {
			// Refuse rather than fall through to an unprotected stream: the host
			// asked for a passcode, and starting without one silently would hand
			// them a false expectation about who can watch.
			goliveLog("START_REFUSED", "", "", uid, "reason=passcode_hash_failed")
			httpx.Err(w, 500, "Could not set the passcode")
			return
		}
		s := string(h)
		passcodeHash = &s
	}

	// FAIL EXPLICITLY rather than falling back to the calling cluster.
	//
	// Go Live has its own LiveKit project (internal/golive). If GOLIVE_LIVEKIT_*
	// is absent — or has been pointed at the CALLING project by copy-paste, which
	// Usable() also catches — this refuses to start a broadcast at all. The
	// alternative is the coupling the separate deployment exists to remove,
	// reintroduced silently and reported by nothing.
	//
	// Checked BEFORE the row is written so a misconfigured server does not leave
	// 'starting' rows behind that the reaper then has to clean up.
	gocfg := golive.ConfigFromEnv()
	if !gocfg.Usable() {
		goliveLog("START_REFUSED", "", "", uid, "reason=golive_livekit_not_configured")
		goliveMetric("start_refused_unconfigured")
		httpx.Err(w, 503, "Go Live is not configured on this server")
		return
	}

	var b *broadcast
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// Abandon anything stuck in 'starting'.
		//
		// A broadcast is created as 'starting' and only becomes 'live' when a
		// playlist exists. If the app dies in between — a crash, a force-quit,
		// egress refusing — the row stays 'starting' FOREVER, and the guard
		// below then refuses every future broadcast by that host with no way for
		// them to clear it. Two such rows were found in production, both from an
		// app crash, and they would have blocked that account permanently.
		//
		// Five minutes is far longer than a healthy start (egress publishes in
		// seconds), so this can only catch genuinely dead attempts.
		if _, e := tx.Exec(ctx,
			`UPDATE broadcast_sessions
			    SET status = 'failed', ended_at = now()
			  WHERE host_id = $1 AND status = 'starting'
			    AND started_at < now() - interval '5 minutes'`, uid); e != nil {
			return e
		}

		// One live broadcast per host. Starting a second would orphan the first:
		// its egress keeps running, it stays 'live' in every listing, and no one
		// can end it because the client only tracks the newest.
		var existing string
		e := tx.QueryRow(ctx,
			`SELECT id::text FROM broadcast_sessions
			  WHERE host_id = $1 AND status IN ('starting','live')`, uid).Scan(&existing)
		if e == nil {
			return errAlreadyLive
		}

		// The room name is derived from the BROADCAST id, in the Go Live
		// namespace — "golive_<uuid>", never "call-<id>" and never the old
		// "bc_<host-id>".
		//
		// Two defects went with that old scheme. It reused ONE room name for
		// every stream a host ever ran, so a viewer holding a stale token could
		// join their next broadcast and egress could attach to the wrong session;
		// and it shared a namespace with calling, which is exactly what the
		// separate Go Live deployment exists to prevent.
		//
		// TWO STATEMENTS, AND IT MUST BE TWO.
		//
		// The obvious single-statement form — a data-modifying CTE that inserts
		// and then updates the row it just inserted — is silently wrong in
		// PostgreSQL. Sub-statements in WITH run against the SAME SNAPSHOT as the
		// main query and cannot see one another's effects on the target table, so
		//
		//	WITH ins AS (INSERT … RETURNING id)
		//	UPDATE broadcast_sessions s SET room = … FROM ins WHERE s.id = ins.id
		//
		// matches ZERO rows. Measured on the bench: `UPDATE 0`, the row landing
		// with room = '' and RETURNING yielding nothing — so every single "Go
		// Live" answered 500 and left an orphan behind. It reads correct, it
		// passes a naive test, and it never works.
		//
		// Inside one transaction the second statement sees the first, which is
		// the whole difference.
		var newID string
		if e := tx.QueryRow(ctx,
			`INSERT INTO broadcast_sessions (host_id, chat_id, title, description, status, visibility, room, passcode_hash)
			 VALUES ($1, $2, $3, $4, 'starting', $5, '', $6)
			 RETURNING id::text`,
			uid, chatID, title, desc, visibility, passcodeHash).Scan(&newID); e != nil {
			// Migration 081's partial unique index fires HERE — this is the
			// insert it guards — so the double-tap race is caught below.
			if isUniqueViolation(e) {
				return errAlreadyLive
			}
			return e
		}

		var err2 error
		b, err2 = scanBroadcast(tx.QueryRow(ctx,
			`UPDATE broadcast_sessions
			    SET room = $2
			  WHERE id = $1
			 RETURNING `+broadcastCols,
			newID, gocfg.RoomName(newID)))
		// The SELECT above and this INSERT are two statements, so two requests
		// arriving together both read "not live" and both insert — a double-tap
		// on Go Live is enough. Migration 081 adds a partial unique index so the
		// loser fails here instead, and it is the same outcome the check would
		// have produced: "you are already live", not a 500.
		if isUniqueViolation(err2) {
			return errAlreadyLive
		}
		return err2
	})
	if err == errAlreadyLive {
		httpx.Err(w, 409, "You already have a live broadcast")
		return
	}
	if err != nil {
		// LOG THE CAUSE. This branch answered a bare 500 with nothing written
		// anywhere, so when every go-live started failing the server logs were
		// completely silent and the only way to find it was to replay the SQL by
		// hand. A 500 nobody can diagnose is barely better than a crash.
		goliveLog("START_FAILED", "", "", uid, "error="+err.Error())
		goliveMetric("start_failed")
		httpx.Err(w, 500, "Could not start the broadcast")
		return
	}
	// ── start the transcoder ───────────────────────────────────────────
	//
	// Nothing else does this. Without it the row exists, the room exists, and no
	// playlist is ever written — the viewer waits on a URL that will not appear.
	//
	// Deliberately NOT fatal. A broadcast whose egress failed to start is a
	// broadcast the host can still end, retry, and see an honest status for; a
	// 500 here would leave an orphaned 'starting' row that nothing can clear.
	// The status stays 'starting' and the client's poll reports the truth.
	//
	// gocfg.Config is the GO LIVE project — checked Usable() above, so this can
	// never reach the calling cluster. livekit.StartHLS is reused unchanged: it
	// signs and calls whatever Config it is handed, which is what makes sharing
	// it reuse rather than coupling.
	{
		egressID, e := livekit.StartHLS(ctx, gocfg.Config, b.Room, b.ID)
		if e != nil {
			goliveMetric("egress_failed")
			goliveLog("EGRESS_START_FAILED", b.ID, b.Room, uid, "error="+e.Error())
		} else {
			// The playback URL is DETERMINISTIC from the broadcast id, so it can
			// be stored now rather than waiting for a callback that may never
			// arrive. Status still only becomes 'live' once a playlist exists —
			// see broadcastSetHLS — so a viewer is never sent to a dead player.
			url := livekit.PlaybackURL(b.ID)
			_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
				_, err := tx.Exec(ctx,
					`UPDATE broadcast_sessions SET egress_id = $2, hls_url = $3 WHERE id = $1`,
					b.ID, egressID, url)
				return err
			})
			// TICKETED in the response, raw in the column — same split every
			// other read path uses (see scanBroadcast). This one built the
			// response from `url` directly and so returned a playback link with
			// no access ticket on it, which broadcastHLS answers 404 for.
			ticketed := broadcastHLSURL(b.ID)
			b.HLSURL = &ticketed
			goliveMetric("egress_started")
		}
	}

	goliveMetric("started")
	goliveLog("BROADCAST_CREATED", b.ID, b.Room, uid, "visibility="+b.Visibility)
	httpx.JSON(w, 200, b)
}

var errAlreadyLive = &alreadyLiveErr{}

type alreadyLiveErr struct{}

func (*alreadyLiveErr) Error() string { return "already live" }

// GET /broadcasts/live — what is on right now.
func broadcastListLive(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	out := []*broadcast{}
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// Private streams are reachable only through an invitation, so discovery
		// shows a private broadcast to its host and its invitees and to nobody
		// else. Filtered in SQL rather than after the scan: sending 100 rows to
		// Go so it can drop most of them is work the partial index already avoids
		// (broadcast_sessions_public_live_idx, migration 105).
		//
		// The 105 RLS policy expresses the same rule. This is the Go half of the
		// two-gate pattern — see routes/golive.go on why one gate is not enough
		// on this deployment.
		rows, err := tx.Query(ctx,
			`SELECT `+broadcastCols+`
			   FROM broadcast_sessions
			  WHERE status = 'live'
			    AND (visibility = 'public'
			         OR host_id = $1
			         OR EXISTS (SELECT 1 FROM broadcast_invites i
			                     WHERE i.broadcast_id = broadcast_sessions.id
			                       AND i.invitee_id = $1))
			  ORDER BY started_at DESC
			  LIMIT 100`, uid)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			b, e := scanBroadcast(rows)
			if e != nil {
				return e
			}
			out = append(out, b)
		}
		return rows.Err()
	})
	httpx.JSON(w, 200, map[string]any{"broadcasts": out})
}

// GET /broadcasts/{id}
func broadcastGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")

	var b *broadcast
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		var e error
		b, e = scanBroadcast(tx.QueryRow(ctx,
			`SELECT `+broadcastCols+` FROM broadcast_sessions WHERE id = $1`, id))
		return e
	})
	if err != nil || b == nil {
		httpx.Err(w, 404, "Broadcast not found")
		return
	}
	// Strips the playback ticket for anyone not entitled to watch. The ticket is
	// the capability broadcast_hls.go actually accepts, so removing it is what
	// enforces a private stream here — see goliveRedact on why this redacts
	// rather than 404s.
	goliveRedact(ctx, uid, b)

	// TELL THE CALLER WHICH SIDE OF THE STAGE THEY ARE ON.
	//
	// Without this the client had no way to know, so app/live-view.tsx joined the
	// room only when a `host=1` URL PARAM was present — a value the client made
	// up about itself. An invited co-host was therefore handed a perfectly good
	// publish token by /token and never used it: they sat in HLS like any viewer,
	// and the 20-seat stage could only ever hold one person.
	//
	// Advertised, never trusted. The token endpoint recomputes it, so a client
	// that lies about myRole gains nothing — it would still be minted an audience
	// grant, and LiveKit would refuse its camera.
	//
	// ponytail: one indexed EXISTS per read for non-hosts, and this read is polled
	// every 12s per viewer. Fine into the thousands; at millions cache it per
	// (broadcast, user) in Redis with the invite write busting the key. Not worth
	// building until viewer counts ask for it.
	b.MyRole = string(goliveStageRole(ctx, uid, id, b.HostID))
	httpx.JSON(w, 200, b)
}

// POST /broadcasts/{id}/hls — publish the playlist URL, once egress has one.
func broadcastSetHLS(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	var body struct {
		HLSURL string `json:"hlsUrl"`
	}
	_ = httpx.Body(r, &body)

	url := strings.TrimSpace(body.HLSURL)
	// Only https. A plaintext playlist would be downgraded or injected in
	// transit, and every viewer would play whatever arrived.
	if !strings.HasPrefix(url, "https://") {
		httpx.Err(w, 400, "hlsUrl must be https")
		return
	}

	var b *broadcast
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// 'starting' -> 'live' happens HERE rather than at creation: a stream is
		// only live once there is something to play. Publishing a URL for an
		// already-ended broadcast is refused by the WHERE clause.
		var e error
		// host_id is checked HERE, in Go, and not only by the 079 RLS policy.
		//
		// Publishing the playlist URL decides what every viewer of this stream
		// plays. RLS is the intended guard, but whether it is in force depends
		// on the deployment's database role (docs/RLS_ENFORCEMENT.md — an open
		// question here), and if it is bypassed this handler had NO other
		// restriction: any authenticated account could repoint any starting
		// broadcast at a playlist of their choosing. The only validation was
		// that the URL began with https://.
		//
		// Same two-gate rule call_sessions.go states and broadcastToken already
		// follows: check it in Go as well, and the feature is correct if either
		// gate holds.
		b, e = scanBroadcast(tx.QueryRow(ctx,
			`UPDATE broadcast_sessions
			    SET hls_url = $2, status = 'live'
			  WHERE id = $1 AND status = 'starting' AND host_id = $3
			  RETURNING `+broadcastCols, id, url, uid))
		return e
	})
	if err != nil || b == nil {
		httpx.Err(w, 409, "Broadcast is not waiting to go live")
		return
	}
	goliveMetric("live")
	httpx.JSON(w, 200, b)
}

// POST /broadcasts/{id}/token — a LiveKit credential for this broadcast room.
//
// ONLY THE HOST MAY PUBLISH. The role is derived from broadcast_sessions.host_id
// read fresh on every mint, never from anything the client sends — so a viewer
// cannot present a token that lets them speak over someone's stream, and a host
// who has already ended cannot resume by reusing an old one.
//
// Viewers normally watch over HLS through the CDN and never call this at all;
// it exists for the low-latency WebRTC path (a promoted speaker, or the host's
// own monitor).
func broadcastToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")

	var b *broadcast
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		var e error
		b, e = scanBroadcast(tx.QueryRow(ctx,
			`SELECT `+broadcastCols+` FROM broadcast_sessions WHERE id = $1`, id))
		return e
	})
	if err != nil || b == nil {
		httpx.Err(w, 404, "Broadcast not found")
		return
	}
	if b.Status == "ended" || b.Status == "failed" {
		httpx.Err(w, 409, "This broadcast has ended")
		return
	}

	// AUDIENCE AUTHORIZATION HAPPENS BEFORE THE TOKEN IS MINTED.
	//
	// This is the gate the brief calls for on Private Live: a stranger asking for
	// a credential to someone's private stream is refused here, so no LiveKit
	// token for that room is ever created — not a subscribe-only one either.
	// Refused outright rather than redacted (unlike the metadata reads) because
	// this endpoint GRANTS media access; there is nothing to hand back safely.
	if !goliveMayWatch(ctx, uid, b) {
		goliveLog("TOKEN_DENIED", b.ID, b.Room, uid, "visibility="+b.Visibility)
		goliveMetric("token_denied")
		// 404, matching the not-found reply above: a 403 would confirm that a
		// private broadcast with this id exists.
		httpx.Err(w, 404, "Broadcast not found")
		return
	}

	// The GO LIVE project, never the calling one. Usable() also refuses a config
	// that has been pointed at the calling cluster's credentials — an overlap
	// must fail, not work.
	gocfg := golive.ConfigFromEnv()
	if !gocfg.Usable() {
		goliveMetric("token_unconfigured")
		httpx.Err(w, 503, "Go Live is not configured on this server")
		return
	}

	// Publish rights come from the DATABASE, read fresh on every mint.
	//
	// The host always may. A guest may only if the host has invited them AND
	// they accepted — which is what turns a viewer into a co-host without ever
	// trusting a claim the client makes about itself. Revoking is therefore
	// immediate in effect: the next token they mint is audience again, and
	// LiveKit refuses their camera at the media server rather than the UI
	// hiding a button.
	// Shared with GET /broadcasts/{id}, which advertises the same role so the
	// client knows whether to join the room at all. One function, so the role a
	// client is TOLD it has and the role its token GRANTS cannot drift apart.
	role := goliveStageRole(ctx, uid, id, b.HostID)

	// gocfg.Config — the Go Live signing key. An audience grant from GrantFor has
	// canPublish=false and an EMPTY publish-source list, so a viewer cannot send
	// camera, microphone or screen even if the client asks: the media server
	// refuses the track. Nothing the client sends influences `role`.
	token, err := livekit.Mint(gocfg.Config, livekit.MintArgs{
		Identity: uid,
		Room:     b.Room,
		Role:     role,
	})
	if err != nil {
		httpx.Err(w, 503, "Could not issue a streaming credential")
		return
	}

	goliveMetric("token_" + string(role))
	goliveLog("TOKEN_ISSUED", b.ID, b.Room, uid, "role="+string(role), "visibility="+b.Visibility)
	httpx.JSON(w, 200, map[string]any{
		"token":    token,
		"url":      gocfg.URL,
		"room":     b.Room,
		"identity": uid,
		"role":     string(role),
		// Broadcast is never end-to-end encrypted; echoed so the client renders
		// the security state from data rather than from an assumption.
		"e2ee": false,
	})
}

// ── viewer count ──────────────────────────────────────────────────────
//
// The live number lives in REDIS, not Postgres. A count updated per join and
// leave means one UPDATE per viewer on a row every viewer also SELECTs — a
// hot-row lock convoy at precisely the moment a stream goes viral, which is
// the moment it must not fall over. Redis handles that shape natively.
//
// A SET rather than a counter: viewers reconnect, background, and lose sockets
// without telling anyone, and INCR/DECR drifts permanently once a decrement is
// missed. Membership can be recomputed; a drifted integer cannot. The TTL means
// a viewer who vanishes ages out instead of inflating the number forever.
const viewerTTL = 90 * time.Second

func viewerSetKey(broadcastID string) string { return "bcv:" + broadcastID }

// POST /broadcasts/{id}/watch — join, and report the current count.
func broadcastWatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")

	// A private stream's viewer set and analytics must not be writable by someone
	// who may not watch it. Without this an uninvited account could heartbeat
	// into a private broadcast, inflate the host's live count and appear in
	// broadcast_viewers — with no media, but the metrics are the host's and the
	// presence is a leak.
	//
	// One indexed query, before the Redis write, on the hot path by design — see
	// goliveMayWatchID.
	if !goliveMayWatchID(ctx, uid, id) {
		goliveMetric("watch_denied")
		httpx.Err(w, 404, "Broadcast not found")
		return
	}

	count := 0
	if redisx.Client != nil {
		k := viewerSetKey(id)
		// Score = expiry. A sorted set gives both membership and cheap eviction
		// of viewers whose client stopped refreshing.
		now := time.Now()
		redisx.Client.ZAdd(ctx, k, redis.Z{Score: float64(now.Add(viewerTTL).Unix()), Member: uid})
		redisx.Client.ZRemRangeByScore(ctx, k, "-inf", strconv.FormatInt(now.Unix(), 10))
		redisx.Client.Expire(ctx, k, viewerTTL*3)
		if n, err := redisx.Client.ZCard(ctx, k).Result(); err == nil {
			count = int(n)
		}
	}

	// One row per viewing SESSION, which is what 079 defines this table to be
	// ("written on join and closed on leave … nothing in the hot path writes
	// here more than twice per viewer").
	//
	// The comment here already said "once per viewing session"; the SQL did the
	// opposite. This endpoint is the viewer HEARTBEAT — app/live-view.tsx calls
	// it every 3 s to stay in the Redis liveness set — so an unconditional
	// INSERT wrote ~1,200 rows per viewer per hour. At 10k viewers that is
	// ~3,300 inserts/sec against a table whose purpose is watch-time
	// reporting, and it made that reporting meaningless: every heartbeat looked
	// like a new session, so unique-viewer and watch-time counts were inflated
	// by the polling rate rather than measuring anything.
	//
	// WHERE NOT EXISTS rather than a unique index: the real rule is "at most
	// one OPEN row per (broadcast, viewer)", and a viewer who legitimately
	// leaves and rejoins must get a SECOND row. A UNIQUE(broadcast_id,user_id)
	// would forbid that and destroy the rejoin history; a partial unique index
	// on left_at IS NULL would express it, but that is a schema change to fix
	// what is a query bug, and it would also start rejecting rows on a table
	// that currently has legitimate duplicates from this very defect.
	//
	// Benign race: two heartbeats in flight together can both see no open row
	// and both insert. That costs one extra analytics row at session start, not
	// one every 3 s, and unwatch closes both.
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`INSERT INTO broadcast_viewers (broadcast_id, user_id)
			 SELECT $1, $2
			  WHERE NOT EXISTS (
			        SELECT 1 FROM broadcast_viewers
			         WHERE broadcast_id = $1 AND user_id = $2 AND left_at IS NULL)`,
			id, uid)
		return e
	})

	httpx.JSON(w, 200, map[string]any{"viewerCount": count})
}

// POST /broadcasts/{id}/unwatch — leave.
func broadcastUnwatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")

	if redisx.Client != nil {
		redisx.Client.ZRem(ctx, viewerSetKey(id), uid)
	}
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`UPDATE broadcast_viewers SET left_at = now()
			  WHERE broadcast_id = $1 AND user_id = $2 AND left_at IS NULL`, id, uid)
		return e
	})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── live chat ─────────────────────────────────────────────────────────

type broadcastMessage struct {
	ID        int64     `json:"id"`
	UserID    string    `json:"userId"`
	Name      string    `json:"name"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"createdAt"`
}

// GET /broadcasts/{id}/chat?after=<id> — newest messages, oldest first.
//
// Cursor rather than offset: a live chat grows while you are reading it, and
// OFFSET would skip or repeat messages as rows shift underneath the query.
func broadcastChatList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)

	out := []broadcastMessage{}
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			// The EXISTS is the private-stream gate, folded into the query the
			// handler already runs rather than added as a second round trip: this
			// is polled every 3 s by every viewer. A stranger gets an empty list,
			// which is also what they would see if the stream had no messages —
			// no existence is confirmed.
			`SELECT c.id, c.user_id::text, COALESCE(u.name, ''), c.message, c.created_at
			   FROM broadcast_chat c JOIN users u ON u.id = c.user_id
			  WHERE c.broadcast_id = $1 AND c.id > $2
			    AND EXISTS (SELECT 1 FROM broadcast_sessions b
			                 WHERE b.id = c.broadcast_id
			                   AND (b.visibility = 'public'
			                        OR b.host_id = $3
			                        OR EXISTS (SELECT 1 FROM broadcast_invites i
			                                    WHERE i.broadcast_id = b.id
			                                      AND i.invitee_id = $3)))
			  ORDER BY c.id DESC LIMIT 100`, id, after, uid)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var m broadcastMessage
			if err := rows.Scan(&m.ID, &m.UserID, &m.Name, &m.Message, &m.CreatedAt); err != nil {
				return err
			}
			out = append(out, m)
		}
		return rows.Err()
	})
	// Reverse into chronological order — the query took the NEWEST 100, the UI
	// renders oldest-first.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	httpx.JSON(w, 200, map[string]any{"messages": out})
}

// POST /broadcasts/{id}/chat
func broadcastChatPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	var body struct {
		Message string `json:"message"`
	}
	_ = httpx.Body(r, &body)

	msg := strings.TrimSpace(body.Message)
	if msg == "" {
		httpx.Err(w, 400, "message required")
		return
	}
	if len(msg) > 500 {
		msg = msg[:500]
	}

	// Chat is per-viewer and unbounded, so it needs its own limit — the call
	// limiter does not apply, and a live chat is the easiest thing on the
	// platform to flood.
	if rl := redisx.Consume(ctx, "bcchat:"+uid, 20, 60); !rl.Allowed {
		w.Header().Set("Retry-After", strconv.FormatInt(rl.ResetInSec, 10))
		httpx.Err(w, 429, "Slow down")
		return
	}

	var m broadcastMessage
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// The RLS policy in 079 refuses an insert once the broadcast is not
		// 'live', so an ended stream stops accepting messages at the database
		// rather than by convention here.
		// INSERT ... SELECT so the live-and-authorized test is part of the write
		// itself: a row appears only if the broadcast is live AND this user may
		// watch it. Zero rows returns pgx.ErrNoRows, which the caller already
		// turns into the same 409 it used for "not accepting chat" — a stranger
		// cannot distinguish a private stream from an ended one.
		return tx.QueryRow(ctx,
			`INSERT INTO broadcast_chat (broadcast_id, user_id, message)
			 SELECT $1, $2, $3
			   FROM broadcast_sessions b
			  WHERE b.id = $1 AND b.status = 'live'
			    AND (b.visibility = 'public'
			         OR b.host_id = $2
			         OR EXISTS (SELECT 1 FROM broadcast_invites i
			                     WHERE i.broadcast_id = b.id AND i.invitee_id = $2))
			 RETURNING id, created_at`, id, uid, msg).
			Scan(&m.ID, &m.CreatedAt)
	})
	if err != nil {
		httpx.Err(w, 409, "This broadcast is not accepting chat")
		return
	}
	m.UserID = uid
	m.Message = msg
	goliveMetric("chat_sent")
	httpx.JSON(w, 200, m)
}

// POST /broadcasts/{id}/end
func broadcastEnd(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	var body struct {
		// Final count, read from Redis by the caller. Persisted so the history
		// survives a Redis flush — see the header.
		ViewerCount int `json:"viewerCount"`
		PeakViewers int `json:"peakViewers"`
	}
	_ = httpx.Body(r, &body)

	var egressID string
	var b *broadcast
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		var e error
		// host_id in the WHERE, for the same reason as broadcastSetHLS: without
		// it, and with RLS bypassed, any authenticated account could end anyone
		// else's live stream — dropping its audience and stopping its egress.
		//
		// A non-host falls through to the idempotent "alreadyEnded" reply
		// below rather than a 403. That is deliberate: this endpoint cannot
		// distinguish "not yours" from "already over" without telling a caller
		// which broadcasts exist, and the honest 200 leaks nothing while the
		// stream stays up. The egress_id read below is inside the same
		// error-returning path, so a refused end also cannot stop the
		// transcoder.
		b, e = scanBroadcast(tx.QueryRow(ctx,
			`UPDATE broadcast_sessions
			    SET status = 'ended',
			        ended_at = now(),
			        viewer_count = $2,
			        peak_viewers = GREATEST(peak_viewers, $3)
			  WHERE id = $1 AND ended_at IS NULL AND host_id = $4
			  RETURNING `+broadcastCols, id, body.ViewerCount, body.PeakViewers, uid))
		if e != nil {
			return e
		}
		return tx.QueryRow(ctx,
			`SELECT COALESCE(egress_id, '') FROM broadcast_sessions WHERE id = $1`, id).Scan(&egressID)
	})

	// Stop the transcoder. Without this, ending a broadcast drops the viewers
	// while Chrome + ffmpeg keep running and writing segments forever — the most
	// expensive leak in this stack, since egress is the only CPU-bound service.
	// Best-effort: the row is already ended, and a failure here must not turn a
	// successful stop into an error the host sees.
	//
	// Stopped against the GO LIVE project. Using livekit.ConfigFromEnv() here
	// would address the CALLING cluster, which does not know this egress id — so
	// every broadcast would end in the database while its transcoder kept running
	// and kept writing segments.
	if egressID != "" {
		if e := livekit.StopHLS(ctx, golive.ConfigFromEnv().Config, egressID); e != nil {
			goliveLog("EGRESS_STOP_FAILED", id, "", uid, "egress_id="+egressID, "error="+e.Error())
			goliveMetric("egress_stop_failed")
		}
	}
	if err != nil || b == nil {
		// Idempotent by intent: ending an already-ended stream is not an error,
		// because the client retries this on a flaky network and a 500 would
		// leave the UI stuck on "ending…".
		httpx.JSON(w, 200, map[string]any{"ok": true, "alreadyEnded": true})
		return
	}
	goliveMetric("ended")
	httpx.JSON(w, 200, b)
}
