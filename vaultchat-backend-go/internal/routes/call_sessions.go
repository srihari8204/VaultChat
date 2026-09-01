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
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/fcm"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/livekit"
	"vaultchat/backend-go/internal/metrics"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/workx"
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
	mux.HandleFunc("POST /calls/{id}/ring", httpx.RequireAuth(callSessionRing))
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

// errCallFull is returned from inside the join transaction so the seat check
// shares the transaction that takes the seat, rather than racing beside it.
var errCallFull = errors.New("call is full")

// errNotAllowed is returned from inside the join transaction when the caller is
// neither a member of the chat nor invited to this specific call.
var errNotAllowed = errors.New("not allowed on this call")

// mayJoinCall answers "is this person allowed on this call at all".
//
// THIS EXISTS BECAUSE RLS DOES NOT RUN IN PRODUCTION.
//
// The join used to rely entirely on the `calls_insert WITH CHECK
// (vc_is_chat_member(chat_id))` policy from migration 066, and the comment here
// said so. But the API connects as role `vaultchat`, which is
// `superuser=true, bypassrls=true` — and a BYPASSRLS role ignores row-level
// security completely, FORCE ROW LEVEL SECURITY included. Verified against
// production. So that policy was enforcing NOTHING: any authenticated user who
// could name a chat id could open or join its call, receive an SFU token, and
// hear the conversation.
//
// Two ways in, and only two:
//   MEMBER   in chat_members for this chat, not left.
//   INVITED  someone already on the call vouched for them (call_invites).
//            That is what lets a 1:1 call gain a third person without adding
//            anyone to the chat — the invite is scoped to ONE call and dies
//            with it.
func mayJoinCall(ctx context.Context, tx pgx.Tx, uid, chatID, callID string) (bool, error) {
	var one int
	err := tx.QueryRow(ctx,
		`SELECT 1 WHERE EXISTS (
		     SELECT 1 FROM chat_members
		      WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL)
		   OR EXISTS (
		     SELECT 1 FROM call_invites
		      WHERE call_id = $3 AND invitee_id = $2)`, chatID, uid, callID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// The group ring shares the per-account ring budget with the per-`to`
// call_incoming relay in internal/realtime/handlers.go, and must therefore use
// the same key, limit and window. Restated here rather than exported from
// realtime: routes already imports realtime, but these are its constants, and a
// number this small is clearer duplicated with a note than reached across a
// package boundary for. If one moves, move both — the shared Redis key is what
// makes them one budget.
const (
	callRingLimit     = 120
	callRingWindowSec = 60
)

// callMaxParticipants is the product ceiling on ONE group call.
//
// WHY IT IS ENFORCED HERE AND NOT BY THE ROOM
//
// livekit.yaml has a max_participants, and it is the wrong instrument twice
// over. It counts every identity in the room, and it refuses by DISCONNECTING —
// which reaches the client as a transport failure indistinguishable from a bad
// network, so the user is told "call failed" when the truth is "the call is
// full". goliveMaxStage (internal/routes/golive.go) moved Go Live's cap out of
// livekit.yaml for the same reason; this is the calling half of that lesson.
// The room cap stays as a backstop, set above this number.
//
// And it is enforced at JOIN rather than at sfu-token, because THIS is where a
// seat is taken: call_participants gets the row here, and /sfu-token then
// requires an existing live row (myRole). Refusing at mint would refuse someone
// who is already occupying the seat they are being told they cannot have.
//
// 64 is the product target. CALL_MAX_PARTICIPANTS overrides it; values below 2
// are ignored, because a call needs two people.
func callMaxParticipants() int {
	if v, err := strconv.Atoi(os.Getenv("CALL_MAX_PARTICIPANTS")); err == nil && v >= 2 {
		return v
	}
	return 64
}

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
		// THE SEAT CHECK, in the same transaction as the seat.
		//
		// Counted EXCLUDING this user, so a rejoin can never be refused: someone
		// whose network dropped is already one of the 64 and must be able to
		// come back to the call they are still nominally on. Excluding them also
		// makes the check idempotent, which matters because clients retry.
		// AUTHORISE FIRST. See mayJoinCall — RLS is inert in prod, so this is the
		// only thing standing between an arbitrary account and someone's call.
		ok, e := mayJoinCall(ctx, tx, uid, c.ChatID, c.ID)
		if e != nil {
			return e
		}
		if !ok {
			return errNotAllowed
		}
		var live int
		if e := tx.QueryRow(ctx,
			`SELECT count(*) FROM call_participants
			  WHERE call_id = $1 AND left_at IS NULL AND user_id <> $2`, c.ID, uid).Scan(&live); e != nil {
			return e
		}
		if live >= callMaxParticipants() {
			return errCallFull
		}
		// Rejoining updates the existing row rather than adding a second, so
		// "was this user on this call, and for how long" keeps one answer.
		// The role is deliberately NOT reset — a participant promoted to
		// speaker who drops and comes back is still a speaker.
		_, e = tx.Exec(ctx,
			`INSERT INTO call_participants (call_id, user_id, role)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (call_id, user_id)
			 DO UPDATE SET left_at = NULL, joined_at = NOW()`, c.ID, uid, role)
		return e
	})
	if errors.Is(err, errNotAllowed) {
		metrics.Inc("call_join_refused")
		httpx.Err(w, 403, "You are not on this chat")
		return
	}
	if errors.Is(err, errCallFull) {
		// Every increment is a real person refused entry to a call in progress —
		// the same reason call_mesh_full is worth counting. A rising rate here is
		// the evidence for raising the ceiling, or for a different product shape.
		metrics.Inc("call_full")
		// 409, not 403: the caller is allowed on this call, there is simply no
		// room. The client tells them so instead of showing a permissions error.
		httpx.Err(w, 409, "This call is full")
		return
	}
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

	// THE SFU CREDENTIAL RIDES THE JOIN RESPONSE — one round trip, not two.
	//
	// The client used to await POST /calls, then await POST /calls/{id}/sfu-token
	// before it could even open the WebSocket. Measured on device (Hyderabad ->
	// Hetzner), those two sequential round trips cost 615 ms + 313 ms of a 3.6 s
	// tap-to-audio: ~26% of call setup spent waiting on HTTP, before any media
	// work began. The token is derived from the role we just wrote, so the
	// server already knows everything needed to mint it here.
	//
	// Additive and OPTIONAL: an older client ignores the field and still calls
	// /sfu-token, which is unchanged. A newer client against an older server
	// finds no field and falls back. Neither needs the other to ship first.
	resp := map[string]any{"call": c, "participants": people, "created": created}
	if cred := mintSfuCredential(ctx, uid, c.ID, role); cred != nil {
		resp["sfu"] = cred
	}
	httpx.JSON(w, 200, resp)
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
// mintSfuCredential builds the LiveKit join credential for one participant.
//
// SHARED BY /sfu-token AND THE JOIN RESPONSE, so a token issued at join is
// identical to one minted a moment later — same role source, same room naming,
// same bookkeeping. Two copies of this would be two places for the role rule to
// drift, and the role IS the permission (an audience token has canPublish=false).
//
// Returns nil when the SFU is unconfigured or minting fails. Callers that can
// still proceed (the join) simply omit the credential; /sfu-token turns it into
// an error, because for that endpoint it IS the answer.
func mintSfuCredential(ctx context.Context, uid, callID, role string) map[string]any {
	cfg := livekit.ConfigFromEnv()
	if !cfg.Configured() {
		metrics.Inc("call_sfu_unconfigured")
		return nil
	}
	name, _ := callerIdentity(ctx, uid)
	token, err := livekit.Mint(cfg, livekit.MintArgs{
		Identity: uid, Name: name,
		Room: livekit.RoomName(callID), Role: livekit.Role(role),
	})
	if err != nil {
		return nil
	}
	// calls.transport exists to record that this call actually became an SFU
	// call. Best-effort: a failed bookkeeping write must not cost a token.
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`UPDATE calls SET transport = 'sfu' WHERE id = $1 AND transport <> 'sfu'`, callID)
		return e
	})
	metrics.Inc("call_sfu_token_" + role)
	return map[string]any{
		"token": token, "url": cfg.URL, "room": livekit.RoomName(callID),
		"identity": uid, "role": role,
	}
}

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

	cred := mintSfuCredential(ctx, uid, c.ID, role)
	if cred == nil {
		// A non-zero rate here means clients are trying to use the SFU on a
		// server that has no keys — a deployment gap, not a user error.
		httpx.Err(w, 503, "Group calling at scale is not configured on this server")
		return
	}

	httpx.JSON(w, 200, cred)
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

// ── POST /calls/{id}/ring — ring a group into a call, socket AND push ──
//
// WHY THIS EXISTS AT ALL
//
// A group call used to ring by having the CLIENT loop and emit one
// `call_incoming` per member. Three things break at 64, and every one of them
// is silent:
//
//  1. NO WAKE-UP PUSH. `call_incoming` is a socket event, so it reaches only
//     devices with a live socket. A 1:1 call also POSTs /call/initiate, which
//     sends the high-priority FCM the native full-screen ringer listens for —
//     the group path never did. So a group call rang only the phones that
//     happened to be awake, which for 63 people is nearly none of them. This is
//     the single reason a 64-person call could not fill up.
//  2. THE RING BUDGET IS PER ACCOUNT. One unit per member meant a 63-member
//     ring spent 63 of 120, and the second call inside a minute was refused
//     member by member with nothing the caller could see.
//  3. THE RECIPIENT LIST CAME FROM THE CLIENT and was checked nowhere.
//
// So the whole fan-out is one request: the server resolves the members, emits
// the socket event, and pushes — for one unit of budget, whatever the size.
//
// `userIds` (optional) narrows it to named people, which is the in-call INVITE.
// Anyone named who is not a current member of the chat is dropped, so the
// invite cannot become a way to ring strangers.
func callSessionRing(w http.ResponseWriter, r *http.Request) {
	c, uid, ok := callLoad(w, r)
	if !ok {
		return
	}
	if c.EndedAt != nil {
		httpx.Err(w, 409, "This call has ended")
		return
	}
	ctx := r.Context()
	// Only someone ON the call may ring for it. Without this any chat member
	// could make everyone's phone ring for a call they are not part of.
	if _, on := myRole(ctx, uid, c.ID); !on {
		httpx.Err(w, 403, "You are not on this call")
		return
	}
	// ONE unit for the whole group. Same key and window as the per-`to` ring in
	// realtime/handlers.go, so the two paths cannot be combined to spend twice.
	// Consume fails OPEN, so a Redis outage degrades to ringing rather than
	// silence.
	if rl := redisx.Consume(ctx, "call:ring:"+uid, callRingLimit, callRingWindowSec); !rl.Allowed {
		metrics.Inc("call_ring_rate_limited")
		w.Header().Set("Retry-After", strconv.FormatInt(rl.ResetInSec, 10))
		httpx.Err(w, 429, "Ringing too fast. Wait a moment.")
		return
	}

	var b struct {
		UserIDs []string `json:"userIds"`
	}
	_ = httpx.Body(r, &b)

	targets := ringTargets(ctx, uid, c, b.UserIDs)

	// NAMED PEOPLE WHO ARE NOT IN THE CHAT: vouch for them, then ring them.
	//
	// This is what lets a 1:1 call gain a third participant. ringTargets only
	// ever returns chat MEMBERS, so anyone explicitly named who is not one is
	// missing from it — and without a grant they could not join even if rung,
	// because mayJoinCall would refuse them.
	//
	// The grant is the narrowest that works: scoped to THIS call, issued only by
	// someone already on it (we are past the myRole check above), and worth
	// nothing once the call ends. It gives no access to the chat, its history,
	// or any later call.
	if len(b.UserIDs) > 0 {
		known := map[string]bool{}
		for _, t := range targets {
			known[t] = true
		}
		var invited []string
		for _, u := range b.UserIDs {
			u = strings.TrimSpace(u)
			if u == "" || u == uid || known[u] {
				continue
			}
			invited = append(invited, u)
		}
		if len(invited) > 0 {
			_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
				for _, inv := range invited {
					if _, e := tx.Exec(ctx,
						`INSERT INTO call_invites (call_id, invitee_id, invited_by)
						 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, c.ID, inv, uid); e != nil {
						return e
					}
				}
				return nil
			})
			metrics.Add("call_invite_granted", uint64(len(invited)))
			targets = append(targets, invited...)
		}
	}

	if len(targets) == 0 {
		httpx.JSON(w, 200, map[string]any{"ok": true, "rang": 0})
		return
	}

	// SOCKET FIRST, and synchronously: a phone that is awake should ring now,
	// not after a round trip to Google.
	emitx.ToUids(targets, "call_incoming", map[string]any{
		"from": uid, "fromUid": uid, "chatId": c.ChatID,
		"group": true, "groupName": groupNameFor(ctx, uid, c.ChatID),
		"type": c.Kind, "video": map[bool]string{true: "1", false: "0"}[c.Kind == "video"],
	})

	// PUSH IN THE BACKGROUND. 63 FCM sends must not hold the caller's request
	// open — they are already in the call by the time this runs, and a slow push
	// tier would otherwise delay the UI that says the call started.
	_, dp := callerIdentity(ctx, uid)
	video := "false"
	if c.Kind == "video" {
		video = "true"
	}
	// THE GROUP IS THE HEADLINE, not the person who pressed call — the same
	// choice every other messenger makes, and the useful one on a lock screen:
	// "Family" tells you what to answer, "Ravi" does not say which of your
	// conversations it is about.
	title := groupNameFor(ctx, uid, c.ChatID)
	// callId carries the CHAT id, matching /call/initiate. The JS launch-intent
	// handler reads it as `chatId` (app/_layout.tsx), so sending the call
	// session's own UUID here would route the answer to a chat that does not
	// exist. The call is found from the chat — one live call per chat is a
	// database constraint.
	chatID := c.ChatID
	workx.Submit(func() { ringGroupPush(targets, chatID, uid, title, dp, video) })

	metrics.Add("call_ring_group_members", uint64(len(targets)))
	httpx.JSON(w, 200, map[string]any{"ok": true, "rang": len(targets)})
}

// ringTargets resolves WHO to ring: the named people if given, otherwise the
// chat's members. Either way the list comes from chat_members, never from the
// request, and never includes the caller.
func ringTargets(ctx context.Context, uid string, c *callSession, named []string) []string {
	// THE NAMED FILTER BELONGS IN THE QUERY, NOT AFTER IT.
	//
	// It used to LIMIT to the seat count and then drop non-named rows in Go,
	// which silently broke the invite in exactly the groups that need it: in a
	// 200-member chat the LIMIT returned the 63 oldest members, so inviting
	// anyone who joined after them matched nothing and rang NOBODY — while the
	// endpoint still answered ok. Filtering in SQL means the LIMIT applies to
	// the set we actually want.
	var want []string
	for _, u := range named {
		if u = strings.TrimSpace(u); u != "" {
			want = append(want, u)
		}
	}

	// LIMIT is the seat count, not the group size.
	//
	// A chat may hold far more people than a call can. Ringing all of them for a
	// 64-seat call wakes hundreds of phones — high-priority pushes that can
	// bypass Do Not Disturb — so that all but 63 can be told the call is full
	// when they answer. Ordered by joined_at so the set is STABLE: an unordered
	// LIMIT gives a different 63 people on every redial, which reads as the app
	// ringing at random. It still bounds a named invite, so an invite cannot be
	// used to ring a whole 500-member chat either.
	// AN EXPLICIT BOOLEAN, not a NULL test on the array.
	//
	// `$3::text[] IS NULL` would depend on the driver encoding a nil slice as
	// SQL NULL rather than an empty array `{}`. If it ever encoded `{}`, the
	// whole-group ring would match NOBODY and starting a call would silently
	// ring no one — the worst possible failure, resting on a driver detail. The
	// flag removes the question: `true OR <anything>` is true even when the
	// right side is NULL, so the unnamed case always selects every member.
	all := len(want) == 0
	var out []string
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT user_id::text FROM chat_members
			  WHERE chat_id = $1 AND left_at IS NULL AND user_id <> $2
			    AND ($3 OR user_id::text = ANY($4))
			  ORDER BY joined_at
			  LIMIT $5`, c.ChatID, uid, all, want, callMaxParticipants()-1)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var m string
			if rows.Scan(&m) != nil || m == "" {
				continue
			}
			out = append(out, m)
		}
		return rows.Err()
	})
	return out
}

// groupNameFor is what the callee's screen shows while it rings. Best effort:
// an unnamed group still rings, it just says "Group call".
func groupNameFor(ctx context.Context, uid, chatID string) string {
	var name *string
	_ = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT name FROM chats WHERE id = $1`, chatID).Scan(&name)
	})
	if name != nil && strings.TrimSpace(*name) != "" {
		return *name
	}
	return "Group call"
}

// ringGroupPush wakes every target that is not holding a live socket.
//
// type="incoming_call" is deliberate: it is the payload the native
// VaultCallMessagingService already handles, and that service is the only thing
// that can ring a killed app. Using any other type would fall through to the JS
// notifee layer, which is what produced two notifications for one call before.
//
// One push per callee, not one per ring repeat — the push only has to WAKE the
// device; once awake the socket delivers everything else.
func ringGroupPush(targets []string, chatID, from, name, dp, video string) {
	ctx := context.Background()
	for _, to := range targets {
		tokens := fcmTokensFor(ctx, to)
		if len(tokens) == 0 {
			continue
		}
		res := fcm.SendCallMessage(tokens, map[string]string{
			"type":       "incoming_call",
			"callId":     chatID,
			"chatId":     chatID,
			"callerId":   from,
			"callerName": name,
			// Read by VaultCallMessagingService: it is what stops the answer
			// button opening a ONE-TO-ONE call with whoever started the group.
			"isGroup":     "true",
			"callerDpUrl": dp,
			"isVideo":     video,
			"ts":          fmt.Sprintf("%d", time.Now().UnixMilli()),
		}, 30000)
		if len(res.Dead) > 0 {
			_, _ = db.Pool.Exec(ctx,
				`UPDATE devices SET fcm_token = NULL WHERE fcm_token = ANY($1::text[])`, res.Dead)
		}
	}
}
