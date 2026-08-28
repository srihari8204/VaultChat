// chats_anon.go — a chat opened by code shows no name and no photo until BOTH
// people choose to keep the other (migration 119).
//
// WHY THE MASK LIVES HERE AND NOT IN THE APP
// ------------------------------------------
// Over twenty client files render a peer's name or photo — the chat list, the
// chat header, the avatar popup, contact info, the incoming-call screen, the
// call session. Masking in the app would mean getting all of them right and
// keeping them right forever, and the first one anybody forgot would leak a
// real name with no error and no symptom.
//
// So the identity never leaves the server in the first place. Every client is
// masked for free, including screens nobody has written yet, and a new screen
// cannot leak what it was never sent.
//
// THE REVEAL IS MUTUAL
// --------------------
// Revealing as soon as ONE side saves would publish that side's identity
// without their agreement: A saves B, A now sees B's real name, and B is still
// looking at a ghost. Disclosure has to be a handshake. chatsAnonMasked
// therefore asks "is ANY active member still unsaved", not "have I saved".
//
// WHAT THIS IS NOT
// ----------------
// Not encryption. It withholds a name and a photo from a payload. Someone who
// already knows who they are talking to still knows, and the two of them are
// exchanging messages either way. It exists so that meeting a stranger through
// a code does not throw in your identity for free.
package routes

import (
	"context"
	"log"
	"net/http"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
)

// What a masked peer looks like on the wire. The name is deliberately a real
// word rather than an empty string: every client already renders whatever it is
// given, and a blank name produces blank rows and initials-less avatars across
// screens none of this code can see.
const chatsAnonName = "Guest"

// chatsAnonMasked reports whether a chat's member identities must be withheld.
//
// TRUE only when the chat is anonymous AND at least one active member has not
// saved. Both halves matter: an ordinary chat is never masked, and an anonymous
// one stops being masked the moment the last person saves.
//
// System pool: this is a property of the chat, identical for everyone who can
// see it, and the callers are already inside their own authorization checks.
func chatsAnonMasked(ctx context.Context, chatID string) bool {
	var masked bool
	err := db.Pool.QueryRow(ctx,
		`SELECT c.anon
		    AND EXISTS (SELECT 1 FROM chat_members m
		                 WHERE m.chat_id = c.id AND m.left_at IS NULL AND m.saved_peer = FALSE)
		   FROM chats c WHERE c.id = $1`, chatID).Scan(&masked)
	if db.NoRows(err) {
		return false // no such chat — there is nothing to mask
	}
	if err != nil {
		// FAIL CLOSED. An unreadable row must not become a revealed name: masking
		// a chat that did not need it is cosmetic, the reverse loses the feature.
		log.Printf("[anon] mask check %s: %v", chatID, err)
		return true
	}
	return masked
}

// chatsAnonMaskedSet answers the same question for a whole chat list in ONE
// query, because the list renders up to 200 chats and a per-row check would be
// 200 round trips to hide a handful of them.
//
// Returns the ids that must be masked; anything absent is shown normally.
func chatsAnonMaskedSet(ctx context.Context, uid string) map[string]bool {
	out := map[string]bool{}
	rows, err := db.Pool.Query(ctx,
		`SELECT c.id::text FROM chats c
		  WHERE c.anon = TRUE
		    AND EXISTS (SELECT 1 FROM chat_members me
		                 WHERE me.chat_id = c.id AND me.user_id = $1 AND me.left_at IS NULL)
		    AND EXISTS (SELECT 1 FROM chat_members m
		                 WHERE m.chat_id = c.id AND m.left_at IS NULL AND m.saved_peer = FALSE)`,
		uid)
	if err != nil {
		// Cannot fail closed usefully here — masking every chat in the list on a
		// transient error would blank the whole screen. Anonymous chats are rare
		// and the single-chat path (chatsAnonMasked) does fail closed, so a lost
		// row here is recoverable the moment the chat is opened.
		log.Printf("[anon] mask set for %s: %v", uid, err)
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out[id] = true
		}
	}
	return out
}

// chatsAnonMaskedPair answers the same question for two PEOPLE rather than a
// chat, because the call paths have a caller and a callee and no chat id.
//
// Masked only when the pair's direct chat is anonymous and still unsaved. If
// they also have an ordinary direct chat, they already know each other and
// nothing is hidden — so this looks for a REVEALED chat first and lets it win.
// Without that, meeting someone by code after years of talking would blank the
// name on their calls.
func chatsAnonMaskedPair(ctx context.Context, a, b string) bool {
	var masked bool
	err := db.Pool.QueryRow(ctx,
		`SELECT COALESCE(bool_and(
		          c.anon AND EXISTS (SELECT 1 FROM chat_members m
		                              WHERE m.chat_id = c.id AND m.left_at IS NULL
		                                AND m.saved_peer = FALSE)), FALSE)
		   FROM chats c
		  WHERE c.type = 'direct'
		    AND EXISTS (SELECT 1 FROM chat_members x WHERE x.chat_id = c.id AND x.user_id = $1 AND x.left_at IS NULL)
		    AND EXISTS (SELECT 1 FROM chat_members y WHERE y.chat_id = c.id AND y.user_id = $2 AND y.left_at IS NULL)`,
		a, b).Scan(&masked)
	if err != nil {
		// bool_and over no rows is NULL, coalesced to FALSE above, so "they have
		// no chat at all" arrives here as not-masked rather than as an error.
		// A real error fails closed, same as chatsAnonMasked.
		log.Printf("[anon] pair mask %s/%s: %v", a, b, err)
		return true
	}
	return masked
}

// RegisterChatsAnonOnID adds POST /chats/{id}/save-contact. Called from
// RegisterChats with its private id-mux, for the ordering reason documented
// there.
func RegisterChatsAnonOnID(id *http.ServeMux) {
	id.HandleFunc("POST /chats/{id}/save-contact", httpx.RequireAuth(chatsSaveContact))
}

// POST /chats/{id}/save-contact — "I want to keep this person."
//
// Idempotent: saving twice is the same as saving once, so a retried tap cannot
// produce a different answer than the first one did.
func chatsSaveContact(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	chatID := r.PathValue("id")

	// Membership is the authorization: only someone in the chat may save its
	// other side, and the UPDATE's own WHERE enforces it rather than a separate
	// check that could drift.
	var affected int64
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx,
			`UPDATE chat_members SET saved_peer = TRUE
			  WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`, chatID, uid)
		if e != nil {
			return e
		}
		affected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		log.Printf("[anon] save-contact %s: %v", chatID, err)
		httpx.Err(w, 500, "Could not save this contact")
		return
	}
	if affected == 0 {
		httpx.Err(w, 403, "Not a member of this chat")
		return
	}

	// Recompute AFTER the write: the caller may have been the last holdout, in
	// which case both sides just became visible to each other.
	revealed := !chatsAnonMasked(ctx, chatID)

	// Tell BOTH clients. The other side's screen is showing a ghost right now
	// and has no reason to re-fetch on its own — without this the reveal only
	// appears on their next cold start, which reads as the feature not working.
	emitx.ChatEvent(chatID, "chat_updated", map[string]any{
		"chatId": chatID, "anonRevealed": revealed,
	})

	httpx.JSON(w, 200, map[string]any{"saved": true, "revealed": revealed})
}
