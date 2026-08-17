// golive_invites.go — shareable invitations for a Private Live (migration 107).
//
// THE FLOW THIS EXISTS FOR
// ------------------------
// Start a private live, get ONE link, send it to whoever you want through
// whatever app you like. The host does not pick invitees up front — the
// invitation itself is the access mechanism.
//
// WHAT THE LINK CONTAINS
// ----------------------
// An opaque 32-byte random code and nothing else. No LiveKit key, no signing
// secret, no room name, no infrastructure detail. The server resolves the code
// to a broadcast; the holder never learns anything about how the media tier is
// put together.
//
// The code is stored HASHED (sha256). A dump of broadcast_invite_links grants
// nothing, because the plaintext exists only in the response that created it.
//
// WHAT REDEEMING GRANTS — AND WHAT IT DOES NOT
// --------------------------------------------
// Audience access to ONE broadcast. It writes an ordinary broadcast_invites row,
// which every existing gate already consults, so link access needs no new
// authorization path and cannot drift from the manual invite.
//
// It does NOT grant a seat on the 20-person stage. seen_at is left NULL, and
// seen_at is what promotes someone to speaker. A link makes you one of unlimited
// VIEWERS; only the host promoting you puts your camera on the stage.
package routes

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/livekit"
	"vaultchat/backend-go/internal/redisx"
)

func RegisterGoLiveInvites(mux *http.ServeMux) {
	mux.HandleFunc("POST /broadcasts/{id}/invite-link", httpx.RequireAuth(goliveInviteLinkCreate))
	mux.HandleFunc("GET /broadcasts/{id}/invite-link", httpx.RequireAuth(goliveInviteLinkGet))
	mux.HandleFunc("DELETE /broadcasts/{id}/invite-link", httpx.RequireAuth(goliveInviteLinkRevoke))
	// Redeem. Under /golive/, NOT /broadcasts/, for two reasons.
	//
	// The holder of a link knows the CODE, not the broadcast, so requiring an id
	// would mean putting it in the link for no benefit.
	//
	// And "POST /broadcasts/invite/{code}" is REFUSED AT STARTUP by Go's
	// ServeMux: it conflicts with "POST /broadcasts/{id}/end" because both match
	// /broadcasts/invite/end and neither is more specific. That is a panic on
	// boot, not a 404 at request time — the whole API crash-loops. Any future
	// /broadcasts/<literal>/... route has the same problem.
	mux.HandleFunc("POST /golive/invite/{code}", httpx.RequireAuth(goliveInviteLinkRedeem))
}

// A link outlives a long stream but not the week. Redemption also requires the
// broadcast to be live, so this is the outer bound, not the only one.
const inviteLinkTTL = 48 * time.Hour

func inviteCodeHash(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// newInviteCode mints 32 bytes of entropy as URL-safe text.
//
// crypto/rand, not math/rand: this is the ONLY thing standing between a private
// broadcast and anyone who guesses. 32 bytes is far beyond brute force, which is
// also why the stored hash can be a plain sha256 rather than a slow KDF.
func newInviteCode() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// inviteLinkURL is what the host copies. PUBLIC_BASE_URL is reused rather than a
// new variable — it is already "this deployment's own origin" and is already
// forwarded to the container for playback.
func inviteLinkURL(code string) string {
	return strings.TrimRight(livekit.PlaybackBase(), "/") + "/live/join/" + code
}

type inviteLink struct {
	// The plaintext code — returned ONLY when created, never on a later read,
	// because only the hash is kept.
	Code      string     `json:"code,omitempty"`
	URL       string     `json:"url,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	Active    bool       `json:"active"`
}

// hostOwns is the two-gate host check these handlers share: RLS says the same
// thing, but this deployment's database role can bypass policies, so the Go
// check is what actually holds. Same rule as broadcastSetHLS.
func hostOwns(r *http.Request, uid, broadcastID string) bool {
	var hostID string
	err := db.WithUser(r.Context(), uid, func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT host_id::text FROM broadcast_sessions WHERE id = $1`, broadcastID).Scan(&hostID)
	})
	return err == nil && hostID == uid
}

// POST /broadcasts/{id}/invite-link — mint a link, replacing any existing one.
func goliveInviteLinkCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")

	if !hostOwns(r, uid, id) {
		goliveLog("INVITE_LINK_DENIED", id, "", uid, "reason=not_host")
		httpx.Err(w, 403, "Only the host can invite people")
		return
	}

	code, err := newInviteCode()
	if err != nil {
		httpx.Err(w, 500, "Could not create an invitation")
		return
	}
	exp := time.Now().Add(inviteLinkTTL)

	err = db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		// ROTATE: revoke the old link in the same transaction as minting the new
		// one. The partial unique index allows exactly one un-revoked row per
		// broadcast, so without this the insert below would collide — and a host
		// who tapped twice would otherwise be left holding two live codes with no
		// way to know which they had already shared.
		if _, e := tx.Exec(ctx,
			`UPDATE broadcast_invite_links SET revoked_at = now()
			  WHERE broadcast_id = $1 AND revoked_at IS NULL`, id); e != nil {
			return e
		}
		_, e := tx.Exec(ctx,
			`INSERT INTO broadcast_invite_links (broadcast_id, code_hash, created_by, expires_at)
			 VALUES ($1, $2, $3, $4)`, id, inviteCodeHash(code), uid, exp)
		return e
	})
	if err != nil {
		goliveLog("INVITE_LINK_FAILED", id, "", uid, "error="+err.Error())
		httpx.Err(w, 500, "Could not create an invitation")
		return
	}

	goliveMetric("invite_link_created")
	goliveLog("INVITE_LINK_CREATED", id, "", uid)
	// The ONLY time the plaintext is ever returned.
	httpx.JSON(w, 200, inviteLink{
		Code: code, URL: inviteLinkURL(code),
		CreatedAt: time.Now(), ExpiresAt: &exp, Active: true,
	})
}

// GET /broadcasts/{id}/invite-link — does one exist, and is it still good?
//
// Returns NO code: only the hash is stored, so the plaintext genuinely cannot be
// re-read. A host who lost the link rotates to get a new one.
func goliveInviteLinkGet(w http.ResponseWriter, r *http.Request) {
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	if !hostOwns(r, uid, id) {
		httpx.Err(w, 403, "Only the host can see the invitation")
		return
	}

	var l inviteLink
	err := db.WithUser(r.Context(), uid, func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(),
			`SELECT created_at, expires_at FROM broadcast_invite_links
			  WHERE broadcast_id = $1 AND revoked_at IS NULL`, id).
			Scan(&l.CreatedAt, &l.ExpiresAt)
	})
	if err != nil {
		httpx.JSON(w, 200, map[string]any{"active": false})
		return
	}
	l.Active = l.ExpiresAt == nil || l.ExpiresAt.After(time.Now())
	httpx.JSON(w, 200, l)
}

// DELETE /broadcasts/{id}/invite-link — turn it off without ending the stream.
func goliveInviteLinkRevoke(w http.ResponseWriter, r *http.Request) {
	uid := httpx.UserFrom(r).ID
	id := r.PathValue("id")
	if !hostOwns(r, uid, id) {
		httpx.Err(w, 403, "Only the host can revoke the invitation")
		return
	}
	_ = db.WithUser(r.Context(), uid, func(tx pgx.Tx) error {
		_, e := tx.Exec(r.Context(),
			`UPDATE broadcast_invite_links SET revoked_at = now()
			  WHERE broadcast_id = $1 AND revoked_at IS NULL`, id)
		return e
	})
	goliveMetric("invite_link_revoked")
	goliveLog("INVITE_LINK_REVOKED", id, "", uid)
	// Already-revoked is success, not an error — the caller wanted it off.
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// POST /broadcasts/invite/{code} — redeem a link.
//
// SysPool, not WithUser. The redeemer is by definition NOT yet authorized for
// this broadcast, so the RLS policies on broadcast_invite_links — which are
// scoped to the host — would hide the very row being redeemed. The validation
// below IS the authorization: a code that does not resolve to a live, unrevoked,
// unexpired link grants nothing.
func goliveInviteLinkRedeem(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	code := strings.TrimSpace(r.PathValue("code"))

	// Rate-limited per user: a code is 32 random bytes, so guessing is hopeless,
	// but an unbounded redeem endpoint is still a free lookup oracle.
	if rl := redisx.Consume(ctx, "bcinvredeem:"+uid, 30, 3600); !rl.Allowed {
		w.Header().Set("Retry-After", strconv.FormatInt(rl.ResetInSec, 10))
		httpx.Err(w, 429, "Too many attempts. Try again later.")
		return
	}

	if code == "" || len(code) > 128 {
		httpx.Err(w, 404, "This invitation is not valid")
		return
	}

	// The joiner's own inputs: the passcode the host shared out-of-band, and the
	// name a room of strangers will see them as.
	var body struct {
		Passcode    string `json:"passcode"`
		DisplayName string `json:"displayName"`
	}
	_ = httpx.Body(r, &body)

	// Resolve, validate, and grant in ONE transaction, so a broadcast that ends
	// between the check and the insert cannot leave a grant behind.
	var broadcastID, hostID string
	var passcodeHash *string
	err := db.SysPool.QueryRow(ctx,
		`SELECT l.broadcast_id::text, b.host_id::text, b.passcode_hash
		   FROM broadcast_invite_links l
		   JOIN broadcast_sessions b ON b.id = l.broadcast_id
		  WHERE l.code_hash = $1
		    AND l.revoked_at IS NULL
		    AND (l.expires_at IS NULL OR l.expires_at > now())
		    AND b.status IN ('starting', 'live')`,
		inviteCodeHash(code)).Scan(&broadcastID, &hostID, &passcodeHash)
	if err != nil {
		// ONE message for every failure — unknown, revoked, expired, or the
		// broadcast has ended. Distinguishing them would turn this into an
		// oracle for which codes exist.
		goliveMetric("invite_link_rejected")
		httpx.Err(w, 404, "This invitation is not valid")
		return
	}

	// THE PASSCODE GATE.
	//
	// Checked AFTER the code resolves but BEFORE anything is granted, and the
	// failure is reported as its own status so the client can re-prompt for just
	// the passcode instead of sending the user back to the link. That is a
	// deliberate exception to the single-message rule above: by this point the
	// caller has already proved they hold a valid code, so "wrong passcode" tells
	// them nothing they did not already know, and hiding it would make a
	// mistyped digit indistinguishable from a dead link.
	//
	// The host is exempt — they set it, and a host locked out of their own
	// broadcast by their own passcode is nothing but a trap.
	if passcodeHash != nil && *passcodeHash != "" && hostID != uid {
		if bcrypt.CompareHashAndPassword([]byte(*passcodeHash), []byte(body.Passcode)) != nil {
			goliveMetric("invite_passcode_rejected")
			goliveLog("INVITE_PASSCODE_REJECTED", broadcastID, "", uid)
			httpx.Err(w, 403, "That passcode is not correct")
			return
		}
	}

	// The name the audience sees. Trimmed and capped to the column's check
	// constraint; empty means "fall back to the profile name" downstream, which
	// is what every pre-108 invite row already resolves to.
	displayName := strings.TrimSpace(body.DisplayName)
	if len(displayName) > 64 {
		displayName = displayName[:64]
	}
	var dn *string
	if displayName != "" {
		dn = &displayName
	}

	// The host redeeming their own link is a no-op, not an error: they may well
	// tap it to check what recipients will see.
	if hostID != uid {
		// The ordinary invite row — the same one POST /invite writes — so every
		// downstream gate (watch, token, chat, polls, HLS ticket) applies with no
		// new path. seen_at stays NULL: a link grants VIEWING, never a seat on
		// the stage.
		// ON CONFLICT ... DO UPDATE, not DO NOTHING: a viewer who rejoins with a
		// different name should be shown under the new one. Only overwritten when
		// a name was actually supplied, so a client that sends none cannot blank
		// out a name the same user set on a previous join.
		if _, e := db.SysPool.Exec(ctx,
			`INSERT INTO broadcast_invites (broadcast_id, inviter_id, invitee_id, display_name)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (broadcast_id, invitee_id)
			 DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, broadcast_invites.display_name)`,
			broadcastID, hostID, uid, dn); e != nil {
			httpx.Err(w, 500, "Could not accept the invitation")
			return
		}
	}

	goliveMetric("invite_link_redeemed")
	goliveLog("INVITE_LINK_REDEEMED", broadcastID, "", uid)
	// The broadcast id is returned so the client can navigate straight to it —
	// safe now, because this user is authorized for it as of a moment ago.
	httpx.JSON(w, 200, map[string]any{"ok": true, "broadcastId": broadcastID})
}
