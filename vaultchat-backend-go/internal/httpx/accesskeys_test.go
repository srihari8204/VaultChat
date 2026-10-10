package httpx

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func writeKeys(t *testing.T) (privPath, pubPath string, priv ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	pk, _ := x509.MarshalPKCS8PrivateKey(priv)
	pb, _ := x509.MarshalPKIXPublicKey(pub)
	privPath, pubPath = filepath.Join(dir, "access.key"), filepath.Join(dir, "access.pub")
	os.WriteFile(privPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pk}), 0o600)
	os.WriteFile(pubPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pb}), 0o600)
	return privPath, pubPath, priv
}

func claims() jwt.MapClaims {
	now := time.Now().Unix()
	return jwt.MapClaims{"sub": "u1", "email": "a@b.c", "iat": now, "exp": now + 900}
}

func hsToken(t *testing.T) string {
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims()).SignedString([]byte(os.Getenv("JWT_SECRET")))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func edToken(t *testing.T, key ed25519.PrivateKey) string {
	tok, err := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims()).SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func accepts(tok string) bool {
	sub, _, _, err := VerifyAccess(tok)
	return err == nil && sub == "u1"
}

func TestAccessTokenModes(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-test-secret-test-secret")
	privPath, pubPath, priv := writeKeys(t)
	_, _, otherPriv := writeKeys(t)
	defer LoadAccessKeys() // leave legacy mode behind for other tests

	// Legacy: no key files, HS256 as always, EdDSA refused.
	t.Setenv("ACCESS_TOKEN_PRIVATE_KEY_FILE", "")
	t.Setenv("ACCESS_TOKEN_PUBLIC_KEY_FILE", "")
	if err := LoadAccessKeys(); err != nil {
		t.Fatal(err)
	}
	if !accepts(hsToken(t)) || accepts(edToken(t, priv)) {
		t.Fatal("legacy mode must take HS256 only")
	}

	// Core, inside the window: both.
	t.Setenv("ACCESS_TOKEN_PRIVATE_KEY_FILE", privPath)
	if err := LoadAccessKeys(); err != nil {
		t.Fatal(err)
	}
	if AccessSigningKey() == nil || !accepts(edToken(t, priv)) || !accepts(hsToken(t)) {
		t.Fatal("core must sign EdDSA and accept HS256 inside the window")
	}
	if accepts(edToken(t, otherPriv)) {
		t.Fatal("EdDSA signed by another key must be refused")
	}

	// Core, after the window.
	hs256Until = time.Now().Add(-time.Second)
	if accepts(hsToken(t)) || !accepts(edToken(t, priv)) {
		t.Fatal("after the window HS256 must be refused and EdDSA accepted")
	}

	// Core with ACCESS_TOKEN_HS256=off: closed from boot.
	t.Setenv("ACCESS_TOKEN_HS256", "off")
	if err := LoadAccessKeys(); err != nil {
		t.Fatal(err)
	}
	if accepts(hsToken(t)) {
		t.Fatal("ACCESS_TOKEN_HS256=off must refuse HS256")
	}
	t.Setenv("ACCESS_TOKEN_HS256", "")

	// Service: public key only, EdDSA only, and nothing to sign with.
	t.Setenv("ACCESS_TOKEN_PRIVATE_KEY_FILE", "")
	t.Setenv("ACCESS_TOKEN_PUBLIC_KEY_FILE", pubPath)
	if err := LoadAccessKeys(); err != nil {
		t.Fatal(err)
	}
	if AccessSigningKey() != nil || !HasAccessPublicKey() {
		t.Fatal("service mode holds only the public key")
	}
	if !accepts(edToken(t, priv)) || accepts(hsToken(t)) {
		t.Fatal("service mode must take EdDSA only")
	}

	// A bad key file is an error, not a silent fallback.
	t.Setenv("ACCESS_TOKEN_PUBLIC_KEY_FILE", privPath)
	if err := LoadAccessKeys(); err == nil {
		t.Fatal("a private key in the public-key file must be refused")
	}
}
