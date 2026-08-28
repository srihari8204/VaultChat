// chat_codes.go — start a chat with someone whose number you do not have
// (migration 118).
//
// THE FLOW THIS EXISTS FOR
// ------------------------
// Every other way into a direct chat needs a userId, an email or a phone
// number, which all mean you already know the person. A code is the missing
// handle: you read six digits across a table, they type them in, and you are
// talking — with no number, no address book entry and no invitation to accept.
//
// SIX DIGITS, AND WHAT PAYS FOR THEM
// ----------------------------------
// A million combinations is not much. The reason this is not a hole is that a
// guess is only ever tested against the codes that are LIVE AT THAT MOMENT, and
// a code lives for chatCodeLife — two minutes. The pool a guesser shoots at is
// whatever was minted in the last two minutes.
//
// Three things hold that up and they move together:
//
//   * chat_codes_live_code_idx, so no two live codes share six digits and one
//     guess can hit at most one person.
//   * chatCodeSweep, which retires expired rows BEFORE minting — an expired row
//     still reads as live to that index, so without the sweep the digit space
//     fills and minting starts failing.
//   * The three rate limits in chatCodeJoin. At this entropy they are the
//     defence, not a formality.
//
// Raising chatCodeLife grows the live pool in proportion. Do not touch it
// without revisiting all three.
//
// WHAT REDEEMING GRANTS — AND WHAT IT DOES NOT
// --------------------------------------------
// An ORDINARY direct chat, opened through directChatEnsure, which is the same
// function POST /chats uses. Same rows, same block check, same E2E key
// exchange. This file adds no authorization path of its own, so it cannot drift
// from the one the normal route uses, and someone who blocked you still cannot
// be reached with a code.
//
// It also does NOT hand over a key. Nothing here touches message crypto: a code
// decides WHO may open a chat, never what can be read inside one.
package routes

import (
	"context"
	"crypto/rand"
	"log"
	"math"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

func RegisterChatCodes(mux *http.ServeMux) {
	mux.HandleFunc("POST /chat-codes", httpx.RequireAuth(chatCodeCreate))
	mux.HandleFunc("GET /chat-codes", httpx.RequireAuth(chatCodeGet))
	mux.HandleFunc("DELETE /chat-codes", httpx.RequireAuth(chatCodeRevoke))
	// Redeeming is keyed by the CODE, not by an id — the holder does not know
	// whose code it is, which is the point.
	mux.HandleFunc("POST /chat-codes/{code}/join", httpx.RequireAuth(chatCodeJoin))
}

const chatCodeLen = 6

// Two minutes: long enough to read six digits to someone and watch them type,
// short enough that the live pool a guesser is shooting at stays tiny. This
// constant IS the security argument — see the header before changing it.
const chatCodeLife = 2 * time.Minute

// How many fresh digits to try before giving up. A collision needs another live
// code to already hold the same six digits, which at a two-minute life is
// vanishingly rare; five attempts is there so a freak run fails loudly instead
// of looping.
const chatCodeMintTries = 5

// newChatCode mints six digits, leading zeros included.
//
// crypto/rand via Int, not a per-digit byte trick: 10 does not divide 256, so
// taking bytes modulo 10 would make the low digits measurably more likely — a
// bias that matters far more at 10^6 than it would at 32^10.
func newChatCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	s := n.String()
	return strings.Repeat("0", chatCodeLen-len(s)) + s, nil
}

// normalizeChatCode keeps the digits and drops everything else, so spaces and a
// stray dash from however the code was written down do not matter.
//
// Anything longer than a code is refused outright rather than truncated, so a
// doubled paste fails loudly instead of silently matching its own first six
// digits.
func normalizeChatCode(s string) string {
	out := make([]byte, 0, chatCodeLen)
	for _, r := range s {
		if r < '0' || r > '9' {
			continue
		}
		if len(out) == chatCodeLen {
			return ""
		}
		out = append(out, byte(r))
	}
	return string(out)
}

// chatCodeSeconds reads the disappearing timer the code should stamp on the
// chat it opens. Absent, null and 0 all mean "no timer" — the messages stay
// until somebody deletes them, which is what both "Until I delete" and "Save
// this contact" want.
//
// The ceiling matches the one PATCH /chats/{id} enforces on the same column, so
// a code cannot set a timer the chat settings screen would refuse.
func chatCodeSeconds(v any) (*int64, bool) {
	if v == nil {
		return nil, true
	}
	f, ok := v.(float64)
	if !ok {
		return nil, false
	}
	n := int64(math.Round(f))
	if n == 0 {
		return nil, true
	}
	if n < 60 || n > 365*24*60*60 {
		return nil, false
	}
	return &n, true
}

// chatCodeSweep retires codes whose two minutes are up.
//
// "Live" to the partial indexes means un-revoked and unused, which an expired
// row still is until something says so. That makes this the thing that keeps
// six digits workable: without it, every code ever minted keeps occupying its
// digits, chat_codes_live_code_idx eventually rejects everything, and the pool
// a guesser is shooting at grows without bound.
//
// System pool, because it must reach every user's rows and RLS would scope it
// to the caller's. Indexed by chat_codes_expiry_idx, so it normally touches
// nothing. Errors are logged and swallowed: minting immediately after will
// either succeed anyway or fail loudly on the unique violation, and refusing to
// issue a code because housekeeping hiccuped helps nobody.
func chatCodeSweep(ctx context.Context) {
	if _, err := db.Pool.Exec(ctx,
		`UPDATE chat_codes SET revoked_at = now()
		  WHERE revoked_at IS NULL AND used_at IS NULL AND expires_at <= now()`); err != nil {
		log.Printf("[chat-codes] sweep: %v", err)
	}
}

type chatCodeView struct {
	// The code itself. Six digits are not hashable in any way that means
	// anything (see the migration), so this is readable — which is why leaving
	// the screen and coming back can show it again rather than forcing a new one.
	Code        string     `json:"code,omitempty"`
	TTLSeconds  *int64     `json:"ttlSeconds"`
	KeepContact bool       `json:"keepContact"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	Active      bool       `json:"active"`
}

// POST /chat-codes — mint a code, replacing any existing one.
func chatCodeCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID

	var b map[string]any
	_ = httpx.Body(r, &b)
	ttl, ok := chatCodeSeconds(b["ttlSeconds"])
	if !ok {
		httpx.Err(w, 400, "ttlSeconds must be 0 or between 60 and 31536000")
		return
	}
	keep := chatsTruthy(b["keepContact"])

	chatCodeSweep(ctx)

	var code string
	var exp time.Time
	var err error
	for i := 0; i < chatCodeMintTries; i++ {
		code, err = newChatCode()
		if err != nil {
			httpx.Err(w, 500, "Could not create a code")
			return
		}
		exp = time.Now().Add(chatCodeLife)
		err = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
			// ROTATE in the same transaction as the insert. The partial unique
			// index allows exactly one live code per person, so without this the
			// insert below would collide — and someone who tapped twice would be
			// holding two codes with no way to tell which they had read out.
			if _, e := tx.Exec(ctx,
				`UPDATE chat_codes SET revoked_at = now()
				  WHERE owner_id = $1 AND revoked_at IS NULL AND used_at IS NULL`, uid); e != nil {
				return e
			}
			_, e := tx.Exec(ctx,
				`INSERT INTO chat_codes (owner_id, code, ttl_seconds, keep_contact, expires_at)
				 VALUES ($1, $2, $3, $4, $5)`,
				uid, code, ttl, keep, exp)
			return e
		})
		// The own-code rotation above already cleared the one-per-owner index, so
		// the only unique violation left is another LIVE code holding these six
		// digits. Roll fresh ones.
		if err == nil || !isUniqueViolation(err) {
			break
		}
	}
	if err != nil {
		log.Printf("[chat-codes POST] %v", err)
		httpx.Err(w, 500, "Could not create a code")
		return
	}

	httpx.JSON(w, 200, chatCodeView{
		Code: code, TTLSeconds: ttl, KeepContact: keep, ExpiresAt: &exp, Active: true,
	})
}

// GET /chat-codes — the live code, if there is one. Lets the screen be left and
// come back within the two minutes instead of minting a second code.
func chatCodeGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID

	var code string
	var ttl *int64
	var keep bool
	var exp time.Time
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT code, ttl_seconds, keep_contact, expires_at FROM chat_codes
			  WHERE owner_id = $1 AND revoked_at IS NULL AND used_at IS NULL
			    AND expires_at > now()`, uid).Scan(&code, &ttl, &keep, &exp)
	})
	if db.NoRows(err) {
		httpx.JSON(w, 200, chatCodeView{Active: false})
		return
	}
	if err != nil {
		log.Printf("[chat-codes GET] %v", err)
		httpx.Err(w, 500, "Could not read your code")
		return
	}
	httpx.JSON(w, 200, chatCodeView{
		Code: code, TTLSeconds: ttl, KeepContact: keep, ExpiresAt: &exp, Active: true,
	})
}

// DELETE /chat-codes — "stop". Anyone still holding the code gets nothing.
func chatCodeRevoke(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`UPDATE chat_codes SET revoked_at = now()
			  WHERE owner_id = $1 AND revoked_at IS NULL AND used_at IS NULL`, uid)
		return e
	})
	if err != nil {
		log.Printf("[chat-codes DELETE] %v", err)
		httpx.Err(w, 500, "Could not stop your code")
		return
	}
	httpx.JSON(w, 200, chatCodeView{Active: false})
}

// POST /chat-codes/{code}/join — redeem.
//
// Runs on the SYSTEM pool for the lookup and the burn: the redeemer is by
// definition not the owner, so an RLS policy keyed on the current user would
// hide the very row being redeemed. Everything after that is ordinary per-user
// work.
func chatCodeJoin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID

	// THREE LIMITS, EACH CLOSING A DIFFERENT DOOR. Six digits means these are
	// the defence rather than a courtesy, so all three are deliberate:
	//
	//   burst   — a person mistyping a code needs a handful of tries, not fifty.
	//   day     — stops one patient account grinding the space over weeks.
	//   ip      — stops the obvious way around the first two, which is to cycle
	//             fresh accounts from the same machine.
	//
	// redisx fails OPEN if Redis is down, deliberately and everywhere. That is a
	// real gap here rather than a shrug: with Redis gone this endpoint has no
	// brute-force protection left but the two-minute life.
	for _, lim := range []struct {
		key    string
		n, win int64
	}{
		{"chatcode:join:" + uid, 5, 600},
		{"chatcode:join:day:" + uid, 20, 86400},
		{"chatcode:join:ip:" + authClientIP(r), 30, 3600},
	} {
		if rl := redisx.Consume(ctx, lim.key, lim.n, lim.win); !rl.Allowed {
			httpx.Err(w, 429, "Too many code attempts. Try again later.")
			return
		}
	}

	code := normalizeChatCode(r.PathValue("code"))
	if len(code) != chatCodeLen {
		httpx.Err(w, 400, "A code is six digits")
		return
	}

	var id int64
	var ownerID string
	var ttl *int64
	var keep bool
	err := db.Pool.QueryRow(ctx,
		`SELECT id, owner_id::text, ttl_seconds, keep_contact FROM chat_codes
		  WHERE code = $1 AND revoked_at IS NULL AND used_at IS NULL
		    AND expires_at > now()`, code).Scan(&id, &ownerID, &ttl, &keep)
	if db.NoRows(err) {
		// One message for expired, revoked, spent and never-existed. Telling them
		// apart would confirm which guesses had once been real codes, which at six
		// digits is most of the way to a working oracle.
		httpx.Err(w, 404, "That code has expired or was already used")
		return
	}
	if err != nil {
		log.Printf("[chat-codes join] %v", err)
		httpx.Err(w, 500, "Could not use that code")
		return
	}
	if ownerID == uid {
		httpx.Err(w, 400, "That is your own code")
		return
	}

	// BURN BEFORE OPENING. Two people redeeming the same code at the same moment
	// both pass the SELECT above; only one can win this UPDATE, and the loser is
	// turned away. The other order — open the chat, then burn — would put a
	// stranger in a conversation meant for one person. A burn followed by a
	// failure to open costs the owner one regenerated code, which is the cheaper
	// way to be wrong.
	tag, err := db.Pool.Exec(ctx,
		`UPDATE chat_codes SET used_by = $2, used_at = now()
		  WHERE id = $1 AND used_at IS NULL`, id, uid)
	if err != nil {
		log.Printf("[chat-codes join] %v", err)
		httpx.Err(w, 500, "Could not use that code")
		return
	}
	if tag.RowsAffected() != 1 {
		httpx.Err(w, 404, "That code has expired or was already used")
		return
	}

	chatID, existing, status, msg := directChatEnsure(ctx, uid, ownerID)
	if status != 0 {
		httpx.Err(w, status, msg)
		return
	}
	if !keep {
		chatCodeHideSignals(ctx, uid, ownerID)
	}

	// A chat opened by code hides BOTH names and photos until BOTH sides save
	// (migration 119).
	//
	// ALWAYS, INCLUDING A CHAT THESE TWO ALREADY HAD. An earlier version skipped
	// this when the chat already existed, on the reasoning that blanking a
	// months-old conversation helps nobody. That reasoning is sound but the
	// behaviour was SILENT: redeeming a code you were told was anonymous just
	// quietly opened an ordinary chat, and the promise on the box was false.
	// Owner's decision (2026-08-28): a code chat is anonymous, no exception.
	//
	// Note what this does NOT do: saved_peer is left alone. So a pair who have
	// already completed the handshake stay visible to each other rather than
	// being re-masked by a later code, and a pair who never did — which is every
	// ordinary chat, since the column defaults to FALSE — becomes masked.
	//
	// The cache consequence is worth stating: for an EXISTING chat this flips
	// revealed -> masked, which is the one direction that can leave a stale
	// client showing a real name. It is harmless here precisely because the chat
	// already existed — both devices already held that name, so nothing is
	// disclosed that was not already there, and the next /chats refresh corrects
	// the display.
	//
	// "Save this contact" counts as the OWNER's decision, made up front: they
	// said they were keeping whoever redeemed it, so they should not be asked
	// again. The redeemer still has to choose, which is what keeps the reveal
	// mutual.
	if err := chatCodeMarkAnon(ctx, chatID, ownerID, keep); err != nil {
		log.Printf("[chat-codes join] anon: %v", err)
		httpx.Err(w, 500, "Chat opened, but it could not be made anonymous")
		return
	}
	// Tell BOTH sides to refetch. The owner may be looking at this chat right
	// now with the peer's real name on screen; without this the mask would not
	// appear until their next cold start.
	//
	// The value is RECOMPUTED rather than hardcoded true: a pair who already
	// completed the handshake stay revealed, and telling their clients otherwise
	// would blank a name the server is still perfectly willing to serve.
	emitx.ChatEvent(chatID, "chat_updated", map[string]any{
		"chatId": chatID, "anonMasked": chatsAnonMasked(ctx, chatID),
	})

	// Stamp the chat's SELF-DESTRUCT time (migration 120).
	//
	// "1 hour" and "3 hours" delete the WHOLE conversation at the deadline —
	// messages, membership, the thread itself — not just the messages inside it.
	// Reconnecting afterwards needs a new code. That is why this sets
	// chats.expires_at and NOT disappearing_seconds: the latter expires messages
	// while the chat quietly persists, which is a weaker promise than the option
	// makes.
	//
	// Set HERE rather than by the joining client, the way /new-chat does it. The
	// promise belongs to the person who made the code, and the person redeeming
	// it is a stranger — leaving it to their client means the owner's promise
	// holds only if that client bothers, with no way for the owner to tell.
	//
	// Overwrites an existing deadline on purpose: if the two already had a chat,
	// the code still said what it said.
	if ttl != nil {
		var expires time.Time
		if err := db.Pool.QueryRow(ctx,
			`UPDATE chats SET expires_at = now() + make_interval(secs => $2)
			  WHERE id = $1 RETURNING expires_at`, chatID, *ttl).Scan(&expires); err != nil {
			log.Printf("[chat-codes join] expiry: %v", err)
			httpx.Err(w, 500, "Chat opened, but its timer could not be set")
			return
		}
		emitx.ChatEvent(chatID, "chat_updated", map[string]any{
			"chatId": chatID, "expiresAt": expires,
		})
	}

	httpx.JSON(w, 200, map[string]any{
		"chatId": chatID, "existing": existing, "ttlSeconds": ttl, "keepContact": keep,
	})
}

// chatCodeMarkAnon makes a freshly opened code chat anonymous, and records the
// owner's up-front "Save this contact" as their half of the reveal.
//
// ORDER IS THE SAFETY HERE, not a transaction. saved_peer is written FIRST and
// anon SECOND, so the only reachable partial state is "owner has saved a chat
// that is not anonymous" — which is inert, because saved_peer is read only when
// anon is true. The reverse order would leave a chat anonymous with the owner's
// consent lost, masked forever from their side even after both people agreed.
//
// System pool, because this runs as the REDEEMER and the member row it updates
// belongs to the OWNER — a per-user connection would be scoped away from it.
func chatCodeMarkAnon(ctx context.Context, chatID, ownerID string, keep bool) error {
	if keep {
		if _, e := db.Pool.Exec(ctx,
			`UPDATE chat_members SET saved_peer = TRUE WHERE chat_id = $1 AND user_id = $2`,
			chatID, ownerID); e != nil {
			return e
		}
	}
	_, e := db.Pool.Exec(ctx, `UPDATE chats SET anon = TRUE WHERE id = $1`, chatID)
	return e
}

// chatCodeHideSignals turns on Ghost Mode both ways for a pair who have just met
// through a code.
//
// Someone who read out a code did not agree to hand over their typing, their
// read receipts and their last-seen along with it. Ghost Mode (migration 015)
// already hides exactly those four signals per contact, so the default here is
// the existing feature applied automatically, not a new privacy mechanism.
//
// Skipped entirely when the code said "Save this contact" — that option exists
// to say "this is a person I am keeping", and a kept contact should behave like
// every other one.
//
// DO NOTHING on conflict: if either side has already set deliberate Ghost Mode
// preferences for the other, those are a real decision and this is a default.
//
// Failures are logged and swallowed. The chat is already open by this point and
// the code is spent, so refusing now would leave two people in a conversation
// neither could re-enter. Both sides can still set these by hand.
//
// ponytail: presence signals only. Name and photo stay visible to each side;
// hiding those means a per-chat identity override across the chat list, chat
// header, call screen and contact card. Add it when someone asks.
func chatCodeHideSignals(ctx context.Context, a, b string) {
	const q = `INSERT INTO ghost_mode (owner_id, target_id, hide_online, hide_typing, hide_read, hide_last_seen)
	           VALUES ($1, $2, TRUE, TRUE, TRUE, TRUE)
	           ON CONFLICT (owner_id, target_id) DO NOTHING`
	for _, p := range [][2]string{{a, b}, {b, a}} {
		if _, err := db.Pool.Exec(ctx, q, p[0], p[1]); err != nil {
			log.Printf("[chat-codes] ghost defaults: %v", err)
		}
	}
}
