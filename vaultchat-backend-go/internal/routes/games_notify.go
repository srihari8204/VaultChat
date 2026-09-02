// games_notify.go — inbound notifications FROM the games server.
//
// WHY THIS EXISTS
// ---------------
// The games platform has ~19 registered players and typically zero online at
// the same moment, so Quick Match almost always falls through to a bot offer.
// Asynchronous play — you move, your opponent gets a push, they play hours
// later — is the only structural fix for that, and this route is its missing
// half. Until it existed the games server was POSTing here and collecting 404s
// ("notify: delivery failed") for every turn taken.
//
// TWO KEYPAIRS, NOT ONE
// ---------------------
// games.go holds the launch-token PRIVATE key: VaultChat signs, the games
// server verifies. This file holds the notify PUBLIC key: the games server
// signs, VaultChat verifies. They are separate keypairs on purpose and must
// never be crossed — reusing the launch keypair here would mean handing the
// games server our signing key, which is exactly the exposure that keeping the
// private half on one machine exists to prevent.
//
// THE SIGNATURE IS THE AUTHENTICATION
// -----------------------------------
// This route is deliberately unauthenticated in the session sense: the caller
// is a server, not a user, and holds no VaultChat session. What makes a
// delivery trustworthy is the EdDSA signature over claims that name their own
// recipient, so every rejection path below is load-bearing.
package routes

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/fcm"
	"vaultchat/backend-go/internal/httpx"
)

// A turn notification is useful for as long as the turn is — which in
// asynchronous play is hours, not the 30 seconds a call ring gets. FCM holds an
// undeliverable data message for this long before dropping it, so a phone that
// was off overnight still gets the nudge when it comes back.
const gamesNotifyTTLMs int64 = 4 * 60 * 60 * 1000

// Bound on free text the games server supplies. It is a trusted peer, not
// trusted input: these strings reach a notification builder on a phone.
const gamesNotifyMaxText = 200

var (
	gamesNotifyKeyOnce sync.Once
	gamesNotifyKey     ed25519.PublicKey
	gamesNotifyKeyErr  error
)

// gamesNotifyPublicKey loads the games server's notify verification key.
// File first, for the same reason as the signing key in games.go: a path in the
// environment instead of key material in `docker inspect` and crash dumps.
func gamesNotifyPublicKey() (ed25519.PublicKey, error) {
	gamesNotifyKeyOnce.Do(func() {
		pemStr := os.Getenv("GAMES_NOTIFY_PUBLIC_KEY_PEM")
		if path := os.Getenv("GAMES_NOTIFY_PUBLIC_KEY_FILE"); path != "" {
			b, err := os.ReadFile(path)
			if err != nil {
				gamesNotifyKeyErr = err
				return
			}
			pemStr = string(b)
		}
		if strings.TrimSpace(pemStr) == "" {
			gamesNotifyKeyErr = errors.New("GAMES_NOTIFY_PUBLIC_KEY_FILE/_PEM not set")
			return
		}
		gamesNotifyKey, gamesNotifyKeyErr = parseGamesNotifyKey(pemStr)
	})
	return gamesNotifyKey, gamesNotifyKeyErr
}

func parseGamesNotifyKey(pemStr string) (ed25519.PublicKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, errors.New("games notify key: not PEM")
	}
	k, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	pub, ok := k.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("games notify key: not Ed25519")
	}
	return pub, nil
}

// gamesNotifyClaims is the event contract. jwt.RegisteredClaims supplies sub
// (recipient vaultId), jti (dedupe key), iat and exp.
type gamesNotifyClaims struct {
	Kind  string `json:"kind"`  // turn | invite | friend
	Title string `json:"title"` // short, already human-readable
	Body  string `json:"body"`
	Game  string `json:"game"` // file stem, e.g. "rummy"
	Room  string `json:"room"` // table id — the tap must open THIS table
	jwt.RegisteredClaims
}

// gamesNotifySlug bounds an identifier that becomes part of a URL the app opens
// inside the games WebView.
//
// INPUT VALIDATION AT A TRUST BOUNDARY — do not drop this because the caller is
// "our own" server. The app composes games.corefinite.com/<game>.html?room=
// <room> from these two fields; a game of "../../x", or a room carrying a quote
// or an ampersand, rewrites that URL into something else. The WebView's origin
// allowlist is the second line of defence and must never be the only one.
func gamesNotifySlug(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 64 {
		return ""
	}
	for _, c := range s {
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '-' || c == '_'
		if !ok {
			return ""
		}
	}
	return s
}

func gamesNotifyText(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > gamesNotifyMaxText {
		s = s[:gamesNotifyMaxText]
	}
	return s
}

// gamesNotify receives one signed event and turns it into a push.
//
// STATUS CODES ARE THE RETRY CONTRACT. The games server retries on failure, so
// each code has to mean the right thing to it:
//
//	400/401 — this delivery is broken; retrying it changes nothing.
//	503     — we are misconfigured; retrying later is correct.
//	502     — we tried to push and the transport failed; retry.
//	200     — accepted, INCLUDING "recipient has no device registered", which is
//	          a fact about the recipient that no retry can change.
func gamesNotify(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	pub, err := gamesNotifyPublicKey()
	if err != nil {
		// Nothing to verify against. 503, not 401: a server that cannot check,
		// not a caller that failed a check.
		httpx.Err(w, http.StatusServiceUnavailable, "Games notify is not configured")
		return
	}

	var b struct {
		Event string `json:"event"`
	}
	if err := httpx.Body(r, &b); err != nil || strings.TrimSpace(b.Event) == "" {
		httpx.Err(w, http.StatusBadRequest, "event required")
		return
	}

	var claims gamesNotifyClaims
	if _, err := jwt.ParseWithClaims(b.Event, &claims,
		func(*jwt.Token) (any, error) { return pub, nil },
		jwt.WithValidMethods([]string{"EdDSA"}),
		// exp is REQUIRED, not merely honoured when present. Without this a
		// token minted with no exp verifies forever, and the 5-minute replay
		// window the contract promises would hold only by convention.
		jwt.WithExpirationRequired(),
	); err != nil {
		log.Printf("[games-notify] rejected: %v", err)
		httpx.Err(w, http.StatusUnauthorized, "bad event signature")
		return
	}

	vaultID := strings.TrimSpace(claims.Subject)
	jti := strings.TrimSpace(claims.ID)
	if vaultID == "" || jti == "" {
		httpx.Err(w, http.StatusBadRequest, "sub and jti required")
		return
	}
	game, room := gamesNotifySlug(claims.Game), gamesNotifySlug(claims.Room)

	// CLAIM THE jti BEFORE SENDING, RELEASE IT IF THE SEND FAILS.
	//
	// Same shape as the egress-restart claim in golive_webhook.go. Recording
	// afterwards would double-notify whenever the write lost a race with a
	// retry; recording first and never releasing would silently swallow the
	// retry of a push that genuinely failed to go out.
	expires := time.Now().Add(15 * time.Minute)
	if claims.ExpiresAt != nil {
		expires = claims.ExpiresAt.Time
	}
	fresh, err := gamesNotifyClaimJTI(ctx, jti, expires)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "dedupe failed")
		return
	}
	if !fresh {
		// Not an error: the games server did its job and retried something we
		// already delivered. 200 so it stops.
		httpx.JSON(w, 200, map[string]any{"ok": true, "deduped": true})
		return
	}

	var userID string
	if err := db.Pool.QueryRow(ctx,
		`SELECT id::text FROM users WHERE vault_id = $1 AND is_deleted = FALSE`, vaultID,
	).Scan(&userID); err != nil {
		// An unknown or deleted vaultId is settled, not transient. The jti stays
		// claimed so retries do not re-run this lookup forever.
		httpx.JSON(w, 200, map[string]any{"ok": true, "delivered": false, "reason": "unknown_recipient"})
		return
	}

	// Remember the table BEFORE the push and regardless of whether it lands.
	// "This player is sitting at this table" is true whether or not their phone
	// has a live FCM token, and the list is the half of asynchronous play that
	// works when the notification is missed, dismissed or never delivered —
	// which is precisely the case a push-only design cannot serve.
	gamesRememberTable(ctx, userID, claims.Kind, game, room,
		gamesNotifyText(claims.Title), gamesNotifyText(claims.Body))

	tokens := fcmTokensFor(ctx, userID)
	if len(tokens) == 0 {
		httpx.JSON(w, 200, map[string]any{"ok": true, "delivered": false, "reason": "no_device_token"})
		return
	}

	// The payload the phone renders. game+room are what make the tap land on the
	// right table — without them the notification opens the games hub and the
	// player has to find their own way back, which misses the point.
	//
	// Title and body cross Google's servers in the clear. That is a deliberate
	// difference from chat push (type:"message", which carries a chatId and
	// nothing else): game state is not end-to-end encrypted anywhere — it lives
	// in plaintext on the games server by design — so there is no VaultChat
	// secret here for content-free delivery to protect.
	//
	// ponytail: reuses SendCallMessage, which stamps APNs voip headers. Correct
	// on Android (the only shipped platform) and wrong for iOS, where a voip
	// push not followed by a CallKit report is an entitlement violation. Split
	// the APNs block out of SendCallMessage before an iOS build ships.
	res := fcm.SendCallMessage(tokens, map[string]string{
		"type":  "games_turn",
		"kind":  gamesNotifyText(claims.Kind),
		"title": gamesNotifyText(claims.Title),
		"body":  gamesNotifyText(claims.Body),
		"game":  game,
		"room":  room,
		"jti":   jti,
	}, gamesNotifyTTLMs)

	if len(res.Dead) > 0 {
		_, _ = db.Pool.Exec(ctx,
			`UPDATE devices SET fcm_token = NULL WHERE fcm_token = ANY($1::text[])`, res.Dead)
	}

	// Every token we had was dead, or the transport itself failed. Release the
	// claim so the games server's retry is not deduped into silence.
	if !res.OK {
		gamesNotifyReleaseJTI(ctx, jti)
		httpx.Err(w, http.StatusBadGateway, "push delivery failed")
		return
	}

	httpx.JSON(w, 200, map[string]any{"ok": true, "delivered": true, "sent": res.Sent})
}

// gamesLiveKinds are the notification kinds that mean "you have a table".
//
// The contract's kinds are turn | invite | friend. A friend request is about a
// person, not a table, and writing a row for one would put a game in the list
// that the player is not sitting at. An unknown kind is treated the same way:
// the games server can add kinds without telling us, and a list is a promise
// about where the player can pick up a game.
var gamesLiveKinds = map[string]bool{"turn": true, "invite": true}

// gamesRememberTable records that this player has a live table here.
//
// Fail-soft on purpose: this is a convenience list derived from a notification
// whose real job is the push. A database hiccup must not turn a deliverable
// turn notification into a 500 that the games server then retries.
func gamesRememberTable(ctx context.Context, userID, kind, game, room, title, body string) {
	if game == "" || room == "" || !gamesLiveKinds[strings.ToLower(strings.TrimSpace(kind))] {
		return
	}
	// your_turn is a record of what we were last told, not a claim about the
	// board — the board itself is re-read from the games server on open.
	yourTurn := strings.EqualFold(strings.TrimSpace(kind), "turn")
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO games_live_tables (user_id, game, room, your_turn, title, body, updated_at)
		 VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), now())
		 ON CONFLICT (user_id, game, room) DO UPDATE
		    SET your_turn = EXCLUDED.your_turn,
		        title      = EXCLUDED.title,
		        body       = EXCLUDED.body,
		        updated_at = now()`,
		userID, game, room, yourTurn, title, body); err != nil {
		log.Printf("[games-notify] live table upsert failed: %v", err)
	}
}

// gamesNotifyClaimJTI records the event id, reporting whether it was new.
//
// The unique index does the work: two concurrent deliveries of the same jti
// race into one INSERT, exactly one affects a row, and the loser is told it is
// a duplicate. No read-then-write window to lose.
func gamesNotifyClaimJTI(ctx context.Context, jti string, expires time.Time) (bool, error) {
	tag, err := db.Pool.Exec(ctx,
		`INSERT INTO games_notify_seen (jti, expires_at) VALUES ($1, $2)
		 ON CONFLICT (jti) DO NOTHING`, jti, expires)
	if err != nil {
		log.Printf("[games-notify] dedupe insert failed: %v", err)
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func gamesNotifyReleaseJTI(ctx context.Context, jti string) {
	if _, err := db.Pool.Exec(ctx, `DELETE FROM games_notify_seen WHERE jti = $1`, jti); err != nil {
		log.Printf("[games-notify] dedupe release failed: %v", err)
	}
}

// gamesDeviceToken registers (or unregisters) the caller's device for games
// push. Auth required — it writes the caller's own device row.
//
// It shares registerFcmDevice with POST /call/token rather than owning a second
// upsert, so a phone registered for calls and for games holds ONE row and
// receives ONE copy of everything.
func gamesDeviceToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)

	var b struct {
		FcmToken   string `json:"fcmToken"`
		Platform   string `json:"platform"`
		Unregister bool   `json:"unregister"`
	}
	_ = httpx.Body(r, &b)
	fcmToken := strings.TrimSpace(b.FcmToken)
	if fcmToken == "" {
		httpx.Err(w, http.StatusBadRequest, "fcmToken required")
		return
	}

	if b.Unregister {
		// Scoped to the caller's own rows: holding a token string is not a
		// capability to silence somebody else's phone.
		if _, err := db.Pool.Exec(ctx,
			`UPDATE devices SET fcm_token = NULL WHERE user_id = $1 AND fcm_token = $2`,
			user.ID, fcmToken); err != nil {
			httpx.Err(w, http.StatusInternalServerError, "Failed to unregister token")
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "registered": false})
		return
	}

	platform := strings.ToLower(strings.TrimSpace(b.Platform))
	if platform == "" {
		platform = "android"
	}
	if err := registerFcmDevice(ctx, user.ID, fcmToken, platform); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "Failed to register token")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "registered": true})
}
