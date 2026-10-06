package notifykey

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// signNotify mints an event the way the games server does.
func signNotify(t *testing.T, key ed25519.PrivateKey, c Claims) string {
	t.Helper()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodEdDSA, c).SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func validClaims(now time.Time) Claims {
	return Claims{
		Kind: "turn", Title: "Your turn", Body: "Srihari played a card",
		Game: "rummy", Room: "t-42",
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "v337da54a1d30",
			ID:        "jti-1",
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		},
	}
}

// parseNotify is the verification Verify performs.
func parseNotify(tok string, pub ed25519.PublicKey) (*Claims, error) { return Parse(tok, pub) }

func testKey(t *testing.T) (ed25519.PrivateKey, ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv, pub
}

func TestGamesNotifyAcceptsAWellFormedEvent(t *testing.T) {
	priv, pub := testKey(t)
	got, err := parseNotify(signNotify(t, priv, validClaims(time.Now())), pub)
	if err != nil {
		t.Fatalf("a valid event was rejected: %v", err)
	}
	if got.Subject != "v337da54a1d30" || got.ID != "jti-1" {
		t.Fatalf("claims lost in transit: sub=%q jti=%q", got.Subject, got.ID)
	}
	if got.Game != "rummy" || got.Room != "t-42" {
		t.Fatalf("deep-link claims lost: game=%q room=%q", got.Game, got.Room)
	}
}

func TestGamesNotifyRejectsWrongKey(t *testing.T) {
	priv, _ := testKey(t)
	_, otherPub := testKey(t)
	if _, err := parseNotify(signNotify(t, priv, validClaims(time.Now())), otherPub); err == nil {
		t.Fatal("an event signed by an unknown key was accepted")
	}
}

func TestGamesNotifyRejectsExpired(t *testing.T) {
	priv, pub := testKey(t)
	c := validClaims(time.Now().Add(-10 * time.Minute))
	if _, err := parseNotify(signNotify(t, priv, c), pub); err == nil {
		t.Fatal("an expired event was accepted")
	}
}

// An event with no exp must not verify. jwt v5 treats a missing exp as "no
// expiry" unless told otherwise, so WithExpirationRequired is the only thing
// standing between us and a token that replays forever.
func TestGamesNotifyRejectsMissingExpiry(t *testing.T) {
	priv, pub := testKey(t)
	c := validClaims(time.Now())
	c.ExpiresAt = nil
	if _, err := parseNotify(signNotify(t, priv, c), pub); err == nil {
		t.Fatal("an event with no exp was accepted")
	}
}

// The launch-token keypair must not be able to mint notify events. If these two
// ever share a key, possession of one direction grants the other.
func TestGamesNotifyRejectsLaunchTokenKey(t *testing.T) {
	launchPriv, _ := testKey(t)
	_, notifyPub := testKey(t)
	tok, err := jwt.NewWithClaims(jwt.SigningMethodEdDSA, jwt.MapClaims{"sub": "@a", "name": "A",
		"iss": "vaultchat", "aud": "vaultchat-games", "exp": time.Now().Add(time.Minute).Unix()}).SignedString(launchPriv)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseNotify(tok, notifyPub); err == nil {
		t.Fatal("a launch token was accepted as a notify event")
	}
}

// HS256 signed with the public key as the secret is the classic algorithm
// confusion attack. WithValidMethods is what refuses it.
func TestGamesNotifyRejectsAlgorithmConfusion(t *testing.T) {
	_, pub := testKey(t)
	forged, err := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims(time.Now())).SignedString([]byte(pub))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseNotify(forged, pub); err == nil {
		t.Fatal("an HS256 forgery was accepted")
	}
}

// The key loader must accept exactly what the games server hands over: a PKIX
// PEM public key, and nothing else.
func TestParseGamesNotifyKey(t *testing.T) {
	_, pub := testKey(t)
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	good := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	parsed, err := ParseKey(good)
	if err != nil {
		t.Fatalf("a valid PKIX Ed25519 key was rejected: %v", err)
	}
	if !parsed.Equal(pub) {
		t.Fatal("parsed key is not the key that went in")
	}

	if _, err := ParseKey("not pem at all"); err == nil {
		t.Fatal("non-PEM accepted")
	}
	// An RSA key verifies nothing we expect; it must not load as Ed25519.
	rsaPem := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: []byte("junk")}))
	if _, err := ParseKey(rsaPem); err == nil {
		t.Fatal("a non-Ed25519 PEM was accepted")
	}
}

// The public key the games server verifies launches against, from the handover
// brief. This does not prove we hold the private half — only the running server
// can — but it pins the value so a silent edit to it is caught here.
func TestGamesLaunchPublicKeyOfRecordParses(t *testing.T) {
	const ofRecord = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAAOuEDU0rePRDEmBGtQFOHl3Pd9tR1KdhM7jnCtgtmKQ=
-----END PUBLIC KEY-----`
	pub, err := ParseKey(ofRecord)
	if err != nil {
		t.Fatalf("the launch public key of record does not parse: %v", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		t.Fatalf("key size %d", len(pub))
	}
}

// The notify public key from the brief, pinned the same way. It must be a
// DIFFERENT key from the launch one — that separation is the security property.
func TestGamesNotifyPublicKeyOfRecordIsSeparate(t *testing.T) {
	const launch = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAAOuEDU0rePRDEmBGtQFOHl3Pd9tR1KdhM7jnCtgtmKQ=
-----END PUBLIC KEY-----`
	const notify = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7wrB2MUzhRVxDaSTi+H2sgFuhNyjIX/mzX+ZlZzh568=
-----END PUBLIC KEY-----`
	l, err := ParseKey(launch)
	if err != nil {
		t.Fatal(err)
	}
	n, err := ParseKey(notify)
	if err != nil {
		t.Fatalf("the notify public key of record does not parse: %v", err)
	}
	if l.Equal(n) {
		t.Fatal("launch and notify keys are the same — the split is the point")
	}
}

var _ = rand.Reader
