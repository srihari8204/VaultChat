package games

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"vaultchat/backend-go/internal/db"
)

var gctMount = Register

// THE GAMES CONTRACT, END TO END, AGAINST A REAL DATABASE.
//
// Every /games/* endpoint is driven through its real handlers and adapters and
// the status + body of each step is compared with a golden file recorded from
// the pre-hexagonal handlers in internal/routes (openspec:
// hexagonal-architecture). Volatile values (tokens, nonces, ids, times) are
// masked; everything else must match byte for byte.
//
// Skipped unless CALL_TEST_DB=1 and DB_* point at a scratch database with the
// migrations applied, like the other DB-backed route tests.

const (
	gctA    = "6a6a6a6a-0000-4000-8000-00000000000a" // vault id + legacy name
	gctB    = "6a6a6a6a-0000-4000-8000-00000000000b" // no vault id
	gctC    = "6a6a6a6a-0000-4000-8000-00000000000c" // vault id + a device token
	gctNone = "6a6a6a6a-0000-4000-8000-0000000000ff" // no such user
)

var gctVolatile = regexp.MustCompile(`"(token|nonce|exp|updatedAt|id)":("[^"]*"|[0-9]+)`)

func gctCleanup(ctx context.Context) {
	for _, q := range []string{
		`DELETE FROM games_live_tables WHERE user_id IN ($1,$2,$3)`,
		`DELETE FROM devices WHERE user_id IN ($1,$2,$3)`,
		`DELETE FROM users WHERE id IN ($1,$2,$3)`,
	} {
		_, _ = db.Pool.Exec(ctx, q, gctA, gctB, gctC)
	}
	_, _ = db.Pool.Exec(ctx, `DELETE FROM games_notify_seen WHERE jti LIKE 'gct-%'`)
	_, _ = db.Pool.Exec(ctx, `DELETE FROM games_matches WHERE table_id LIKE 'gct-%'`)
}

func gctPEM(t *testing.T, typ string, der []byte, err error) string {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der}))
}

func TestGamesContract(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	gctCleanup(ctx)
	t.Cleanup(func() { gctCleanup(ctx) })
	for _, q := range []string{
		`INSERT INTO users (id, email, name, vault_id) VALUES ('` + gctA + `','a@gct.test','Alice','vgctA')`,
		`INSERT INTO users (id, email, name) VALUES ('` + gctB + `','b@gct.test','Bob')`,
		`INSERT INTO users (id, email, name, vault_id) VALUES ('` + gctC + `','c@gct.test',NULL,'vgctC')`,
		`INSERT INTO devices (user_id, push_token, platform, fcm_token) VALUES ('` + gctC + `','fcm:gct','android','gct-fcm-token')`,
	} {
		if _, err := db.Pool.Exec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	launchPub, launchPriv, _ := ed25519.GenerateKey(rand.Reader)
	notifyPub, notifyPriv, _ := ed25519.GenerateKey(rand.Reader)
	keyFile := filepath.Join(t.TempDir(), "launch.pem")
	der, err := x509.MarshalPKCS8PrivateKey(launchPriv)
	if err := os.WriteFile(keyFile, []byte(gctPEM(t, "PRIVATE KEY", der, err)), 0o600); err != nil {
		t.Fatal(err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(notifyPub)
	t.Setenv("GAMES_SIGNING_PRIVATE_KEY_FILE", keyFile)
	t.Setenv("GAMES_NOTIFY_PUBLIC_KEY_PEM", gctPEM(t, "PUBLIC KEY", pubDER, err))
	t.Setenv("LIVEKIT_API_KEY", "gct-key")
	t.Setenv("LIVEKIT_API_SECRET", "gct-secret-gct-secret-gct-secret-gct")
	t.Setenv("LIVEKIT_URL", "wss://lk.gct.test")
	t.Setenv("JWT_SECRET", "gct-jwt")

	mux := http.NewServeMux()
	gctMount(mux)

	event := func(sub, jti, kind string, exp bool) string {
		claims := jwt.MapClaims{"sub": sub, "jti": jti, "kind": kind, "title": "  Your turn  ",
			"body": "Alice played", "game": "rummy", "room": "gct-t1", "iat": time.Now().Unix()}
		if exp {
			claims["exp"] = time.Now().Add(5 * time.Minute).Unix()
		}
		tok, err := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims).SignedString(notifyPriv)
		if err != nil {
			t.Fatal(err)
		}
		return `{"event":"` + tok + `"}`
	}
	_, wrongPriv, _ := ed25519.GenerateKey(rand.Reader)
	wrongTok, _ := jwt.NewWithClaims(jwt.SigningMethodEdDSA, jwt.MapClaims{"sub": "vgctA", "jti": "gct-w",
		"exp": time.Now().Add(time.Minute).Unix()}).SignedString(wrongPriv)

	var log strings.Builder
	var matchID string
	do := func(step, user, method, path, body string) string {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if user != "" {
			tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
				"sub": user, "exp": time.Now().Add(time.Minute).Unix()}).SignedString([]byte("gct-jwt"))
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		raw := strings.TrimSpace(rec.Body.String())
		fmt.Fprintf(&log, "%s %d %s\n", step, rec.Code, gctVolatile.ReplaceAllString(raw, `"$1":"*"`))
		return raw
	}

	// Launch token: the minted token must verify as the games server would.
	raw := do("launch/ok", gctA, "POST", "/games/launch-token", "")
	var lt struct{ Token string }
	_ = json.Unmarshal([]byte(raw), &lt)
	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(lt.Token, claims, func(*jwt.Token) (any, error) { return launchPub, nil },
		jwt.WithValidMethods([]string{"EdDSA"}), jwt.WithIssuer("vaultchat"), jwt.WithAudience("vaultchat-games")); err != nil {
		t.Fatalf("launch token does not verify: %v", err)
	}
	fmt.Fprintf(&log, "launch/claims sub=%v name=%v n=%d\n", claims["sub"], claims["name"], len(claims))
	do("launch/no-vault", gctB, "POST", "/games/launch-token", "")
	do("launch/no-user", gctNone, "POST", "/games/launch-token", "")
	do("launch/no-auth", "", "POST", "/games/launch-token", "")

	do("voice/player", gctA, "POST", "/games/voice-token", `{"game":"rummy","room":"gct-t1"}`)
	do("voice/spectator", gctC, "POST", "/games/voice-token", `{"game":"ludo","room":"gct-t1","spectator":true}`)
	do("voice/unknown-game", gctA, "POST", "/games/voice-token", `{"game":"chess","room":"gct-t1"}`)
	do("voice/bad-slug", gctA, "POST", "/games/voice-token", `{"game":"rummy","room":"a/b"}`)
	do("voice/bad-body", gctA, "POST", "/games/voice-token", `nope`)
	do("voice/no-vault", gctB, "POST", "/games/voice-token", `{"game":"rummy","room":"gct-t1"}`)

	do("notify/no-event", "", "POST", "/games/notify", `{}`)
	do("notify/bad-sig", "", "POST", "/games/notify", `{"event":"`+wrongTok+`"}`)
	do("notify/no-exp", "", "POST", "/games/notify", event("vgctA", "gct-0", "turn", false))
	do("notify/no-jti", "", "POST", "/games/notify", event("vgctA", "", "turn", true))
	do("notify/no-device", "", "POST", "/games/notify", event("vgctA", "gct-1", "turn", true))
	do("notify/dedupe", "", "POST", "/games/notify", event("vgctA", "gct-1", "turn", true))
	do("notify/friend", "", "POST", "/games/notify", event("vgctA", "gct-2", "friend", true))
	do("notify/unknown", "", "POST", "/games/notify", event("vgctZ", "gct-3", "turn", true))
	do("notify/push-fails", "", "POST", "/games/notify", event("vgctC", "gct-4", "invite", true))
	do("notify/push-fails-again", "", "POST", "/games/notify", event("vgctC", "gct-4", "invite", true))

	do("tables/A", gctA, "GET", "/games/tables", "")
	do("tables/C", gctC, "GET", "/games/tables", "")
	do("tables/forget-bad", gctA, "DELETE", "/games/tables?game=rummy", "")
	do("tables/forget", gctA, "DELETE", "/games/tables?game=rummy&room=gct-t1", "")
	do("tables/A-after", gctA, "GET", "/games/tables", "")

	do("device/missing", gctB, "POST", "/games/device-token", `{}`)
	do("device/register", gctB, "POST", "/games/device-token", `{"fcmToken":" gct-b-token "}`)
	do("device/unregister", gctB, "POST", "/games/device-token", `{"fcmToken":"gct-b-token","unregister":true}`)
	var n int
	_ = db.Pool.QueryRow(ctx, `SELECT count(*) FROM devices WHERE user_id = $1 AND fcm_token IS NOT NULL`, gctB).Scan(&n)
	fmt.Fprintf(&log, "device/live-after-unregister %d\n", n)

	do("match/not-practice", gctA, "POST", "/games/matches", `{"tableId":"gct-m1","variant":"pool101"}`)
	do("match/bad-variant", gctA, "POST", "/games/matches", `{"tableId":"gct-m1","variant":"pool151","practice":true}`)
	do("match/bad-body", gctA, "POST", "/games/matches", `[`)
	do("match/no-vault", gctB, "POST", "/games/matches", `{"tableId":"gct-m1","variant":"pool101","practice":true}`)
	raw = do("match/create", gctA, "POST", "/games/matches", `{"tableId":"gct-m1","variant":"pool101","practice":true}`)
	var m struct{ Match struct{ ID string } }
	_ = json.Unmarshal([]byte(raw), &m)
	matchID = m.Match.ID
	raw = do("match/create-again", gctC, "POST", "/games/matches", `{"tableId":"gct-m1","variant":"deals2","practice":true}`)
	_ = json.Unmarshal([]byte(raw), &m)
	fmt.Fprintf(&log, "match/same-id %v\n", m.Match.ID == matchID)
	do("match/get", gctA, "GET", "/games/matches?tableId=gct-m1", "")
	do("match/get-none", gctA, "GET", "/games/matches?tableId=gct-none", "")
	do("match/get-missing", gctA, "GET", "/games/matches", "")
	do("match/deal-missing", gctA, "POST", "/games/matches/deal", `{"matchId":"`+matchID+`"}`)
	do("match/deal-unknown", gctA, "POST", "/games/matches/deal",
		`{"matchId":"6a6a6a6a-0000-4000-8000-0000000000ee","dealIndex":0,"results":[{"vaultId":"vgctA","points":5}]}`)
	do("match/deal-no-vault", gctB, "POST", "/games/matches/deal", `{"matchId":"`+matchID+`","dealIndex":0,"results":[{"vaultId":"x"}]}`)
	results := `"results":[{"vaultId":"vgctA","name":"Alice","points":0,"winner":true},{"vaultId":"vgctC","name":"Cee","points":80}]`
	do("match/deal-0", gctA, "POST", "/games/matches/deal", `{"matchId":"`+matchID+`","dealIndex":0,`+results+`}`)
	do("match/deal-0-again", gctC, "POST", "/games/matches/deal", `{"matchId":"`+matchID+`","dealIndex":0,`+results+`}`)
	do("match/deal-1-out", gctA, "POST", "/games/matches/deal",
		`{"matchId":"`+matchID+`","dealIndex":1,"results":[{"vaultId":"vgctA","points":2},{"vaultId":"vgctC","points":30}]}`)
	do("match/deal-after-end", gctA, "POST", "/games/matches/deal",
		`{"matchId":"`+matchID+`","dealIndex":2,"results":[{"vaultId":"vgctA","points":2}]}`)

	golden := os.Getenv("GAMES_GOLDEN")
	if golden == "" {
		golden = "testdata/games_contract.golden"
	}
	if os.Getenv("GAMES_GOLDEN_WRITE") == "1" {
		if err := os.WriteFile(golden, []byte(log.String()), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if got := log.String(); got != string(want) {
		t.Fatalf("games contract changed.\n--- want\n%s\n--- got\n%s", want, got)
	}
}
