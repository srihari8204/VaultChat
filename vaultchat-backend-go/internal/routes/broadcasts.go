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
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/livekit"
	"vaultchat/backend-go/internal/metrics"
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
	ID          string     `json:"id"`
	HostID      string     `json:"hostId"`
	ChatID      *string    `json:"chatId,omitempty"`
	Title       string     `json:"title"`
	Status      string     `json:"status"`
	HLSURL      *string    `json:"hlsUrl,omitempty"`
	Room        string     `json:"room"`
	E2EE        bool       `json:"e2ee"`
	ViewerCount int        `json:"viewerCount"`
	PeakViewers int        `json:"peakViewers"`
	StartedAt   time.Time  `json:"startedAt"`
	EndedAt     *time.Time `json:"endedAt,omitempty"`
}

const broadcastCols = `id::text, host_id::text, chat_id::text, title, status,
	                   hls_url, room, e2ee, viewer_count, peak_viewers, started_at, ended_at`

func scanBroadcast(row pgx.Row) (*broadcast, error) {
	var b broadcast
	if err := row.Scan(&b.ID, &b.HostID, &b.ChatID, &b.Title, &b.Status,
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
		Title  string `json:"title"`
		ChatID string `json:"chatId"`
	}
	_ = httpx.Body(r, &body)

	title := strings.TrimSpace(body.Title)
	if len(title) > 200 {
		title = title[:200]
	}
	var chatID *string
	if c := strings.TrimSpace(body.ChatID); c != "" {
		chatID = &c
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

		var err2 error
		b, err2 = scanBroadcast(tx.QueryRow(ctx,
			`INSERT INTO broadcast_sessions (host_id, chat_id, title, status, room)
			 VALUES ($1, $2, $3, 'starting', $4)
			 RETURNING `+broadcastCols,
			uid, chatID, title, "bc_"+uid))
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
	cfg := livekit.ConfigFromEnv()
	if cfg.Configured() {
		egressID, e := livekit.StartHLS(ctx, cfg, b.Room, b.ID)
		if e != nil {
			metrics.Inc("broadcast_egress_failed")
			log.Printf("[broadcast] egress did not start for %s: %v", b.ID, e)
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
			b.HLSURL = &url
			metrics.Inc("broadcast_egress_started")
		}
	}

	metrics.Inc("broadcast_started")
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
		rows, err := tx.Query(ctx,
			`SELECT `+broadcastCols+`
			   FROM broadcast_sessions
			  WHERE status = 'live'
			  ORDER BY started_at DESC
			  LIMIT 100`)
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
	metrics.Inc("broadcast_live")
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

	cfg := livekit.ConfigFromEnv()
	if !cfg.Configured() {
		httpx.Err(w, 503, "Live streaming is not configured on this server")
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
	role := livekit.Role("audience")
	switch {
	case b.HostID == uid:
		role = livekit.Role("host")
	default:
		var accepted bool
		_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx,
				`SELECT TRUE FROM broadcast_invites
				  WHERE broadcast_id = $1 AND invitee_id = $2 AND seen_at IS NOT NULL`,
				id, uid).Scan(&accepted)
		})
		if accepted {
			role = livekit.Role("speaker")
		}
	}

	token, err := livekit.Mint(cfg, livekit.MintArgs{
		Identity: uid,
		Room:     b.Room,
		Role:     role,
	})
	if err != nil {
		httpx.Err(w, 503, "Could not issue a streaming credential")
		return
	}

	metrics.Inc("broadcast_token_" + string(role))
	httpx.JSON(w, 200, map[string]any{
		"token":    token,
		"url":      cfg.URL,
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
			`SELECT c.id, c.user_id::text, COALESCE(u.name, ''), c.message, c.created_at
			   FROM broadcast_chat c JOIN users u ON u.id = c.user_id
			  WHERE c.broadcast_id = $1 AND c.id > $2
			  ORDER BY c.id DESC LIMIT 100`, id, after)
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
		return tx.QueryRow(ctx,
			`INSERT INTO broadcast_chat (broadcast_id, user_id, message)
			 VALUES ($1, $2, $3) RETURNING id, created_at`, id, uid, msg).
			Scan(&m.ID, &m.CreatedAt)
	})
	if err != nil {
		httpx.Err(w, 409, "This broadcast is not accepting chat")
		return
	}
	m.UserID = uid
	m.Message = msg
	metrics.Inc("broadcast_chat_sent")
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
	if egressID != "" {
		if e := livekit.StopHLS(ctx, livekit.ConfigFromEnv(), egressID); e != nil {
			log.Printf("[broadcast] egress %s did not stop cleanly: %v", egressID, e)
			metrics.Inc("broadcast_egress_stop_failed")
		}
	}
	if err != nil || b == nil {
		// Idempotent by intent: ending an already-ended stream is not an error,
		// because the client retries this on a flaky network and a 500 would
		// leave the UI stuck on "ending…".
		httpx.JSON(w, 200, map[string]any{"ok": true, "alreadyEnded": true})
		return
	}
	metrics.Inc("broadcast_ended")
	httpx.JSON(w, 200, b)
}
