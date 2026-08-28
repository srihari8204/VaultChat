// call_sessions.go — server-side call records and roles (migration 066).
//
// Separate from calls.go on purpose: that file is the FCM wake-up push, which
// rings a killed device and knows nothing about who is on a call. This is the
// durable record — which call, who joined, in what role, for how long.
//
// WHY THE SERVER NEEDS TO KNOW
// ---------------------------
// Until now `callId` was just the chatId, so a chat could only ever have had
// one call. There was nothing to attach a recording to, no way to ask who was
// on a given call, and history lived only on the device that made it.
//
// Roles are the other half, and they are why this lands before the SFU rather
// than with it: in Phase C a LiveKit grant is minted FROM the role, so an
// audience token is subscribe-only because this table says so. A role the
// client asserts is not a role.
//
// AUTHORIZATION IS ENFORCED HERE, NOT ONLY IN RLS
// -----------------------------------------------
// Every query runs through db.WithUser so the 066 policies apply, and those
// policies are written to hold on their own. But RLS is only in force if the
// tables are FORCE'd and the app role does not own them — see
// docs/RLS_ENFORCEMENT.md, which is an open question on this deployment. So
// every host-only action is ALSO checked in Go. Two independent gates, and the
// feature is correct if either holds.
package routes

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/livekit"
	"vaultchat/backend-go/internal/metrics"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/vault"
)

func RegisterCallSessions(mux *http.ServeMux) {
	// Note the path split: calls.go owns singular /call/* (the FCM wake-up),
	// this owns plural /calls/* (the session record). Distinct prefixes, so
	// neither shadows the other.
	mux.HandleFunc("POST /calls", httpx.RequireAuth(callSessionStart))
	// Registered before /calls/{id} — Go 1.22's mux prefers the more specific
	// pattern, but writing them in this order keeps that obvious to a reader.
	mux.HandleFunc("GET /calls/history", httpx.RequireAuth(callSessionHistory))
	mux.HandleFunc("GET /calls/{id}", httpx.RequireAuth(callSessionGet))
	mux.HandleFunc("POST /calls/{id}/leave", httpx.RequireAuth(callSessionLeave))
	mux.HandleFunc("POST /calls/{id}/end", httpx.RequireAuth(callSessionEnd))
	mux.HandleFunc("POST /calls/{id}/role", httpx.RequireAuth(callSessionRole))
	mux.HandleFunc("POST /calls/{id}/hand", httpx.RequireAuth(callSessionHand))
	mux.HandleFunc("POST /calls/{id}/sfu-token", httpx.RequireAuth(callSessionSfuToken))
}

// ── shapes ────────────────────────────────────────────────────────────

type callSession struct {
	ID        string        `json:"id"`
	ChatID    string        `json:"chatId"`
	StartedBy string        `json:"startedBy"`
	Kind      string        `json:"kind"`
	Transport string        `json:"transport"`
	Mode      string        `json:"mode"`
	StartedAt httpx.JSTime  `json:"startedAt"`
	EndedAt   *httpx.JSTime `json:"endedAt"`
	EndReason *string       `json:"endReason"`
}

type callParticipant struct {
	UserID       string        `json:"userId"`
	Name         string        `json:"name"`
	PhotoURL     *string       `json:"photoUrl"`
	Role         string        `json:"role"`
	JoinedAt     httpx.JSTime  `json:"joinedAt"`
	LeftAt       *httpx.JSTime `json:"leftAt"`
	HandRaisedAt *httpx.JSTime `json:"handRaisedAt"`
}

var callRoles = map[string]bool{"host": true, "cohost": true, "speaker": true, "audience": true}

// ── helpers ───────────────────────────────────────────────────────────

const callSelect = `SELECT id::text, chat_id::text, started_by::text, kind, transport, mode,
                           started_at, ended_at, end_reason
                    FROM calls WHERE id = $1`

func scanCall(row pgx.Row) (*callSession, error) {
	var c callSession
	var startedAt time.Time
	var endedAt *time.Time
	if err := row.Scan(&c.ID, &c.ChatID, &c.StartedBy, &c.Kind, &c.Transport, &c.Mode,
		&startedAt, &endedAt, &c.EndReason); err != nil {
		return nil, err
	}
	c.StartedAt = httpx.JSTime(startedAt)
	c.EndedAt = httpx.JST(endedAt)
	return &c, nil
}

// roster reads the participants of a call, joined to users for display.
// Includes people who have LEFT: a call's roster is its history, and the client
// decides whether to show a departed participant greyed out or not at all.
func roster(ctx context.Context, uid, callID string) ([]callParticipant, error) {
	out := []callParticipant{}
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// Names come from the CIPHERS — u.name is NULL for every vault-onboarded
		// account, which is what made a call roster a list of blanks. Same
		// resolution as callerIdentity and the chat member list.
		rows, err := tx.Query(ctx,
			`SELECT p.user_id::text,
			        u.first_name_cipher, u.last_name_cipher, u.email_cipher, u.name,
			        u.photo_url, p.role, p.joined_at, p.left_at, p.hand_raised_at
			   FROM call_participants p
			   JOIN users u ON u.id = p.user_id
			  WHERE p.call_id = $1
			  ORDER BY p.joined_at`, callID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var p callParticipant
			var joined time.Time
			var left, hand *time.Time
			var fnc, lnc, ec, legacyName *string
			if err := rows.Scan(&p.UserID, &fnc, &lnc, &ec, &legacyName, &p.PhotoURL,
				&p.Role, &joined, &left, &hand); err != nil {
				return err
			}
			if nm := vault.IdentityFromRow(fnc, lnc, ec, nil, nil, nil, legacyName, nil, nil, nil, nil).Name; nm != nil {
				p.Name = *nm
			}
			// Anonymous code chat, not yet mutually saved (migration 119). The
			// in-call roster is the fourth and last place a masked identity can
			// escape; the other three are the chat list, the member list and the
			// push notification that rings the phone.
			//
			// ponytail: one pair query per OTHER participant. That is a single
			// query for the 1:1 calls this can actually apply to — an anonymous
			// chat has exactly two people in it — and group rosters answer FALSE
			// on the first EXISTS. If group calls ever grow anonymous members,
			// batch this into one query keyed on uid.
			if p.UserID != uid && chatsAnonMaskedPair(ctx, uid, p.UserID) {
				p.Name = chatsAnonName
				p.PhotoURL = nil
			}
			p.JoinedAt = httpx.JSTime(joined)
			p.LeftAt = httpx.JST(left)
			p.HandRaisedAt = httpx.JST(hand)
			out = append(out, p)
		}
		return rows.Err()
	})
	return out, err
}

// myRole returns the caller's role on a call and whether they are on it at all.
// Reading it under RLS means a non-member gets "not on this call" rather than a
// leak, and it is the Go-side half of the two-gate authorization described in
// the file header.
func myRole(ctx context.Context, uid, callID string) (string, bool) {
	var role string
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT role FROM call_participants
			  WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL`, callID, uid).Scan(&role)
	})
	if err != nil {
		return "", false
	}
	return role, true
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// callLoad fetches a call the caller is allowed to see, or writes the error.
func callLoad(w http.ResponseWriter, r *http.Request) (*callSession, string, bool) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	callID := strings.TrimSpace(r.PathValue("id"))
	if callID == "" {
		httpx.Err(w, 400, "call id required")
		return nil, "", false
	}
	var c *callSession
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		var e error
		c, e = scanCall(tx.QueryRow(ctx, callSelect, callID))
		return e
	})
	if err != nil {
		// RLS makes "not yours" and "does not exist" the same no-rows result,
		// and 404 for both is the answer that leaks the least.
		httpx.Err(w, 404, "Call not found")
		return nil, "", false
	}
	return c, uid, true
}

// ── POST /calls — start the chat's call, or join the one already live ──
//
// One endpoint for both because "start" and "join" are the same intent from the
// client's side: be on this chat's call. Which one happens depends on a race
// the client cannot see, and making it choose would mean it sometimes chooses
// wrong. The unique partial index on (chat_id) WHERE ended_at IS NULL is what
// makes that safe: two simultaneous starts, one insert wins, the loser reads
// the winner's call and joins it.
// How many calls one account may START per minute.
//
// Call spam is cheap and loud: each attempt rings a device, wakes it from doze,
// and can bypass Do Not Disturb, so it is a more effective harassment vector
// than messaging and costs the sender nothing. There was no limit at all.
//
// 10/min is deliberately generous — a real user redialling a bad connection,
// or a group host re-ringing several people, must never hit it. It exists to
// stop automation, not to police impatience.
const (
	callStartLimit     = 10
	callStartWindowSec = 60
)

func callSessionStart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID

	// Keyed on the CALLER, not the IP: an abuser behind carrier NAT shares an
	// address with thousands of innocent users, and an account is what actually
	// gets banned. redisx.Consume fails OPEN, so a Redis outage degrades to
	// today's behaviour rather than blocking every call on the platform.
	if rl := redisx.Consume(ctx, "call:start:"+uid, callStartLimit, callStartWindowSec); !rl.Allowed {
		metrics.Inc("call_rate_limited")
		w.Header().Set("Retry-After", strconv.FormatInt(rl.ResetInSec, 10))
		httpx.Err(w, 429, "Too many calls. Wait a moment and try again.")
		return
	}
	var b struct {
		ChatID string `json:"chatId"`
		Kind   string `json:"kind"`
		Mode   string `json:"mode"`
	}
	_ = httpx.Body(r, &b)
	chatID := strings.TrimSpace(b.ChatID)
	if chatID == "" {
		httpx.Err(w, 400, "chatId required")
		return
	}
	kind := "audio"
	if b.Kind == "video" {
		kind = "video"
	}
	mode := "meeting"
	if b.Mode == "webinar" || b.Mode == "broadcast" {
		mode = b.Mode
	}

	var c *callSession
	created := false
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// Join the live call if there is one.
		var e error
		c, e = scanCall(tx.QueryRow(ctx,
			`SELECT id::text, chat_id::text, started_by::text, kind, transport, mode,
			        started_at, ended_at, end_reason
			   FROM calls WHERE chat_id = $1 AND ended_at IS NULL`, chatID))
		if e == nil {
			return nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		c, e = scanCall(tx.QueryRow(ctx,
			`INSERT INTO calls (chat_id, started_by, kind, mode)
			 VALUES ($1, $2, $3, $4)
			 RETURNING id::text, chat_id::text, started_by::text, kind, transport, mode,
			           started_at, ended_at, end_reason`, chatID, uid, kind, mode))
		if e != nil {
			return e
		}
		created = true
		return nil
	})
	// Lost the race: someone else's INSERT landed first. Re-read and join it —
	// that is the outcome the caller wanted anyway.
	if err != nil && isUniqueViolation(err) {
		created = false
		err = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
			var e error
			c, e = scanCall(tx.QueryRow(ctx,
				`SELECT id::text, chat_id::text, started_by::text, kind, transport, mode,
				        started_at, ended_at, end_reason
				   FROM calls WHERE chat_id = $1 AND ended_at IS NULL`, chatID))
			return e
		})
	}
	if err != nil || c == nil {
		// The RLS insert policy refuses a non-member, which is the same 403 the
		// membership check would produce.
		metrics.Inc("call_join_refused")
		httpx.Err(w, 403, "Cannot start a call in this chat")
		return
	}

	// The starter hosts; everyone else joins as a speaker in a meeting and as
	// audience in a webinar/broadcast, which is what those modes mean.
	role := "speaker"
	switch {
	case created:
		role = "host"
	case c.Mode != "meeting":
		role = "audience"
	}
	err = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// Rejoining updates the existing row rather than adding a second, so
		// "was this user on this call, and for how long" keeps one answer.
		// The role is deliberately NOT reset — a participant promoted to
		// speaker who drops and comes back is still a speaker.
		_, e := tx.Exec(ctx,
			`INSERT INTO call_participants (call_id, user_id, role)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (call_id, user_id)
			 DO UPDATE SET left_at = NULL, joined_at = NOW()`, c.ID, uid, role)
		return e
	})
	if err != nil {
		metrics.Inc("call_join_refused")
		httpx.Err(w, 403, "Cannot join this call")
		return
	}

	// Separate counters rather than one with a flag: "how many calls happen" and
	// "how many people are on them" are different questions, and a rate of joins
	// climbing while starts stay flat is a bigger group, not more calls.
	if created {
		metrics.Inc("call_started")
	} else {
		metrics.Inc("call_joined")
	}

	people, _ := roster(ctx, uid, c.ID)
	emitx.ChatEvent(c.ChatID, "call_session_joined", map[string]any{
		"callId": c.ID, "chatId": c.ChatID, "userId": uid, "role": role, "created": created,
	})
	httpx.JSON(w, 200, map[string]any{"call": c, "participants": people, "created": created})
}

// ── GET /calls/{id} ───────────────────────────────────────────────────
func callSessionGet(w http.ResponseWriter, r *http.Request) {
	c, uid, ok := callLoad(w, r)
	if !ok {
		return
	}
	people, err := roster(r.Context(), uid, c.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to read call")
		return
	}
	httpx.JSON(w, 200, map[string]any{"call": c, "participants": people})
}

// ── POST /calls/{id}/leave ────────────────────────────────────────────
//
// Idempotent, and deliberately not an error when you were never on the call:
// leaving is what a client does on teardown, including teardown paths that run
// after something already went wrong. Failing here would turn one problem into
// two.
//
// Ending the call when the last participant leaves is the server's job, not the
// client's — the client that would have done it is the one that just went away.
func callSessionLeave(w http.ResponseWriter, r *http.Request) {
	c, uid, ok := callLoad(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	remaining := 0
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx,
			`UPDATE call_participants SET left_at = NOW()
			  WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL`, c.ID, uid); e != nil {
			return e
		}
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM call_participants
			  WHERE call_id = $1 AND left_at IS NULL`, c.ID).Scan(&remaining)
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to leave call")
		return
	}

	emitx.ChatEvent(c.ChatID, "call_session_left", map[string]any{
		"callId": c.ID, "chatId": c.ChatID, "userId": uid, "remaining": remaining,
	})
	if remaining == 0 && c.EndedAt == nil {
		endCall(ctx, uid, c, "empty")
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "remaining": remaining})
}

// endCall closes a call and announces it. Safe to call twice — the WHERE clause
// makes the second one a no-op rather than moving ended_at.
func endCall(ctx context.Context, uid string, c *callSession, reason string) {
	durationSec := int64(time.Since(time.Time(c.StartedAt)).Seconds())
	if durationSec < 0 {
		durationSec = 0
	}
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx,
			`UPDATE calls SET ended_at = NOW(), end_reason = $2
			  WHERE id = $1 AND ended_at IS NULL`, c.ID, reason); e != nil {
			return e
		}
		// Anyone still marked present is stamped out too, so a crashed client
		// does not leave a participant who never left.
		_, e := tx.Exec(ctx,
			`UPDATE call_participants SET left_at = NOW()
			  WHERE call_id = $1 AND left_at IS NULL`, c.ID)
		return e
	})
	// Duration as a counter pair rather than a histogram: the shared bucket set
	// tops out at 10 s, tuned for request latency, and a call is minutes. A sum
	// and a count give a truthful mean; bucketing calls into "+Inf" would give a
	// graph that looks precise and says nothing.
	metrics.Inc("call_ended")
	metrics.Add("call_seconds_total", uint64(durationSec))
	emitx.ChatEvent(c.ChatID, "call_session_ended", map[string]any{
		"callId": c.ID, "chatId": c.ChatID, "reason": reason,
	})
}

// ── POST /calls/{id}/end — host only ──────────────────────────────────
func callSessionEnd(w http.ResponseWriter, r *http.Request) {
	c, uid, ok := callLoad(w, r)
	if !ok {
		return
	}
	// The already-ended check comes FIRST, and the order is load-bearing.
	// endCall() stamps every remaining participant out, so once a call is over
	// nobody is on it — including the host, whose role can then no longer be
	// read. Checking the role first therefore answered a retried end with 403
	// instead of "already done", and a retried end is the normal case: this is
	// exactly the request a client repeats when the first response is lost.
	//
	// Reporting it to any chat member leaks nothing — GET /calls/{id} already
	// tells them the same thing, and callLoad has established they may see it.
	if c.EndedAt != nil {
		httpx.JSON(w, 200, map[string]any{"ok": true, "alreadyEnded": true})
		return
	}
	// Only the host ends a live call for everyone. A cohost may promote and
	// demote but may not end the meeting — that asymmetry is the point.
	if role, on := myRole(r.Context(), uid, c.ID); !on || role != "host" {
		httpx.Err(w, 403, "Only the host can end this call")
		return
	}
	endCall(r.Context(), uid, c, "host_ended")
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── POST /calls/{id}/role — host or cohost ────────────────────────────
func callSessionRole(w http.ResponseWriter, r *http.Request) {
	c, uid, ok := callLoad(w, r)
	if !ok {
		return
	}
	var b struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
	}
	_ = httpx.Body(r, &b)
	target := strings.TrimSpace(b.UserID)
	if target == "" || !callRoles[b.Role] {
		httpx.Err(w, 400, "userId and a valid role required")
		return
	}
	ctx := r.Context()
	mine, on := myRole(ctx, uid, c.ID)
	if !on || (mine != "host" && mine != "cohost") {
		httpx.Err(w, 403, "Only a host or cohost can change roles")
		return
	}
	// One host. Handing the role over is a separate action (not built yet), and
	// silently minting a second host from a promote would make "who can end this
	// call" ambiguous at exactly the wrong moment.
	if b.Role == "host" {
		httpx.Err(w, 400, "A call has one host; transfer is not supported yet")
		return
	}
	// A cohost cannot demote the host, and cannot demote a peer cohost either —
	// otherwise two cohosts can demote each other and the room's moderation
	// depends on who tapped first.
	if mine == "cohost" {
		if targetRole, tOn := myRole(ctx, target, c.ID); tOn && (targetRole == "host" || targetRole == "cohost") {
			httpx.Err(w, 403, "A cohost cannot change another host or cohost")
			return
		}
	}
	if target == uid {
		httpx.Err(w, 400, "You cannot change your own role")
		return
	}

	tag := 0
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// Promoting answers the raised hand, so it comes down in the same
		// statement. Leaving it up means the host grants the request and the
		// queue still shows it pending — and the person who was just given the
		// floor is the least likely to think about lowering it.
		ct, e := tx.Exec(ctx,
			`UPDATE call_participants
			    SET role = $3,
			        hand_raised_at = CASE WHEN $3 IN ('speaker','cohost') THEN NULL ELSE hand_raised_at END
			  WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL`, c.ID, target, b.Role)
		if e != nil {
			return e
		}
		tag = int(ct.RowsAffected())
		return nil
	})
	if err != nil {
		httpx.Err(w, 403, "Cannot change that role")
		return
	}
	if tag == 0 {
		httpx.Err(w, 404, "That participant is not on this call")
		return
	}

	emitx.ChatEvent(c.ChatID, "call_role_changed", map[string]any{
		"callId": c.ID, "chatId": c.ChatID, "userId": target, "role": b.Role, "by": uid,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true, "userId": target, "role": b.Role})
}

// ── POST /calls/{id}/hand — raise or lower your own hand ──────────────
//
// Stored as a TIMESTAMP rather than a boolean, so the host's list orders by who
// asked first. That is the fair reading of a raised hand, and a boolean cannot
// express it — with a boolean the order is whatever the roster happens to
// return, which quietly favours whoever joined earliest.
//
// Lowering someone ELSE's hand is a host action and deliberately allowed: after
// promoting a speaker the host needs the queue to clear, and the alternative is
// a stuck hand nobody can put down. The RLS policy permits it for host/cohost
// and the Go check mirrors that.
func callSessionHand(w http.ResponseWriter, r *http.Request) {
	c, uid, ok := callLoad(w, r)
	if !ok {
		return
	}
	var b struct {
		Raised bool   `json:"raised"`
		UserID string `json:"userId"`
	}
	_ = httpx.Body(r, &b)

	ctx := r.Context()
	target := strings.TrimSpace(b.UserID)
	if target == "" {
		target = uid
	}
	if target != uid {
		if b.Raised {
			httpx.Err(w, 403, "You can only raise your own hand")
			return
		}
		if mine, on := myRole(ctx, uid, c.ID); !on || (mine != "host" && mine != "cohost") {
			httpx.Err(w, 403, "Only a host or cohost can lower another hand")
			return
		}
	}

	affected := 0
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		var at any
		if b.Raised {
			at = time.Now()
		}
		ct, e := tx.Exec(ctx,
			`UPDATE call_participants SET hand_raised_at = $3
			  WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL`, c.ID, target, at)
		if e != nil {
			return e
		}
		affected = int(ct.RowsAffected())
		return nil
	})
	if err != nil {
		httpx.Err(w, 403, "Cannot change that hand")
		return
	}
	if affected == 0 {
		httpx.Err(w, 404, "That participant is not on this call")
		return
	}

	emitx.ChatEvent(c.ChatID, "call_hand_changed", map[string]any{
		"callId": c.ID, "chatId": c.ChatID, "userId": target, "raised": b.Raised, "by": uid,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true, "userId": target, "raised": b.Raised})
}

// ── POST /calls/{id}/sfu-token — a scoped LiveKit join credential ─────
//
// The role in call_participants becomes a media-server permission here, and
// this is the only place that translation happens. An audience member receives
// a token with canPublish=false and an empty publish-source list, so their
// camera and microphone are refused by the SFU itself — not hidden by the UI.
// That is the difference between a convention and a guarantee, and it is why
// roles were built (B1/B2) before the SFU rather than alongside it.
//
// Read the role FRESH on every mint rather than trusting anything the client
// sends: a participant demoted a second ago must not be able to present a token
// minted while they were still a speaker. Tokens are short-lived
// (livekit.DefaultTTL) for the same reason.
//
// Works with no cluster provisioned — minting is offline signing. Without keys
// it answers 503 with a reason rather than a token nothing would accept.
func callSessionSfuToken(w http.ResponseWriter, r *http.Request) {
	c, uid, ok := callLoad(w, r)
	if !ok {
		return
	}
	if c.EndedAt != nil {
		httpx.Err(w, 409, "This call has ended")
		return
	}
	ctx := r.Context()

	// Must be a LIVE participant. myRole requires left_at IS NULL, so someone
	// who left cannot mint their way back in without rejoining through POST
	// /calls, which is where membership is actually checked.
	role, on := myRole(ctx, uid, c.ID)
	if !on {
		httpx.Err(w, 403, "You are not on this call")
		return
	}

	cfg := livekit.ConfigFromEnv()
	if !cfg.Configured() {
		// Worth counting: a non-zero rate here means clients are trying to use
		// the SFU on a server that has no keys, which is a deployment gap rather
		// than a user error.
		metrics.Inc("call_sfu_unconfigured")
		httpx.Err(w, 503, "Group calling at scale is not configured on this server")
		return
	}

	name, _ := callerIdentity(ctx, uid)
	token, err := livekit.Mint(cfg, livekit.MintArgs{
		Identity: uid,
		Name:     name,
		Room:     livekit.RoomName(c.ID),
		Role:     livekit.Role(role),
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to issue a call token")
		return
	}

	// Record that this call actually became an SFU call. calls.transport exists
	// for exactly this, and stamping it at the first mint means a mixed-fleet
	// period stays legible afterwards instead of being guesswork. Best-effort:
	// a failed bookkeeping write must not cost the caller their token.
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`UPDATE calls SET transport = 'sfu' WHERE id = $1 AND transport <> 'sfu'`, c.ID)
		return e
	})

	metrics.Inc("call_sfu_token_" + role)
	httpx.JSON(w, 200, map[string]any{
		"token": token,
		"url":   cfg.URL,
		"room":  livekit.RoomName(c.ID),
		// Echoed so the client can render the right controls without re-deriving
		// the role — and so a demotion that happened between joining and minting
		// is visible immediately rather than at the next roster event.
		"identity": uid,
		"role":     role,
	})
}

// ── GET /calls/history ────────────────────────────────────────────────
//
// Every call this user was on, newest first, across all their devices. This is
// what replaces "history exists only on the handset that made the call, capped
// at 300 entries, gone on reinstall" — the client merges it with its local log
// (B3) rather than being replaced by it, so an offline device still shows its
// own calls.
func callSessionHistory(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	limit := int64(100)
	if n, ok := httpx.ParseIntPrefix(r.URL.Query().Get("limit")); ok && n > 0 && n <= 500 {
		limit = n
	}

	type entry struct {
		CallID    string        `json:"callId"`
		ChatID    string        `json:"chatId"`
		Kind      string        `json:"kind"`
		Mode      string        `json:"mode"`
		Role      string        `json:"role"`
		StartedBy string        `json:"startedBy"`
		StartedAt httpx.JSTime  `json:"startedAt"`
		EndedAt   *httpx.JSTime `json:"endedAt"`
		JoinedAt  httpx.JSTime  `json:"joinedAt"`
		LeftAt    *httpx.JSTime `json:"leftAt"`
		// Seconds this user was actually on the call — not the call's length.
		// They are different numbers for anyone who joined late or left early,
		// and the one a user's own history should show is theirs.
		DurationSec int `json:"durationSec"`
	}
	out := []entry{}
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT c.id::text, c.chat_id::text, c.kind, c.mode, p.role, c.started_by::text,
			        c.started_at, c.ended_at, p.joined_at, p.left_at,
			        GREATEST(0, EXTRACT(EPOCH FROM
			          (COALESCE(p.left_at, c.ended_at, NOW()) - p.joined_at)))::int
			   FROM call_participants p
			   JOIN calls c ON c.id = p.call_id
			  WHERE p.user_id = $1
			  ORDER BY p.joined_at DESC
			  LIMIT $2`, uid, limit)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var it entry
			var started, joined time.Time
			var ended, left *time.Time
			if e := rows.Scan(&it.CallID, &it.ChatID, &it.Kind, &it.Mode, &it.Role, &it.StartedBy,
				&started, &ended, &joined, &left, &it.DurationSec); e != nil {
				return e
			}
			it.StartedAt = httpx.JSTime(started)
			it.EndedAt = httpx.JST(ended)
			it.JoinedAt = httpx.JSTime(joined)
			it.LeftAt = httpx.JST(left)
			out = append(out, it)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to read call history")
		return
	}
	httpx.JSON(w, 200, map[string]any{"calls": out})
}
