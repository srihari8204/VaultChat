// Package httpx — JSON + auth plumbing matching the Node backend's contract
// EXACTLY: response shapes {error: "..."}, the requireAuth 401 texts
// ('Missing Bearer token' | 'token_expired' | 'invalid_token'), a JWT with
// {sub, email} claims (jwt.js): HS256, or EdDSA once a key is configured
// (accesskeys.go).
package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// JSTime marshals like JS Date.toISOString(): UTC, fixed 3-digit ms — the
// format node-pg dates take in every Node response.
type JSTime time.Time

func (t JSTime) MarshalJSON() ([]byte, error) {
	return []byte(time.Time(t).UTC().Format(`"2006-01-02T15:04:05.000Z"`)), nil
}

// JST wraps a nullable pg timestamp for response structs.
func JST(t *time.Time) *JSTime {
	if t == nil {
		return nil
	}
	j := JSTime(*t)
	return &j
}

var intPrefixRe = regexp.MustCompile(`^\s*[+-]?\d+`)

// ParseIntPrefix mirrors JS parseInt(s, 10): trims, reads an optional sign +
// leading digits, ignores the rest. false = NaN. (Hex '0x' inputs diverge —
// no Node route receives them.)
func ParseIntPrefix(s string) (int64, bool) {
	m := intPrefixRe.FindString(s)
	if m == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSpace(m), 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

type ctxKey int

const userKey ctxKey = 1

// User mirrors Node's req.user.
type User struct {
	ID    string
	Email string
}

func UserFrom(r *http.Request) User {
	u, _ := r.Context().Value(userKey).(User)
	return u
}

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Err writes the Node error shape: {"error": msg} (+ extra fields if given).
func Err(w http.ResponseWriter, status int, msg string, extra ...map[string]any) {
	body := map[string]any{"error": msg}
	for _, e := range extra {
		for k, v := range e {
			body[k] = v
		}
	}
	JSON(w, status, body)
}

// Body decodes the JSON body into dst. An empty body is not an error
// (mirrors express.json() treating no-body POSTs as {}).
func Body(r *http.Request, dst any) error {
	if r.Body == nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 2<<20)) // 2 MB, same as Node
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, dst)
}

var bearerRe = regexp.MustCompile(`(?i)^Bearer\s+(.+)$`)

func jwtSecret() []byte { return []byte(os.Getenv("JWT_SECRET")) }

// VerifyAccess validates an access token and returns (sub, email). EdDSA
// tokens verify against the Ed25519 public key; HS256 tokens only while
// hs256Accepted (accesskeys.go), which is always in legacy mode.
func VerifyAccess(token string) (string, string, error) {
	parsed, err := jwt.Parse(token, func(t *jwt.Token) (any, error) {
		switch t.Method.Alg() {
		case jwt.SigningMethodEdDSA.Alg():
			if accessPub == nil {
				return nil, errors.New("no access public key")
			}
			return accessPub, nil
		case jwt.SigningMethodHS256.Alg():
			if !hs256Accepted(time.Now()) {
				return nil, errors.New("hs256 no longer accepted")
			}
			return jwtSecret(), nil
		}
		return nil, errors.New("bad alg")
	}, jwt.WithValidMethods([]string{"EdDSA", "HS256"}))
	if err != nil || !parsed.Valid {
		if err != nil && strings.Contains(err.Error(), "expired") {
			return "", "", errors.New("token_expired")
		}
		return "", "", errors.New("invalid_token")
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return "", "", errors.New("invalid_token")
	}
	sub, _ := claims["sub"].(string)
	email, _ := claims["email"].(string)
	if sub == "" {
		return "", "", errors.New("invalid_token")
	}
	return sub, email, nil
}

// RequireAuth mirrors jwt.js requireAuth: exact 401 error strings.
func RequireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m := bearerRe.FindStringSubmatch(r.Header.Get("Authorization"))
		if m == nil {
			Err(w, http.StatusUnauthorized, "Missing Bearer token")
			return
		}
		sub, email, err := VerifyAccess(m[1])
		if err != nil {
			Err(w, http.StatusUnauthorized, err.Error()) // token_expired | invalid_token
			return
		}
		ctx := context.WithValue(r.Context(), userKey, User{ID: sub, Email: email})
		next(w, r.WithContext(ctx))
	}
}
