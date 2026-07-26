// Package httpx — JSON + auth plumbing matching the Node backend's contract
// EXACTLY: response shapes {error: "..."}, the requireAuth 401 texts
// ('Missing Bearer token' | 'token_expired' | 'invalid_token'), HS256 JWT with
// {sub, email} claims (jwt.js).
package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

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

// VerifyAccess validates an HS256 access token and returns (sub, email).
func VerifyAccess(token string) (string, string, error) {
	parsed, err := jwt.Parse(token, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, errors.New("bad alg")
		}
		return jwtSecret(), nil
	}, jwt.WithValidMethods([]string{"HS256"}))
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
