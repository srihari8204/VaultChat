// broadcast_social.go — invitations, likes and comments (migration 082).
//
// Split from broadcasts.go on purpose: that file owns the STREAM lifecycle
// (start, egress, end), which is where the expensive and dangerous operations
// live. This is the social layer around it, and mixing the two makes it easy to
// touch a transcoder while meaning to touch a like.
//
// RLS (082) is the authority on who may write. Every handler here also checks
// in Go, for the same reason call_sessions.go does: two independent gates, and
// the feature is correct if either holds.

package routes

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/metrics"
	"vaultchat/backend-go/internal/redisx"
)

func RegisterBroadcastSocial(mux *http.ServeMux) {
	mux.HandleFunc("POST /broadcasts/{id}/invite", httpx.RequireAuth(broadcastInvite))
	mux.HandleFunc("GET /broadcasts/invites", httpx.RequireAuth(broadcastMyInvites))
	mux.HandleFunc("POST /broadcasts/{id}/invite/accept", httpx.RequireAuth(broadcastInviteAccept))
	mux.HandleFunc("POST /broadcasts/{id}/like", httpx.RequireAuth(broadcastLike))
	mux.HandleFunc("DELETE /broadcasts/{id}/like", httpx.RequireAuth(broadcastUnlike))
	mux.HandleFunc("GET /broadcasts/{id}/comments", httpx.RequireAuth(broadcastComments))
	mux.HandleFunc("POST /broadcasts/{id}/comments", httpx.RequireAuth(broadcastComment))
	mux.HandleFunc("DELETE /broadcasts/{id}/comments/{cid}", httpx.RequireAuth(broadcastCommentDelete))
}

// ── invitations ───────────────────────────────────────────────────────

// POST /broadcasts/{id}/invite  { userIds: [...] }
//
// A broadcast is public to anyone holding the link; an invitation is how it
// REACHES someone. Sent in bulk because the natural gesture is "invite these
// five people", and five round trips would make the UI feel broken.
func broadcastInvite(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	var body struct {
		UserIDs []string `json:"userIds"`
	}
	_ = httpx.Body(r, &body)

	if len(body.UserIDs) == 0 {
		httpx.Err(w, 400, "userIds required")
		return
	}
	// Bounded so one request cannot notify the entire user table.
	if len(body.UserIDs) > 50 {
		body.UserIDs = body.UserIDs[:50]
	}
	// Spam control: invitations become notifications on someone else's device,
	// which is exactly the shape of abuse worth limiting.
	if rl := redisx.Consume(ctx, "bcinv:"+uid, 100, 3600); !rl.Allowed {
		w.Header().Set("Retry-After", strconv.FormatInt(rl.ResetInSec, 10))
		httpx.Err(w, 429, "Too many invitations. Try again later.")
		return
	}

	// WHO MAY INVITE DEPENDS ON VISIBILITY, and for a private stream this is an
	// authorization decision, not a courtesy.
	//
	// `broadcast_invites` is the ENTIRE audience table for a private broadcast:
	// goliveMayWatch, goliveAudienceSQL, the stream chat read and write gates and
	// the poll gates all resolve to a row in it. So an unchecked INSERT here is a
	// self-service grant. Two accounts could invite each other into any private
	// broadcast id and both would pass broadcastToken, receive a LiveKit token
	// for the host's private room, and — once accept() stamped seen_at —
	// goliveStageRole would return RoleSpeaker, i.e. publish rights. A stranger
	// could put their camera and microphone on someone else's private stage.
	//
	// Public stays open on purpose: the handler's premise is that a public
	// broadcast is reachable by anyone holding the link, so an invitation there
	// only delivers a notification about something already permitted. Narrowing
	// that would break sharing without protecting anything.
	//
	// Checked BEFORE the rate limiter's side effects matter and before any row
	// is written.
	var visibility, hostID string
	if err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT visibility, host_id FROM broadcast_sessions WHERE id = $1`,
			id).Scan(&visibility, &hostID)
	}); err != nil {
		// Deliberately the same answer as "not permitted" — a distinct 404 here
		// would confirm which broadcast ids exist.
		httpx.Err(w, 403, "Forbidden")
		return
	}
	// Unrecognised visibility denies rather than guesses, matching goliveMayWatch.
	if visibility != "public" && hostID != uid {
		httpx.Err(w, 403, "Forbidden")
		return
	}

	sent := 0
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		for _, invitee := range body.UserIDs {
			invitee = strings.TrimSpace(invitee)
			if invitee == "" || invitee == uid {
				continue // inviting yourself is a no-op, not an error
			}
			// ON CONFLICT: re-inviting is idempotent. Without it a user could be
			// notified repeatedly by someone tapping the same button.
			ct, e := tx.Exec(ctx,
				`INSERT INTO broadcast_invites (broadcast_id, inviter_id, invitee_id)
				 VALUES ($1, $2, $3) ON CONFLICT (broadcast_id, invitee_id) DO NOTHING`,
				id, uid, invitee)
			if e != nil {
				return e
			}
			if ct.RowsAffected() > 0 {
				sent++
			}
		}
		return nil
	})
	if err != nil {
		httpx.Err(w, 400, "Could not send invitations")
		return
	}

	// Live nudge for anyone currently connected. Best-effort: the row is the
	// durable record, this is only what makes it arrive now rather than on the
	// next fetch.
	emitx.ToUids(body.UserIDs, "broadcast_invite", map[string]any{"broadcastId": id, "from": uid})

	metrics.Inc("broadcast_invites_sent")
	httpx.JSON(w, 200, map[string]any{"sent": sent})
}

// GET /broadcasts/invites — live streams I have been invited to.
func broadcastMyInvites(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID

	out := []map[string]any{}
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// Only LIVE ones: an invitation to a finished stream is noise, and
		// clearing it would otherwise be a chore the user has to do by hand.
		rows, err := tx.Query(ctx,
			`SELECT i.id, i.broadcast_id::text, b.title, u.name, i.created_at
			   FROM broadcast_invites i
			   JOIN broadcast_sessions b ON b.id = i.broadcast_id
			   JOIN users u ON u.id = i.inviter_id
			  WHERE i.invitee_id = $1 AND b.status = 'live'
			  ORDER BY i.created_at DESC LIMIT 50`, uid)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var iid int64
			var bid, title, from string
			var at time.Time
			if err := rows.Scan(&iid, &bid, &title, &from, &at); err != nil {
				return err
			}
			out = append(out, map[string]any{
				"id": iid, "broadcastId": bid, "title": title, "from": from, "createdAt": at,
			})
		}
		return rows.Err()
	})
	httpx.JSON(w, 200, map[string]any{"invites": out})
}

// POST /broadcasts/{id}/invite/accept — become a co-host.
//
// Accepting is what ELEVATES a viewer's LiveKit token from subscribe-only to
// publish. The client must then reconnect to the room with a freshly minted
// token: LiveKit reads permissions at connect, so an already-connected
// participant cannot gain publish rights by asking nicely.
//
// seen_at doubles as "accepted". A separate status column would let the two
// disagree, and there is no third state a broadcast invitation needs — you are
// either publishing or you are watching.
func broadcastInviteAccept(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")

	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`UPDATE broadcast_invites SET seen_at = now()
			  WHERE broadcast_id = $1 AND invitee_id = $2`, id, uid)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err != nil {
		httpx.Err(w, 404, "You have not been invited to this broadcast")
		return
	}

	// Tell the host so their UI can show the guest arriving.
	emitx.ToRooms([]string{"broadcast:" + id}, "broadcast_cohost_joined",
		map[string]any{"broadcastId": id, "userId": uid})

	metrics.Inc("broadcast_invite_accepted")
	// The client must re-mint: publish rights are carried IN the token, so the
	// one it already holds is still subscribe-only.
	httpx.JSON(w, 200, map[string]any{"ok": true, "remintToken": true})
}

// ── likes ─────────────────────────────────────────────────────────────

// likeSetKey holds the set of users who have liked a broadcast.
//
// A SET, not a counter. Likes are idempotent — the same person tapping twice
// must not count twice — and a plain INCR cannot express that. It also makes the
// total recoverable: a counter that drifts is wrong forever, a set can always be
// re-counted.
func likeSetKey(broadcastID string) string { return "bcl:" + broadcastID }

// POST /broadcasts/{id}/like
//
// REDIS IS THE LIVE PATH, POSTGRES IS THE RECORD.
//
// The obvious implementation — INSERT then SELECT count(*) — puts two writes and
// an aggregate on the hot path of a gesture people repeat hundreds of times a
// second during a good moment in a stream. Worse, every one of them touches
// rows the same viewers are reading.
//
// So the count comes from a Redis set (O(1), idempotent by construction) and the
// durable row is written after the response is decided. If Redis is unavailable
// the code falls through to Postgres and is merely slower, not broken.
func broadcastLike(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")

	total := -1
	if redisx.Client != nil {
		k := likeSetKey(id)
		redisx.Client.SAdd(ctx, k, uid)
		// Likes outlive the stream in Postgres; the Redis copy only has to
		// survive the broadcast, so it expires rather than accumulating for
		// every stream ever made.
		redisx.Client.Expire(ctx, k, 24*time.Hour)
		if n, err := redisx.Client.SCard(ctx, k).Result(); err == nil {
			total = int(n)
		}
	}

	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx,
			`INSERT INTO broadcast_likes (broadcast_id, user_id) VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`, id, uid); e != nil {
			return e
		}
		if total >= 0 {
			return nil // Redis already answered
		}
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM broadcast_likes WHERE broadcast_id = $1`, id).Scan(&total)
	})
	if err != nil && total < 0 {
		httpx.Err(w, 400, "Could not like this broadcast")
		return
	}

	// Everyone watching sees the number move. Fire-and-forget: a like that does
	// not animate on someone else's screen is not worth failing the request for.
	emitx.ToRooms([]string{"broadcast:" + id}, "broadcast_like",
		map[string]any{"broadcastId": id, "likes": total, "userId": uid})

	metrics.Inc("broadcast_liked")
	httpx.JSON(w, 200, map[string]any{"likes": total, "liked": true})
}

// DELETE /broadcasts/{id}/like
func broadcastUnlike(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")

	total := -1
	if redisx.Client != nil {
		redisx.Client.SRem(ctx, likeSetKey(id), uid)
		if n, err := redisx.Client.SCard(ctx, likeSetKey(id)).Result(); err == nil {
			total = int(n)
		}
	}

	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx,
			`DELETE FROM broadcast_likes WHERE broadcast_id = $1 AND user_id = $2`, id, uid); e != nil {
			return e
		}
		if total >= 0 {
			return nil
		}
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM broadcast_likes WHERE broadcast_id = $1`, id).Scan(&total)
	})
	if err != nil && total < 0 {
		httpx.Err(w, 400, "Could not remove the like")
		return
	}

	emitx.ToRooms([]string{"broadcast:" + id}, "broadcast_like",
		map[string]any{"broadcastId": id, "likes": total, "userId": uid})

	httpx.JSON(w, 200, map[string]any{"likes": total, "liked": false})
}

// ── comments ──────────────────────────────────────────────────────────

// GET /broadcasts/{id}/comments?after=<id>
//
// Unlike chat, comments OUTLIVE the stream — so this works on an ended
// broadcast too, and deleted rows are filtered rather than removed.
func broadcastComments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)

	out := []broadcastMessage{}
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			// THE NAME THE AUDIENCE SEES, in the order the product means it.
			//
			// A private live asks each joiner what to be called and stores it on
			// their invite row (display_name, migration 108). That answer is
			// about THIS broadcast — someone joining a friend's private stream
			// may not want their account name on it — so it wins here.
			//
			// A public live asks nobody: there is no invite row, the LEFT JOIN
			// yields NULL, and the registered profile name is used. Which is the
			// whole rule: entered name for private, registered name for public,
			// one COALESCE rather than a branch in the client.
			//
			// The join is LEFT and on (broadcast, user) — the same key the invite
			// table is unique on — so a public comment cannot pick up a name from
			// some other broadcast the author was once invited to.
			`SELECT c.id, c.user_id::text,
			        COALESCE(NULLIF(i.display_name, ''), u.name, ''),
			        c.body, c.created_at
			   FROM broadcast_comments c
			   JOIN users u ON u.id = c.user_id
			   LEFT JOIN broadcast_invites i
			          ON i.broadcast_id = c.broadcast_id AND i.invitee_id = c.user_id
			  WHERE c.broadcast_id = $1 AND c.id > $2 AND c.deleted_at IS NULL
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
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	httpx.JSON(w, 200, map[string]any{"comments": out})
}

// POST /broadcasts/{id}/comments
func broadcastComment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	var body struct {
		Body string `json:"body"`
	}
	_ = httpx.Body(r, &body)

	text := strings.TrimSpace(body.Body)
	if text == "" {
		httpx.Err(w, 400, "body required")
		return
	}
	if len(text) > 1000 {
		text = text[:1000]
	}
	if rl := redisx.Consume(ctx, "bccom:"+uid, 30, 60); !rl.Allowed {
		w.Header().Set("Retry-After", strconv.FormatInt(rl.ResetInSec, 10))
		httpx.Err(w, 429, "Slow down")
		return
	}

	var m broadcastMessage
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`INSERT INTO broadcast_comments (broadcast_id, user_id, body)
			 VALUES ($1, $2, $3) RETURNING id, created_at`, id, uid, text).
			Scan(&m.ID, &m.CreatedAt)
	})
	if err != nil {
		httpx.Err(w, 400, "Could not post the comment")
		return
	}
	m.UserID = uid
	m.Message = text

	// Push to everyone watching rather than making each viewer poll for it. The
	// poll still exists as the catch-up path for someone who joined late or
	// missed a frame of the socket — this is what makes it feel live.
	emitx.ToRooms([]string{"broadcast:" + id}, "broadcast_comment", m)

	metrics.Inc("broadcast_comment_posted")
	httpx.JSON(w, 200, m)
}

// DELETE /broadcasts/{id}/comments/{cid}
//
// Soft delete. A removed comment stays auditable — moderation without a record
// of what was removed is not moderation, it is just deletion.
func broadcastCommentDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	cid, _ := strconv.ParseInt(r.PathValue("cid"), 10, 64)

	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// The RLS policy already restricts this to the author or the host; the
		// WHERE clause repeats it so the intent is visible where it is enforced.
		ct, e := tx.Exec(ctx,
			`UPDATE broadcast_comments c
			    SET deleted_at = now()
			  WHERE c.id = $1 AND c.deleted_at IS NULL
			    AND (c.user_id = $2
			         OR EXISTS (SELECT 1 FROM broadcast_sessions b
			                     WHERE b.id = c.broadcast_id AND b.host_id = $2))`, cid, uid)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return pgx.ErrNoRows
		}
		return nil
	})
	if err != nil {
		httpx.Err(w, 403, "You cannot remove that comment")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
