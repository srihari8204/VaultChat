// user.go ← routes/user.js — profile, security overview, reports, SOS, security
// events, breach monitors, contact verifications, identity/keybundle, ghost
// mode, bookmarks, sessions, scheduled messages, settings, blocks, encrypted
// backups. Same endpoints, same status codes, same error strings/shapes.
// Node's router.use(requireAuth) applies to every route → httpx.RequireAuth on
// every handler here. BIGSERIAL/BIGINT columns render as JSON strings (node-pg
// int8 → string, db.js sets no type parsers) unless Node wraps in Number().
package routes

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"golang.org/x/crypto/bcrypt"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/vault"
)

const userPinBcryptRounds = 10

func RegisterUser(mux *http.ServeMux) {
	mux.HandleFunc("GET /user/profile", httpx.RequireAuth(userProfileGet))
	mux.HandleFunc("PUT /user/profile", httpx.RequireAuth(userProfilePut))
	mux.HandleFunc("GET /user/security-overview", httpx.RequireAuth(userSecurityOverview))
	mux.HandleFunc("POST /user/reports", httpx.RequireAuth(userReportsPost))
	mux.HandleFunc("POST /user/sos", httpx.RequireAuth(userSosPost))
	mux.HandleFunc("GET /user/sos", httpx.RequireAuth(userSosGet))
	mux.HandleFunc("POST /user/security-events", httpx.RequireAuth(userSecurityEventsPost))
	mux.HandleFunc("GET /user/security-events", httpx.RequireAuth(userSecurityEventsGet))
	mux.HandleFunc("GET /user/breach-monitors", httpx.RequireAuth(userBreachMonitorsGet))
	mux.HandleFunc("POST /user/breach-monitors", httpx.RequireAuth(userBreachMonitorsPost))
	mux.HandleFunc("PATCH /user/breach-monitors/{id}", httpx.RequireAuth(userBreachMonitorsPatch))
	mux.HandleFunc("DELETE /user/breach-monitors/{id}", httpx.RequireAuth(userBreachMonitorsDelete))
	mux.HandleFunc("GET /user/contact-verifications", httpx.RequireAuth(userContactVerificationsGet))
	mux.HandleFunc("POST /user/contact-verifications", httpx.RequireAuth(userContactVerificationsPost))
	mux.HandleFunc("GET /user/by-vault/{vaultId}", httpx.RequireAuth(userByVault))
	mux.HandleFunc("POST /user/pin", httpx.RequireAuth(userPinPost))
	mux.HandleFunc("POST /user/pin/verify", httpx.RequireAuth(userPinVerify))
	mux.HandleFunc("POST /user/devices", httpx.RequireAuth(userDevicesPost))
	mux.HandleFunc("DELETE /user/devices", httpx.RequireAuth(userDevicesDelete))
	mux.HandleFunc("GET /user/turn", httpx.RequireAuth(userTurn))
	mux.HandleFunc("GET /user/export", httpx.RequireAuth(userExport))
	mux.HandleFunc("DELETE /user/account", httpx.RequireAuth(userAccountDelete))
	mux.HandleFunc("GET /user/ghost-mode", httpx.RequireAuth(userGhostModeList))
	mux.HandleFunc("GET /user/ghost-mode/{targetId}", httpx.RequireAuth(userGhostModeGet))
	mux.HandleFunc("PUT /user/ghost-mode/{targetId}", httpx.RequireAuth(userGhostModePut))
	mux.HandleFunc("DELETE /user/ghost-mode/{targetId}", httpx.RequireAuth(userGhostModeDelete))
	mux.HandleFunc("GET /user/bookmarks", httpx.RequireAuth(userBookmarksGet))
	mux.HandleFunc("POST /user/bookmarks", httpx.RequireAuth(userBookmarksPost))
	mux.HandleFunc("DELETE /user/bookmarks/{id}", httpx.RequireAuth(userBookmarksDelete))
	mux.HandleFunc("GET /user/sessions", httpx.RequireAuth(userSessionsGet))
	mux.HandleFunc("DELETE /user/sessions/{id}", httpx.RequireAuth(userSessionsDeleteOne))
	mux.HandleFunc("DELETE /user/sessions", httpx.RequireAuth(userSessionsDeleteAll))
	mux.HandleFunc("GET /user/scheduled-messages", httpx.RequireAuth(userScheduledGet))
	mux.HandleFunc("POST /user/scheduled-messages", httpx.RequireAuth(userScheduledPost))
	mux.HandleFunc("DELETE /user/scheduled-messages/{id}", httpx.RequireAuth(userScheduledDelete))
	mux.HandleFunc("POST /user/keybundle", httpx.RequireAuth(userKeybundlePost))
	mux.HandleFunc("GET /user/settings", httpx.RequireAuth(userSettingsGet))
	mux.HandleFunc("PUT /user/settings", httpx.RequireAuth(userSettingsPut))
	mux.HandleFunc("GET /user/blocks", httpx.RequireAuth(userBlocksGet))
	mux.HandleFunc("POST /user/blocks", httpx.RequireAuth(userBlocksPost))
	mux.HandleFunc("DELETE /user/blocks/{userId}", httpx.RequireAuth(userBlocksDelete))
	mux.HandleFunc("GET /user/backup/key", httpx.RequireAuth(userBackupKey))
	mux.HandleFunc("GET /user/backup/meta", httpx.RequireAuth(userBackupMeta))
	mux.HandleFunc("POST /user/backup/presign", httpx.RequireAuth(userBackupPresign))
	mux.HandleFunc("POST /user/backup/commit", httpx.RequireAuth(userBackupCommit))
	mux.HandleFunc("PUT /user/backup", httpx.RequireAuth(userBackupPut))
	mux.HandleFunc("GET /user/backup", httpx.RequireAuth(userBackupGet))
	mux.HandleFunc("DELETE /user/backup", httpx.RequireAuth(userBackupDelete))
	// GET /user/:id/identity and GET /user/:id/keybundle overlap with
	// /user/by-vault/{vaultId} in ServeMux precedence (registration panic), so
	// they dispatch through this subtree fallback instead.
	mux.HandleFunc("GET /user/", httpx.RequireAuth(userSubtreeGet))
}

func userSubtreeGet(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/user/"), "/")
	if len(parts) == 2 && parts[1] == "identity" {
		userIdentityGet(w, r, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "keybundle" {
		userKeybundleGet(w, r, parts[0])
		return
	}
	http.NotFound(w, r)
}

// ── users row + publicUser (user.js publicUser) ────────────────────────

const userUsersCols = `id, email, name, phone, photo_url, vault_id, dob, status, online, last_seen_at, auth_provider, pin_hash, face_count, email_verified_at, created_at, first_name_cipher, last_name_cipher, email_cipher, phone_cipher, dob_cipher, status_cipher`

type userUsersRow struct {
	ID              string
	Email           *string
	Name            *string
	Phone           *string
	PhotoURL        *string
	VaultID         *string
	DOB             *time.Time
	Status          *string
	Online          bool
	LastSeenAt      *time.Time
	AuthProvider    *string
	PinHash         *string
	FaceCount       int
	EmailVerifiedAt *time.Time
	CreatedAt       time.Time
	FirstNameCipher *string
	LastNameCipher  *string
	EmailCipher     *string
	PhoneCipher     *string
	DOBCipher       *string
	StatusCipher    *string
}

func (u *userUsersRow) fields() []any {
	return []any{&u.ID, &u.Email, &u.Name, &u.Phone, &u.PhotoURL, &u.VaultID, &u.DOB,
		&u.Status, &u.Online, &u.LastSeenAt, &u.AuthProvider, &u.PinHash, &u.FaceCount,
		&u.EmailVerifiedAt, &u.CreatedAt, &u.FirstNameCipher, &u.LastNameCipher,
		&u.EmailCipher, &u.PhoneCipher, &u.DOBCipher, &u.StatusCipher}
}

func (u *userUsersRow) public() map[string]any {
	// Legacy plaintext dob (pg DATE) renders as Node's String(row.dob) — the JS
	// Date toString form (server TZ is UTC). Unreachable for post-042 rows.
	var legacyDOB *string
	if u.DOB != nil {
		s := u.DOB.UTC().Format("Mon Jan 02 2006 15:04:05 GMT+0000 (Coordinated Universal Time)")
		legacyDOB = &s
	}
	ident := vault.IdentityFromRow(u.FirstNameCipher, u.LastNameCipher, u.EmailCipher,
		u.PhoneCipher, u.DOBCipher, u.StatusCipher,
		u.Name, u.Email, u.Phone, legacyDOB, u.Status)
	return map[string]any{
		"id":              u.ID,
		"email":           ident.Email,
		"name":            ident.Name,
		"phone":           ident.Phone,
		"photoURL":        u.PhotoURL,
		"vaultId":         u.VaultID,
		"dob":             ident.DOB,
		"status":          ident.Status,
		"online":          u.Online,
		"lastSeen":        httpx.JST(u.LastSeenAt),
		"authProvider":    u.AuthProvider,
		"hasPin":          u.PinHash != nil && *u.PinHash != "",
		"faceCount":       u.FaceCount,
		"emailVerifiedAt": httpx.JST(u.EmailVerifiedAt),
		"createdAt":       httpx.JSTime(u.CreatedAt),
	}
}

// userBigStr renders a nullable BIGINT the way node-pg does: string or null.
func userBigStr(n *int64) *string {
	if n == nil {
		return nil
	}
	s := strconv.FormatInt(*n, 10)
	return &s
}

func userSha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// genVaultId — 'v' + 6 random bytes hex, like user.js genVaultId.
func userGenVaultID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "v" + hex.EncodeToString(b)
}

// ── GET /user/profile ──────────────────────────────────────────────────

func userProfileGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	u := &userUsersRow{}
	err := db.Pool.QueryRow(ctx,
		`SELECT `+userUsersCols+` FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1`,
		user.ID).Scan(u.fields()...)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "User not found")
		} else {
			httpx.Err(w, 500, "Failed to fetch profile")
		}
		return
	}

	// Lazily assign a VaultID the first time a user is seen without one
	// (covers accounts created after the 024 backfill). Retry on the rare
	// unique-index collision.
	if u.VaultID == nil || *u.VaultID == "" {
		for i := 0; i < 5; i++ {
			err := db.Pool.QueryRow(ctx,
				`UPDATE users SET vault_id = $1 WHERE id = $2 AND vault_id IS NULL RETURNING `+userUsersCols,
				userGenVaultID(), user.ID).Scan(u.fields()...)
			if err == nil {
				break
			}
			if db.NoRows(err) {
				// Concurrently assigned — reload and stop.
				if err := db.Pool.QueryRow(ctx,
					`SELECT `+userUsersCols+` FROM users WHERE id = $1 LIMIT 1`,
					user.ID).Scan(u.fields()...); err != nil {
					httpx.Err(w, 500, "Failed to fetch profile")
					return
				}
				break
			}
			if i == 4 {
				httpx.Err(w, 500, "Failed to fetch profile")
				return
			}
		}
	}
	httpx.JSON(w, 200, u.public())
}

// ── GET /user/security-overview ────────────────────────────────────────

func userSecurityOverview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := httpx.UserFrom(r).ID
	fail := func() { httpx.Err(w, 500, "Failed to load security overview") }

	var sessions, devices, blocks, keys int
	if err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
		uid).Scan(&sessions); err != nil {
		fail()
		return
	}
	if err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*)::int AS n FROM devices WHERE user_id = $1`, uid).Scan(&devices); err != nil {
		fail()
		return
	}
	if err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*)::int AS n FROM user_blocks WHERE blocker_id = $1`, uid).Scan(&blocks); err != nil {
		fail()
		return
	}
	if err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*)::int AS n FROM identity_keys WHERE user_id = $1`, uid).Scan(&keys); err != nil {
		fail()
		return
	}
	var createdAt *time.Time
	var discoverable, readReceipts, lastSeenVisible *bool
	err := db.Pool.QueryRow(ctx,
		`SELECT created_at, discoverable, read_receipts, last_seen_visible FROM users WHERE id = $1`,
		uid).Scan(&createdAt, &discoverable, &readReceipts, &lastSeenVisible)
	if err != nil && !db.NoRows(err) {
		fail()
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"activeSessions":   sessions,
		"linkedDevices":    devices,
		"blockedContacts":  blocks,
		"e2eeKeyPublished": keys > 0,
		"accountCreatedAt": httpx.JST(createdAt),
		"settings": map[string]any{
			"discoverable":    discoverable,
			"readReceipts":    readReceipts,
			"lastSeenVisible": lastSeenVisible,
		},
	})
}

// ── POST /user/reports ─────────────────────────────────────────────────

func userReportsPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		ReportedUserID any `json:"reportedUserId"`
		Reason         any `json:"reason"`
		Context        any `json:"context"`
	}
	_ = httpx.Body(r, &b)
	reportedID := strings.TrimSpace(authStr(b.ReportedUserID))
	if reportedID == "" {
		httpx.Err(w, 400, "reportedUserId required")
		return
	}
	if reportedID == user.ID {
		httpx.Err(w, 400, "Cannot report yourself")
		return
	}
	var reason, contextS *string
	if s := truncRunes(authStr(b.Reason), 500); s != "" {
		reason = &s
	}
	if s := truncRunes(authStr(b.Context), 200); s != "" {
		contextS = &s
	}

	var one int
	err := db.Pool.QueryRow(ctx,
		`SELECT 1 FROM users WHERE id = $1 AND is_deleted = FALSE`, reportedID).Scan(&one)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "User not found")
		} else {
			httpx.Err(w, 500, "Failed to file report")
		}
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO user_reports (reporter_id, reported_id, reason, context) VALUES ($1, $2, $3, $4)`,
		user.ID, reportedID, reason, contextS); err != nil {
		httpx.Err(w, 500, "Failed to file report")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── SOS (push via Expo, port of push.js sendPushToTokens) ──────────────

var userExpoHTTP = &http.Client{Timeout: 15 * time.Second}

func userExpoPostBatch(chunk []map[string]any) []map[string]any {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		body, _ := json.Marshal(chunk)
		req, err := http.NewRequest("POST", "https://exp.host/--/api/v2/push/send", strings.NewReader(string(body)))
		if err != nil {
			return nil
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Accept-encoding", "gzip, deflate")
		resp, err := userExpoHTTP.Do(req)
		if err != nil {
			lastErr = err
		} else {
			data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
			resp.Body.Close()
			if resp.StatusCode >= 500 {
				lastErr = fmt.Errorf("Expo %d", resp.StatusCode)
			} else if resp.StatusCode >= 400 {
				log.Printf("[push] Expo Push returned %d %s", resp.StatusCode, string(data[:min(len(data), 200)]))
				return nil
			} else {
				var out struct {
					Data []map[string]any `json:"data"`
				}
				if json.Unmarshal(data, &out) != nil {
					return nil
				}
				return out.Data
			}
		}
		if attempt < 3 {
			time.Sleep(time.Duration(300*attempt) * time.Millisecond)
		}
	}
	log.Printf("[push] batch failed after retries: %v", lastErr)
	return nil
}

// userSendExpoPush ports push.js sendPushToTokens (batching, retries, dead-
// token pruning). Errors never propagate — SOS logs and continues like Node.
func userSendExpoPush(ctx context.Context, tokens []string, title, body string, data map[string]any) {
	valid := []string{}
	for _, t := range tokens {
		if strings.HasPrefix(t, "Expo") {
			valid = append(valid, t)
		}
	}
	if len(valid) == 0 {
		return
	}
	dead := []string{}
	for i := 0; i < len(valid); i += 100 {
		slice := valid[i:min(i+100, len(valid))]
		chunk := make([]map[string]any, 0, len(slice))
		for _, tk := range slice {
			chunk = append(chunk, map[string]any{
				"to": tk, "sound": "default", "title": title, "body": body,
				"data": data, "priority": "high", "channelId": "default",
				"_displayInForeground": true,
			})
		}
		tickets := userExpoPostBatch(chunk)
		for idx, t := range tickets {
			if idx >= len(slice) || t == nil {
				continue
			}
			if s, _ := t["status"].(string); s == "error" {
				if d, _ := t["details"].(map[string]any); d != nil {
					if e, _ := d["error"].(string); e == "DeviceNotRegistered" {
						dead = append(dead, slice[idx])
					}
				}
			}
		}
	}
	if len(dead) > 0 {
		if _, err := db.Pool.Exec(ctx,
			`DELETE FROM devices WHERE push_token = ANY($1::text[])`, dead); err != nil {
			log.Printf("[push] prune dead tokens: %v", err)
		}
	}
}

// userJSFloat renders a float64 like JS template-literal number coercion for
// typical coordinate magnitudes.
func userJSFloat(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// POST /user/sos
func userSosPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		Test       any `json:"test"`
		Latitude   any `json:"latitude"`
		Longitude  any `json:"longitude"`
		ContactIds any `json:"contactIds"`
	}
	_ = httpx.Body(r, &b)
	test := authTruthy(b.Test)
	var lat, lng *float64
	if f, ok := b.Latitude.(float64); ok {
		lat = &f
	}
	if f, ok := b.Longitude.(float64); ok {
		lng = &f
	}
	var subset []string
	if arr, ok := b.ContactIds.([]any); ok {
		subset = []string{}
		for _, v := range arr {
			if s, ok := v.(string); ok {
				subset = append(subset, s)
			}
		}
	}

	rows, err := db.Pool.Query(ctx,
		`SELECT contact_id FROM trusted_contacts WHERE owner_id = $1`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to send SOS")
		return
	}
	recipients := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			httpx.Err(w, 500, "Failed to send SOS")
			return
		}
		recipients = append(recipients, id)
	}
	rows.Close()
	if subset != nil && len(subset) > 0 {
		inSubset := map[string]bool{}
		for _, s := range subset {
			inSubset[s] = true
		}
		kept := []string{}
		for _, id := range recipients {
			if inSubset[id] {
				kept = append(kept, id)
			}
		}
		recipients = kept
	}

	myName := "VaultChat User"
	var namePtr *string
	err = db.Pool.QueryRow(ctx,
		`SELECT COALESCE(NULLIF(name, ''), email) AS n FROM users WHERE id = $1`, user.ID).Scan(&namePtr)
	if err != nil && !db.NoRows(err) {
		httpx.Err(w, 500, "Failed to send SOS")
		return
	}
	if namePtr != nil && *namePtr != "" {
		myName = *namePtr
	}

	notified := 0
	if len(recipients) > 0 {
		tokRows, err := db.Pool.Query(ctx,
			`SELECT push_token FROM devices WHERE user_id = ANY($1::uuid[])`, recipients)
		if err != nil {
			httpx.Err(w, 500, "Failed to send SOS")
			return
		}
		tokens := []string{}
		for tokRows.Next() {
			var t *string
			if err := tokRows.Scan(&t); err != nil {
				tokRows.Close()
				httpx.Err(w, 500, "Failed to send SOS")
				return
			}
			if t != nil && *t != "" {
				tokens = append(tokens, *t)
			}
		}
		tokRows.Close()
		if len(tokens) > 0 {
			mapURL := ""
			if lat != nil && lng != nil {
				mapURL = " https://maps.google.com/?q=" + userJSFloat(*lat) + "," + userJSFloat(*lng)
			}
			title := "🚨 EMERGENCY SOS"
			verb := "needs help"
			if test {
				title = "[TEST] SOS"
				verb = "sent a test SOS"
			}
			var latV, lngV any
			if lat != nil {
				latV = *lat
			}
			if lng != nil {
				lngV = *lng
			}
			userSendExpoPush(ctx, tokens, title,
				fmt.Sprintf("%s %s.%s", myName, verb, mapURL),
				map[string]any{"type": "sos", "test": test, "fromUserId": user.ID,
					"latitude": latV, "longitude": lngV})
		}
		notified = len(recipients)
	}

	sosType := "emergency"
	if test {
		sosType = "test"
	}
	// THE POSITION IS SENT, NOT STORED.
	//
	// The alert above carries the location to the people who need it — that is
	// the whole point of an SOS, and nothing about it changes. What no longer
	// happens is writing those coordinates into this database, where they would
	// sit permanently in the clear.
	//
	// Everything else in VaultChat relays positions it cannot read. SOS was the
	// single exception, and it was the worst possible one: the exact place
	// somebody stood at the moment they were most in danger, retained
	// indefinitely, in the one table an attacker would look for first. The row
	// still records THAT an alert happened, when, and how many people it
	// reached, which is what the history screen is actually for.
	//
	// The columns are left in place rather than dropped: dropping them is
	// irreversible and this is a decision worth being able to revisit. They are
	// simply never written again.
	var id int64
	var createdAt time.Time
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO sos_events (user_id, type, contacts_notified)
	     VALUES ($1, $2, $3) RETURNING id, created_at`,
		user.ID, sosType, notified).Scan(&id, &createdAt)
	if err != nil {
		httpx.Err(w, 500, "Failed to send SOS")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"contactsNotified": notified,
		"id":               strconv.FormatInt(id, 10),
		"createdAt":        httpx.JSTime(createdAt),
	})
}

// GET /user/sos
func userSosGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(ctx,
		`SELECT id, type, latitude, longitude, contacts_notified, created_at
	       FROM sos_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
		user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load SOS history")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var sosType string
		var lat, lng *float64
		var notified int
		var createdAt time.Time
		if err := rows.Scan(&id, &sosType, &lat, &lng, &notified, &createdAt); err != nil {
			httpx.Err(w, 500, "Failed to load SOS history")
			return
		}
		out = append(out, map[string]any{
			"id":               strconv.FormatInt(id, 10),
			"type":             sosType,
			"latitude":         lat,
			"longitude":        lng,
			"contactsNotified": notified,
			"createdAt":        httpx.JSTime(createdAt),
		})
	}
	httpx.JSON(w, 200, out)
}

// ── Security audit chain (#41) ─────────────────────────────────────────

// POST /user/security-events
func userSecurityEventsPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		Events any `json:"events"`
	}
	_ = httpx.Body(r, &b)
	events, _ := b.Events.([]any)
	if len(events) == 0 {
		httpx.JSON(w, 200, map[string]any{"stored": 0})
		return
	}
	if len(events) > 500 {
		httpx.Err(w, 400, "Too many events (max 500)")
		return
	}

	stored := int64(0)
	for _, ev := range events {
		e, ok := ev.(map[string]any)
		if !ok {
			continue
		}
		blob, ok1 := e["blob"].(string)
		hash, ok2 := e["hash"].(string)
		prevHash, ok3 := e["prevHash"].(string)
		if !ok1 || !ok2 || !ok3 {
			continue
		}
		if len(blob) > 20000 || len(hash) > 128 || len(prevHash) > 128 {
			continue // sanity caps
		}
		var ts *int64
		if f, ok := e["ts"].(float64); ok {
			n := int64(math.Trunc(f))
			ts = &n
		}
		tag, err := db.Pool.Exec(ctx,
			`INSERT INTO security_events (user_id, blob, hash, prev_hash, client_ts)
	         VALUES ($1, $2, $3, $4, $5)
	         ON CONFLICT (user_id, hash) DO NOTHING`,
			user.ID, blob, hash, prevHash, ts)
		if err != nil {
			httpx.Err(w, 500, "Failed to store security events")
			return
		}
		stored += tag.RowsAffected()
	}
	httpx.JSON(w, 200, map[string]any{"stored": stored})
}

// GET /user/security-events?since=<id>
func userSecurityEventsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	since, ok := httpx.ParseIntPrefix(r.URL.Query().Get("since"))
	if !ok {
		since = 0
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT id, blob, hash, prev_hash, client_ts
	       FROM security_events
	      WHERE user_id = $1 AND id > $2
	      ORDER BY id ASC
	      LIMIT 1000`,
		user.ID, since)
	if err != nil {
		httpx.Err(w, 500, "Failed to load security events")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var blob, hash, prevHash string
		var ts *int64
		if err := rows.Scan(&id, &blob, &hash, &prevHash, &ts); err != nil {
			httpx.Err(w, 500, "Failed to load security events")
			return
		}
		out = append(out, map[string]any{
			"id":       strconv.FormatInt(id, 10),
			"blob":     blob,
			"hash":     hash,
			"prevHash": prevHash,
			"ts":       userBigStr(ts),
		})
	}
	httpx.JSON(w, 200, map[string]any{"events": out})
}

// ── Breach monitors ────────────────────────────────────────────────────

type userMonitorRow struct {
	ID            int64
	TargetType    string
	Target        string
	BreachCount   int
	LastCheckedAt *time.Time
	CreatedAt     time.Time
}

func (m *userMonitorRow) public() map[string]any {
	return map[string]any{
		"id":            strconv.FormatInt(m.ID, 10),
		"targetType":    m.TargetType,
		"target":        m.Target,
		"breachCount":   m.BreachCount,
		"lastCheckedAt": httpx.JST(m.LastCheckedAt),
		"createdAt":     httpx.JSTime(m.CreatedAt),
	}
}

func userBreachMonitorsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(ctx,
		`SELECT id, target_type, target, breach_count, last_checked_at, created_at
	       FROM breach_monitors WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
		user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load breach monitors")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var m userMonitorRow
		if err := rows.Scan(&m.ID, &m.TargetType, &m.Target, &m.BreachCount, &m.LastCheckedAt, &m.CreatedAt); err != nil {
			httpx.Err(w, 500, "Failed to load breach monitors")
			return
		}
		out = append(out, m.public())
	}
	httpx.JSON(w, 200, map[string]any{"monitors": out})
}

func userBreachMonitorsPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		Target     any `json:"target"`
		TargetType any `json:"targetType"`
	}
	_ = httpx.Body(r, &b)
	target := strings.ToLower(strings.TrimSpace(authStr(b.Target)))
	targetType := "email"
	if authTruthy(b.TargetType) {
		targetType = strings.TrimSpace(authStr(b.TargetType))
	}
	if target == "" {
		httpx.Err(w, 400, "target required")
		return
	}
	if len([]rune(target)) > 320 {
		httpx.Err(w, 400, "target too long")
		return
	}
	if targetType != "email" {
		httpx.Err(w, 400, "unsupported targetType")
		return
	}
	var m userMonitorRow
	err := db.Pool.QueryRow(ctx,
		`INSERT INTO breach_monitors (user_id, target_type, target)
	     VALUES ($1, $2, $3)
	     ON CONFLICT (user_id, target_type, target) DO UPDATE SET target = EXCLUDED.target
	     RETURNING id, target_type, target, breach_count, last_checked_at, created_at`,
		user.ID, targetType, target).Scan(&m.ID, &m.TargetType, &m.Target, &m.BreachCount, &m.LastCheckedAt, &m.CreatedAt)
	if err != nil {
		httpx.Err(w, 500, "Failed to add breach monitor")
		return
	}
	httpx.JSON(w, 200, map[string]any{"monitor": m.public()})
}

func userBreachMonitorsPatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id, ok := httpx.ParseIntPrefix(r.PathValue("id"))
	if !ok {
		httpx.Err(w, 400, "bad id")
		return
	}
	var b struct {
		BreachCount any `json:"breachCount"`
	}
	_ = httpx.Body(r, &b)
	breachCount := int64(0)
	if f, ok := b.BreachCount.(float64); ok {
		breachCount = int64(math.Trunc(f))
		if breachCount < 0 {
			breachCount = 0
		}
	}
	var retID int64
	err := db.Pool.QueryRow(ctx,
		`UPDATE breach_monitors SET breach_count = $1, last_checked_at = NOW()
	      WHERE id = $2 AND user_id = $3 RETURNING id`,
		breachCount, id, user.ID).Scan(&retID)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "not found")
		} else {
			httpx.Err(w, 500, "Failed to update breach monitor")
		}
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func userBreachMonitorsDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id, ok := httpx.ParseIntPrefix(r.PathValue("id"))
	if !ok {
		httpx.Err(w, 400, "bad id")
		return
	}
	tag, err := db.Pool.Exec(ctx,
		`DELETE FROM breach_monitors WHERE id = $1 AND user_id = $2`, id, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to delete breach monitor")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "deleted": tag.RowsAffected()})
}

// ── Contact verification (safety numbers, #101) ────────────────────────

func userContactVerificationsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(ctx,
		`SELECT contact_id FROM contact_verifications WHERE user_id = $1`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load verifications")
		return
	}
	defer rows.Close()
	verified := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			httpx.Err(w, 500, "Failed to load verifications")
			return
		}
		verified = append(verified, id)
	}
	httpx.JSON(w, 200, map[string]any{"verified": verified})
}

func userContactVerificationsPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		ContactID any `json:"contactId"`
		Verified  any `json:"verified"`
	}
	_ = httpx.Body(r, &b)
	contactID := strings.TrimSpace(authStr(b.ContactID))
	verified := true
	if v, ok := b.Verified.(bool); ok && !v {
		verified = false
	}
	if contactID == "" {
		httpx.Err(w, 400, "contactId required")
		return
	}
	if verified {
		if _, err := db.Pool.Exec(ctx,
			`INSERT INTO contact_verifications (user_id, contact_id)
	         VALUES ($1, $2) ON CONFLICT (user_id, contact_id) DO NOTHING`,
			user.ID, contactID); err != nil {
			httpx.Err(w, 500, "Failed to update verification")
			return
		}
	} else {
		if _, err := db.Pool.Exec(ctx,
			`DELETE FROM contact_verifications WHERE user_id = $1 AND contact_id = $2`,
			user.ID, contactID); err != nil {
			httpx.Err(w, 500, "Failed to update verification")
			return
		}
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "verified": verified})
}

// GET /user/:id/identity (via userSubtreeGet)
func userIdentityGet(w http.ResponseWriter, r *http.Request, targetID string) {
	ctx := r.Context()
	var key string
	err := db.Pool.QueryRow(ctx,
		`SELECT public_key_b64 FROM identity_keys WHERE user_id = $1`, targetID).Scan(&key)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "User has no identity key")
		} else {
			httpx.Err(w, 500, "Failed to load identity key")
		}
		return
	}
	httpx.JSON(w, 200, map[string]any{"identityKey": key})
}

// GET /user/by-vault/:vaultId
func userByVault(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	vid := authStr(r.PathValue("vaultId"))
	if strings.HasPrefix(vid, "@") {
		vid = vid[1:]
	}
	vid = strings.TrimSpace(vid)
	if vid == "" {
		httpx.Err(w, 400, "vaultId required")
		return
	}
	var id string
	var name, photoURL, vaultID *string
	err := db.Pool.QueryRow(ctx,
		`SELECT id, name, photo_url, vault_id FROM users
	      WHERE vault_id = $1 AND is_deleted = FALSE LIMIT 1`, vid).Scan(&id, &name, &photoURL, &vaultID)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "No user with that VaultID")
		} else {
			httpx.Err(w, 500, "Failed to resolve VaultID")
		}
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"userId": id, "name": name, "photoURL": photoURL, "vaultId": vaultID,
	})
}

// ── PUT /user/profile ──────────────────────────────────────────────────

var userDobRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func userProfilePut(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b map[string]any
	_ = httpx.Body(r, &b)

	sets := []string{}
	params := []any{user.ID}

	// Node's add(): key absent → skip; present-but-null → transform throws →
	// catch-all 500 ('Failed to update profile'); ''-after-trim → NULL.
	add := func(col, key string, n int) bool {
		v, present := b[key]
		if !present {
			return true
		}
		if v == nil {
			return false // null.toString() throws in Node
		}
		s := truncRunes(strings.TrimSpace(authStr(v)), n)
		if s == "" {
			params = append(params, nil)
		} else {
			params = append(params, s)
		}
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(params)))
		return true
	}
	if !add("name", "name", 100) || !add("phone", "phone", 32) ||
		!add("photo_url", "photoURL", 1024) || !add("status", "status", 200) {
		httpx.Err(w, 500, "Failed to update profile")
		return
	}

	if authTruthy(b["dob"]) {
		dob := authStr(b["dob"])
		if !userDobRe.MatchString(dob) {
			httpx.Err(w, 400, "dob must be YYYY-MM-DD")
			return
		}
		params = append(params, dob)
		sets = append(sets, fmt.Sprintf("dob = $%d", len(params)))
	}

	// Phone — normalize (digits-only, India default for 10-digit input), store
	// the PEPPERED hash for contact lookup: HMAC(pepper, sha256(digits)).
	if authTruthy(b["phone"]) {
		digits := authNonDigitRe.ReplaceAllString(authStr(b["phone"]), "")
		if len(digits) == 10 {
			digits = "91" + digits
		}
		ph, err := vault.DiscoveryHash(userSha256Hex(digits))
		if err != nil {
			httpx.Err(w, 500, "Failed to update profile")
			return
		}
		params = append(params, ph)
		sets = append(sets, fmt.Sprintf("phone_hash = $%d", len(params)))
	}

	// Security Qs — hash answers, never store raw
	if v, present := b["securityQ1"]; present {
		params = append(params, authStrIfTruthy(v))
		sets = append(sets, fmt.Sprintf("security_q1 = $%d", len(params)))
	}
	if v, present := b["securityA1"]; present {
		var h *string
		if authTruthy(v) {
			s := userSha256Hex(strings.TrimSpace(strings.ToLower(authStr(v))))
			h = &s
		}
		params = append(params, h)
		sets = append(sets, fmt.Sprintf("security_a1_hash = $%d", len(params)))
	}
	if v, present := b["securityQ2"]; present {
		params = append(params, authStrIfTruthy(v))
		sets = append(sets, fmt.Sprintf("security_q2 = $%d", len(params)))
	}
	if v, present := b["securityA2"]; present {
		var h *string
		if authTruthy(v) {
			s := userSha256Hex(strings.TrimSpace(strings.ToLower(authStr(v))))
			h = &s
		}
		params = append(params, h)
		sets = append(sets, fmt.Sprintf("security_a2_hash = $%d", len(params)))
	}

	if len(sets) == 0 {
		// Nothing to update — return current profile
		u := &userUsersRow{}
		err := db.Pool.QueryRow(ctx,
			`SELECT `+userUsersCols+` FROM users WHERE id = $1 LIMIT 1`, user.ID).Scan(u.fields()...)
		if err != nil {
			if db.NoRows(err) {
				httpx.JSON(w, 200, nil) // Node publicUser(undefined) → null
			} else {
				httpx.Err(w, 500, "Failed to update profile")
			}
			return
		}
		httpx.JSON(w, 200, u.public())
		return
	}

	u := &userUsersRow{}
	err := db.Pool.QueryRow(ctx,
		`UPDATE users SET `+strings.Join(sets, ", ")+` WHERE id = $1 AND is_deleted = FALSE RETURNING `+userUsersCols,
		params...).Scan(u.fields()...)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "User not found")
		} else {
			httpx.Err(w, 500, "Failed to update profile")
		}
		return
	}
	httpx.JSON(w, 200, u.public())
}

// ── PIN ────────────────────────────────────────────────────────────────

var userPinRe = regexp.MustCompile(`^\d{4,8}$`)

func userPinPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		Pin any `json:"pin"`
	}
	_ = httpx.Body(r, &b)
	pin := authStr(b.Pin)
	if !userPinRe.MatchString(pin) {
		httpx.Err(w, 400, "PIN must be 4-8 digits")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(pin), userPinBcryptRounds)
	if err != nil {
		httpx.Err(w, 500, "Failed to save PIN")
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`UPDATE users SET pin_hash = $1 WHERE id = $2 AND is_deleted = FALSE`,
		string(hash), user.ID); err != nil {
		httpx.Err(w, 500, "Failed to save PIN")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func userPinVerify(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		Pin any `json:"pin"`
	}
	_ = httpx.Body(r, &b)
	pin := authStr(b.Pin)
	if !userPinRe.MatchString(pin) {
		httpx.JSON(w, 200, map[string]any{"ok": false})
		return
	}
	var pinHash, mpinHash *string
	err := db.Pool.QueryRow(ctx,
		`SELECT pin_hash, mpin_hash FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1`,
		user.ID).Scan(&pinHash, &mpinHash)
	if err != nil {
		if db.NoRows(err) {
			httpx.JSON(w, 200, map[string]any{"ok": false})
		} else {
			httpx.Err(w, 500, "PIN verification failed")
		}
		return
	}
	ok := false
	if pinHash != nil && *pinHash != "" {
		ok = bcrypt.CompareHashAndPassword([]byte(*pinHash), []byte(pin)) == nil
	}
	if !ok && mpinHash != nil && *mpinHash != "" {
		ok = vault.VerifySecret(pin, *mpinHash)
	}
	httpx.JSON(w, 200, map[string]any{"ok": ok})
}

// ── Push notification devices ──────────────────────────────────────────

func userDevicesPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		PushToken  any `json:"pushToken"`
		Platform   any `json:"platform"`
		DeviceName any `json:"deviceName"`
		AppVersion any `json:"appVersion"`
	}
	_ = httpx.Body(r, &b)
	pushToken := strings.TrimSpace(authStr(b.PushToken))
	platform := strings.ToLower(strings.TrimSpace(authStr(b.Platform)))
	var deviceName, appVersion *string
	if authTruthy(b.DeviceName) {
		s := truncRunes(authStr(b.DeviceName), 100)
		deviceName = &s
	}
	if authTruthy(b.AppVersion) {
		s := truncRunes(authStr(b.AppVersion), 32)
		appVersion = &s
	}

	if pushToken == "" {
		httpx.Err(w, 400, "pushToken required")
		return
	}
	if platform != "ios" && platform != "android" && platform != "web" {
		httpx.Err(w, 400, "platform must be ios | android | web")
		return
	}

	var id string
	err := db.Pool.QueryRow(ctx,
		`INSERT INTO devices (user_id, push_token, platform, device_name, app_version)
	     VALUES ($1, $2, $3, $4, $5)
	     ON CONFLICT (user_id, push_token) DO UPDATE SET
	       platform     = EXCLUDED.platform,
	       device_name  = COALESCE(EXCLUDED.device_name, devices.device_name),
	       app_version  = COALESCE(EXCLUDED.app_version, devices.app_version),
	       last_seen_at = NOW()
	     RETURNING id`,
		user.ID, pushToken, platform, deviceName, appVersion).Scan(&id)
	if err != nil {
		httpx.Err(w, 500, "Failed to register device")
		return
	}
	httpx.JSON(w, 200, map[string]any{"id": id})
}

func userDevicesDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		PushToken any `json:"pushToken"`
	}
	_ = httpx.Body(r, &b)
	pushToken := strings.TrimSpace(authStr(b.PushToken))
	if pushToken == "" {
		httpx.Err(w, 400, "pushToken required")
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`DELETE FROM devices WHERE user_id = $1 AND push_token = $2`,
		user.ID, pushToken); err != nil {
		httpx.Err(w, 500, "Failed to unregister device")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── TURN credentials for WebRTC calls ──────────────────────────────────

func userTurn(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	secret := os.Getenv("TURN_SECRET")
	if secret == "" {
		// No TURN configured — STUN-only fallback.
		httpx.JSON(w, 200, map[string]any{
			"iceServers": []map[string]any{
				{"urls": "stun:stun.l.google.com:19302"},
				{"urls": "stun:stun1.l.google.com:19302"},
			},
		})
		return
	}
	ttlSec := 24 * 3600
	expiry := time.Now().Unix() + int64(ttlSec)
	username := fmt.Sprintf("%d:%s", expiry, user.ID)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	host := os.Getenv("TURN_HOST")
	if host == "" {
		host = "turn.corefinite.com"
	}

	httpx.JSON(w, 200, map[string]any{
		"iceServers": turnIceServers(host, strings.TrimSpace(os.Getenv("TURN_HOST6")), username, credential),
		"ttl":        ttlSec,
	})
}

// turnIceServers builds the ICE server list handed to clients. Split out from
// userTurn so the URL shapes — which are easy to get subtly wrong and
// impossible to notice until a call fails — are directly testable.
func turnIceServers(host, host6, username, credential string) []map[string]any {
	servers := []map[string]any{
		{"urls": "stun:stun.l.google.com:19302"},
		{
			"urls": []string{
				fmt.Sprintf("turn:%s:3478?transport=udp", host),
				fmt.Sprintf("turn:%s:3478?transport=tcp", host),
				// UDP 443. Corporate networks, hotel Wi-Fi and some carriers
				// permit only 80/443, where 3478 is silently dropped and the
				// call gathers no relay candidate at all — the "sometimes it
				// just doesn't connect" class of failure. The host redirects
				// UDP 443 to 3478 (TCP 443 belongs to nginx and cannot move).
				fmt.Sprintf("turn:%s:443?transport=udp", host),
			},
			"username":   username,
			"credential": credential,
		},
	}

	// TURN over TLS. The most likely candidate to survive a restrictive network:
	// it is TCP and it looks exactly like HTTPS on the wire.
	//
	// This was dark for a long time — coturn had no certificate, refused to open
	// its TLS listener, and clients were handed a URL for a port with nothing
	// behind it, paying a connection timeout on every call before ICE moved on.
	// A certificate is now installed and republished on renewal by
	// /etc/letsencrypt/renewal-hooks/deploy/coturn.sh; without that hook the
	// listener would keep serving an expired certificate ~60 days later.
	//
	// Hostname, never a literal: the certificate is issued for TURN_HOST, so an
	// IP form would fail verification.
	servers = append(servers, map[string]any{
		"urls":       fmt.Sprintf("turns:%s:5349?transport=tcp", host),
		"username":   username,
		"credential": credential,
	})

	// IPv6 relay, addressed by LITERAL so it does not depend on DNS.
	//
	// coturn already listens on the host's IPv6 address, but TURN_HOST has no
	// AAAA record, so every client resolves the relay to IPv4 only and the v6
	// listener is unreachable. Mobile networks are increasingly IPv6-first
	// (measured on device: three global v6 addresses on Wi-Fi alone, and
	// WhatsApp using v6), and reaching an IPv4-only relay from one costs a
	// 464XLAT translation hop — extra latency, carrier NAT, and shorter UDP
	// mappings, all of which hurt call media. On a genuinely IPv6-only network
	// there is no relay at all.
	//
	// A literal beats publishing an AAAA record here because it needs no DNS
	// change to take effect and cannot be broken by a stale cache. Adding the
	// AAAA as well is still worthwhile; this does not conflict with it.
	//
	// turns: is deliberately NOT offered on the literal — the certificate is
	// issued for the hostname, so a literal would fail validation.
	if host6 != "" {
		servers = append(servers, map[string]any{
			"urls": []string{
				fmt.Sprintf("turn:[%s]:3478?transport=udp", host6),
				fmt.Sprintf("turn:[%s]:3478?transport=tcp", host6),
			},
			"username":   username,
			"credential": credential,
		})
	}

	return servers
}

// ── GET /user/export — GDPR data export ────────────────────────────────

func userExport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	fail := func() { httpx.Err(w, 500, "Export failed") }

	u := &userUsersRow{}
	err := db.Pool.QueryRow(ctx,
		`SELECT `+userUsersCols+` FROM users WHERE id = $1 LIMIT 1`, user.ID).Scan(u.fields()...)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "User not found")
		} else {
			fail()
		}
		return
	}
	profile := u.public()

	var discoverable, lastSeenVisible, readReceipts, profilePhotoVisible *bool
	if err := db.Pool.QueryRow(ctx,
		`SELECT discoverable, last_seen_visible, read_receipts, profile_photo_visible
	       FROM users WHERE id = $1`, user.ID).Scan(&discoverable, &lastSeenVisible, &readReceipts, &profilePhotoVisible); err != nil && !db.NoRows(err) {
		fail()
		return
	}

	blocks := []map[string]any{}
	rows, err := db.Pool.Query(ctx,
		`SELECT blocked_id, created_at FROM user_blocks WHERE blocker_id = $1`, user.ID)
	if err != nil {
		fail()
		return
	}
	for rows.Next() {
		var id string
		var createdAt time.Time
		if err := rows.Scan(&id, &createdAt); err != nil {
			rows.Close()
			fail()
			return
		}
		blocks = append(blocks, map[string]any{"userId": id, "createdAt": httpx.JSTime(createdAt)})
	}
	rows.Close()

	devices := []map[string]any{}
	rows, err = db.Pool.Query(ctx,
		`SELECT platform, push_token, last_seen_at, created_at FROM devices WHERE user_id = $1`, user.ID)
	if err != nil {
		fail()
		return
	}
	for rows.Next() {
		var platform string
		var pushToken *string
		var lastSeenAt, createdAt time.Time
		if err := rows.Scan(&platform, &pushToken, &lastSeenAt, &createdAt); err != nil {
			rows.Close()
			fail()
			return
		}
		tok := ""
		if pushToken != nil {
			tok = *pushToken
		}
		suffix := tok
		if len(tok) > 12 {
			suffix = tok[len(tok)-12:]
		}
		devices = append(devices, map[string]any{
			"platform": platform,
			// Don't dump full push tokens (they're sensitive credentials) — truncate.
			"pushTokenSuffix": suffix,
			"lastSeenAt":      httpx.JSTime(lastSeenAt),
			"createdAt":       httpx.JSTime(createdAt),
		})
	}
	rows.Close()

	chats := []map[string]any{}
	rows, err = db.SysPool.Query(ctx,
		`SELECT c.id, c.type, c.name, c.photo_url, c.created_at,
	            cm.role, cm.joined_at, cm.left_at, cm.last_read_message_id
	       FROM chats c
	       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1`, user.ID)
	if err != nil {
		fail()
		return
	}
	for rows.Next() {
		var id, chatType, role string
		var name, photoURL *string
		var createdAt, joinedAt time.Time
		var leftAt *time.Time
		var lastRead *int64
		if err := rows.Scan(&id, &chatType, &name, &photoURL, &createdAt, &role, &joinedAt, &leftAt, &lastRead); err != nil {
			rows.Close()
			fail()
			return
		}
		chats = append(chats, map[string]any{
			"id": id, "type": chatType, "name": name, "photoURL": photoURL,
			"createdAt": httpx.JSTime(createdAt),
			"role":      role, "joinedAt": httpx.JSTime(joinedAt), "leftAt": httpx.JST(leftAt),
			"lastReadMessageId": userBigStr(lastRead),
		})
	}
	rows.Close()

	messages := []map[string]any{}
	rows, err = db.SysPool.Query(ctx,
		`SELECT m.id, m.chat_id, m.sender_id, m.type, m.content, m.meta,
	            m.reply_to_id, m.created_at, m.edited_at, m.deleted_at
	       FROM messages m
	       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
	      WHERE cm.left_at IS NULL OR m.created_at <= cm.left_at
	      ORDER BY m.id DESC
	      LIMIT 10000`, user.ID)
	if err != nil {
		fail()
		return
	}
	for rows.Next() {
		var id int64
		var chatID, senderID, msgType string
		var content *string
		var meta any
		var replyTo *int64
		var createdAt time.Time
		var editedAt, deletedAt *time.Time
		if err := rows.Scan(&id, &chatID, &senderID, &msgType, &content, &meta, &replyTo, &createdAt, &editedAt, &deletedAt); err != nil {
			rows.Close()
			fail()
			return
		}
		messages = append(messages, map[string]any{
			"id": strconv.FormatInt(id, 10), "chatId": chatID, "senderId": senderID, "type": msgType,
			"content": content, "meta": meta, "replyToId": userBigStr(replyTo),
			"createdAt": httpx.JSTime(createdAt), "editedAt": httpx.JST(editedAt), "deletedAt": httpx.JST(deletedAt),
		})
	}
	rows.Close()

	attachments := []map[string]any{}
	rows, err = db.SysPool.Query(ctx,
		`SELECT id, filename, mime_type, size_bytes, created_at
	       FROM attachments WHERE owner_user_id = $1`, user.ID)
	if err != nil {
		fail()
		return
	}
	for rows.Next() {
		var id, filename, mime string
		var size int
		var createdAt time.Time
		if err := rows.Scan(&id, &filename, &mime, &size, &createdAt); err != nil {
			rows.Close()
			fail()
			return
		}
		attachments = append(attachments, map[string]any{
			"id": id, "filename": filename, "mime": mime, "size": size,
			"createdAt": httpx.JSTime(createdAt),
		})
	}
	rows.Close()

	// Reactions are no longer a table. Migration 056 dropped message_reactions
	// when reactions became E2EE reference-messages ({reactsTo, op, emoji}
	// sealed inside an ordinary message), so this query had been failing with
	// 42P01 and taking the WHOLE export down with it — "Export my data" was a
	// 500 against any migrated database. The reactions are not missing from the
	// export: they are in `messages`, sealed, like every other message. The key
	// stays, empty, for schemaVersion 1 consumers.
	reactions := []map[string]any{}

	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="vaultchat-export-%s.json"`, user.ID))
	httpx.JSON(w, 200, map[string]any{
		"schemaVersion": 1,
		"exportedAt":    httpx.JSTime(time.Now()),
		"user": map[string]any{
			"profile": profile,
			"settings": map[string]any{
				"discoverable":        discoverable,
				"lastSeenVisible":     lastSeenVisible,
				"readReceipts":        readReceipts,
				"profilePhotoVisible": profilePhotoVisible,
			},
		},
		"blocks":      blocks,
		"devices":     devices,
		"chats":       chats,
		"messages":    messages,
		"attachments": attachments,
		"reactions":   reactions,
	})
}

// ── DELETE /user/account ───────────────────────────────────────────────

func userAccountDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)

	// "Tell us why you're leaving" — optional, exactly like WhatsApp's. Logged
	// and nothing more: it is product feedback, and writing it to a table keyed
	// by the account we are erasing would defeat the point of erasing it.
	var body struct {
		Reason string `json:"reason"`
	}
	_ = httpx.Body(r, &body)
	if body.Reason != "" {
		if len(body.Reason) > 120 {
			body.Reason = body.Reason[:120]
		}
		log.Printf("[account delete] reason=%q", body.Reason)
	}

	err := authTx(ctx, func(tx pgx.Tx) error {
		// ERASE the identity, do not merely flag it.
		//
		// This used to set is_deleted and stop, leaving every encrypted field,
		// the MPIN hash, the recovery answers and the published E2EE identity
		// exactly where they were. "Delete my account" has to actually delete,
		// both because Play requires it of any app with accounts and because a
		// flag is not what a person asking to be forgotten is asking for.
		//
		// Nulling the lookup hashes also frees the address: the duplicate check
		// in /auth/profile/init only counts rows where is_deleted = FALSE, so
		// without this a returning user could re-register but we would still be
		// holding an HMAC of their old email and phone forever.
		if _, err := tx.Exec(ctx,
			`UPDATE users SET
			   is_deleted = TRUE, deleted_at = NOW(), updated_at = NOW(),
			   email = NULL, phone = NULL, name = NULL, dob = NULL, status = NULL,
			   email_lookup = NULL, phone_lookup = NULL, phone_hash = NULL,
			   email_cipher = NULL, phone_cipher = NULL,
			   first_name_cipher = NULL, last_name_cipher = NULL,
			   dob_cipher = NULL, status_cipher = NULL,
			   photo_url = NULL, photo_key_cipher = NULL,
			   mpin_hash = NULL, pin_hash = NULL, google_sub = NULL, vault_id = NULL
			 WHERE id = $1`, user.ID); err != nil {
			return err
		}

		// The row itself STAYS. Deleting it would be one statement and is the
		// wrong statement: messages.sender_id is ON DELETE CASCADE, so a hard
		// delete would take every message this person ever sent out of everyone
		// else's conversations — destroying other people's history to honour one
		// person's request. The tombstone keeps those foreign keys valid while
		// holding nothing that identifies anyone.
		//
		// Their own message bodies are not orphaned by this: the delivery-bound
		// sweep in jobs.go already erases server-side ciphertext once every
		// device has it, and each recipient's copy is on their own device,
		// encrypted to keys we never had.
		for _, q := range []string{
			`DELETE FROM user_security_questions WHERE user_id = $1`, // recovery credential
			`DELETE FROM identity_keys           WHERE user_id = $1`, // published E2EE identity
			`DELETE FROM signed_prekeys          WHERE user_id = $1`,
			`DELETE FROM one_time_prekeys        WHERE user_id = $1`,
			`DELETE FROM user_backup_keys        WHERE user_id = $1`, // encrypted-backup key material
			`DELETE FROM devices                 WHERE user_id = $1`, // device records + push tokens
			`DELETE FROM user_sync_devices       WHERE user_id = $1`,
			`DELETE FROM trusted_contacts        WHERE owner_id = $1`,
			`DELETE FROM refresh_tokens          WHERE user_id = $1`, // sign every session out, permanently

			// Leave every group, the same way the Leave button does. WhatsApp
			// removes a deleted account from all of its groups, and a tombstone
			// sitting silently in a roster is worse than either alternative:
			// members keep seeing a phantom, and admin counts still include it.
			// left_at rather than DELETE because that is what the rest of the
			// codebase means by "not a member" (idx_chat_members_user, every
			// roster query) and it keeps the group's own history intact.
			`UPDATE chat_members SET left_at = NOW() WHERE user_id = $1 AND left_at IS NULL`,

			// Content and settings that are theirs alone. Rows where the user is
			// the OBJECT rather than the subject — someone else's block, someone
			// else's ghost-mode entry — are deliberately left: those belong to
			// the other person and now point at a tombstone that says nothing.
			`DELETE FROM stories              WHERE user_id     = $1`, // their status posts (cascades views/keys)
			`DELETE FROM story_views          WHERE viewer_id   = $1`, // what they watched
			`DELETE FROM story_keys           WHERE viewer_id   = $1`,
			`DELETE FROM status_audience      WHERE owner_id    = $1`,
			`DELETE FROM user_backups         WHERE user_id     = $1`, // server-side chat backup
			`DELETE FROM security_events      WHERE user_id     = $1`, // their encrypted audit chain
			`DELETE FROM user_blocks          WHERE blocker_id  = $1`,
			`DELETE FROM ghost_mode           WHERE owner_id    = $1`,
			`DELETE FROM contact_verifications WHERE user_id    = $1`,
			`DELETE FROM bookmarks            WHERE user_id     = $1`,
			`DELETE FROM scheduled_messages   WHERE user_id     = $1`, // nothing may send after they are gone
			`DELETE FROM breach_monitors      WHERE user_id     = $1`,
			`DELETE FROM sos_events           WHERE user_id     = $1`,
			`DELETE FROM chat_codes           WHERE owner_id    = $1`,
			`DELETE FROM sync_codes           WHERE initiator_id = $1`,
			`DELETE FROM group_sender_keys    WHERE sender_id   = $1 OR recipient_id = $1`,
			`DELETE FROM channel_subscribers  WHERE user_id     = $1`,
			`DELETE FROM poll_votes           WHERE user_id     = $1`,
			`DELETE FROM family_relations     WHERE viewer_id   = $1`,
		} {
			if _, err := tx.Exec(ctx, q, user.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to delete account")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── Ghost Mode ─────────────────────────────────────────────────────────

func userGhostModeList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(ctx,
		`SELECT g.target_id, g.hide_online, g.hide_typing, g.hide_read, g.hide_last_seen, g.updated_at,
	            u.name, u.email, u.photo_url
	       FROM ghost_mode g
	       JOIN users u ON u.id = g.target_id
	      WHERE g.owner_id = $1
	        AND (g.hide_online OR g.hide_typing OR g.hide_read OR g.hide_last_seen)
	      ORDER BY g.updated_at DESC`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load ghost mode list")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var targetID string
		var ho, ht, hr, hl bool
		var updatedAt time.Time
		var name, email, photoURL *string
		if err := rows.Scan(&targetID, &ho, &ht, &hr, &hl, &updatedAt, &name, &email, &photoURL); err != nil {
			httpx.Err(w, 500, "Failed to load ghost mode list")
			return
		}
		out = append(out, map[string]any{
			"targetId": targetID, "hideOnline": ho, "hideTyping": ht,
			"hideRead": hr, "hideLastSeen": hl, "updatedAt": httpx.JSTime(updatedAt),
			"name": name, "email": email, "photoURL": photoURL,
		})
	}
	httpx.JSON(w, 200, out)
}

func userGhostModeGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	targetID := r.PathValue("targetId")
	if targetID == user.ID {
		httpx.Err(w, 400, "Cannot ghost-mode yourself")
		return
	}
	var tid string
	var ho, ht, hr, hl bool
	var updatedAt time.Time
	err := db.Pool.QueryRow(ctx,
		`SELECT target_id, hide_online, hide_typing, hide_read, hide_last_seen, updated_at
	       FROM ghost_mode WHERE owner_id = $1 AND target_id = $2`,
		user.ID, targetID).Scan(&tid, &ho, &ht, &hr, &hl, &updatedAt)
	if err != nil {
		if db.NoRows(err) {
			// Default row — note: NO updatedAt key, exactly like Node.
			httpx.JSON(w, 200, map[string]any{
				"targetId": targetID, "hideOnline": false, "hideTyping": false,
				"hideRead": false, "hideLastSeen": false,
			})
		} else {
			httpx.Err(w, 500, "Failed to load ghost mode")
		}
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"targetId": tid, "hideOnline": ho, "hideTyping": ht,
		"hideRead": hr, "hideLastSeen": hl, "updatedAt": httpx.JSTime(updatedAt),
	})
}

func userGhostModePut(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	targetID := r.PathValue("targetId")
	if targetID == user.ID {
		httpx.Err(w, 400, "Cannot ghost-mode yourself")
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	flag := func(key string) *bool {
		v, present := b[key]
		if !present {
			return nil
		}
		t := authTruthy(v)
		return &t
	}
	ho, ht, hr, hl := flag("hideOnline"), flag("hideTyping"), flag("hideRead"), flag("hideLastSeen")
	if ho == nil && ht == nil && hr == nil && hl == nil {
		httpx.Err(w, 400, "At least one flag required")
		return
	}

	// Upsert with COALESCE so a partial body doesn't clobber other flags.
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO ghost_mode (owner_id, target_id, hide_online, hide_typing, hide_read, hide_last_seen)
	     VALUES ($1, $2, COALESCE($3, FALSE), COALESCE($4, FALSE), COALESCE($5, FALSE), COALESCE($6, FALSE))
	     ON CONFLICT (owner_id, target_id) DO UPDATE
	       SET hide_online    = COALESCE($3, ghost_mode.hide_online),
	           hide_typing    = COALESCE($4, ghost_mode.hide_typing),
	           hide_read      = COALESCE($5, ghost_mode.hide_read),
	           hide_last_seen = COALESCE($6, ghost_mode.hide_last_seen)`,
		user.ID, targetID, ho, ht, hr, hl); err != nil {
		httpx.Err(w, 500, "Failed to save ghost mode")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func userGhostModeDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if _, err := db.Pool.Exec(ctx,
		`DELETE FROM ghost_mode WHERE owner_id = $1 AND target_id = $2`,
		user.ID, r.PathValue("targetId")); err != nil {
		httpx.Err(w, 500, "Failed to clear ghost mode")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── Bookmarks (saved messages) ─────────────────────────────────────────

const userMaxBookmarkNote = 280

func userBookmarksGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rows, err := db.SysPool.Query(ctx,
		`SELECT b.id, b.note, b.created_at,
	            m.id   AS message_id,
	            m.chat_id, m.sender_id, m.type, m.content, m.meta,
	            m.created_at AS message_created_at, m.deleted_at,
	            c.type AS chat_type, c.name AS chat_name,
	            -- Anonymous code chat, not yet mutually saved (migration 119).
	            -- Bookmarking a message from a masked peer must not be a way to
	            -- read their name back. su.name is the LEGACY plaintext column
	            -- and is NULL for every vault-onboarded account, so this only
	            -- ever had teeth for older accounts — but the promise the
	            -- feature makes does not have an exception for those.
	            CASE WHEN c.anon
	                  AND EXISTS (SELECT 1 FROM chat_members am
	                               WHERE am.chat_id = c.id AND am.left_at IS NULL
	                                 AND am.saved_peer = FALSE)
	                 THEN NULL ELSE su.name END AS sender_name
	       FROM bookmarks b
	       LEFT JOIN messages m ON m.id = b.message_id
	       LEFT JOIN chats    c ON c.id = m.chat_id
	       LEFT JOIN users    su ON su.id = m.sender_id
	      WHERE b.user_id = $1
	      ORDER BY b.created_at DESC
	      LIMIT 500`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load bookmarks")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var note *string
		var createdAt time.Time
		var messageID *int64
		var chatID, senderID, msgType, content *string
		var meta any
		var messageCreatedAt, deletedAt *time.Time
		var chatType, chatName, senderName *string
		if err := rows.Scan(&id, &note, &createdAt, &messageID, &chatID, &senderID, &msgType,
			&content, &meta, &messageCreatedAt, &deletedAt, &chatType, &chatName, &senderName); err != nil {
			httpx.Err(w, 500, "Failed to load bookmarks")
			return
		}
		var message any
		if messageID != nil {
			message = map[string]any{
				"id":         *messageID, // Node: Number(row.message_id)
				"chatId":     chatID,
				"chatType":   chatType,
				"chatName":   chatName,
				"senderId":   senderID,
				"senderName": senderName,
				"type":       msgType,
				"content":    content,
				"meta":       meta,
				"createdAt":  httpx.JST(messageCreatedAt),
				"deletedAt":  httpx.JST(deletedAt),
			}
		}
		out = append(out, map[string]any{
			"id":        strconv.FormatInt(id, 10),
			"note":      note,
			"createdAt": httpx.JSTime(createdAt),
			"message":   message,
		})
	}
	httpx.JSON(w, 200, out)
}

func userBookmarksPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		MessageID any `json:"messageId"`
		Note      any `json:"note"`
	}
	_ = httpx.Body(r, &b)
	messageID, ok := httpx.ParseIntPrefix(authStr(b.MessageID))
	if !ok {
		httpx.Err(w, 400, "messageId required")
		return
	}
	var note *string
	if b.Note != nil {
		s := truncRunes(authStr(b.Note), userMaxBookmarkNote)
		note = &s
	}

	// Verify the caller is still an active member of the message's chat.
	// Two-step so we return 404 for unknown messages vs 403 for member-loss.
	//
	// The message read is BOUND to the caller so RLS backs up the check below
	// rather than the check standing alone. Two independent gates:
	//
	//   RLS enforced   → a non-member's read returns no rows → 404, and the
	//                    membership check never runs. The handler is correct
	//                    even if that check were removed or written wrongly.
	//   RLS not enforced (today — see docs/RLS_ENFORCEMENT.md)
	//                  → the read succeeds and the membership check answers 403,
	//                    exactly as it does now. No behaviour change.
	//
	// So enforcing RLS turns some 403s into 404s on this path. That is the
	// safer of the two: a 403 confirms the message exists, a 404 does not.
	var mid int64
	var chatID string
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT m.id, m.chat_id FROM messages m WHERE m.id = $1 LIMIT 1`, messageID).Scan(&mid, &chatID)
	})
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "Message not found")
		} else {
			httpx.Err(w, 500, "Failed to save bookmark")
		}
		return
	}
	var one int
	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT 1 FROM chat_members
		      WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
			chatID, user.ID).Scan(&one)
	})
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 403, "Not a member of this chat")
		} else {
			httpx.Err(w, 500, "Failed to save bookmark")
		}
		return
	}

	var id int64
	var retNote *string
	var createdAt time.Time
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO bookmarks (user_id, message_id, note)
	     VALUES ($1, $2, $3)
	     ON CONFLICT (user_id, message_id)
	       DO UPDATE SET note = COALESCE(EXCLUDED.note, bookmarks.note)
	     RETURNING id, note, created_at`,
		user.ID, messageID, note).Scan(&id, &retNote, &createdAt)
	if err != nil {
		httpx.Err(w, 500, "Failed to save bookmark")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"id":        strconv.FormatInt(id, 10),
		"note":      retNote,
		"createdAt": httpx.JSTime(createdAt),
	})
}

func userBookmarksDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id, ok := httpx.ParseIntPrefix(r.PathValue("id"))
	if !ok {
		httpx.Err(w, 400, "Invalid id")
		return
	}
	var retID int64
	err := db.Pool.QueryRow(ctx,
		`DELETE FROM bookmarks WHERE id = $1 AND user_id = $2 RETURNING id`,
		id, user.ID).Scan(&retID)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "Not found")
		} else {
			httpx.Err(w, 500, "Failed to remove bookmark")
		}
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── Sessions ───────────────────────────────────────────────────────────

// userHashCurrentRefresh mirrors user.js hashCurrentRefresh: bcrypt with a
// FRESH salt (jwt.hashRefresh), so it deliberately matches nothing stored —
// Node's is_current / keep-current comparisons behave identically.
func userHashCurrentRefresh(rawHeader string) *string {
	tok := strings.TrimSpace(rawHeader)
	if tok == "" {
		return nil
	}
	h, err := bcrypt.GenerateFromPassword([]byte(tok), authBcryptRounds)
	if err != nil {
		return nil
	}
	s := string(h)
	return &s
}

// userInetStr renders a nullable INET like node-pg (pg text form).
func userInetStr(p *netip.Prefix) *string {
	if p == nil {
		return nil
	}
	var s string
	if p.Bits() == p.Addr().BitLen() {
		s = p.Addr().String()
	} else {
		s = p.String()
	}
	return &s
}

func userSessionsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	currentHash := ""
	if h := userHashCurrentRefresh(r.Header.Get("X-Current-Refresh")); h != nil {
		currentHash = *h
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT id, user_agent, ip, created_at, last_used_at, expires_at,
	            token_hash = $2 AS is_current
	       FROM refresh_tokens
	      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
	      ORDER BY COALESCE(last_used_at, created_at) DESC`,
		user.ID, currentHash)
	if err != nil {
		httpx.Err(w, 500, "Failed to list sessions")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var userAgent *string
		var ip *netip.Prefix
		var createdAt, expiresAt time.Time
		var lastUsedAt *time.Time
		var isCurrent bool
		if err := rows.Scan(&id, &userAgent, &ip, &createdAt, &lastUsedAt, &expiresAt, &isCurrent); err != nil {
			httpx.Err(w, 500, "Failed to list sessions")
			return
		}
		out = append(out, map[string]any{
			"id":         strconv.FormatInt(id, 10),
			"userAgent":  userAgent,
			"ip":         userInetStr(ip),
			"createdAt":  httpx.JSTime(createdAt),
			"lastUsedAt": httpx.JST(lastUsedAt),
			"expiresAt":  httpx.JSTime(expiresAt),
			"isCurrent":  isCurrent,
		})
	}
	httpx.JSON(w, 200, out)
}

func userSessionsDeleteOne(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id, ok := httpx.ParseIntPrefix(r.PathValue("id"))
	if !ok {
		httpx.Err(w, 400, "Invalid session id")
		return
	}
	var retID int64
	err := db.Pool.QueryRow(ctx,
		`UPDATE refresh_tokens SET revoked_at = NOW()
	      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
	      RETURNING id`,
		id, user.ID).Scan(&retID)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "Session not found or already revoked")
		} else {
			httpx.Err(w, 500, "Failed to revoke session")
		}
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func userSessionsDeleteAll(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	currentHash := userHashCurrentRefresh(r.Header.Get("X-Current-Refresh"))
	if currentHash == nil {
		httpx.Err(w, 400, "X-Current-Refresh header required so we don't lock you out")
		return
	}
	tag, err := db.Pool.Exec(ctx,
		`UPDATE refresh_tokens SET revoked_at = NOW()
	      WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2`,
		user.ID, *currentHash)
	if err != nil {
		httpx.Err(w, 500, "Failed to revoke other sessions")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "revoked": tag.RowsAffected()})
}

// ── Scheduled messages ─────────────────────────────────────────────────

var userSchedTypes = map[string]bool{
	"text": true, "image": true, "video": true, "audio": true,
	"file": true, "location": true, "system": true, "sticker": true,
}

func userScheduledGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rows, err := db.SysPool.Query(ctx,
		`SELECT s.id, s.chat_id, s.type, s.content, s.meta, s.reply_to_id,
	            s.send_at, s.sent_at, s.message_id, s.created_at,
	            c.type AS chat_type, c.name AS chat_name
	       FROM scheduled_messages s
	       JOIN chats c ON c.id = s.chat_id
	      WHERE s.user_id = $1
	        AND (s.sent_at IS NULL OR s.sent_at > NOW() - INTERVAL '7 days')
	      ORDER BY COALESCE(s.sent_at, s.send_at) DESC
	      LIMIT 200`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load scheduled messages")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var chatID, msgType string
		var content *string
		var meta any
		var replyTo, messageID *int64
		var sendAt, createdAt time.Time
		var sentAt *time.Time
		var chatType string
		var chatName *string
		if err := rows.Scan(&id, &chatID, &msgType, &content, &meta, &replyTo,
			&sendAt, &sentAt, &messageID, &createdAt, &chatType, &chatName); err != nil {
			httpx.Err(w, 500, "Failed to load scheduled messages")
			return
		}
		out = append(out, map[string]any{
			"id":        strconv.FormatInt(id, 10),
			"chatId":    chatID,
			"chatName":  chatName,
			"chatType":  chatType,
			"type":      msgType,
			"content":   content,
			"meta":      meta,
			"replyToId": userBigStr(replyTo),
			"sendAt":    httpx.JSTime(sendAt),
			"sentAt":    httpx.JST(sentAt),
			"messageId": userBigStr(messageID),
			"createdAt": httpx.JSTime(createdAt),
		})
	}
	httpx.JSON(w, 200, out)
}

// userParseJSDate covers the date inputs clients actually send (ISO strings,
// epoch-ms numbers) — the same shapes new Date(x) accepts on those inputs.
func userParseJSDate(v any) (time.Time, bool) {
	if f, ok := v.(float64); ok {
		return time.UnixMilli(int64(f)).UTC(), true
	}
	s, ok := v.(string)
	if !ok {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339,
		"2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func userScheduledPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		ChatID    any `json:"chatId"`
		SendAt    any `json:"sendAt"`
		Type      any `json:"type"`
		Content   any `json:"content"`
		Meta      any `json:"meta"`
		ReplyToID any `json:"replyToId"`
	}
	_ = httpx.Body(r, &b)
	chatID := authStr(b.ChatID)
	msgType := "text"
	if authTruthy(b.Type) {
		msgType = authStr(b.Type)
	}
	var content *string
	if b.Content != nil {
		s := authStr(b.Content)
		content = &s
	}
	var meta any
	switch b.Meta.(type) {
	case map[string]any, []any:
		meta = b.Meta
	}

	if chatID == "" {
		httpx.Err(w, 400, "chatId required")
		return
	}
	if !authTruthy(b.SendAt) {
		httpx.Err(w, 400, "sendAt required (ISO timestamp)")
		return
	}
	if !userSchedTypes[msgType] {
		httpx.Err(w, 400, "invalid type")
		return
	}
	sendAt, ok := userParseJSDate(b.SendAt)
	if !ok {
		httpx.Err(w, 400, "sendAt is not a valid date")
		return
	}
	now := time.Now()
	if sendAt.Before(now.Add(5 * time.Second)) {
		httpx.Err(w, 400, "sendAt must be at least 5 seconds in the future")
		return
	}
	if sendAt.After(now.Add(365 * 24 * time.Hour)) {
		httpx.Err(w, 400, "sendAt cannot be more than 1 year out")
		return
	}

	var replyTo *int64
	if authTruthy(b.ReplyToID) {
		n, ok := httpx.ParseIntPrefix(authStr(b.ReplyToID))
		if !ok {
			// Node inserts NaN → pg rejects → catch-all 500.
			httpx.Err(w, 500, "Failed to schedule message")
			return
		}
		replyTo = &n
	}

	// Verify the caller is still a member of the chat right now.
	var one int
	err := db.SysPool.QueryRow(ctx,
		`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		chatID, user.ID).Scan(&one)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 403, "Not a member of this chat")
		} else {
			httpx.Err(w, 500, "Failed to schedule message")
		}
		return
	}

	// Type-specific validation matches POST /chats/:id/messages.
	isMedia := msgType == "image" || msgType == "video" || msgType == "audio" || msgType == "file"
	if msgType == "text" && (content == nil || *content == "") {
		// Node: content falsy OR non-string → 400. authStr coerced non-strings
		// already; only empty/absent remain falsy here.
		httpx.Err(w, 400, "content required for text messages")
		return
	}
	if isMedia {
		isExternalGif := false
		if m, ok := meta.(map[string]any); ok && msgType == "image" {
			if gifURL, ok := m["gifUrl"].(string); ok {
				if userGifURLRe.MatchString(gifURL) && len(gifURL) <= 2048 {
					isExternalGif = true
				}
			}
		}
		hasAttachment := false
		if m, ok := meta.(map[string]any); ok {
			hasAttachment = authTruthy(m["attachmentId"])
		}
		if !isExternalGif && !hasAttachment {
			httpx.Err(w, 400, "meta.attachmentId required for media messages")
			return
		}
	}

	var id int64
	var retChatID, retType string
	var retContent *string
	var retMeta any
	var retReplyTo *int64
	var retSendAt, retCreatedAt time.Time
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO scheduled_messages (user_id, chat_id, type, content, meta, reply_to_id, send_at)
	     VALUES ($1, $2, $3, $4, $5, $6, $7)
	     RETURNING id, chat_id, type, content, meta, reply_to_id, send_at, created_at`,
		user.ID, chatID, msgType, content, meta, replyTo,
		sendAt.UTC().Format("2006-01-02T15:04:05.000Z")).
		Scan(&id, &retChatID, &retType, &retContent, &retMeta, &retReplyTo, &retSendAt, &retCreatedAt)
	if err != nil {
		httpx.Err(w, 500, "Failed to schedule message")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"id":        strconv.FormatInt(id, 10),
		"chatId":    retChatID,
		"type":      retType,
		"content":   retContent,
		"meta":      retMeta,
		"replyToId": userBigStr(retReplyTo),
		"sendAt":    httpx.JSTime(retSendAt),
		"createdAt": httpx.JSTime(retCreatedAt),
	})
}

var userGifURLRe = regexp.MustCompile(`^https://\S+$`)

func userScheduledDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id, ok := httpx.ParseIntPrefix(r.PathValue("id"))
	if !ok {
		httpx.Err(w, 400, "Invalid id")
		return
	}
	var retID int64
	err := db.Pool.QueryRow(ctx,
		`DELETE FROM scheduled_messages
	      WHERE id = $1 AND user_id = $2 AND sent_at IS NULL
	      RETURNING id`,
		id, user.ID).Scan(&retID)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "Not found or already sent")
		} else {
			httpx.Err(w, 500, "Failed to cancel scheduled message")
		}
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── Key bundles (X3DH prekey distribution) ─────────────────────────────

const (
	userMinOtpkPool   = 10
	userMaxOtpkUpload = 100
)

// GET /user/:id/keybundle (via userSubtreeGet)
func userKeybundleGet(w http.ResponseWriter, r *http.Request, targetID string) {
	ctx := r.Context()
	if targetID == "" {
		httpx.Err(w, 400, "user id required")
		return
	}

	missing := false
	var identityKey string
	var signedPreKey any
	var oneTimePreKey any
	remaining := 0

	err := authTx(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx,
			`SELECT public_key_b64 FROM identity_keys WHERE user_id = $1`, targetID).Scan(&identityKey)
		if err != nil {
			if db.NoRows(err) {
				missing = true
				return nil
			}
			return err
		}

		var spKeyID int
		var spPub, spSig string
		err = tx.QueryRow(ctx,
			`SELECT key_id, public_key_b64, signature_b64
	           FROM signed_prekeys
	          WHERE user_id = $1 AND retired_at IS NULL
	          ORDER BY created_at DESC
	          LIMIT 1`, targetID).Scan(&spKeyID, &spPub, &spSig)
		if err == nil {
			signedPreKey = map[string]any{"keyId": spKeyID, "publicKey": spPub, "signature": spSig}
		} else if !db.NoRows(err) {
			return err
		}

		var otpID int64
		var otpKeyID int
		var otpPub string
		err = tx.QueryRow(ctx,
			`SELECT id, key_id, public_key_b64
	           FROM one_time_prekeys
	          WHERE user_id = $1 AND used_at IS NULL
	          ORDER BY id
	          FOR UPDATE SKIP LOCKED
	          LIMIT 1`, targetID).Scan(&otpID, &otpKeyID, &otpPub)
		if err == nil {
			if _, err := tx.Exec(ctx,
				`UPDATE one_time_prekeys SET used_at = NOW() WHERE id = $1`, otpID); err != nil {
				return err
			}
			oneTimePreKey = map[string]any{"keyId": otpKeyID, "publicKey": otpPub}
		} else if !db.NoRows(err) {
			return err
		}

		return tx.QueryRow(ctx,
			`SELECT COUNT(*)::int AS n FROM one_time_prekeys WHERE user_id = $1 AND used_at IS NULL`,
			targetID).Scan(&remaining)
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to load key bundle")
		return
	}
	if missing {
		httpx.Err(w, 404, "User has no key bundle")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"identityKey":   identityKey,
		"signedPreKey":  signedPreKey,
		"oneTimePreKey": oneTimePreKey,
		"remainingOtpk": remaining,
	})
}

func userKeybundlePost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := httpx.UserFrom(r).ID
	var b struct {
		IdentityKey    any `json:"identityKey"`
		SignedPreKey   any `json:"signedPreKey"`
		OneTimePreKeys any `json:"oneTimePreKeys"`
	}
	_ = httpx.Body(r, &b)

	otpkIn, _ := b.OneTimePreKeys.([]any)
	if len(otpkIn) > userMaxOtpkUpload {
		httpx.Err(w, 400, fmt.Sprintf("Too many one-time prekeys (max %d)", userMaxOtpkUpload))
		return
	}

	// Node inserts JS numbers into INTEGER key_id; a fractional value fails at
	// pg → catch-all 500. Mirror the visible outcome without the round-trip.
	intKey := func(v any) (int64, bool) {
		f, ok := v.(float64)
		if !ok || f != math.Trunc(f) {
			return 0, false
		}
		return int64(f), true
	}

	err := authTx(ctx, func(tx pgx.Tx) error {
		if ik, ok := b.IdentityKey.(string); ok && len(ik) > 0 {
			ik = truncRunes(ik, 8192)
			// Fresh identity (reinstall / re-provision) invalidates the previous
			// identity's prekeys — purge so only the new identity's remain.
			var prevKey string
			identityChanged := false
			err := tx.QueryRow(ctx,
				`SELECT public_key_b64 FROM identity_keys WHERE user_id = $1`, userID).Scan(&prevKey)
			if err == nil {
				identityChanged = prevKey != ik
			} else if !db.NoRows(err) {
				return err
			}

			if _, err := tx.Exec(ctx,
				`INSERT INTO identity_keys (user_id, public_key_b64)
	             VALUES ($1, $2)
	             ON CONFLICT (user_id) DO UPDATE SET public_key_b64 = EXCLUDED.public_key_b64, updated_at = NOW()`,
				userID, ik); err != nil {
				return err
			}

			if identityChanged {
				if _, err := tx.Exec(ctx,
					`DELETE FROM one_time_prekeys WHERE user_id = $1`, userID); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx,
					`UPDATE signed_prekeys SET retired_at = NOW() WHERE user_id = $1 AND retired_at IS NULL`,
					userID); err != nil {
					return err
				}
			}
		}

		if sp, ok := b.SignedPreKey.(map[string]any); ok {
			_, keyIsNum := sp["keyId"].(float64)
			pub, pubOK := sp["publicKey"].(string)
			sig, sigOK := sp["signature"].(string)
			if keyIsNum && pubOK && sigOK {
				keyID, ok := intKey(sp["keyId"])
				if !ok {
					return fmt.Errorf("fractional keyId")
				}
				if _, err := tx.Exec(ctx,
					`UPDATE signed_prekeys SET retired_at = NOW()
	                  WHERE user_id = $1 AND retired_at IS NULL`, userID); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx,
					`INSERT INTO signed_prekeys (user_id, key_id, public_key_b64, signature_b64)
	                 VALUES ($1, $2, $3, $4)
	                 ON CONFLICT (user_id, key_id) DO UPDATE
	                   SET public_key_b64 = EXCLUDED.public_key_b64,
	                       signature_b64  = EXCLUDED.signature_b64,
	                       retired_at     = NULL`,
					userID, keyID, truncRunes(pub, 8192), truncRunes(sig, 8192)); err != nil {
					return err
				}
			}
		}

		for _, item := range otpkIn {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			_, keyIsNum := m["keyId"].(float64)
			pub, pubOK := m["publicKey"].(string)
			if !keyIsNum || !pubOK {
				continue
			}
			keyID, ok := intKey(m["keyId"])
			if !ok {
				return fmt.Errorf("fractional keyId")
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO one_time_prekeys (user_id, key_id, public_key_b64)
	             VALUES ($1, $2, $3)
	             ON CONFLICT (user_id, key_id) DO NOTHING`,
				userID, keyID, truncRunes(pub, 8192)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to save key bundle")
		return
	}

	var remaining int
	if err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*)::int AS n FROM one_time_prekeys WHERE user_id = $1 AND used_at IS NULL`,
		userID).Scan(&remaining); err != nil {
		httpx.Err(w, 500, "Failed to save key bundle")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "remainingOtpk": remaining, "minPool": userMinOtpkPool})
}

// ── Settings / Privacy ─────────────────────────────────────────────────

func userSettingsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var discoverable, lastSeenVisible, readReceipts, profilePhotoVisible *bool
	var groupAddPolicy *string
	var dds *int
	err := db.Pool.QueryRow(ctx,
		`SELECT discoverable, last_seen_visible, read_receipts, profile_photo_visible,
	            group_add_policy, default_disappearing_seconds
	       FROM users WHERE id = $1`, user.ID).
		Scan(&discoverable, &lastSeenVisible, &readReceipts, &profilePhotoVisible, &groupAddPolicy, &dds)
	if err != nil && !db.NoRows(err) {
		httpx.Err(w, 500, "Failed to load settings")
		return
	}
	gap := "everyone"
	if groupAddPolicy != nil && *groupAddPolicy != "" {
		gap = *groupAddPolicy
	}
	seconds := 0
	if dds != nil {
		seconds = *dds
	}
	httpx.JSON(w, 200, map[string]any{
		"discoverable":               discoverable != nil && *discoverable,
		"lastSeenVisible":            lastSeenVisible != nil && *lastSeenVisible,
		"readReceipts":               readReceipts != nil && *readReceipts,
		"profilePhotoVisible":        profilePhotoVisible != nil && *profilePhotoVisible,
		"groupAddPolicy":             gap,
		"defaultDisappearingSeconds": seconds,
	})
}

func userSettingsPut(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b map[string]any
	_ = httpx.Body(r, &b)

	sets := []string{}
	params := []any{user.ID}
	flag := func(col, key string) {
		v, present := b[key]
		if !present {
			return
		}
		params = append(params, authTruthy(v))
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(params)))
	}
	flag("discoverable", "discoverable")
	flag("last_seen_visible", "lastSeenVisible")
	flag("read_receipts", "readReceipts")
	flag("profile_photo_visible", "profilePhotoVisible")

	if gap, ok := b["groupAddPolicy"].(string); ok &&
		(gap == "everyone" || gap == "contacts" || gap == "nobody") {
		params = append(params, gap)
		sets = append(sets, fmt.Sprintf("group_add_policy = $%d", len(params)))
	}
	if v, present := b["defaultDisappearingSeconds"]; present {
		n, ok := httpx.ParseIntPrefix(authStr(v))
		if !ok {
			n = 0
		}
		if n < 0 {
			n = 0
		}
		if n > 365*24*60*60 {
			n = 365 * 24 * 60 * 60
		}
		params = append(params, n)
		sets = append(sets, fmt.Sprintf("default_disappearing_seconds = $%d", len(params)))
	}

	if len(sets) == 0 {
		httpx.JSON(w, 200, map[string]any{"ok": true, "noop": true})
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`UPDATE users SET `+strings.Join(sets, ", ")+` WHERE id = $1`, params...); err != nil {
		httpx.Err(w, 500, "Failed to save settings")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── Blocks ─────────────────────────────────────────────────────────────

func userBlocksGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(ctx,
		`SELECT ub.blocked_id, ub.created_at,
	            u.name, u.email, u.photo_url
	       FROM user_blocks ub
	       JOIN users u ON u.id = ub.blocked_id
	      WHERE ub.blocker_id = $1
	      ORDER BY ub.created_at DESC`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load blocks")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var blockedID string
		var createdAt time.Time
		var name, email, photoURL *string
		if err := rows.Scan(&blockedID, &createdAt, &name, &email, &photoURL); err != nil {
			httpx.Err(w, 500, "Failed to load blocks")
			return
		}
		out = append(out, map[string]any{
			"userId": blockedID, "name": name, "email": email,
			"photoURL": photoURL, "createdAt": httpx.JSTime(createdAt),
		})
	}
	httpx.JSON(w, 200, out)
}

func userBlocksPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		UserID any `json:"userId"`
	}
	_ = httpx.Body(r, &b)
	target := authStr(b.UserID)
	if target == "" {
		httpx.Err(w, 400, "userId required")
		return
	}
	if target == user.ID {
		httpx.Err(w, 400, "cannot block yourself")
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO user_blocks (blocker_id, blocked_id)
	     VALUES ($1, $2)
	     ON CONFLICT DO NOTHING`, user.ID, target); err != nil {
		httpx.Err(w, 500, "Failed to block")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func userBlocksDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if _, err := db.Pool.Exec(ctx,
		`DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
		user.ID, r.PathValue("userId")); err != nil {
		httpx.Err(w, 500, "Failed to unblock")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── Encrypted chat backup (object storage, port of lib/storage.js) ─────

func userBackupObjKey(uid string) string { return "backups/" + uid + ".vcbak" }

func userStorageEnabled() bool {
	return os.Getenv("S3_ENDPOINT") != "" && os.Getenv("S3_ACCESS_KEY") != ""
}

func userS3Bucket() string {
	if b := os.Getenv("S3_BUCKET"); b != "" {
		return b
	}
	return "vaultchat-media"
}

var (
	userS3Mu     sync.Mutex
	userS3Server *minio.Client
	userS3Sign   *minio.Client
)

func userMkS3Client(endpoint string) (*minio.Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("bad S3 endpoint %q", endpoint)
	}
	region := os.Getenv("S3_REGION")
	if region == "" {
		region = "auto"
	}
	return minio.New(u.Host, &minio.Options{
		Creds:        credentials.NewStaticV4(os.Getenv("S3_ACCESS_KEY"), os.Getenv("S3_SECRET_KEY"), ""),
		Secure:       u.Scheme == "https",
		Region:       region,
		BucketLookup: minio.BucketLookupPath, // MinIO + most S3-compatibles need path-style
	})
}

// userS3SignClient — endpoint baked into presigned URLs (what CLIENTS hit).
func userS3SignClient() (*minio.Client, error) {
	userS3Mu.Lock()
	defer userS3Mu.Unlock()
	if userS3Sign != nil {
		return userS3Sign, nil
	}
	ep := os.Getenv("S3_PUBLIC_ENDPOINT")
	if ep == "" {
		ep = os.Getenv("S3_ENDPOINT")
	}
	c, err := userMkS3Client(ep)
	if err != nil {
		return nil, err
	}
	userS3Sign = c
	return c, nil
}

// userS3ServerClient — INTERNAL endpoint for the server's own object ops.
func userS3ServerClient() (*minio.Client, error) {
	userS3Mu.Lock()
	defer userS3Mu.Unlock()
	if userS3Server != nil {
		return userS3Server, nil
	}
	c, err := userMkS3Client(os.Getenv("S3_ENDPOINT"))
	if err != nil {
		return nil, err
	}
	userS3Server = c
	return c, nil
}

// GET /user/backup/key — account-managed backup key (WhatsApp default model).
func userBackupKey(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var dek string
	err := db.Pool.QueryRow(ctx,
		`SELECT dek FROM user_backup_keys WHERE user_id = $1`, user.ID).Scan(&dek)
	if err != nil {
		if !db.NoRows(err) {
			httpx.Err(w, 500, "Failed")
			return
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			httpx.Err(w, 500, "Failed")
			return
		}
		if _, err := db.Pool.Exec(ctx,
			`INSERT INTO user_backup_keys (user_id, dek) VALUES ($1, $2)
	         ON CONFLICT (user_id) DO NOTHING`,
			user.ID, base64.StdEncoding.EncodeToString(raw)); err != nil {
			httpx.Err(w, 500, "Failed")
			return
		}
		if err := db.Pool.QueryRow(ctx,
			`SELECT dek FROM user_backup_keys WHERE user_id = $1`, user.ID).Scan(&dek); err != nil {
			httpx.Err(w, 500, "Failed")
			return
		}
	}
	httpx.JSON(w, 200, map[string]any{"key": dek})
}

// GET /user/backup/meta
func userBackupMeta(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var sizeBytes int64
	var messageCount int
	var updatedAt time.Time
	err := db.Pool.QueryRow(ctx,
		`SELECT size_bytes, message_count, updated_at FROM user_backups WHERE user_id = $1`,
		user.ID).Scan(&sizeBytes, &messageCount, &updatedAt)
	if err != nil {
		if db.NoRows(err) {
			httpx.JSON(w, 200, map[string]any{"exists": false})
		} else {
			httpx.Err(w, 500, "Failed")
		}
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"exists": true, "sizeBytes": sizeBytes, "messageCount": messageCount,
		"updatedAt": httpx.JSTime(updatedAt),
	})
}

// POST /user/backup/presign
func userBackupPresign(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	if !userStorageEnabled() {
		httpx.JSON(w, 200, map[string]any{"mode": "inline"})
		return
	}
	c, err := userS3SignClient()
	if err != nil {
		httpx.Err(w, 500, "Failed")
		return
	}
	key := userBackupObjKey(user.ID)
	u, err := c.PresignedPutObject(r.Context(), userS3Bucket(), key, 900*time.Second)
	if err != nil {
		httpx.Err(w, 500, "Failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"mode": "object", "uploadUrl": u.String(), "key": key})
}

// POST /user/backup/commit
func userBackupCommit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		Key          any `json:"key"`
		SizeBytes    any `json:"sizeBytes"`
		MessageCount any `json:"messageCount"`
	}
	_ = httpx.Body(r, &b)
	if authStr(b.Key) != userBackupObjKey(user.ID) {
		httpx.Err(w, 400, "bad key")
		return
	}
	sizeBytes, ok := httpx.ParseIntPrefix(authStr(b.SizeBytes))
	if !ok {
		sizeBytes = 0
	}
	messageCount, ok := httpx.ParseIntPrefix(authStr(b.MessageCount))
	if !ok {
		messageCount = 0
	}
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO user_backups (user_id, storage_key, blob, size_bytes, message_count, updated_at)
	     VALUES ($1, $2, NULL, $3, $4, NOW())
	     ON CONFLICT (user_id) DO UPDATE
	       SET storage_key = EXCLUDED.storage_key, blob = NULL,
	           size_bytes = EXCLUDED.size_bytes, message_count = EXCLUDED.message_count, updated_at = NOW()`,
		user.ID, userBackupObjKey(user.ID), sizeBytes, messageCount); err != nil {
		httpx.Err(w, 500, "Failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "updatedAt": httpx.JSTime(time.Now())})
}

// PUT /user/backup — inline fallback; Node mounts express.json({limit:'16mb'})
// on this one route, so read the body ourselves past httpx.Body's 2 MB cap.
func userBackupPut(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		Blob         any `json:"blob"`
		SizeBytes    any `json:"sizeBytes"`
		MessageCount any `json:"messageCount"`
	}
	if r.Body != nil {
		data, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
		if err == nil && len(data) > 0 {
			_ = json.Unmarshal(data, &b)
		}
	}
	blob, ok := b.Blob.(string)
	if !ok || blob == "" {
		httpx.Err(w, 400, "blob required")
		return
	}
	sizeBytes, okN := httpx.ParseIntPrefix(authStr(b.SizeBytes))
	if !okN {
		sizeBytes = 0
	}
	messageCount, okN := httpx.ParseIntPrefix(authStr(b.MessageCount))
	if !okN {
		messageCount = 0
	}
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO user_backups (user_id, storage_key, blob, size_bytes, message_count, updated_at)
	     VALUES ($1, NULL, $2, $3, $4, NOW())
	     ON CONFLICT (user_id) DO UPDATE
	       SET storage_key = NULL, blob = EXCLUDED.blob,
	           size_bytes = EXCLUDED.size_bytes, message_count = EXCLUDED.message_count, updated_at = NOW()`,
		user.ID, blob, sizeBytes, messageCount); err != nil {
		httpx.Err(w, 500, "Failed to save backup")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "updatedAt": httpx.JSTime(time.Now())})
}

// GET /user/backup
func userBackupGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var storageKey, blob *string
	var sizeBytes int64
	var messageCount int
	var updatedAt time.Time
	err := db.Pool.QueryRow(ctx,
		`SELECT storage_key, blob, size_bytes, message_count, updated_at FROM user_backups WHERE user_id = $1`,
		user.ID).Scan(&storageKey, &blob, &sizeBytes, &messageCount, &updatedAt)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "No backup")
		} else {
			httpx.Err(w, 500, "Failed")
		}
		return
	}
	if storageKey != nil && *storageKey != "" && userStorageEnabled() {
		c, err := userS3SignClient()
		if err != nil {
			httpx.Err(w, 500, "Failed")
			return
		}
		u, err := c.PresignedGetObject(ctx, userS3Bucket(), *storageKey, 3600*time.Second, nil)
		if err != nil {
			httpx.Err(w, 500, "Failed")
			return
		}
		httpx.JSON(w, 200, map[string]any{
			"mode": "object", "downloadUrl": u.String(),
			"sizeBytes": sizeBytes, "messageCount": messageCount, "updatedAt": httpx.JSTime(updatedAt),
		})
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"mode": "inline", "blob": blob,
		"sizeBytes": sizeBytes, "messageCount": messageCount, "updatedAt": httpx.JSTime(updatedAt),
	})
}

// DELETE /user/backup
func userBackupDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var storageKey *string
	err := db.Pool.QueryRow(ctx,
		`SELECT storage_key FROM user_backups WHERE user_id = $1`, user.ID).Scan(&storageKey)
	if err != nil && !db.NoRows(err) {
		httpx.Err(w, 500, "Failed")
		return
	}
	if storageKey != nil && *storageKey != "" && userStorageEnabled() {
		if c, err := userS3ServerClient(); err == nil {
			if err := c.RemoveObject(ctx, userS3Bucket(), *storageKey, minio.RemoveObjectOptions{}); err != nil {
				log.Printf("[storage] deleteObject: %v", err) // best-effort, like Node
			}
		}
	}
	if _, err := db.Pool.Exec(ctx,
		`DELETE FROM user_backups WHERE user_id = $1`, user.ID); err != nil {
		httpx.Err(w, 500, "Failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
