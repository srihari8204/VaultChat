// golive_polls.go — polls on a Go Live broadcast (migration 106).
//
// THE SHAPE OF THE PROBLEM
// ------------------------
// The stage is capped at 20; the AUDIENCE is not capped at all. A poll is the
// one thing every one of those unbounded viewers writes to, and they all write
// in the same few seconds — the host says "vote now" and ten thousand phones
// answer at once. Then every one of them reads the result.
//
// So this follows the same split the viewer count and the like count already
// use in this codebase, for the same reason:
//
//	Redis     the live tally. A SET PER OPTION, so a count is SCARD — O(1),
//	          idempotent by construction, and it can never drift because a set
//	          only grows.
//	Postgres  the durable record. One row per (poll, voter), written after the
//	          answer is decided, so an aggregate is never on the hot path.
//
// If Redis is down the code falls through to a Postgres GROUP BY and is merely
// slower, not broken — the same degradation broadcastLike accepts.
//
// WHY A VOTE IS FINAL
// -------------------
// There is no "change my vote". That is not a simplification for its own sake:
// a mutable vote means the Redis sets must be able to SHRINK, and a set that can
// shrink can disagree with Postgres after a partial failure. Immutable votes
// make the fast path and the durable path incapable of contradicting each other.
package routes

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

func RegisterGoLivePolls(mux *http.ServeMux) {
	mux.HandleFunc("POST /broadcasts/{id}/polls", httpx.RequireAuth(golivePollCreate))
	mux.HandleFunc("GET /broadcasts/{id}/polls", httpx.RequireAuth(golivePollList))
	mux.HandleFunc("POST /broadcasts/{id}/polls/{pid}/vote", httpx.RequireAuth(golivePollVote))
	mux.HandleFunc("POST /broadcasts/{id}/polls/{pid}/close", httpx.RequireAuth(golivePollClose))
}

const (
	pollMaxQuestion = 200
	pollMaxOption   = 100
	pollMinOptions  = 2
	pollMaxOptions  = 10
)

type golivePoll struct {
	ID       int64    `json:"id"`
	Question string   `json:"question"`
	Options  []string `json:"options"`
	// Votes per option, positionally aligned with Options.
	Counts []int `json:"counts"`
	Total  int   `json:"total"`
	// The caller's own choice, or -1 if they have not voted. Lets the UI show
	// "you picked this" without a second request.
	MyVote    int       `json:"myVote"`
	Closed    bool      `json:"closed"`
	CreatedAt time.Time `json:"createdAt"`
}

// Redis keys. Two per poll:
//
//	bcp:<id>:voters   everyone who has answered — SADD returns 0 on a repeat,
//	                  which is how a double tap is rejected in ONE round trip
//	                  rather than ten SISMEMBERs across the option sets.
//	bcp:<id>:<idx>    who chose option idx. SCARD is the tally.
func pollVotersKey(pollID int64) string {
	return "bcp:" + strconv.FormatInt(pollID, 10) + ":voters"
}
func pollOptionKey(pollID int64, idx int) string {
	return "bcp:" + strconv.FormatInt(pollID, 10) + ":" + strconv.Itoa(idx)
}

// Polls outlive the stream in Postgres; the Redis copy only has to survive the
// broadcast, so it expires rather than accumulating for every poll ever run.
const pollRedisTTL = 24 * time.Hour

// POST /broadcasts/{id}/polls — the host asks a question.
func golivePollCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")

	var body struct {
		Question string   `json:"question"`
		Options  []string `json:"options"`
	}
	_ = httpx.Body(r, &body)

	q := strings.TrimSpace(body.Question)
	if q == "" {
		httpx.Err(w, 400, "A poll needs a question")
		return
	}
	if len(q) > pollMaxQuestion {
		q = q[:pollMaxQuestion]
	}

	opts := make([]string, 0, len(body.Options))
	for _, o := range body.Options {
		o = strings.TrimSpace(o)
		if o == "" {
			continue // a blank option is a typo, not a choice
		}
		if len(o) > pollMaxOption {
			o = o[:pollMaxOption]
		}
		opts = append(opts, o)
		if len(opts) == pollMaxOptions {
			break
		}
	}
	if len(opts) < pollMinOptions {
		httpx.Err(w, 400, "A poll needs at least two options")
		return
	}

	// ONLY THE HOST. Checked in Go as well as by the 106 RLS policy, because
	// this deployment's database role can bypass policies — same two-gate rule
	// as broadcastSetHLS. A poll on someone else's stream would appear to the
	// whole audience as if the host had asked it.
	var hostID string
	if err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT host_id::text FROM broadcast_sessions WHERE id = $1`, id).Scan(&hostID)
	}); err != nil {
		httpx.Err(w, 404, "Broadcast not found")
		return
	}
	if hostID != uid {
		goliveLog("POLL_DENIED", id, "", uid, "reason=not_host")
		httpx.Err(w, 403, "Only the host can start a poll")
		return
	}

	var p golivePoll
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`INSERT INTO broadcast_polls (broadcast_id, question, options)
			 VALUES ($1, $2, $3)
			 RETURNING id, question, options, created_at`,
			id, q, opts).Scan(&p.ID, &p.Question, &p.Options, &p.CreatedAt)
	})
	if err != nil {
		goliveLog("POLL_CREATE_FAILED", id, "", uid, "error="+err.Error())
		httpx.Err(w, 500, "Could not start the poll")
		return
	}
	p.Counts = make([]int, len(p.Options))
	p.MyVote = -1

	// Everyone watching sees it appear without waiting for their next poll of
	// the list. Fire-and-forget: a poll that arrives on the next refresh instead
	// of instantly is not worth failing the request for.
	emitx.ToRooms([]string{"broadcast:" + id}, "golive_poll_created",
		map[string]any{"broadcastId": id, "poll": p})

	goliveMetric("poll_created")
	goliveLog("POLL_CREATED", id, "", uid, "poll_id="+strconv.FormatInt(p.ID, 10),
		"options="+strconv.Itoa(len(p.Options)))
	httpx.JSON(w, 200, p)
}

// GET /broadcasts/{id}/polls — every poll on this broadcast, with live tallies.
func golivePollList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")

	// The audience gate, before anything is read: a private stream's polls are
	// not public just because polls are a lighter object than video.
	if !goliveMayWatchID(ctx, uid, id) {
		httpx.Err(w, 404, "Broadcast not found")
		return
	}

	out := []golivePoll{}
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// The caller's own vote comes back in the same statement — a second
		// round trip per poll would be one more query per viewer per refresh on
		// a path an unbounded audience polls.
		rows, e := tx.Query(ctx,
			`SELECT p.id, p.question, p.options, p.closed_at IS NOT NULL, p.created_at,
			        COALESCE(v.option_idx, -1)
			   FROM broadcast_polls p
			   LEFT JOIN broadcast_poll_votes v
			          ON v.poll_id = p.id AND v.user_id = $2
			  WHERE p.broadcast_id = $1
			  ORDER BY p.id DESC
			  LIMIT 50`, id, uid)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var p golivePoll
			var my int16
			if e := rows.Scan(&p.ID, &p.Question, &p.Options, &p.Closed, &p.CreatedAt, &my); e != nil {
				return e
			}
			p.MyVote = int(my)
			out = append(out, p)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Err(w, 500, "Could not load the polls")
		return
	}

	for i := range out {
		out[i].Counts, out[i].Total = golivePollTally(ctx, uid, &out[i])
	}
	httpx.JSON(w, 200, map[string]any{"polls": out})
}

// golivePollTally reads the per-option counts, Redis first.
//
// Postgres is the fallback and NOT the normal path: a GROUP BY per poll per
// viewer per refresh is exactly the aggregate this design exists to keep off the
// hot path. It runs when Redis is unavailable, or for an old poll whose Redis
// keys have expired — in which case the durable rows are the only source left,
// which is what they are for.
func golivePollTally(ctx context.Context, uid string, p *golivePoll) ([]int, int) {
	counts := make([]int, len(p.Options))
	total := 0

	if redisx.Client != nil {
		ok := true
		for i := range p.Options {
			n, err := redisx.Client.SCard(ctx, pollOptionKey(p.ID, i)).Result()
			if err != nil {
				ok = false
				break
			}
			counts[i] = int(n)
			total += counts[i]
		}
		// total > 0 guards the case that matters: an expired or never-populated
		// Redis key set answers "0 votes" perfectly happily, and reporting that
		// for a poll with real rows behind it would silently erase the result.
		if ok && total > 0 {
			return counts, total
		}
		counts = make([]int, len(p.Options))
		total = 0
	}

	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT option_idx, count(*) FROM broadcast_poll_votes
			  WHERE poll_id = $1 GROUP BY option_idx`, p.ID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var idx int16
			var n int
			if e := rows.Scan(&idx, &n); e != nil {
				return e
			}
			if int(idx) < len(counts) {
				counts[idx] = n
				total += n
			}
		}
		return rows.Err()
	})
	return counts, total
}

// POST /broadcasts/{id}/polls/{pid}/vote
func golivePollVote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	pollID, convErr := strconv.ParseInt(r.PathValue("pid"), 10, 64)
	if convErr != nil {
		httpx.Err(w, 400, "Unknown poll")
		return
	}

	var body struct {
		Option int `json:"option"`
	}
	_ = httpx.Body(r, &body)

	// UNLIMITED VOTERS, but only people who may WATCH. Deliberately not the
	// stage check: answering a poll is what the unbounded audience is for.
	if !goliveMayWatchID(ctx, uid, id) {
		httpx.Err(w, 404, "Broadcast not found")
		return
	}

	// Read the poll to validate the option against its real length and confirm
	// it is still open and belongs to THIS broadcast — without that last check a
	// poll id from another stream could be voted on through this path.
	var options []string
	var closed bool
	if err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT options, closed_at IS NOT NULL FROM broadcast_polls
			  WHERE id = $1 AND broadcast_id = $2`, pollID, id).Scan(&options, &closed)
	}); err != nil {
		httpx.Err(w, 404, "Unknown poll")
		return
	}
	if closed {
		httpx.Err(w, 409, "This poll is closed")
		return
	}
	if body.Option < 0 || body.Option >= len(options) {
		httpx.Err(w, 400, "That is not one of the options")
		return
	}

	// ONE ROUND TRIP TO REJECT A REPEAT. SADD returns the number of NEW members,
	// so 0 means this person already voted — no read-then-write race, and no
	// scan across the option sets.
	first := true
	if redisx.Client != nil {
		n, err := redisx.Client.SAdd(ctx, pollVotersKey(pollID), uid).Result()
		if err == nil {
			first = n > 0
			redisx.Client.Expire(ctx, pollVotersKey(pollID), pollRedisTTL)
		}
	}
	if !first {
		httpx.Err(w, 409, "You have already voted")
		return
	}

	// The durable record. ON CONFLICT DO NOTHING makes Postgres agree with the
	// Redis verdict even if Redis was unavailable and `first` defaulted true —
	// the primary key is the real authority on "one vote per person".
	var inserted bool
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`INSERT INTO broadcast_poll_votes (poll_id, user_id, option_idx)
			 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, pollID, uid, body.Option)
		if e != nil {
			return e
		}
		inserted = ct.RowsAffected() > 0
		return nil
	})
	if err != nil {
		// Undo the Redis claim, or this person can never vote again: the voters
		// set would say they had, while no row exists to prove what they chose.
		if redisx.Client != nil {
			redisx.Client.SRem(ctx, pollVotersKey(pollID), uid)
		}
		httpx.Err(w, 409, "Could not record your vote")
		return
	}
	if !inserted {
		httpx.Err(w, 409, "You have already voted")
		return
	}

	if redisx.Client != nil {
		k := pollOptionKey(pollID, body.Option)
		redisx.Client.SAdd(ctx, k, uid)
		redisx.Client.Expire(ctx, k, pollRedisTTL)
	}

	p := golivePoll{ID: pollID, Options: options, MyVote: body.Option}
	p.Counts, p.Total = golivePollTally(ctx, uid, &p)

	// Everyone watching sees the bars move.
	emitx.ToRooms([]string{"broadcast:" + id}, "golive_poll_vote",
		map[string]any{"broadcastId": id, "pollId": pollID,
			"counts": p.Counts, "total": p.Total})

	goliveMetric("poll_voted")
	httpx.JSON(w, 200, map[string]any{
		"pollId": pollID, "myVote": body.Option, "counts": p.Counts, "total": p.Total,
	})
}

// POST /broadcasts/{id}/polls/{pid}/close — stop taking answers.
func golivePollClose(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	pollID, convErr := strconv.ParseInt(r.PathValue("pid"), 10, 64)
	if convErr != nil {
		httpx.Err(w, 400, "Unknown poll")
		return
	}

	// host_id in the WHERE, so a non-host closes nothing. Same construction as
	// broadcastEnd: the clause IS the authorization, and it holds whether or not
	// RLS is in force.
	var closed bool
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`UPDATE broadcast_polls p
			    SET closed_at = now()
			  WHERE p.id = $1 AND p.broadcast_id = $2 AND p.closed_at IS NULL
			    AND EXISTS (SELECT 1 FROM broadcast_sessions b
			                 WHERE b.id = p.broadcast_id AND b.host_id = $3)
			 RETURNING TRUE`, pollID, id, uid).Scan(&closed)
	})
	if err != nil || !closed {
		// Idempotent: closing an already-closed poll is not an error, for the
		// same reason ending an already-ended broadcast is not.
		httpx.JSON(w, 200, map[string]any{"ok": true, "alreadyClosed": true})
		return
	}

	emitx.ToRooms([]string{"broadcast:" + id}, "golive_poll_closed",
		map[string]any{"broadcastId": id, "pollId": pollID})
	goliveMetric("poll_closed")
	goliveLog("POLL_CLOSED", id, "", uid, "poll_id="+strconv.FormatInt(pollID, 10))
	httpx.JSON(w, 200, map[string]any{"ok": true, "pollId": pollID})
}
