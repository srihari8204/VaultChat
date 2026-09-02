package routes

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// signNotify mints an event the way the games server does.
func signNotify(t *testing.T, key ed25519.PrivateKey, c gamesNotifyClaims) string {
	t.Helper()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodEdDSA, c).SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func validClaims(now time.Time) gamesNotifyClaims {
	return gamesNotifyClaims{
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

// parseNotify is the verification the handler performs, isolated so the rules
// can be asserted without a live database.
func parseNotify(tok string, pub ed25519.PublicKey) (*gamesNotifyClaims, error) {
	var c gamesNotifyClaims
	_, err := jwt.ParseWithClaims(tok, &c, func(*jwt.Token) (any, error) { return pub, nil },
		jwt.WithValidMethods([]string{"EdDSA"}),
		jwt.WithExpirationRequired(),
	)
	return &c, err
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
	tok, _, _, err := mintGamesToken(launchPriv, "@a", "A", time.Now())
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

func TestGamesNotifySlugRejectsUrlBreakingInput(t *testing.T) {
	// Each of these becomes part of games.corefinite.com/<game>.html?room=<room>.
	for _, bad := range []string{
		"", "   ", "../../etc/passwd", "rummy.html", "a b", "a&b=1", "a?b",
		"a/b", "a#b", "a'b", `a"b`, "a%2e%2e", strings.Repeat("a", 65),
	} {
		if got := gamesNotifySlug(bad); got != "" {
			t.Fatalf("gamesNotifySlug(%q) = %q, want rejected", bad, got)
		}
	}
	for _, good := range []string{"rummy", "tic-tac-toe", "snakes_ladders", "t-42", "ABC123"} {
		if got := gamesNotifySlug(good); got != good {
			t.Fatalf("gamesNotifySlug(%q) = %q, want it kept", good, got)
		}
	}
}

func TestGamesNotifyTextIsBounded(t *testing.T) {
	if got := gamesNotifyText("  hi  "); got != "hi" {
		t.Fatalf("trim: %q", got)
	}
	if got := gamesNotifyText(strings.Repeat("x", 500)); len(got) != gamesNotifyMaxText {
		t.Fatalf("len = %d, want %d", len(got), gamesNotifyMaxText)
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
	parsed, err := parseGamesNotifyKey(good)
	if err != nil {
		t.Fatalf("a valid PKIX Ed25519 key was rejected: %v", err)
	}
	if !parsed.Equal(pub) {
		t.Fatal("parsed key is not the key that went in")
	}

	if _, err := parseGamesNotifyKey("not pem at all"); err == nil {
		t.Fatal("non-PEM accepted")
	}
	// An RSA key verifies nothing we expect; it must not load as Ed25519.
	rsaPem := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: []byte("junk")}))
	if _, err := parseGamesNotifyKey(rsaPem); err == nil {
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
	pub, err := parseGamesNotifyKey(ofRecord)
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
	l, err := parseGamesNotifyKey(launch)
	if err != nil {
		t.Fatal(err)
	}
	n, err := parseGamesNotifyKey(notify)
	if err != nil {
		t.Fatalf("the notify public key of record does not parse: %v", err)
	}
	if l.Equal(n) {
		t.Fatal("launch and notify keys are the same — the split is the point")
	}
}

var _ = rand.Reader

// ── the live-tables list (migration 125) ──────────────────────────────

// THE SCOPING IS THE WHOLE SECURITY MODEL of this list.
//
// RLS is inert in production — the API connects as a superuser and bypasses
// every policy — so if the handler's own query stops filtering by user_id, the
// endpoint serves every player's tables to whoever asks first. This asserts the
// clause is still in the query the handler runs.
func TestGamesLiveTablesQueryScopesToTheCaller(t *testing.T) {
	if !strings.Contains(gamesLiveTablesSQL, "WHERE user_id = $1") {
		t.Fatal("the live-tables query must filter by user_id — RLS will not do it in prod")
	}
	if !strings.Contains(gamesLiveTablesSQL, "FROM games_live_tables") {
		t.Fatal("the live-tables query must read games_live_tables")
	}
}

// A friend request is about a person, not a table. Writing a row for one would
// put a game in the list that the player is not sitting at — and an unknown
// kind is treated the same way, because the games server can add kinds without
// telling us and this list is a promise about where a game can be picked up.
func TestOnlyTableKindsBecomeALiveTable(t *testing.T) {
	for _, kind := range []string{"turn", "invite"} {
		if !gamesLiveKinds[kind] {
			t.Errorf("kind %q means the player has a table and must be remembered", kind)
		}
	}
	for _, kind := range []string{"friend", "", "achievement", "TURN "} {
		if gamesLiveKinds[kind] {
			t.Errorf("kind %q must not create a live table", kind)
		}
	}
}
