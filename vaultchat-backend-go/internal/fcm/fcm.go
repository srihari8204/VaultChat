// Package fcm — data-only, high-priority FCM sends over the HTTP v1 API,
// port of lib/callFcm.js. The OAuth2 service-account grant is minted with the
// already-present golang-jwt (RS256) — no Google SDK dependency.
//
// Credentials: FIREBASE_SERVICE_ACCOUNT (inline JSON, same as Node) or
// FIREBASE_SERVICE_ACCOUNT_FILE (path; the container equivalent of Node's
// serviceAccountKey.json). Missing/invalid → sends report ok:false, exactly
// Node's graceful "push disabled" degrade.
package fcm

import (
	"bytes"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type serviceAccount struct {
	ProjectID   string `json:"project_id"`
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
}

var (
	mu       sync.Mutex
	sa       *serviceAccount
	saKey    *rsa.PrivateKey
	saLoaded bool
	token    string
	tokenExp time.Time
	client   = &http.Client{Timeout: 15 * time.Second}
)

func load() bool {
	mu.Lock()
	defer mu.Unlock()
	if saLoaded {
		return sa != nil
	}
	saLoaded = true
	raw := []byte(os.Getenv("FIREBASE_SERVICE_ACCOUNT"))
	if len(raw) == 0 {
		if p := os.Getenv("FIREBASE_SERVICE_ACCOUNT_FILE"); p != "" {
			raw, _ = os.ReadFile(p)
		}
	}
	if len(raw) == 0 {
		log.Println("[fcm] no service account — call wake-up push disabled")
		return false
	}
	var s serviceAccount
	if err := json.Unmarshal(raw, &s); err != nil || s.ClientEmail == "" || s.PrivateKey == "" {
		log.Println("[fcm] bad service account JSON — push disabled")
		return false
	}
	block, _ := pem.Decode([]byte(s.PrivateKey))
	if block == nil {
		log.Println("[fcm] bad private key PEM — push disabled")
		return false
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		log.Printf("[fcm] key parse failed: %v", err)
		return false
	}
	rk, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		log.Println("[fcm] service account key is not RSA — push disabled")
		return false
	}
	if s.TokenURI == "" {
		s.TokenURI = "https://oauth2.googleapis.com/token"
	}
	sa, saKey = &s, rk
	return true
}

func accessToken() (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if token != "" && time.Now().Before(tokenExp.Add(-60*time.Second)) {
		return token, nil
	}
	now := time.Now()
	assertion, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss":   sa.ClientEmail,
		"scope": "https://www.googleapis.com/auth/firebase.messaging",
		"aud":   sa.TokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}).SignedString(saKey)
	if err != nil {
		return "", err
	}
	resp, err := client.PostForm(sa.TokenURI, url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assertion},
	})
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.AccessToken == "" {
		return "", errors.New("token grant failed")
	}
	token = out.AccessToken
	tokenExp = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	return token, nil
}

type Result struct {
	OK   bool
	Sent int
	Dead []string
}

// SendCallMessage mirrors lib/callFcm.js sendCallMessage: data-only android
// HIGH priority + APNs voip headers, per-token sends, dead-token collection.
func SendCallMessage(tokens []string, data map[string]string, ttlMs int64) Result {
	res := Result{Dead: []string{}}
	if len(tokens) == 0 || !load() {
		return res
	}
	at, err := accessToken()
	if err != nil {
		log.Printf("[fcm] send failed: %v", err)
		return res
	}
	payload := map[string]string{}
	for k, v := range data {
		payload[k] = v
	}
	endpoint := fmt.Sprintf("https://fcm.googleapis.com/v1/projects/%s/messages:send", sa.ProjectID)
	for _, tk := range tokens {
		body, _ := json.Marshal(map[string]any{
			"message": map[string]any{
				"token": tk,
				"data":  payload,
				"android": map[string]any{
					"priority": "HIGH",
					"ttl":      fmt.Sprintf("%ds", ttlMs/1000),
					// No notification block on purpose — data-only wakes the service.
				},
				"apns": map[string]any{
					"headers": map[string]string{
						"apns-push-type":  "voip",
						"apns-priority":   "10",
						"apns-expiration": fmt.Sprintf("%d", time.Now().Unix()+ttlMs/1000),
						"apns-topic":      envOr("IOS_BUNDLE_ID", "com.vaultchat.app") + ".voip",
					},
					"payload": map[string]any{"aps": map[string]any{"content-available": 1}},
				},
			},
		})
		req, _ := http.NewRequest("POST", endpoint, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+at)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			log.Printf("[fcm] send error: %v", err)
			continue
		}
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		if resp.StatusCode == 200 {
			res.Sent++
			continue
		}
		// UNREGISTERED (404) / invalid token (400) → prune, like firebase-admin.
		if resp.StatusCode == 404 || (resp.StatusCode == 400 && strings.Contains(string(rb), "registration token")) {
			res.Dead = append(res.Dead, tk)
		} else {
			log.Printf("[fcm] send error: %d %s", resp.StatusCode, string(rb[:min(len(rb), 200)]))
		}
	}
	res.OK = res.Sent > 0
	return res
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
