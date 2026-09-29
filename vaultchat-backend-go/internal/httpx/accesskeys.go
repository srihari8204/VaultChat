package httpx

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"time"
)

// Access-token keys (openspec: microservices-prepare, "Core signs logins,
// services check them").
//
// Three modes, decided once at boot by LoadAccessKeys:
//
//   - legacy (no key file set): HS256 over JWT_SECRET, exactly as before.
//   - core (ACCESS_TOKEN_PRIVATE_KEY_FILE): signs EdDSA; verifies EdDSA, and
//     HS256 only for one access-token lifetime after boot so tokens issued
//     before the switch expire naturally instead of logging everyone out.
//     ACCESS_TOKEN_HS256=off closes that window immediately.
//   - service (ACCESS_TOKEN_PUBLIC_KEY_FILE only): verifies EdDSA, never HS256,
//     so a feature service never needs the login secret.
//
// Keys are PEM files, the same format as the games launch key: PKCS#8 for the
// private key (`openssl genpkey -algorithm ed25519`), PKIX for the public one
// (`openssl pkey -pubout`).
var (
	accessPriv ed25519.PrivateKey
	accessPub  ed25519.PublicKey
	// hs256Until bounds HS256 acceptance once an Ed25519 key is loaded. Zero
	// means legacy mode: HS256 with no bound.
	hs256Until time.Time
)

// LoadAccessKeys reads the key files named in the environment. main calls it
// once before serving; a set but unreadable file is fatal there, because a
// process that silently fell back to HS256 would reject every token core signs.
func LoadAccessKeys() error {
	accessPriv, accessPub, hs256Until = nil, nil, time.Time{}
	if path := os.Getenv("ACCESS_TOKEN_PRIVATE_KEY_FILE"); path != "" {
		priv, err := readPrivateKey(path)
		if err != nil {
			return fmt.Errorf("ACCESS_TOKEN_PRIVATE_KEY_FILE: %w", err)
		}
		accessPriv = priv
		accessPub = priv.Public().(ed25519.PublicKey)
		hs256Until = time.Now().Add(time.Duration(AccessTTLSeconds()) * time.Second)
		if os.Getenv("ACCESS_TOKEN_HS256") == "off" {
			hs256Until = time.Now()
		}
		return nil
	}
	if path := os.Getenv("ACCESS_TOKEN_PUBLIC_KEY_FILE"); path != "" {
		pub, err := readPublicKey(path)
		if err != nil {
			return fmt.Errorf("ACCESS_TOKEN_PUBLIC_KEY_FILE: %w", err)
		}
		accessPub = pub
		hs256Until = time.Unix(0, 0) // closed: a service never takes HS256
	}
	return nil
}

// AccessSigningKey is core's private key, or nil in legacy and service mode.
func AccessSigningKey() ed25519.PrivateKey { return accessPriv }

// HasAccessPublicKey reports whether this process can verify Ed25519 tokens.
func HasAccessPublicKey() bool { return accessPub != nil }

// AccessTTLSeconds is the access-token lifetime: JWT_ACCESS_TTL, 15 minutes by
// default. The HS256 window is sized from it, so it must match what signed.
func AccessTTLSeconds() int64 {
	if n, ok := ParseIntPrefix(os.Getenv("JWT_ACCESS_TTL")); ok {
		return n
	}
	return 15 * 60
}

// hs256Accepted reports whether an HS256 access token may be verified now.
func hs256Accepted(now time.Time) bool {
	return hs256Until.IsZero() || now.Before(hs256Until)
}

func readPrivateKey(path string) (ed25519.PrivateKey, error) {
	block, err := readPEM(path)
	if err != nil {
		return nil, err
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("not an Ed25519 private key")
	}
	return priv, nil
}

func readPublicKey(path string) (ed25519.PublicKey, error) {
	block, err := readPEM(path)
	if err != nil {
		return nil, err
	}
	k, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	pub, ok := k.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("not an Ed25519 public key")
	}
	return pub, nil
}

func readPEM(path string) (*pem.Block, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, errors.New("not PEM")
	}
	return block, nil
}
