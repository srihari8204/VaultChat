// Package routes — Go ports of vaultchat-backend/routes/*.js.
// contacts.go ← routes/contacts.js. Same endpoints, same status codes, same
// error strings, same response shapes (proven by contract/run.js).
package routes

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/vault"
)

const maxHashesPerRequest = 5000
const maxTrusted = 3

// Per-ACCOUNT phone-hash budget for /contacts/match, on top of the 5 req/min
// call limiter. The call limiter bounds requests; it does not bound how many
// numbers an account can probe — 5 req/min x 5000 hashes is 36M hashes a day,
// which turns discovery into a directory-enumeration oracle over the ~10^9-10^10
// mobile keyspace. A real address book is <= 5000 numbers and re-syncs rarely,
// so four full syncs a day is generous headroom for a human and a hard ceiling
// for a scraper.
const matchHashesPerDay = 20000
const matchQuotaWindow = 86400

var hex64Re = regexp.MustCompile(`^[a-f0-9]{64}$`)

func RegisterContacts(mux *http.ServeMux) {
	mux.HandleFunc("POST /contacts/match", httpx.RequireAuth(contactsMatch))
	mux.HandleFunc("POST /contacts/sync/create", httpx.RequireAuth(syncCreate))
	mux.HandleFunc("GET /contacts/sync/{code}", httpx.RequireAuth(syncStatus))
	mux.HandleFunc("POST /contacts/sync/verify", httpx.RequireAuth(syncVerify))
}

// POST /contacts/match — peppered phone-hash discovery.
func contactsMatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)

	rl := redisx.Consume(ctx, "contacts:"+user.ID, 5, 60)
	if !rl.Allowed {
		httpx.Err(w, http.StatusTooManyRequests, "Too many requests",
			map[string]any{"retryAfter": rl.ResetInSec})
		return
	}

	var body struct {
		PhoneHashes []any `json:"phoneHashes"`
	}
	if err := httpx.Body(r, &body); err != nil || body.PhoneHashes == nil {
		httpx.Err(w, http.StatusBadRequest, "phoneHashes array required")
		return
	}
	if len(body.PhoneHashes) > maxHashesPerRequest {
		httpx.Err(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("Max %d hashes per request", maxHashesPerRequest))
		return
	}

	seen := map[string]bool{}
	hashes := []string{}
	for _, v := range body.PhoneHashes {
		s, _ := v.(string)
		s = strings.ToLower(strings.TrimSpace(s))
		if hex64Re.MatchString(s) && !seen[s] {
			seen[s] = true
			hashes = append(hashes, s)
		}
	}
	if len(hashes) == 0 {
		httpx.JSON(w, 200, []any{})
		return
	}

	// Charge the daily per-account hash budget. Counted AFTER dedup/validation
	// so a client that sends the same number twice, or sends junk, isn't billed
	// for it — and so the meter tracks distinct numbers probed, which is the
	// thing we actually care about capping.
	if q := redisx.ConsumeBy(ctx, "contacts:hashes:"+user.ID,
		int64(len(hashes)), matchHashesPerDay, matchQuotaWindow); !q.Allowed {
		httpx.Err(w, http.StatusTooManyRequests, "Contact sync quota exceeded",
			map[string]any{"retryAfter": q.ResetInSec})
		return
	}

	// Pepper client hashes server-side; echo the ORIGINAL hash back.
	peppered := make([]string, 0, len(hashes))
	toOriginal := map[string]string{}
	for _, h := range hashes {
		ph, err := vault.DiscoveryHash(h)
		if err != nil {
			httpx.Err(w, 500, "Contact match failed")
			return
		}
		peppered = append(peppered, ph)
		toOriginal[ph] = h
	}

	rows, err := db.Pool.Query(ctx,
		`SELECT id, name, first_name_cipher, last_name_cipher, email_cipher, photo_url, phone_hash
		   FROM users
		  WHERE phone_hash = ANY($1::text[])
		    AND discoverable = TRUE
		    AND is_deleted = FALSE
		    AND id <> $2
		    -- Someone you blocked (or who blocked you) is not a suggestion.
		    -- Address-book matching re-offered them every time the user opened
		    -- the Contacts screen, which is one of the ways a "removed" person
		    -- kept coming back.
		    AND NOT EXISTS (
		      SELECT 1 FROM user_blocks ub
		       WHERE (ub.blocker_id = $2 AND ub.blocked_id = users.id)
		          OR (ub.blocker_id = users.id AND ub.blocked_id = $2)
		    )`,
		peppered, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Contact match failed")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var id string
		var name, firstC, lastC, emailC, photoURL, phoneHash *string
		if err := rows.Scan(&id, &name, &firstC, &lastC, &emailC, &photoURL, &phoneHash); err != nil {
			httpx.Err(w, 500, "Contact match failed")
			return
		}
		ident := vault.IdentityFromRow(firstC, lastC, emailC, nil, nil, nil, name, nil, nil, nil, nil)
		var orig any
		if phoneHash != nil {
			if o, ok := toOriginal[*phoneHash]; ok {
				orig = o
			}
		}
		out = append(out, map[string]any{
			"id":        id,
			"name":      ident.Name,
			"photoURL":  photoURL,
			"phoneHash": orig,
		})
	}
	httpx.JSON(w, 200, out)
}

// ── Mutual-consent contact sync ────────────────────────────────────────

func genSyncCode() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	return fmt.Sprintf("%06d", n.Int64())
}

func syncCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if _, err := db.Pool.Exec(ctx, `DELETE FROM sync_codes WHERE initiator_id = $1`, user.ID); err != nil {
		httpx.Err(w, 500, "Failed to create code")
		return
	}
	for i := 0; i < 6; i++ {
		code := genSyncCode()
		_, err := db.Pool.Exec(ctx,
			`INSERT INTO sync_codes (code, initiator_id, expires_at)
			 VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`, code, user.ID)
		if err == nil {
			httpx.JSON(w, 200, map[string]any{"success": true, "code": code})
			return
		}
		if i == 5 {
			httpx.Err(w, 500, "Failed to create code")
			return
		}
	}
}

func syncStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var expiresAt time.Time
	var verifiedAt *time.Time
	err := db.Pool.QueryRow(ctx,
		`SELECT expires_at, verified_at FROM sync_codes WHERE code = $1 AND initiator_id = $2 LIMIT 1`,
		r.PathValue("code"), user.ID).Scan(&expiresAt, &verifiedAt)
	if err != nil {
		httpx.Err(w, 404, "not found")
		return
	}
	if expiresAt.Before(time.Now()) {
		httpx.Err(w, http.StatusGone, "expired")
		return
	}
	httpx.JSON(w, 200, map[string]any{"verified": verifiedAt != nil})
}

var sixDigitsRe = regexp.MustCompile(`^\d{6}$`)

func syncVerify(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var body struct {
		Code any `json:"code"`
	}
	_ = httpx.Body(r, &body)
	code := strings.TrimSpace(fmt.Sprintf("%v", orEmpty(body.Code)))
	if !sixDigitsRe.MatchString(code) {
		httpx.Err(w, 400, "6-digit code required")
		return
	}

	var initiatorID string
	var expiresAt time.Time
	var verifiedAt *time.Time
	err := db.Pool.QueryRow(ctx,
		`SELECT initiator_id, expires_at, verified_at FROM sync_codes WHERE code = $1 LIMIT 1`,
		code).Scan(&initiatorID, &expiresAt, &verifiedAt)
	if err != nil {
		httpx.Err(w, 404, "Invalid code")
		return
	}
	if expiresAt.Before(time.Now()) {
		httpx.Err(w, http.StatusGone, "Code expired")
		return
	}
	if initiatorID == user.ID {
		httpx.Err(w, 400, "Cannot sync with yourself")
		return
	}
	if verifiedAt != nil {
		httpx.Err(w, http.StatusConflict, "Code already used")
		return
	}

	// Single use is decided HERE, not by the read above: two redemptions that
	// both passed the read race on this conditional UPDATE and exactly one row
	// changes. The loser (or a code that expired in between) gets 409.
	tag, err := db.Pool.Exec(ctx,
		`UPDATE sync_codes SET verified_by = $1, verified_at = NOW()
		  WHERE code = $2 AND verified_at IS NULL AND expires_at > NOW() AND initiator_id <> $1`,
		user.ID, code)
	if err != nil {
		httpx.Err(w, 500, "Verification failed")
		return
	}
	if tag.RowsAffected() != 1 {
		httpx.Err(w, http.StatusConflict, "Code already used")
		return
	}
	var id string
	var name, email, phone *string
	err = db.Pool.QueryRow(ctx,
		`SELECT id, name, email, phone FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1`,
		initiatorID).Scan(&id, &name, &email, &phone)
	if err != nil {
		httpx.Err(w, 404, "Initiator no longer exists")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"success": true,
		"initiator": map[string]any{
			"userId": id, "displayName": name, "email": email, "phoneNumber": phone,
		},
	})
}

// ── Trusted (emergency) contacts ───────────────────────────────────────

func trustedList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(ctx,
		`SELECT tc.contact_id, u.name, u.vault_id,
		        u.online AND NOT COALESCE(g.hide_online, FALSE)
		   FROM trusted_contacts tc JOIN users u ON u.id = tc.contact_id
		   -- Ghost Mode hide_online toward me: presence_changed is withheld, so is this.
		   LEFT JOIN ghost_mode g ON g.owner_id = tc.contact_id AND g.target_id = tc.owner_id
		  WHERE tc.owner_id = $1
		  ORDER BY tc.created_at`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load trusted contacts")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var contactID string
		var name, vaultID *string
		var online *bool
		if err := rows.Scan(&contactID, &name, &vaultID, &online); err != nil {
			httpx.Err(w, 500, "Failed to load trusted contacts")
			return
		}
		out = append(out, map[string]any{
			"userId": contactID, "name": name, "vaultId": vaultID,
			"online": online != nil && *online,
		})
	}
	httpx.JSON(w, 200, out)
}

func trustedAdd(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var body struct {
		VaultID any `json:"vaultId"`
	}
	_ = httpx.Body(r, &body)
	vid := strings.TrimSpace(strings.TrimPrefix(fmt.Sprintf("%v", orEmpty(body.VaultID)), "@"))
	if vid == "" {
		httpx.Err(w, 400, "vaultId required")
		return
	}

	var peerID string
	var name, vaultID *string
	var online *bool
	err := db.Pool.QueryRow(ctx,
		`SELECT id, name, vault_id, online FROM users WHERE vault_id = $1 AND is_deleted = FALSE LIMIT 1`,
		vid).Scan(&peerID, &name, &vaultID, &online)
	if err != nil {
		httpx.Err(w, 404, "No user with that VaultID")
		return
	}
	if peerID == user.ID {
		httpx.Err(w, 400, "You can't add yourself")
		return
	}

	var n int
	if err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*)::int FROM trusted_contacts WHERE owner_id = $1`, user.ID).Scan(&n); err != nil {
		httpx.Err(w, 500, "Failed to add trusted contact")
		return
	}
	if n >= maxTrusted {
		httpx.Err(w, http.StatusConflict, fmt.Sprintf("Maximum %d trusted contacts", maxTrusted))
		return
	}

	tag, err := db.Pool.Exec(ctx,
		`INSERT INTO trusted_contacts (owner_id, contact_id) VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`, user.ID, peerID)
	if err != nil {
		httpx.Err(w, 500, "Failed to add trusted contact")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusConflict, "Already a trusted contact")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"userId": peerID, "name": name, "vaultId": vaultID,
		"online": online != nil && *online,
	})
}

func trustedRemove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if _, err := db.Pool.Exec(ctx,
		`DELETE FROM trusted_contacts WHERE owner_id = $1 AND contact_id = $2`,
		user.ID, r.PathValue("userId")); err != nil {
		httpx.Err(w, 500, "Failed to remove trusted contact")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
