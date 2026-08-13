package routes

import (
	"crypto/sha256"
	"encoding/base64"
	"testing"

	"github.com/golang-jwt/jwt/v5"

	"vaultchat/backend-go/internal/livekit"
)

var whCfg = livekit.Config{APIKey: "APIkey123", APISecret: "secret-that-is-long-enough"}

// sign builds the header LiveKit sends: HS256 over {iss, sha256(body)}.
func sign(t *testing.T, cfg livekit.Config, iss string, body []byte, hashOverride string) string {
	t.Helper()
	h := sha256.Sum256(body)
	sum := base64.StdEncoding.EncodeToString(h[:])
	if hashOverride != "" {
		sum = hashOverride
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256,
		jwt.MapClaims{"iss": iss, "sha256": sum}).SignedString([]byte(cfg.APISecret))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return tok
}

func TestWebhookSignatureAccepted(t *testing.T) {
	body := []byte(`{"event":"egress_started"}`)
	if !verifyLivekitSignature(whCfg, sign(t, whCfg, whCfg.APIKey, body, ""), body) {
		t.Fatal("a correctly signed delivery was rejected")
	}
	// LiveKit emits standard base64; unpadded must not be a reason to drop a
	// genuine delivery.
	h := sha256.Sum256(body)
	raw := base64.RawStdEncoding.EncodeToString(h[:])
	if !verifyLivekitSignature(whCfg, sign(t, whCfg, whCfg.APIKey, body, raw), body) {
		t.Fatal("unpadded base64 body hash was rejected")
	}
	// A Bearer prefix is tolerated rather than fatal.
	if !verifyLivekitSignature(whCfg, "Bearer "+sign(t, whCfg, whCfg.APIKey, body, ""), body) {
		t.Fatal("Bearer-prefixed header was rejected")
	}
}

// The body hash is what stops a captured header being replayed over a
// different payload — the difference between "someone signed something" and
// "this exact event is authentic".
func TestWebhookRejectsSwappedBody(t *testing.T) {
	signed := []byte(`{"event":"egress_started","egress_info":{"egress_id":"EG_real"}}`)
	attacker := []byte(`{"event":"egress_started","egress_info":{"egress_id":"EG_theirs"}}`)
	if verifyLivekitSignature(whCfg, sign(t, whCfg, whCfg.APIKey, signed, ""), attacker) {
		t.Fatal("a header signed for one body was accepted over another")
	}
}

func TestWebhookRejectsBadCredentials(t *testing.T) {
	body := []byte(`{"event":"egress_started"}`)

	// Signed with a different secret — the ordinary forgery attempt.
	wrong := livekit.Config{APIKey: whCfg.APIKey, APISecret: "not-the-real-secret"}
	if verifyLivekitSignature(whCfg, sign(t, wrong, whCfg.APIKey, body, ""), body) {
		t.Fatal("a token signed with the wrong secret was accepted")
	}
	// Right secret, wrong project.
	if verifyLivekitSignature(whCfg, sign(t, whCfg, "someone-elses-key", body, ""), body) {
		t.Fatal("a token from another API key was accepted")
	}
	// A sha256 claim that is simply absent must not read as "nothing to check".
	noHash, err := jwt.NewWithClaims(jwt.SigningMethodHS256,
		jwt.MapClaims{"iss": whCfg.APIKey}).SignedString([]byte(whCfg.APISecret))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if verifyLivekitSignature(whCfg, noHash, body) {
		t.Fatal("a token with no sha256 claim was accepted")
	}
	for _, bad := range []string{"", "   ", "Bearer ", "not-a-jwt", "a.b.c"} {
		if verifyLivekitSignature(whCfg, bad, body) {
			t.Fatalf("malformed header %q was accepted", bad)
		}
	}
}

// alg=none is the classic JWT bypass; jwt.WithValidMethods must refuse it.
func TestWebhookRejectsAlgNone(t *testing.T) {
	body := []byte(`{"event":"egress_started"}`)
	h := sha256.Sum256(body)
	tok, err := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{
		"iss": whCfg.APIKey, "sha256": base64.StdEncoding.EncodeToString(h[:]),
	}).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if verifyLivekitSignature(whCfg, tok, body) {
		t.Fatal("alg=none was accepted")
	}
}
