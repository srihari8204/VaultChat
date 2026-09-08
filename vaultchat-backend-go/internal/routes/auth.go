// auth.go ← routes/auth.js — OTP/Google/refresh auth + encrypted-PII onboarding
// (migration 042). Same endpoints, same status codes, same error strings/shapes.
// Token interop: HS256 {sub, email} access JWTs (jwt.js), bcrypt-hashed opaque
// refresh tokens rotated on use — both verify cross-backend. OTP hashes are
// bcrypt(10) like otp.js; MPIN/answers are argon2id via internal/vault.
// Mail = Resend HTTPS API (email.js), SMS = Twilio REST (sms.js) — same env.
package routes

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/vault"
)

func RegisterAuth(mux *http.ServeMux) {
	mux.HandleFunc("POST /auth/send-otp", authSendOtp)
	mux.HandleFunc("POST /auth/verify-otp", authVerifyOtp)
	mux.HandleFunc("POST /auth/google", authGoogle)
	mux.HandleFunc("POST /auth/refresh", authRefresh)
	mux.HandleFunc("POST /auth/logout", authLogout)
	mux.HandleFunc("POST /auth/send-otp-phone", authSendOtpPhone)
	mux.HandleFunc("POST /auth/verify-otp-phone", authVerifyOtpPhone)
	mux.HandleFunc("POST /auth/onboard/send-otp", authOnboardSendOtp)
	mux.HandleFunc("POST /auth/onboard/verify-otp", authOnboardVerifyOtp)
	mux.HandleFunc("POST /auth/lookup", authLookup)
	mux.HandleFunc("POST /auth/profile/init", authProfileInit)
	mux.HandleFunc("POST /auth/security-questions/save", authSecurityQuestionsSave)
	mux.HandleFunc("GET /auth/security-questions/{userId}", authSecurityQuestionsGet)
	mux.HandleFunc("POST /auth/security-questions/verify", authSecurityQuestionsVerify)
	mux.HandleFunc("POST /auth/mpin/set", authMpinSet)
	mux.HandleFunc("POST /auth/mpin/verify", authMpinVerify)
	mux.HandleFunc("POST /auth/mpin/recover", authMpinRecover)
	mux.HandleFunc("POST /auth/profile/photo", httpx.RequireAuth(authProfilePhoto))
	mux.HandleFunc("POST /auth/mfa/configure", httpx.RequireAuth(authMfaConfigure))
	mux.HandleFunc("GET /auth/profile", httpx.RequireAuth(authProfileGet))
}

// ── small helpers (auth-prefixed; package routes is shared) ────────────

const (
	authOtpTTLSec      = 600 // otp.js OTP_TTL_SECONDS
	authOtpMaxAttempts = 5   // otp.js MAX_ATTEMPTS
	authBcryptRounds   = 10  // otp.js BCRYPT_ROUNDS / jwt.js REFRESH_HASH_ROUNDS
	authRefreshBytes   = 48  // jwt.js REFRESH_BYTES
)

var authHTTP = &http.Client{Timeout: 15 * time.Second}

// authStr mirrors Node's (x || empty-string).toString() coercion.
func authStr(v any) string { return fmt.Sprintf("%v", orEmpty(v)) }

// authTruthy mirrors JS truthiness for decoded-JSON values.
func authTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0 && t == t // 0 and NaN are falsy
	default:
		return true
	}
}

// authStrIfTruthy mirrors `x ? x.toString() : null`.
func authStrIfTruthy(v any) *string {
	if !authTruthy(v) {
		return nil
	}
	s := authStr(v)
	return &s
}

// ── client IP, behind two proxies ──────────────────────────────────────
//
// AUDIT F10: this returned the socket peer, full stop. The deployed path is
// nginx → Caddy → go-api, so the socket peer is ALWAYS the proxy, and every
// per-IP limit keyed on it was shared by every user on the internet: OTP
// issuance at 10/hour and account lookup at 20/minute, pooled. A trickle of
// traffic from one person locked everybody else out of signing in.
//
// The forwarding header cannot simply be trusted either — it is caller-supplied
// and would let anyone mint a fresh identity per request, which is worse than
// pooling. So: trust it ONLY when the request actually arrived from a proxy we
// recognise, and then take the right-most entry that is not itself a trusted
// proxy. Right-most matters: X-Forwarded-For is append-only, so a client can
// prepend whatever it likes on the left, and only the entries our own hops
// added at the end are trustworthy.
//
// Default trust covers the checked-in topology — loopback plus the docker
// networks the compose files pin. TRUSTED_PROXIES overrides it with a
// comma-separated CIDR list for a different deployment.
var trustedProxyNets = func() []*net.IPNet {
	spec := os.Getenv("TRUSTED_PROXIES")
	if spec == "" {
		spec = "127.0.0.0/8,::1/128,172.28.0.0/16,172.17.0.0/16"
	}
	var out []*net.IPNet
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if _, n, err := net.ParseCIDR(part); err == nil {
			out = append(out, n)
		}
	}
	return out
}()

func authIsTrustedProxy(ip string) bool {
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil {
		return false
	}
	for _, n := range trustedProxyNets {
		if n.Contains(parsed) {
			return true
		}
	}
	return false
}

// authClientIP is the address rate limits are keyed on.
func authClientIP(r *http.Request) string {
	peer := r.RemoteAddr
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		peer = host
	}
	// Direct connection from something we do not recognise: its headers are
	// worth nothing, and spoofing must not be possible.
	if !authIsTrustedProxy(peer) {
		return peer
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			candidate := strings.TrimSpace(parts[i])
			if candidate == "" || authIsTrustedProxy(candidate) {
				continue // one of our own hops — keep walking left
			}
			if net.ParseIP(candidate) != nil {
				return candidate
			}
			break // garbage in the header; fall through
		}
	}
	// nginx sets this to its own immediate peer, which is the real client on
	// the first hop. Only reachable when the request came from a trusted proxy.
	if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" && net.ParseIP(xr) != nil {
		return xr
	}
	return peer
}

var authEmailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// authNormalizeEmail — auth.js normalizeEmail: strings only, trim+lower, regex.
func authNormalizeEmail(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	trimmed := strings.ToLower(strings.TrimSpace(s))
	if !authEmailRe.MatchString(trimmed) {
		return ""
	}
	return trimmed
}

var authNonDigitRe = regexp.MustCompile(`\D`)

// authNormalizePhone — auth.js local normalizePhone: digits only, 10-digit
// numbers assumed Indian (prepend 91). "" = invalid.
func authNormalizePhone(v any) string {
	if !authTruthy(v) {
		return ""
	}
	d := authNonDigitRe.ReplaceAllString(authStr(v), "")
	if d == "" {
		return ""
	}
	if len(d) == 10 {
		d = "91" + d
	}
	return d
}

// authHashPhone — HMAC(pepper, sha256(digits)), auth.js hashPhone.
func authHashPhone(norm string) (string, error) {
	sum := sha256.Sum256([]byte(norm))
	return vault.DiscoveryHash(hex.EncodeToString(sum[:]))
}

// authDiscoveryPhoneHash — auth.js discoveryPhoneHash (drops '+', 91-prefix).
func authDiscoveryPhoneHash(phone string) (string, error) {
	digits := authNonDigitRe.ReplaceAllString(phone, "")
	if len(digits) == 10 {
		digits = "91" + digits
	}
	sum := sha256.Sum256([]byte(digits))
	return vault.DiscoveryHash(hex.EncodeToString(sum[:]))
}

// authEnvErr writes the onboarding envelope { error: { code, message } }.
func authEnvErr(w http.ResponseWriter, status int, code, message string) {
	httpx.JSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": message}})
}

func authTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck — no-op after commit
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func authSafeDecrypt(c *string) *string {
	if c == nil || *c == "" {
		return nil
	}
	v, err := vault.Decrypt(*c)
	if err != nil {
		return nil
	}
	return &v
}

// ── OTP (otp.js: bcrypt-hashed 6-digit codes) ──────────────────────────

func authHashOTP(code string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(code), authBcryptRounds)
	return string(h), err
}

func authVerifyOTP(code, hashed string) bool {
	if code == "" || hashed == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hashed), []byte(code)) == nil
}

// ── tokens (jwt.js) ────────────────────────────────────────────────────

func authEnvTTL(name string, def int64) int64 {
	if n, ok := httpx.ParseIntPrefix(os.Getenv(name)); ok {
		return n
	}
	return def
}

// authSignAccess mints the same HS256 {sub, email, iat, exp} token jwt.js does.
func authSignAccess(userID string, email *string) (string, error) {
	now := time.Now().Unix()
	claims := jwt.MapClaims{
		"sub":   userID,
		"email": email,
		"iat":   now,
		"exp":   now + authEnvTTL("JWT_ACCESS_TTL", 15*60),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).
		SignedString([]byte(os.Getenv("JWT_SECRET")))
}

func authGenRefreshToken() (string, error) {
	b := make([]byte, authRefreshBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// authRefreshLookup is a refresh token's SEARCHABLE identity: a keyed digest,
// so one indexed equality finds the single row instead of bcrypt-comparing
// against a page of candidates (audit F05). Reuses the existing lookup pepper
// rather than introducing a second one — same primitive as email/phone lookup.
//
// Returns "" when the pepper is unset, and every caller treats that as "fall
// back to the legacy scan" rather than failing: a misconfigured environment
// must not lock every user out of refreshing.
func authRefreshLookup(token string) string {
	if token == "" {
		return ""
	}
	h, err := vault.LookupHash("refresh:" + token)
	if err != nil {
		return ""
	}
	return h
}

func authCompareRefresh(token, hash string) bool {
	if token == "" || hash == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(token)) == nil
}

// authIssueTokens mirrors auth.js issueTokens: access JWT + stored refresh row.
func authIssueTokens(ctx context.Context, r *http.Request, userID string, email *string) (string, string, error) {
	access, err := authSignAccess(userID, email)
	if err != nil {
		return "", "", err
	}
	refresh, err := authGenRefreshToken()
	if err != nil {
		return "", "", err
	}
	refreshHash, err := bcrypt.GenerateFromPassword([]byte(refresh), authBcryptRounds)
	if err != nil {
		return "", "", err
	}
	var ipPtr *string
	if ip := authClientIP(r); ip != "" {
		ipPtr = &ip
	}
	// token_lookup makes the row findable in one indexed hit (migration 127).
	// NULL when the pepper is unset, which keeps the legacy scan working.
	var lookupPtr *string
	if lk := authRefreshLookup(refresh); lk != "" {
		lookupPtr = &lk
	}
	_, err = db.Pool.Exec(ctx,
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip, token_lookup)
	     VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL, $4, $5, $6)`,
		userID, string(refreshHash),
		strconv.FormatInt(authEnvTTL("JWT_REFRESH_TTL", 30*24*60*60), 10),
		truncRunes(r.Header.Get("User-Agent"), 500), ipPtr, lookupPtr)
	if err != nil {
		return "", "", err
	}
	return access, refresh, nil
}

// ── users row + publicUser (auth.js publicUser / findOrCreateUser) ─────

const authUserCols = `id, email, name, phone, photo_url, dob, status, online, last_seen_at, auth_provider, email_verified_at, created_at, google_sub, mpin_hash, mfa_enabled, onboarding_complete, first_name_cipher, last_name_cipher, email_cipher, phone_cipher, dob_cipher, status_cipher`

type authUserRow struct {
	ID                 string
	Email              *string
	Name               *string
	Phone              *string
	PhotoURL           *string
	DOB                *time.Time
	Status             *string
	Online             bool
	LastSeenAt         *time.Time
	AuthProvider       *string
	EmailVerifiedAt    *time.Time
	CreatedAt          time.Time
	GoogleSub          *string
	MpinHash           *string
	MfaEnabled         bool
	OnboardingComplete bool
	FirstNameCipher    *string
	LastNameCipher     *string
	EmailCipher        *string
	PhoneCipher        *string
	DOBCipher          *string
	StatusCipher       *string
}

func (u *authUserRow) fields() []any {
	return []any{&u.ID, &u.Email, &u.Name, &u.Phone, &u.PhotoURL, &u.DOB, &u.Status,
		&u.Online, &u.LastSeenAt, &u.AuthProvider, &u.EmailVerifiedAt, &u.CreatedAt,
		&u.GoogleSub, &u.MpinHash, &u.MfaEnabled, &u.OnboardingComplete,
		&u.FirstNameCipher, &u.LastNameCipher, &u.EmailCipher, &u.PhoneCipher,
		&u.DOBCipher, &u.StatusCipher}
}

type authPublicUser struct {
	ID              string        `json:"id"`
	Email           *string       `json:"email"`
	Name            *string       `json:"name"`
	Phone           *string       `json:"phone"`
	PhotoURL        *string       `json:"photoURL"`
	DOB             *string       `json:"dob"`
	Status          *string       `json:"status"`
	Online          bool          `json:"online"`
	LastSeen        *httpx.JSTime `json:"lastSeen"`
	AuthProvider    *string       `json:"authProvider"`
	EmailVerifiedAt *httpx.JSTime `json:"emailVerifiedAt"`
	CreatedAt       httpx.JSTime  `json:"createdAt"`
}

func (u *authUserRow) public() authPublicUser {
	// Legacy plaintext dob is a pg DATE; Node's String(row.dob) renders the JS
	// Date toString form (server TZ is UTC). Unreachable for post-042 rows.
	var legacyDOB *string
	if u.DOB != nil {
		s := u.DOB.UTC().Format("Mon Jan 02 2006 15:04:05 GMT+0000 (Coordinated Universal Time)")
		legacyDOB = &s
	}
	ident := vault.IdentityFromRow(u.FirstNameCipher, u.LastNameCipher, u.EmailCipher,
		u.PhoneCipher, u.DOBCipher, u.StatusCipher,
		u.Name, u.Email, u.Phone, legacyDOB, u.Status)
	return authPublicUser{
		ID: u.ID, Email: ident.Email, Name: ident.Name, Phone: ident.Phone,
		PhotoURL: u.PhotoURL, DOB: ident.DOB, Status: ident.Status,
		Online: u.Online, LastSeen: httpx.JST(u.LastSeenAt), AuthProvider: u.AuthProvider,
		EmailVerifiedAt: httpx.JST(u.EmailVerifiedAt), CreatedAt: httpx.JSTime(u.CreatedAt),
	}
}

type authSessionResp struct {
	AccessToken  string         `json:"accessToken"`
	RefreshToken string         `json:"refreshToken"`
	User         authPublicUser `json:"user"`
	IsNewUser    bool           `json:"isNewUser"`
}

type authTokenPair struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}

func authFindOrCreateUser(ctx context.Context, email string, name, googleSub *string, authProvider string) (*authUserRow, bool, error) {
	u := &authUserRow{}
	err := db.Pool.QueryRow(ctx,
		`SELECT `+authUserCols+` FROM users WHERE email = $1 AND is_deleted = FALSE LIMIT 1`,
		email).Scan(u.fields()...)
	if err == nil {
		updates := []string{}
		params := []any{u.ID}
		if googleSub != nil && u.GoogleSub == nil {
			params = append(params, *googleSub)
			updates = append(updates, fmt.Sprintf("google_sub = $%d", len(params)))
		}
		if u.EmailVerifiedAt == nil {
			updates = append(updates, "email_verified_at = NOW()")
		}
		if len(updates) > 0 {
			err = db.Pool.QueryRow(ctx,
				`UPDATE users SET `+strings.Join(updates, ", ")+` WHERE id = $1 RETURNING `+authUserCols,
				params...).Scan(u.fields()...)
			if err != nil {
				return nil, false, err
			}
		}
		return u, false, nil
	}
	if !db.NoRows(err) {
		return nil, false, err
	}
	if authProvider == "" {
		authProvider = "email"
	}
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO users (email, name, google_sub, auth_provider, email_verified_at)
	     VALUES ($1, $2, $3, $4, NOW())
	     RETURNING `+authUserCols,
		email, name, googleSub, authProvider).Scan(u.fields()...)
	if err != nil {
		return nil, false, err
	}
	return u, true, nil
}

// authAudit — auth.js auditAttempt: best-effort, never blocks auth.
func authAudit(ctx context.Context, userID *string, ip, attemptType string, success bool) {
	var ipPtr *string
	if ip != "" {
		ipPtr = &ip
	}
	_, _ = db.Pool.Exec(ctx,
		`INSERT INTO auth_attempts (user_id, ip_address, attempt_type, success) VALUES ($1, $2, $3, $4)`,
		userID, ipPtr, attemptType, success)
}

// ── mail (email.js — Resend HTTPS API) + SMS (sms.js — Twilio REST) ────

func authSendOTPEmail(toEmail, code string) error {
	key := os.Getenv("RESEND_API_KEY")
	if key == "" {
		return fmt.Errorf("RESEND_API_KEY not set")
	}
	from := os.Getenv("EMAIL_FROM")
	if from == "" {
		from = "VaultChat <noreply@corefinite.com>"
	}
	payload, err := json.Marshal(map[string]string{
		"from":    from,
		"to":      toEmail,
		"subject": "Your VaultChat sign-in code",
		"text": "Your VaultChat sign-in code is: " + code + "\n\n" +
			"This code expires in 10 minutes.\n\n" +
			"If you didn't request this, you can safely ignore this email.",
		"html": `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 16px;">Your VaultChat sign-in code</h2>
        <p style="font-size:14px;color:#555;margin:0 0 24px;">Enter this code in the app to continue.</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f4f4f4;padding:16px 24px;border-radius:8px;text-align:center;">` + code + `</div>
        <p style="font-size:13px;color:#888;margin:24px 0 0;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, "https://api.resend.com/emails", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := authHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("resend send failed (%d)", resp.StatusCode)
	}
	return nil
}

func authSmsConfigured() bool {
	return os.Getenv("TWILIO_ACCOUNT_SID") != "" && os.Getenv("TWILIO_AUTH_TOKEN") != "" &&
		(os.Getenv("TWILIO_MESSAGING_SERVICE_SID") != "" || os.Getenv("TWILIO_FROM_NUMBER") != "")
}

func authSendOTPSMS(phone, code string) error {
	if !authSmsConfigured() {
		log.Printf("[sms] OTP for %s: %s (Twilio not configured — visible only here)", phone, code)
		return nil
	}
	sid := os.Getenv("TWILIO_ACCOUNT_SID")
	form := url.Values{}
	form.Set("To", phone)
	form.Set("Body", "Your VaultChat code is "+code+". Don't share it. It expires in 10 minutes.")
	if msgSid := os.Getenv("TWILIO_MESSAGING_SERVICE_SID"); msgSid != "" {
		form.Set("MessagingServiceSid", msgSid)
	} else {
		form.Set("From", os.Getenv("TWILIO_FROM_NUMBER"))
	}
	req, err := http.NewRequest(http.MethodPost,
		"https://api.twilio.com/2010-04-01/Accounts/"+sid+"/Messages.json",
		strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.SetBasicAuth(sid, os.Getenv("TWILIO_AUTH_TOKEN"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := authHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("twilio send failed (%d)", resp.StatusCode)
	}
	return nil
}

// ── POST /auth/send-otp ────────────────────────────────────────────────

func authSendOtp(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Email any `json:"email"`
	}
	_ = httpx.Body(r, &b)
	e := authNormalizeEmail(b.Email)
	if e == "" {
		httpx.Err(w, 400, "Invalid email")
		return
	}

	perEmail := redisx.Consume(ctx, "otp:email:"+e, 3, 3600)
	if !perEmail.Allowed {
		httpx.Err(w, 429, "Too many requests. Try again later.",
			map[string]any{"retryAfter": perEmail.ResetInSec})
		return
	}
	perIP := redisx.Consume(ctx, "otp:ip:"+authClientIP(r), 10, 3600)
	if !perIP.Allowed {
		httpx.Err(w, 429, "Too many requests. Try again later.",
			map[string]any{"retryAfter": perIP.ResetInSec})
		return
	}

	code := genSyncCode()
	codeHash, err := authHashOTP(code)
	if err != nil {
		httpx.Err(w, 500, "Failed to send code")
		return
	}
	err = authTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`UPDATE otp_codes SET consumed_at = NOW()
	         WHERE email = $1 AND consumed_at IS NULL`, e); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO otp_codes (email, code_hash, expires_at)
	         VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)`,
			e, codeHash, strconv.Itoa(authOtpTTLSec))
		return err
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to send code")
		return
	}
	if err := authSendOTPEmail(e, code); err != nil {
		httpx.Err(w, 500, "Failed to send code")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── POST /auth/verify-otp ──────────────────────────────────────────────

func authVerifyOtp(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Email any `json:"email"`
		Otp   any `json:"otp"`
		Name  any `json:"name"`
	}
	_ = httpx.Body(r, &b)
	e := authNormalizeEmail(b.Email)
	code := strings.TrimSpace(authStr(b.Otp))
	var namePtr *string
	if name := strings.TrimSpace(authStr(b.Name)); name != "" {
		namePtr = &name
	}

	if e == "" {
		httpx.Err(w, 400, "Invalid email")
		return
	}
	if !sixDigitsRe.MatchString(code) {
		httpx.Err(w, 400, "OTP must be 6 digits")
		return
	}

	var otpID int64
	var codeHash string
	var expiresAt time.Time
	var attempts int
	err := db.Pool.QueryRow(ctx,
		`SELECT id, code_hash, expires_at, attempts
	     FROM otp_codes
	     WHERE email = $1 AND consumed_at IS NULL AND expires_at > NOW()
	     ORDER BY id DESC
	     LIMIT 1`, e).Scan(&otpID, &codeHash, &expiresAt, &attempts)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 400, "OTP expired or not found. Request a new one.")
		} else {
			httpx.Err(w, 500, "Verification failed")
		}
		return
	}

	if attempts >= authOtpMaxAttempts {
		if _, err := db.Pool.Exec(ctx,
			`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, otpID); err != nil {
			httpx.Err(w, 500, "Verification failed")
			return
		}
		httpx.Err(w, 429, "Too many attempts. Request a new code.")
		return
	}

	// Dev-only fixed OTP bypass — same warning as Node: NEVER set DEV_OTP in prod.
	match := (os.Getenv("DEV_OTP") != "" && code == os.Getenv("DEV_OTP")) || authVerifyOTP(code, codeHash)
	if !match {
		if _, err := db.Pool.Exec(ctx,
			`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, otpID); err != nil {
			httpx.Err(w, 500, "Verification failed")
			return
		}
		httpx.Err(w, 400, "Invalid code")
		return
	}

	if _, err := db.Pool.Exec(ctx,
		`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, otpID); err != nil {
		httpx.Err(w, 500, "Verification failed")
		return
	}

	user, isNewUser, err := authFindOrCreateUser(ctx, e, namePtr, nil, "email")
	if err != nil {
		httpx.Err(w, 500, "Verification failed")
		return
	}
	access, refresh, err := authIssueTokens(ctx, r, user.ID, user.Email)
	if err != nil {
		httpx.Err(w, 500, "Verification failed")
		return
	}
	httpx.JSON(w, 200, authSessionResp{access, refresh, user.public(), isNewUser})
}

// ── POST /auth/google ──────────────────────────────────────────────────

// Node verifies the ID token locally via google-auth-library (JWKS). Here we
// use Google's tokeninfo endpoint (validates signature + expiry server-side) —
// same accept/reject outcomes, no new dependency.
func authGoogle(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		IDToken any `json:"idToken"`
		Name    any `json:"name"`
	}
	_ = httpx.Body(r, &b)
	idToken := authStr(b.IDToken)
	name := strings.TrimSpace(authStr(b.Name))
	if idToken == "" {
		httpx.Err(w, 400, "idToken required")
		return
	}

	resp, err := authHTTP.Get("https://oauth2.googleapis.com/tokeninfo?id_token=" + url.QueryEscape(idToken))
	if err != nil {
		httpx.Err(w, 500, "Google sign-in failed")
		return
	}
	defer resp.Body.Close()
	var payload struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified string `json:"email_verified"`
		Name          string `json:"name"`
		Aud           string `json:"aud"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&payload) != nil {
		// invalid/expired token → Node's verifyIdToken throws → catch-all 500
		httpx.Err(w, 500, "Google sign-in failed")
		return
	}
	if aud := os.Getenv("GOOGLE_WEB_CLIENT_ID"); aud != "" && payload.Aud != aud {
		httpx.Err(w, 500, "Google sign-in failed") // audience mismatch throws in Node
		return
	}
	if payload.Email == "" || payload.Sub == "" {
		httpx.Err(w, 400, "Invalid Google token")
		return
	}
	if payload.EmailVerified == "false" {
		httpx.Err(w, 400, "Google email not verified")
		return
	}

	e := authNormalizeEmail(payload.Email)
	if e == "" {
		httpx.Err(w, 400, "Invalid email in Google token")
		return
	}

	var displayName *string
	if name != "" {
		displayName = &name
	} else if payload.Name != "" {
		displayName = &payload.Name
	}
	user, isNewUser, err := authFindOrCreateUser(ctx, e, displayName, &payload.Sub, "google")
	if err != nil {
		httpx.Err(w, 500, "Google sign-in failed")
		return
	}
	access, refresh, err := authIssueTokens(ctx, r, user.ID, user.Email)
	if err != nil {
		httpx.Err(w, 500, "Google sign-in failed")
		return
	}
	httpx.JSON(w, 200, authSessionResp{access, refresh, user.public(), isNewUser})
}

// ── POST /auth/refresh ─────────────────────────────────────────────────

func authRefresh(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		RefreshToken any `json:"refreshToken"`
	}
	_ = httpx.Body(r, &b)
	presented := authStr(b.RefreshToken)
	if presented == "" {
		httpx.Err(w, 400, "refreshToken required")
		return
	}

	// AUDIT F05/F07. The grace window exists so a retried refresh does not lose
	// the race with the one that already rotated. It applies ONLY to a row
	// revoked BY rotation: a device revoked from the sessions screen used to be
	// handed the same 30 seconds and could mint fresh credentials after being
	// kicked off.
	const graceSec = 30

	type cand struct {
		id        int64
		userID    string
		tokenHash string
		revokedAt *time.Time
	}
	var match *cand

	// One indexed equality on the keyed digest — no page of candidates, no
	// bcrypt storm on an invalid token, and no 500-row horizon past which a
	// perfectly valid session stops being found.
	if lk := authRefreshLookup(presented); lk != "" {
		var c cand
		err := db.Pool.QueryRow(ctx,
			`SELECT id, user_id, token_hash, revoked_at FROM refresh_tokens
		      WHERE token_lookup = $1
		        AND expires_at > NOW()
		        AND (revoked_at IS NULL
		             OR (revoked_reason = 'rotated'
		                 AND revoked_at > NOW() - ($2 || ' seconds')::INTERVAL))
		      LIMIT 1`, lk, strconv.Itoa(graceSec)).Scan(&c.id, &c.userID, &c.tokenHash, &c.revokedAt)
		if err == nil {
			// Still bcrypt-verified. The digest finds the row; it does not
			// authorise it, so a leaked database plus the pepper is not a
			// forged session.
			if authCompareRefresh(presented, c.tokenHash) {
				match = &c
			}
		} else if !db.NoRows(err) {
			httpx.Err(w, 500, "Refresh failed")
			return
		}
	}

	// LEGACY FALLBACK — rows written before migration 127 have no lookup value,
	// and the plaintext was never stored so they cannot be backfilled. Without
	// this, deploying the migration would sign out everyone currently signed in.
	// Delete once every pre-127 token has expired (JWT_REFRESH_TTL, 30d).
	if match == nil {
		rows, err := db.Pool.Query(ctx,
			`SELECT id, user_id, token_hash, revoked_at FROM refresh_tokens
		     WHERE token_lookup IS NULL
		       AND expires_at > NOW()
		       AND (revoked_at IS NULL
		            OR (revoked_reason IS DISTINCT FROM 'revoked'
		                AND revoked_at > NOW() - ($1 || ' seconds')::INTERVAL))
		     ORDER BY id DESC
		     LIMIT 500`, strconv.Itoa(graceSec))
		if err != nil {
			httpx.Err(w, 500, "Refresh failed")
			return
		}
		cands := []cand{}
		for rows.Next() {
			var c cand
			if err := rows.Scan(&c.id, &c.userID, &c.tokenHash, &c.revokedAt); err != nil {
				rows.Close()
				httpx.Err(w, 500, "Refresh failed")
				return
			}
			cands = append(cands, c)
		}
		rows.Close()
		for i := range cands {
			if authCompareRefresh(presented, cands[i].tokenHash) {
				match = &cands[i]
				break
			}
		}
	}

	if match == nil {
		httpx.Err(w, 401, "Invalid refresh token")
		return
	}

	user := &authUserRow{}
	err := db.Pool.QueryRow(ctx,
		`SELECT `+authUserCols+` FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1`,
		match.userID).Scan(user.fields()...)
	if err != nil {
		if db.NoRows(err) {
			if _, err := db.Pool.Exec(ctx,
				`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`, match.id); err != nil {
				httpx.Err(w, 500, "Refresh failed")
				return
			}
			httpx.Err(w, 401, "User no longer exists")
		} else {
			httpx.Err(w, 500, "Refresh failed")
		}
		return
	}

	if match.revokedAt == nil {
		// 'rotated' is what earns the grace window on the NEXT request. An
		// explicit revocation writes 'revoked' and gets none (F07).
		_, err = db.Pool.Exec(ctx,
			`UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = 'rotated', last_used_at = NOW() WHERE id = $1`, match.id)
	} else {
		_, err = db.Pool.Exec(ctx,
			`UPDATE refresh_tokens SET last_used_at = NOW() WHERE id = $1`, match.id)
	}
	if err != nil {
		httpx.Err(w, 500, "Refresh failed")
		return
	}

	access, refresh, err := authIssueTokens(ctx, r, user.ID, user.Email)
	if err != nil {
		httpx.Err(w, 500, "Refresh failed")
		return
	}
	httpx.JSON(w, 200, authTokenPair{access, refresh})
}

// ── POST /auth/logout ──────────────────────────────────────────────────

func authLogout(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		RefreshToken any `json:"refreshToken"`
	}
	_ = httpx.Body(r, &b)
	presented := authStr(b.RefreshToken)
	if presented != "" {
		rows, err := db.Pool.Query(ctx,
			`SELECT id, token_hash FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > NOW() LIMIT 500`)
		if err != nil {
			httpx.Err(w, 500, "Logout failed")
			return
		}
		type cand struct {
			id        int64
			tokenHash string
		}
		cands := []cand{}
		for rows.Next() {
			var c cand
			if err := rows.Scan(&c.id, &c.tokenHash); err != nil {
				rows.Close()
				httpx.Err(w, 500, "Logout failed")
				return
			}
			cands = append(cands, c)
		}
		rows.Close()
		for _, c := range cands {
			if authCompareRefresh(presented, c.tokenHash) {
				if _, err := db.Pool.Exec(ctx,
					`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`, c.id); err != nil {
					httpx.Err(w, 500, "Logout failed")
					return
				}
				break
			}
		}
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── POST /auth/send-otp-phone ──────────────────────────────────────────

func authSendOtpPhone(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Phone any `json:"phone"`
	}
	_ = httpx.Body(r, &b)
	norm := authNormalizePhone(b.Phone)
	if norm == "" || len(norm) < 8 {
		httpx.Err(w, 400, "Invalid phone")
		return
	}
	ph, err := authHashPhone(norm)
	if err != nil {
		httpx.Err(w, 500, "Failed to send code")
		return
	}

	perPhone := redisx.Consume(ctx, "otp:phone:"+ph, 3, 3600)
	if !perPhone.Allowed {
		httpx.Err(w, 429, "Too many requests. Try again later.",
			map[string]any{"retryAfter": perPhone.ResetInSec})
		return
	}
	perIP := redisx.Consume(ctx, "otp:phone-ip:"+authClientIP(r), 10, 3600)
	if !perIP.Allowed {
		httpx.Err(w, 429, "Too many requests. Try again later.",
			map[string]any{"retryAfter": perIP.ResetInSec})
		return
	}

	code := genSyncCode()
	codeHash, err := authHashOTP(code)
	if err != nil {
		httpx.Err(w, 500, "Failed to send code")
		return
	}
	err = authTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`UPDATE otp_codes SET consumed_at = NOW()
	         WHERE phone_hash = $1 AND consumed_at IS NULL`, ph); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO otp_codes (phone_hash, code_hash, expires_at)
	         VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)`,
			ph, codeHash, strconv.Itoa(authOtpTTLSec))
		return err
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to send code")
		return
	}
	if err := authSendOTPSMS("+"+norm, code); err != nil {
		httpx.Err(w, 500, "Failed to send code")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "dev": !authSmsConfigured()})
}

// ── POST /auth/verify-otp-phone ────────────────────────────────────────

func authVerifyOtpPhone(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Phone any `json:"phone"`
		Otp   any `json:"otp"`
		Name  any `json:"name"`
	}
	_ = httpx.Body(r, &b)
	norm := authNormalizePhone(b.Phone)
	code := strings.TrimSpace(authStr(b.Otp))
	var namePtr *string
	if name := strings.TrimSpace(authStr(b.Name)); name != "" {
		namePtr = &name
	}
	if norm == "" {
		httpx.Err(w, 400, "Invalid phone")
		return
	}
	if !sixDigitsRe.MatchString(code) {
		httpx.Err(w, 400, "OTP must be 6 digits")
		return
	}

	ph, err := authHashPhone(norm)
	if err != nil {
		httpx.Err(w, 500, "Verification failed")
		return
	}

	var otpID int64
	var codeHash string
	var expiresAt time.Time
	var attempts int
	err = db.Pool.QueryRow(ctx,
		`SELECT id, code_hash, expires_at, attempts
	       FROM otp_codes
	       WHERE phone_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
	       ORDER BY id DESC
	       LIMIT 1`, ph).Scan(&otpID, &codeHash, &expiresAt, &attempts)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 400, "OTP expired or not found. Request a new one.")
		} else {
			httpx.Err(w, 500, "Verification failed")
		}
		return
	}

	if attempts >= authOtpMaxAttempts {
		if _, err := db.Pool.Exec(ctx,
			`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, otpID); err != nil {
			httpx.Err(w, 500, "Verification failed")
			return
		}
		httpx.Err(w, 429, "Too many attempts. Request a new code.")
		return
	}

	match := (os.Getenv("DEV_OTP") != "" && code == os.Getenv("DEV_OTP")) || authVerifyOTP(code, codeHash)
	if !match {
		if _, err := db.Pool.Exec(ctx,
			`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, otpID); err != nil {
			httpx.Err(w, 500, "Verification failed")
			return
		}
		httpx.Err(w, 400, "Invalid code")
		return
	}

	if _, err := db.Pool.Exec(ctx,
		`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, otpID); err != nil {
		httpx.Err(w, 500, "Verification failed")
		return
	}

	// Two modes: linking (caller authenticated) vs signup (no auth header).
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	actingUserID := ""
	if strings.HasPrefix(authHeader, "Bearer ") {
		if sub, _, err := httpx.VerifyAccess(authHeader[7:]); err == nil {
			actingUserID = sub // bad token → fall through to signup mode
		}
	}

	if actingUserID != "" {
		var conflictID string
		err := db.Pool.QueryRow(ctx,
			`SELECT id FROM users WHERE phone_hash = $1 AND id <> $2 AND is_deleted = FALSE LIMIT 1`,
			ph, actingUserID).Scan(&conflictID)
		if err == nil {
			httpx.Err(w, http.StatusConflict, "Phone already linked to another account")
			return
		}
		if !db.NoRows(err) {
			httpx.Err(w, 500, "Verification failed")
			return
		}
		if _, err := db.Pool.Exec(ctx,
			`UPDATE users SET phone = $1, phone_hash = $2 WHERE id = $3`,
			"+"+norm, ph, actingUserID); err != nil {
			httpx.Err(w, 500, "Verification failed")
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "linked": true})
		return
	}

	// Signup-by-phone.
	user := &authUserRow{}
	isNewUser := false
	err = db.Pool.QueryRow(ctx,
		`SELECT `+authUserCols+` FROM users WHERE phone_hash = $1 AND is_deleted = FALSE LIMIT 1`,
		ph).Scan(user.fields()...)
	if err != nil {
		if !db.NoRows(err) {
			httpx.Err(w, 500, "Verification failed")
			return
		}
		// email column is UNIQUE; deterministic-but-opaque placeholder local-part.
		placeholderEmail := "phone+" + ph[:12] + "@vaultchat.local"
		err = db.Pool.QueryRow(ctx,
			`INSERT INTO users (email, phone, phone_hash, auth_provider)
	         VALUES ($1, $2, $3, 'phone') RETURNING `+authUserCols,
			placeholderEmail, "+"+norm, ph).Scan(user.fields()...)
		if err != nil {
			httpx.Err(w, 500, "Verification failed")
			return
		}
		isNewUser = true
		if namePtr != nil {
			if _, err := db.Pool.Exec(ctx,
				`UPDATE users SET name = $1 WHERE id = $2`, *namePtr, user.ID); err != nil {
				httpx.Err(w, 500, "Verification failed")
				return
			}
			user.Name = namePtr
		}
	}

	access, refresh, err := authIssueTokens(ctx, r, user.ID, user.Email)
	if err != nil {
		httpx.Err(w, 500, "Verification failed")
		return
	}
	httpx.JSON(w, 200, authSessionResp{access, refresh, user.public(), isNewUser})
}

// ════════════════════════════════════════════════════════════════════════
// Onboarding re-architecture (encrypted PII, migration 042).
// Error envelope: { error: { code, message } }.
// ════════════════════════════════════════════════════════════════════════

var authSecurityQuestionCodes = map[string]bool{
	"first_pet": true, "mother_maiden": true, "birth_city": true, "primary_school": true,
	"childhood_friend": true, "first_car": true, "favourite_teacher": true,
	"street_grew_up": true, "first_job_city": true, "favourite_book": true,
	"oldest_cousin": true, "maternal_grandfather": true,
}

var authWeakMpins = map[string]bool{
	"123456": true, "654321": true, "000000": true, "111111": true, "222222": true,
	"333333": true, "444444": true, "555555": true, "666666": true, "777777": true,
	"888888": true, "999999": true, "123123": true, "121212": true, "112233": true,
	"098765": true, "012345": true,
}

func authIsWeakMpin(m string) bool {
	if !sixDigitsRe.MatchString(m) {
		return true // exactly 6 digits
	}
	if strings.Count(m, m[:1]) == 6 {
		return true // all same
	}
	if strings.Contains("0123456789", m) || strings.Contains("9876543210", m) {
		return true // sequential
	}
	return authWeakMpins[m]
}

func authAgeFromDob(iso string) (int, bool) {
	var d time.Time
	var err error
	for _, layout := range []string{"2006-01-02", time.RFC3339Nano, time.RFC3339} {
		if d, err = time.Parse(layout, iso); err == nil {
			break
		}
	}
	if err != nil {
		return 0, false
	}
	now := time.Now().UTC()
	a := now.Year() - d.Year()
	mo := int(now.Month()) - int(d.Month())
	if mo < 0 || (mo == 0 && now.Day() < d.Day()) {
		a--
	}
	return a, true
}

// ── POST /auth/onboard/send-otp ────────────────────────────────────────

func authOnboardSendOtp(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Email any `json:"email"`
	}
	_ = httpx.Body(r, &b)
	e := vault.NormalizeEmail(authStr(b.Email))
	if e == "" {
		authEnvErr(w, 400, "bad_request", "Invalid email")
		return
	}
	perEmail := redisx.Consume(ctx, "otp:email:"+e, 3, 3600)
	if !perEmail.Allowed {
		authEnvErr(w, 429, "rate_limited", "Too many requests. Try again later.")
		return
	}
	perIP := redisx.Consume(ctx, "otp:ip:"+authClientIP(r), 10, 3600)
	if !perIP.Allowed {
		authEnvErr(w, 429, "rate_limited", "Too many requests. Try again later.")
		return
	}

	code := genSyncCode()
	codeHash, err := authHashOTP(code)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Failed to send code")
		return
	}
	err = authTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`UPDATE otp_codes SET consumed_at = NOW() WHERE email = $1 AND consumed_at IS NULL`, e); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1, $2, NOW() + ($3 || ' seconds')::INTERVAL)`,
			e, codeHash, strconv.Itoa(authOtpTTLSec))
		return err
	})
	if err != nil {
		authEnvErr(w, 500, "server_error", "Failed to send code")
		return
	}
	if err := authSendOTPEmail(e, code); err != nil {
		authEnvErr(w, 500, "server_error", "Failed to send code")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── POST /auth/onboard/verify-otp ──────────────────────────────────────

func authOnboardVerifyOtp(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Email any `json:"email"`
		Code  any `json:"code"`
	}
	_ = httpx.Body(r, &b)
	e := vault.NormalizeEmail(authStr(b.Email))
	code := strings.TrimSpace(authStr(b.Code))
	if e == "" || code == "" {
		authEnvErr(w, 400, "bad_request", "email and code required")
		return
	}
	// A 6-digit code is a million guesses; unlimited attempts inside the OTP's
	// validity window make it a formality, and this ticket is what /profile/init
	// accepts as proof of email ownership. Same 5-per-15-minutes shape as
	// /mpin/verify. Per-email AND per-IP: the email key alone lets one host walk
	// a list of addresses, the IP key alone is defeated by rotating them.
	gate := redisx.Consume(ctx, "onboard-otp:"+e, 5, 900)
	if gate.Allowed {
		gate = redisx.Consume(ctx, "onboard-otp-ip:"+authClientIP(r), 50, 900)
	}
	if !gate.Allowed {
		reset := gate.ResetInSec
		if reset == 0 {
			reset = 900
		}
		authEnvErr(w, http.StatusLocked, "locked", fmt.Sprintf("Too many attempts. Try again in %ds", reset))
		return
	}
	var otpID int64
	var codeHash string
	err := db.Pool.QueryRow(ctx,
		`SELECT id, code_hash FROM otp_codes
	     WHERE email = $1 AND consumed_at IS NULL AND expires_at > NOW()
	     ORDER BY expires_at DESC LIMIT 1`, e).Scan(&otpID, &codeHash)
	if err != nil && !db.NoRows(err) {
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	ok := err == nil && authVerifyOTP(code, codeHash)
	if !ok {
		authEnvErr(w, 401, "invalid_code", "Incorrect or expired code")
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, otpID); err != nil {
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	// Ticket binds to the email lookup hash; profile/init requires it.
	el, err := vault.EmailLookup(e)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	ticket, err := vault.SignTicket(el, 900)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "emailTicket": ticket})
}

// ── POST /auth/lookup ──────────────────────────────────────────────────

func authLookup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ipLimit := redisx.Consume(ctx, "auth-ip:"+authClientIP(r), 20, 60)
	if !ipLimit.Allowed {
		authEnvErr(w, 429, "rate_limited", "Too many requests")
		return
	}
	var b struct {
		Email any `json:"email"`
		Phone any `json:"phone"`
	}
	_ = httpx.Body(r, &b)
	email := vault.NormalizeEmail(authStr(b.Email))
	phone := vault.NormalizePhone(authStr(b.Phone))
	if email == "" || phone == "" {
		authEnvErr(w, 400, "bad_request", "email and phone are required")
		return
	}

	el, err := vault.EmailLookup(email)
	if err != nil {
		log.Printf("[auth/lookup] %v", err) // e.g. VAULTCHAT_LOOKUP_PEPPER not set
		authEnvErr(w, 500, "server_error", "Lookup failed")
		return
	}
	pl, err := vault.PhoneLookup(phone)
	if err != nil {
		log.Printf("[auth/lookup] %v", err)
		authEnvErr(w, 500, "server_error", "Lookup failed")
		return
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT id, email_lookup, phone_lookup FROM users
	     WHERE (email_lookup = $1 OR phone_lookup = $2) AND is_deleted = FALSE LIMIT 2`,
		el, pl)
	if err != nil {
		log.Printf("[auth/lookup] %v", err) // e.g. column email_lookup does not exist → run migrations
		authEnvErr(w, 500, "server_error", "Lookup failed")
		return
	}
	type hit struct {
		id string
		el *string
		pl *string
	}
	hits := []hit{}
	for rows.Next() {
		var h hit
		if err := rows.Scan(&h.id, &h.el, &h.pl); err != nil {
			rows.Close()
			authEnvErr(w, 500, "server_error", "Lookup failed")
			return
		}
		hits = append(hits, h)
	}
	rows.Close()

	ip := authClientIP(r)
	for _, h := range hits {
		if h.el != nil && *h.el == el && h.pl != nil && *h.pl == pl {
			authAudit(ctx, &h.id, ip, "lookup", true)
			httpx.JSON(w, 200, map[string]any{"exists": true, "userId": h.id})
			return
		}
	}
	phoneTaken, emailTaken := false, false
	for _, h := range hits {
		if h.pl != nil && *h.pl == pl {
			phoneTaken = true
		}
		if h.el != nil && *h.el == el {
			emailTaken = true
		}
	}
	authAudit(ctx, nil, ip, "lookup", false)
	if phoneTaken {
		httpx.JSON(w, 200, map[string]any{"exists": false, "conflict": "phone"})
		return
	}
	if emailTaken {
		httpx.JSON(w, 200, map[string]any{"exists": false, "conflict": "email"})
		return
	}
	httpx.JSON(w, 200, map[string]any{"exists": false})
}

// ── POST /auth/profile/init ────────────────────────────────────────────

func authProfileInit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Email         any `json:"email"`
		Phone         any `json:"phone"`
		FirstName     any `json:"firstName"`
		LastName      any `json:"lastName"`
		Dob           any `json:"dob"`
		Status        any `json:"status"`
		ProfilePicUrl any `json:"profilePicUrl"`
		EmailTicket   any `json:"emailTicket"`
	}
	_ = httpx.Body(r, &b)
	email := vault.NormalizeEmail(authStr(b.Email))
	phone := vault.NormalizePhone(authStr(b.Phone))
	firstName := strings.TrimSpace(authStr(b.FirstName))
	lastName := strings.TrimSpace(authStr(b.LastName))
	dob := strings.TrimSpace(authStr(b.Dob))
	status := authStr(b.Status)
	profilePicUrl := authStrIfTruthy(b.ProfilePicUrl)

	if email == "" || phone == "" || firstName == "" || dob == "" {
		authEnvErr(w, 400, "bad_request", "email, phone, firstName and dob are required")
		return
	}
	age, ok := authAgeFromDob(dob)
	if !ok || age < 13 {
		authEnvErr(w, 400, "min_age", "You must be at least 13")
		return
	}
	if len([]rune(status)) > 139 {
		authEnvErr(w, 400, "status_too_long", "Status max 139 characters")
		return
	}

	el, err := vault.EmailLookup(email)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not create profile")
		return
	}
	pl, err := vault.PhoneLookup(phone)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not create profile")
		return
	}

	// Email ownership: valid ticket from /auth/onboard/verify-otp for THIS email.
	if !vault.VerifyTicket(authStr(b.EmailTicket), el) {
		authEnvErr(w, 401, "email_unverified", "Verify your email with the code first")
		return
	}

	var one int
	err = db.Pool.QueryRow(ctx,
		`SELECT 1 FROM users WHERE (email_lookup = $1 OR phone_lookup = $2) AND is_deleted = FALSE LIMIT 1`,
		el, pl).Scan(&one)
	if err == nil {
		authEnvErr(w, http.StatusConflict, "already_exists", "An account already exists for this email or mobile")
		return
	}
	if !db.NoRows(err) {
		authEnvErr(w, 500, "server_error", "Could not create profile")
		return
	}

	emailC, err := vault.Encrypt(email)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not create profile")
		return
	}
	phoneC, err := vault.Encrypt(phone)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not create profile")
		return
	}
	firstC, err := vault.Encrypt(firstName)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not create profile")
		return
	}
	var lastC *string
	if lastName != "" {
		c, err := vault.Encrypt(lastName)
		if err != nil {
			authEnvErr(w, 500, "server_error", "Could not create profile")
			return
		}
		lastC = &c
	}
	dobC, err := vault.Encrypt(dob)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not create profile")
		return
	}
	var statusC *string
	if strings.TrimSpace(status) != "" {
		c, err := vault.Encrypt(status) // Node encrypts the UNtrimmed status
		if err != nil {
			authEnvErr(w, 500, "server_error", "Could not create profile")
			return
		}
		statusC = &c
	}
	phoneHash, err := authDiscoveryPhoneHash(phone)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not create profile")
		return
	}

	var userID string
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO users
	       (email_lookup, phone_lookup, email_cipher, phone_cipher,
	        first_name_cipher, last_name_cipher, dob_cipher, status_cipher,
	        photo_url, phone_hash, auth_provider, email_verified_at, onboarding_complete)
	     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'google',NOW(),FALSE)
	     RETURNING id`,
		el, pl, emailC, phoneC, firstC, lastC, dobC, statusC,
		profilePicUrl, phoneHash).Scan(&userID)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not create profile")
		return
	}
	// Onboarding continues with /security-questions/save and /mpin/set, both of
	// which write credentials keyed on a body userId. Neither can require a JWT
	// (there is no session until the MPIN exists), so they take THIS ticket
	// instead — minted only here, only after the email OTP proved ownership,
	// and bound to the id we just created. Without it those two endpoints hand
	// any caller another user's account.
	setupTicket, err := vault.SignTicket(authSetupTicketData(userID), 900)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not create profile")
		return
	}
	httpx.JSON(w, 200, map[string]any{"userId": userID, "setupTicket": setupTicket})
}

// authSetupTicketData is the ticket binding shared by /security-questions/save
// and /mpin/set. Kept in one function so the two verifiers cannot drift from
// the minter — a mismatch here fails open on neither side, but it does brick
// onboarding, and the string is easy to mistype in three places.
func authSetupTicketData(userID string) string { return "setup:" + userID }

// ── POST /auth/security-questions/save ─────────────────────────────────

type authAnswerBody struct {
	QuestionCode any `json:"questionCode"`
	Answer       any `json:"answer"`
}

func authSecurityQuestionsSave(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		UserID      any              `json:"userId"`
		SetupTicket any              `json:"setupTicket"`
		Answers     []authAnswerBody `json:"answers"`
	}
	_ = httpx.Body(r, &b)
	userID := authStr(b.UserID)
	if userID == "" || b.Answers == nil || len(b.Answers) != 5 {
		authEnvErr(w, 400, "bad_request", "Exactly 5 answers required")
		return
	}
	// Ownership: these answers ARE a credential — /security-questions/verify
	// trades them for a recovery ticket, which /mpin/recover trades for a
	// session. Overwriting them on an established account is account takeover,
	// so the caller must hold the setup ticket from /auth/profile/init.
	if !vault.VerifyTicket(authStr(b.SetupTicket), authSetupTicketData(userID)) {
		authEnvErr(w, 401, "not_verified", "Start onboarding again to set your security questions")
		return
	}
	codes := map[string]bool{}
	for _, a := range b.Answers {
		codes[authStr(a.QuestionCode)] = true
	}
	if len(codes) != 5 {
		authEnvErr(w, 400, "duplicate_question", "Questions must be unique")
		return
	}
	for c := range codes {
		if !authSecurityQuestionCodes[c] {
			authEnvErr(w, 400, "invalid_question", "Unknown question code")
			return
		}
	}
	for _, a := range b.Answers {
		if len([]rune(vault.NormalizeAnswer(authStr(a.Answer)))) < 2 {
			authEnvErr(w, 400, "answer_too_short", "Each answer needs at least 2 characters")
			return
		}
	}
	var one string
	err := db.Pool.QueryRow(ctx,
		`SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE`, userID).Scan(&one)
	if err != nil {
		if db.NoRows(err) {
			authEnvErr(w, 404, "not_found", "User not found")
		} else {
			authEnvErr(w, 500, "server_error", "Could not save security questions")
		}
		return
	}

	for _, a := range b.Answers {
		hash, err := vault.HashSecret(vault.NormalizeAnswer(authStr(a.Answer)))
		if err != nil {
			authEnvErr(w, 500, "server_error", "Could not save security questions")
			return
		}
		if _, err := db.Pool.Exec(ctx,
			`INSERT INTO user_security_questions (user_id, question_code, answer_hash)
	         VALUES ($1, $2, $3)
	         ON CONFLICT (user_id, question_code) DO UPDATE SET answer_hash = EXCLUDED.answer_hash`,
			userID, authStr(a.QuestionCode), hash); err != nil {
			authEnvErr(w, 500, "server_error", "Could not save security questions")
			return
		}
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── POST /auth/mpin/set ────────────────────────────────────────────────

func authMpinSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		UserID      any `json:"userId"`
		SetupTicket any `json:"setupTicket"`
		Mpin        any `json:"mpin"`
	}
	_ = httpx.Body(r, &b)
	userID := authStr(b.UserID)
	mpin := authStr(b.Mpin)
	if userID == "" {
		authEnvErr(w, 400, "bad_request", "userId required")
		return
	}
	// Ownership, gate 1 of 2. This endpoint writes the credential that
	// /mpin/verify trades for a session, so without proof of ownership it is a
	// one-call account takeover of any userId the caller can name. It cannot
	// require a JWT — no session exists yet — so it takes the setup ticket
	// /auth/profile/init minted after the email OTP. Resets do NOT come here;
	// they go to /mpin/recover, which has always required its own ticket.
	if !vault.VerifyTicket(authStr(b.SetupTicket), authSetupTicketData(userID)) {
		authEnvErr(w, 401, "not_verified", "Start onboarding again to set your MPIN")
		return
	}
	if authIsWeakMpin(mpin) {
		authEnvErr(w, 400, "weak_mpin", "Choose a less predictable MPIN")
		return
	}
	var one string
	err := db.Pool.QueryRow(ctx,
		`SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE`, userID).Scan(&one)
	if err != nil {
		if db.NoRows(err) {
			authEnvErr(w, 404, "not_found", "User not found")
		} else {
			authEnvErr(w, 500, "server_error", "Could not set MPIN")
		}
		return
	}

	hash, err := vault.HashSecret(mpin)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not set MPIN")
		return
	}
	// Ownership, gate 2 of 2: FIRST-SET ONLY. The ticket above is the real
	// gate; this is what contains the damage if one ever leaks (a crash report,
	// a proxy log) inside its 15-minute life — a replay cannot overwrite a PIN
	// that already exists.
	tag, err := db.Pool.Exec(ctx,
		`UPDATE users SET mpin_hash = $1, onboarding_complete = TRUE, updated_at = NOW()
		   WHERE id = $2 AND mpin_hash IS NULL`,
		hash, userID)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not set MPIN")
		return
	}
	// Zero rows means the PIN was already set. Answer 200, not an error: the
	// only caller that reaches here holds a valid ticket for THIS id, so this is
	// the onboarding client retrying after a reply was lost in flight, and
	// failing it would strand a real user on the last step of signup. An
	// attacker holding the same ticket learns nothing and changes nothing.
	if tag.RowsAffected() == 0 {
		httpx.JSON(w, 200, map[string]any{"ok": true, "already": true})
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── POST /auth/mpin/verify ─────────────────────────────────────────────

func authMpinVerify(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		UserID any `json:"userId"`
		Mpin   any `json:"mpin"`
	}
	_ = httpx.Body(r, &b)
	userID := authStr(b.UserID)
	mpin := authStr(b.Mpin)
	if userID == "" || mpin == "" {
		authEnvErr(w, 400, "bad_request", "userId and mpin required")
		return
	}

	// ConsumeSecure, not Consume: a Redis outage must not remove the
	// five-attempt limit on a six-digit PIN (audit F11).
	gate := redisx.ConsumeSecure(ctx, "mpin:"+userID, 5, 900)
	if !gate.Allowed {
		reset := gate.ResetInSec
		if reset == 0 {
			reset = 900
		}
		authEnvErr(w, http.StatusLocked, "locked", fmt.Sprintf("Too many attempts. Try again in %ds", reset))
		return
	}

	user := &authUserRow{}
	err := db.Pool.QueryRow(ctx,
		`SELECT `+authUserCols+` FROM users WHERE id = $1 AND is_deleted = FALSE`,
		userID).Scan(user.fields()...)
	if err != nil && !db.NoRows(err) {
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	ok := err == nil && user.MpinHash != nil && *user.MpinHash != "" &&
		vault.VerifySecret(mpin, *user.MpinHash)
	authAudit(ctx, &userID, authClientIP(r), "mpin", ok)
	if !ok {
		authEnvErr(w, 401, "invalid_mpin", "Incorrect MPIN")
		return
	}

	redisx.Reset(ctx, "mpin:"+userID)
	access, refresh, err := authIssueTokens(ctx, r, user.ID, user.Email)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	httpx.JSON(w, 200, authTokenPair{access, refresh})
}

// ── GET /auth/security-questions/{userId} ──────────────────────────────

func authSecurityQuestionsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := db.Pool.Query(ctx,
		`SELECT question_code FROM user_security_questions WHERE user_id = $1 ORDER BY created_at`,
		r.PathValue("userId"))
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not load questions")
		return
	}
	defer rows.Close()
	questions := []string{}
	for rows.Next() {
		var q string
		if err := rows.Scan(&q); err != nil {
			authEnvErr(w, 500, "server_error", "Could not load questions")
			return
		}
		questions = append(questions, q)
	}
	if rows.Err() != nil {
		authEnvErr(w, 500, "server_error", "Could not load questions")
		return
	}
	httpx.JSON(w, 200, map[string]any{"questions": questions})
}

// ── POST /auth/security-questions/verify ───────────────────────────────

func authSecurityQuestionsVerify(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		UserID  any              `json:"userId"`
		Answers []authAnswerBody `json:"answers"`
	}
	_ = httpx.Body(r, &b)
	userID := authStr(b.UserID)
	if userID == "" || len(b.Answers) == 0 {
		authEnvErr(w, 400, "bad_request", "answers required")
		return
	}

	// Same reasoning as the MPIN gate: recovery answers are a credential.
	gate := redisx.ConsumeSecure(ctx, "recover:"+userID, 5, 900)
	if !gate.Allowed {
		reset := gate.ResetInSec
		if reset == 0 {
			reset = 900
		}
		authEnvErr(w, http.StatusLocked, "locked", fmt.Sprintf("Too many attempts. Try again in %ds", reset))
		return
	}

	rows, err := db.Pool.Query(ctx,
		`SELECT question_code, answer_hash FROM user_security_questions WHERE user_id = $1`, userID)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	byCode := map[string]string{}
	for rows.Next() {
		var code, hash string
		if err := rows.Scan(&code, &hash); err != nil {
			rows.Close()
			authEnvErr(w, 500, "server_error", "Verification failed")
			return
		}
		byCode[code] = hash
	}
	rows.Close()

	correct := 0
	for _, a := range b.Answers {
		if h, found := byCode[authStr(a.QuestionCode)]; found &&
			vault.VerifySecret(vault.NormalizeAnswer(authStr(a.Answer)), h) {
			correct++
		}
	}
	ok := correct >= 3
	authAudit(ctx, &userID, authClientIP(r), "recover", ok)
	if !ok {
		authEnvErr(w, 401, "insufficient_answers",
			fmt.Sprintf("Need at least 3 correct answers (got %d)", correct))
		return
	}
	redisx.Reset(ctx, "recover:"+userID)
	ticket, err := vault.SignTicket("recover:"+userID, 900)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "recoveryTicket": ticket})
}

// ── POST /auth/mpin/recover ────────────────────────────────────────────

func authMpinRecover(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		UserID         any `json:"userId"`
		RecoveryTicket any `json:"recoveryTicket"`
		Mpin           any `json:"mpin"`
	}
	_ = httpx.Body(r, &b)
	userID := authStr(b.UserID)
	mpin := authStr(b.Mpin)
	if userID == "" {
		authEnvErr(w, 400, "bad_request", "userId required")
		return
	}
	if !vault.VerifyTicket(authStr(b.RecoveryTicket), "recover:"+userID) {
		authEnvErr(w, 401, "not_verified", "Answer your security questions first")
		return
	}
	if authIsWeakMpin(mpin) {
		authEnvErr(w, 400, "weak_mpin", "Choose a less predictable MPIN")
		return
	}

	user := &authUserRow{}
	err := db.Pool.QueryRow(ctx,
		`SELECT `+authUserCols+` FROM users WHERE id = $1 AND is_deleted = FALSE`,
		userID).Scan(user.fields()...)
	if err != nil {
		if db.NoRows(err) {
			authEnvErr(w, 404, "not_found", "User not found")
		} else {
			authEnvErr(w, 500, "server_error", "Could not reset MPIN")
		}
		return
	}

	hash, err := vault.HashSecret(mpin)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not reset MPIN")
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`UPDATE users SET mpin_hash = $1, updated_at = NOW() WHERE id = $2`, hash, userID); err != nil {
		authEnvErr(w, 500, "server_error", "Could not reset MPIN")
		return
	}
	redisx.Reset(ctx, "mpin:"+userID) // clear any verify-lockout
	access, refresh, err := authIssueTokens(ctx, r, user.ID, user.Email)
	if err != nil {
		authEnvErr(w, 500, "server_error", "Could not reset MPIN")
		return
	}
	httpx.JSON(w, 200, authTokenPair{access, refresh})
}

// ── POST /auth/profile/photo (JWT) ─────────────────────────────────────

func authProfilePhoto(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		PhotoID  any `json:"photoId"`
		PhotoKey any `json:"photoKey"`
	}
	_ = httpx.Body(r, &b)
	photoID := authStrIfTruthy(b.PhotoID)
	photoKey := authStrIfTruthy(b.PhotoKey)
	var keyCipher *string
	if photoID != nil && photoKey != nil {
		c, err := vault.Encrypt(*photoKey)
		if err != nil {
			authEnvErr(w, 500, "server_error", "Could not save photo")
			return
		}
		keyCipher = &c
	}
	// Safe replacement: verify the new object, move the reference, and only
	// then retire the old one. See attachment_lifecycle.go for why the order is
	// the entire contract — every failure path below leaves the EXISTING photo
	// in place rather than losing both.
	//
	// This also classifies the object server-side as 'profile', which is what
	// makes an upload from a client that sends no `purpose` land in the right
	// class instead of 'unknown'.
	newID := ""
	if photoID != nil {
		newID = *photoID
	}
	err := attSwapRef(ctx, user.ID, newID, "profile",
		func(c context.Context, tx pgx.Tx) (string, error) {
			var prev *string
			e := tx.QueryRow(c, `SELECT photo_url FROM users WHERE id = $1`, user.ID).Scan(&prev)
			if prev == nil {
				return "", e
			}
			return *prev, e
		},
		func(c context.Context, tx pgx.Tx, id string) error {
			var ref any
			if id != "" {
				ref = id
			}
			_, e := tx.Exec(c,
				`UPDATE users SET photo_url = $1, photo_key_cipher = $2, updated_at = NOW() WHERE id = $3`,
				ref, keyCipher, user.ID)
			return e
		})
	if err != nil {
		if db.NoRows(err) {
			// The new id is not an unpurged attachment owned by this user.
			// Refused rather than stored, so a caller cannot point their avatar
			// at another user's object.
			authEnvErr(w, 400, "invalid_photo", "That photo is not available")
			return
		}
		log.Printf("[profile photo] %v", err)
		authEnvErr(w, 500, "server_error", "Could not save photo")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── POST /auth/mfa/configure (JWT) ─────────────────────────────────────

func authMfaConfigure(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		MfaEnabled any `json:"mfaEnabled"`
	}
	_ = httpx.Body(r, &b)
	if _, err := db.Pool.Exec(ctx,
		`UPDATE users SET mfa_enabled = $1, updated_at = NOW() WHERE id = $2`,
		authTruthy(b.MfaEnabled), user.ID); err != nil {
		authEnvErr(w, 500, "server_error", "Could not update MFA")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── GET /auth/profile (JWT) ────────────────────────────────────────────

func authProfileGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	u := &authUserRow{}
	err := db.Pool.QueryRow(ctx,
		`SELECT `+authUserCols+` FROM users WHERE id = $1 AND is_deleted = FALSE`,
		user.ID).Scan(u.fields()...)
	if err != nil {
		if db.NoRows(err) {
			authEnvErr(w, 404, "not_found", "User not found")
		} else {
			authEnvErr(w, 500, "server_error", "Could not load profile")
		}
		return
	}
	photo := u.PhotoURL
	if photo != nil && *photo == "" {
		photo = nil // Node's `r.photo_url || null`
	}
	httpx.JSON(w, 200, struct {
		UserID             string  `json:"userId"`
		Email              *string `json:"email"`
		Phone              *string `json:"phone"`
		FirstName          *string `json:"firstName"`
		LastName           *string `json:"lastName"`
		DOB                *string `json:"dob"`
		Status             *string `json:"status"`
		ProfilePicUrl      *string `json:"profilePicUrl"`
		MfaEnabled         bool    `json:"mfaEnabled"`
		OnboardingComplete bool    `json:"onboardingComplete"`
	}{
		u.ID,
		authSafeDecrypt(u.EmailCipher),
		authSafeDecrypt(u.PhoneCipher),
		authSafeDecrypt(u.FirstNameCipher),
		authSafeDecrypt(u.LastNameCipher),
		authSafeDecrypt(u.DOBCipher),
		authSafeDecrypt(u.StatusCipher),
		photo,
		u.MfaEnabled,
		u.OnboardingComplete,
	})
}
