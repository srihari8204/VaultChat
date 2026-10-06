// Package launchtoken implements app.LaunchSigner: the Ed25519-signed token the
// VaultGames mini-app (games.corefinite.com) exchanges for its own session
// (openspec: hexagonal-architecture; port of vaultchat-server/mintLaunchToken.ts).
//
// The PRIVATE key lives ONLY here (GAMES_SIGNING_PRIVATE_KEY_FILE/_PEM); the
// games server holds the public half. The token carries vaultId + displayName +
// nonce and NOTHING else — the games server rejects any unexpected claim
// outright, so never add fields here. No phone, no email, no keys.
package launchtoken

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"os"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"vaultchat/backend-go/internal/games/app"
)

const (
	// Fixed by the games server (go-server/internal/shared/types.go). Changing
	// either value here makes every token fail verification.
	Issuer   = "vaultchat"
	Audience = "vaultchat-games"
)

// Signer loads its key once — a missing/malformed key is a deploy error, not a
// per-request one.
type Signer struct {
	once sync.Once
	key  ed25519.PrivateKey
	err  error
}

var _ app.LaunchSigner = (*Signer)(nil)

func (s *Signer) load() (ed25519.PrivateKey, error) {
	s.once.Do(func() {
		// Prefer the file: the key then never appears in `docker inspect`,
		// `docker compose config`, the process environment or a crash dump —
		// only a path does.
		if path := os.Getenv("GAMES_SIGNING_PRIVATE_KEY_FILE"); path != "" {
			b, err := os.ReadFile(path)
			if err != nil {
				s.err = err
				return
			}
			s.key, s.err = ParseKey(string(b))
			return
		}
		pemStr := os.Getenv("GAMES_SIGNING_PRIVATE_KEY_PEM")
		if pemStr == "" {
			s.err = errors.New("GAMES_SIGNING_PRIVATE_KEY_FILE/_PEM not set")
			return
		}
		s.key, s.err = ParseKey(pemStr)
	})
	return s.key, s.err
}

func (s *Signer) Ready() error { _, err := s.load(); return err }

func (s *Signer) Sign(vaultID, name string, iat, exp time.Time) (string, string, error) {
	key, err := s.load()
	if err != nil {
		return "", "", err
	}
	return Mint(key, vaultID, name, iat, exp)
}

// ParseKey reads a PEM PKCS#8 Ed25519 private key (what `openssl genpkey
// -algorithm ed25519` and go-server's cmd/genkeys both emit).
func ParseKey(pemStr string) (ed25519.PrivateKey, error) {
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

// Mint builds the signed token. Exactly these seven claims — the games server
// rejects any extra one, so this is the contract (see launchtoken_test.go).
func Mint(key ed25519.PrivateKey, vaultID, name string, iat, exp time.Time) (token, nonce string, err error) {
	if nonce, err = newNonce(); err != nil {
		return "", "", err
	}
	token, err = jwt.NewWithClaims(jwt.SigningMethodEdDSA, jwt.MapClaims{
		"sub":   vaultID,
		"name":  name,
		"nonce": nonce,
		"iss":   Issuer,
		"aud":   Audience,
		"iat":   iat.Unix(),
		"exp":   exp.Unix(),
	}).SignedString(key)
	if err != nil {
		return "", "", err
	}
	return token, nonce, nil
}

// newNonce is a random UUIDv4.
func newNonce() (string, error) {
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
