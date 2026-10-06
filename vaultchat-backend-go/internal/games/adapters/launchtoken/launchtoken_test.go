package launchtoken

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// The games server verifies with exactly these rules (go-server/internal/auth):
// EdDSA only, iss/aud fixed, exp required, and ANY claim outside this set is a
// hard rejection. If this test fails, every launch token fails in production.
var gamesAllowedClaims = map[string]bool{
	"sub": true, "name": true, "nonce": true, "iss": true, "aud": true, "iat": true, "exp": true,
}

func testKey(t *testing.T) (ed25519.PrivateKey, ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv, pub
}

func TestMintGamesTokenVerifiesLikeGamesServer(t *testing.T) {
	priv, pub := testKey(t)

	now := time.Now()
	tok, nonce, err := Mint(priv, "@srihari", "Srihari", now, now.Add(15*time.Minute))
	exp := now.Add(15 * time.Minute).Unix()
	if err != nil {
		t.Fatal(err)
	}

	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(tok, claims, func(*jwt.Token) (any, error) { return pub, nil },
		jwt.WithValidMethods([]string{"EdDSA"}),
		jwt.WithIssuer(Issuer),
		jwt.WithAudience(Audience),
		jwt.WithExpirationRequired(),
	); err != nil {
		t.Fatalf("games server would reject this token: %v", err)
	}

	for k := range claims {
		if !gamesAllowedClaims[k] {
			t.Fatalf("forbidden claim %q would be rejected by the games server", k)
		}
	}
	if got := claims["sub"]; got != "@srihari" {
		t.Fatalf("sub = %v, want the vaultId", got)
	}
	if got := claims["name"]; got != "Srihari" {
		t.Fatalf("name = %v", got)
	}
	if claims["nonce"] != nonce || nonce == "" {
		t.Fatalf("nonce mismatch: claim=%v returned=%q", claims["nonce"], nonce)
	}
	if exp <= time.Now().Unix() {
		t.Fatalf("exp %d is not in the future", exp)
	}
}

func TestMintGamesTokenRejectedByWrongKey(t *testing.T) {
	priv, _ := testKey(t)
	_, otherPub := testKey(t)

	tok, _, err := Mint(priv, "@a", "A", time.Now(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jwt.Parse(tok, func(*jwt.Token) (any, error) { return otherPub, nil },
		jwt.WithValidMethods([]string{"EdDSA"})); err == nil {
		t.Fatal("token verified under the wrong public key")
	}
}

func TestParseGamesKeyRoundTrip(t *testing.T) {
	priv, _ := testKey(t)
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	pemStr := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))

	got, err := ParseKey(pemStr)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Equal(priv) {
		t.Fatal("parsed key differs from the original")
	}
	if _, err := ParseKey("not a pem"); err == nil {
		t.Fatal("expected an error for non-PEM input")
	}
}
