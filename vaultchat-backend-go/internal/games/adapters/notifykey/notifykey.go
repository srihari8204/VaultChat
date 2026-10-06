// Package notifykey implements app.NotifyVerifier: inbound events FROM the
// games server, signed with ITS key (openspec: hexagonal-architecture).
//
// TWO KEYPAIRS, NOT ONE. launchtoken holds the launch PRIVATE key (VaultChat
// signs, the games server verifies); this holds the notify PUBLIC key (the
// games server signs, VaultChat verifies). They are separate on purpose and
// must never be crossed — reusing the launch keypair here would mean handing
// the games server our signing key.
package notifykey

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"log"
	"os"
	"strings"
	"sync"

	"github.com/golang-jwt/jwt/v5"

	"vaultchat/backend-go/internal/games/app"
	"vaultchat/backend-go/internal/games/domain"
)

// Claims is the event contract. jwt.RegisteredClaims supplies sub (recipient
// vaultId), jti (dedupe key), iat and exp.
type Claims struct {
	Kind  string `json:"kind"`  // turn | invite | friend
	Title string `json:"title"` // short, already human-readable
	Body  string `json:"body"`
	Game  string `json:"game"` // file stem, e.g. "rummy"
	Room  string `json:"room"` // table id — the tap must open THIS table
	jwt.RegisteredClaims
}

type Verifier struct {
	once sync.Once
	key  ed25519.PublicKey
	err  error
}

var _ app.NotifyVerifier = (*Verifier)(nil)

// load reads the key once. File first, for the same reason as the signing key:
// a path in the environment instead of key material in `docker inspect`.
func (v *Verifier) load() (ed25519.PublicKey, error) {
	v.once.Do(func() {
		pemStr := os.Getenv("GAMES_NOTIFY_PUBLIC_KEY_PEM")
		if path := os.Getenv("GAMES_NOTIFY_PUBLIC_KEY_FILE"); path != "" {
			b, err := os.ReadFile(path)
			if err != nil {
				v.err = err
				return
			}
			pemStr = string(b)
		}
		if strings.TrimSpace(pemStr) == "" {
			v.err = errors.New("GAMES_NOTIFY_PUBLIC_KEY_FILE/_PEM not set")
			return
		}
		v.key, v.err = ParseKey(pemStr)
	})
	return v.key, v.err
}

func (v *Verifier) Ready() error { _, err := v.load(); return err }

func (v *Verifier) Verify(event string) (domain.Event, error) {
	pub, err := v.load()
	if err != nil {
		return domain.Event{}, err
	}
	c, err := Parse(event, pub)
	if err != nil {
		log.Printf("[games-notify] rejected: %v", err)
		return domain.Event{}, err
	}
	ev := domain.Event{Recipient: c.Subject, ID: c.ID, Kind: c.Kind, Title: c.Title, Body: c.Body, Game: c.Game, Room: c.Room}
	if c.ExpiresAt != nil {
		t := c.ExpiresAt.Time
		ev.ExpiresAt = &t
	}
	return ev, nil
}

// Parse verifies an event: EdDSA only (refusing the HS256-with-public-key
// algorithm confusion), and exp REQUIRED — without it a token minted with no
// exp verifies forever.
func Parse(event string, pub ed25519.PublicKey) (*Claims, error) {
	var c Claims
	_, err := jwt.ParseWithClaims(event, &c,
		func(*jwt.Token) (any, error) { return pub, nil },
		jwt.WithValidMethods([]string{"EdDSA"}),
		jwt.WithExpirationRequired(),
	)
	return &c, err
}

func ParseKey(pemStr string) (ed25519.PublicKey, error) {
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
