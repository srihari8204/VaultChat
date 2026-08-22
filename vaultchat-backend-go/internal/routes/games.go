// Package routes — games.go: mints the signed launch token that the VaultGames
// mini-app (games.corefinite.com) exchanges for its own session.
//
// Port of vaultchat-server/mintLaunchToken.ts + gamesRoutes.ts. The Ed25519
// PRIVATE key lives ONLY here (GAMES_SIGNING_PRIVATE_KEY_PEM); the games server
// holds the matching public half and verifies with it.
//
// The token carries vaultId + displayName + nonce and NOTHING else — the games
// server rejects any unexpected claim outright, so never add fields here.
// No phone, no email, no keys. Keep it that way.
package routes

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/vault"
)

const (
	// Fixed by the games server (go-server/internal/shared/types.go). Changing
	// either value here makes every token fail verification.
	gamesIssuer   = "vaultchat"
	gamesAudience = "vaultchat-games"

	// Short on purpose: the token is a bearer credential for the WebView, and a
	// short life is the replay defense. The app re-mints as needed.
	gamesLaunchTTL = 15 * time.Minute
)

// Loaded once — a missing/malformed key is a deploy error, not a per-request one.
var (
	gamesKeyOnce sync.Once
	gamesKey     ed25519.PrivateKey
	gamesKeyErr  error
)

func gamesSigningKey() (ed25519.PrivateKey, error) {
	gamesKeyOnce.Do(func() {
		// Prefer the file: the key then never appears in `docker inspect`,
		// `docker compose config`, the process environment or a crash dump —
		// only a path does. Same reasoning as FIREBASE_SERVICE_ACCOUNT_FILE.
		if path := os.Getenv("GAMES_SIGNING_PRIVATE_KEY_FILE"); path != "" {
			b, err := os.ReadFile(path)
			if err != nil {
				gamesKeyErr = err
				return
			}
			gamesKey, gamesKeyErr = parseGamesKey(string(b))
			return
		}
		pemStr := os.Getenv("GAMES_SIGNING_PRIVATE_KEY_PEM")
		if pemStr == "" {
			gamesKeyErr = errors.New("GAMES_SIGNING_PRIVATE_KEY_FILE/_PEM not set")
			return
		}
		gamesKey, gamesKeyErr = parseGamesKey(pemStr)
	})
	return gamesKey, gamesKeyErr
}

// parseGamesKey reads a PEM PKCS#8 Ed25519 private key (what `openssl genpkey
// -algorithm ed25519` and go-server's cmd/genkeys both emit).
func parseGamesKey(pemStr string) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, errors.New("games signing key: not PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("games signing key: not Ed25519")
	}
	return priv, nil
}

func RegisterGames(mux *http.ServeMux) {
	mux.HandleFunc("POST /games/launch-token", httpx.RequireAuth(gamesLaunchToken))
	// Inbound turn/invite pushes from the games server, and the device
	// registration that makes them deliverable. Both live in games_notify.go.
	mux.HandleFunc("POST /games/notify", gamesNotify)
	mux.HandleFunc("POST /games/device-token", httpx.RequireAuth(gamesDeviceToken))
}

// gamesLaunchToken mints a launch token for the already-authenticated caller.
// RequireAuth has confirmed the VaultChat session before we get here.
func gamesLaunchToken(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)

	key, err := gamesSigningKey()
	if err != nil {
		httpx.Err(w, http.StatusServiceUnavailable, "Games launch is not configured")
		return
	}

	// sub MUST be the vaultId: the games server keys balances, stats and shared
	// deep links by it. The internal user id is not portable across the boundary.
	//
	// THE NAME LIVES IN THE CIPHERS, NOT IN users.name.
	//
	// Same trap that made every incoming call ring as "VaultChat user" — see the
	// long note on callerIdentity in calls.go. Every account created through the
	// vault onboarding flow writes first_name_cipher/last_name_cipher and leaves
	// the legacy plaintext column NULL, so `COALESCE(name,'')` returned '' for
	// all of them and the fallback below shipped the vaultId AS the display name.
	// That is why real players sat in the games lobby, on its leaderboards and in
	// its "your turn" pushes as `v337da54a1d30`.
	//
	// The fallback stays — the games server rejects an empty name outright — but
	// it is now the last resort it was written to be, not the path everyone took.
	var vaultID string
	var fnc, lnc, legacyName *string
	err = db.Pool.QueryRow(r.Context(),
		`SELECT COALESCE(vault_id, ''), first_name_cipher, last_name_cipher, name
		   FROM users WHERE id = $1 AND is_deleted = FALSE`,
		user.ID,
	).Scan(&vaultID, &fnc, &lnc, &legacyName)
	if err != nil {
		httpx.Err(w, http.StatusNotFound, "User not found")
		return
	}
	if vaultID == "" {
		httpx.Err(w, http.StatusConflict, "User has no VaultID")
		return
	}
	name := vaultID
	if nm := vault.IdentityFromRow(fnc, lnc, nil, nil, nil, nil, legacyName, nil, nil, nil, nil).Name; nm != nil {
		if trimmed := strings.TrimSpace(*nm); trimmed != "" {
			name = trimmed
		}
	}

	tok, nonce, exp, err := mintGamesToken(key, vaultID, name, time.Now())
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "Failed to mint launch token")
		return
	}

	// The nonce is returned for parity with the TS route, but single-use is
	// enforced on the games server (auth.Verify consumes it) — no store here.
	httpx.JSON(w, http.StatusOK, map[string]any{
		"token":     tok,
		"nonce":     nonce,
		"exp":       exp,
		"expiresIn": int(gamesLaunchTTL.Seconds()),
	})
}

// mintGamesToken builds the signed token. Exactly these seven claims — the games
// server rejects any extra one, so this is the contract (see games_test.go).
func mintGamesToken(key ed25519.PrivateKey, vaultID, name string, now time.Time) (token, nonce string, exp int64, err error) {
	nonce, err = gamesNonce()
	if err != nil {
		return "", "", 0, err
	}
	exp = now.Add(gamesLaunchTTL).Unix()
	token, err = jwt.NewWithClaims(jwt.SigningMethodEdDSA, jwt.MapClaims{
		"sub":   vaultID,
		"name":  name,
		"nonce": nonce,
		"iss":   gamesIssuer,
		"aud":   gamesAudience,
		"iat":   now.Unix(),
		"exp":   exp,
	}).SignedString(key)
	if err != nil {
		return "", "", 0, err
	}
	return token, nonce, exp, nil
}

func gamesNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return hex.EncodeToString(b[0:4]) + "-" + hex.EncodeToString(b[4:6]) + "-" +
		hex.EncodeToString(b[6:8]) + "-" + hex.EncodeToString(b[8:10]) + "-" +
		hex.EncodeToString(b[10:16]), nil
}
