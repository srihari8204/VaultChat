// admin.go ← routes/admin.js — Admin Console API. x-admin-key guarded (NOT
// user JWT), rate-limited, metadata-only (never message content/ciphertext).
//
// Runtime divergences vs Node (server.js injects {io, getOnlineCount} via
// adminRouter.setRuntime — both live only inside the Node process):
//   - onlineNow / getOnlineCount (routes/admin.js:28 → userSockets.size,
//     server.js:469): no cross-process socket map exists. The same socket
//     layer DOES persist presence to users.online (server.js:502/511), so we
//     count that — equivalent steady-state, may differ transiently around
//     connect/disconnect. NOT invented; it is Node-maintained shared state.
//   - POST /broadcast (routes/admin.js:189 → io.emit, ALL sockets): the
//     /internal/emit bridge (server.js:154) only targets rooms/userIds — it
//     has no global-broadcast form, so this route answers 503 "Socket layer
//     not ready" (Node's own io-unset path) instead of faking delivery.
//     Cutover needs a broadcast:true extension to /internal/emit first.
package routes

import (
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"math"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

var adminStart = time.Now()

func RegisterAdmin(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/stats", adminAuth(adminStats))
	mux.HandleFunc("GET /api/admin/users", adminAuth(adminUsers))
	mux.HandleFunc("GET /api/admin/messages", adminAuth(adminMessages))
	mux.HandleFunc("GET /api/admin/sessions", adminAuth(adminSessions))
	mux.HandleFunc("DELETE /api/admin/sessions/{id}", adminAuth(adminSessionDelete))
	mux.HandleFunc("POST /api/admin/broadcast", adminAuth(adminBroadcast))
	mux.HandleFunc("GET /api/admin/health-detail", adminAuth(adminHealthDetail))
}

// adminKeyEqual — constant-time compare via sha256 of both sides so length
// never leaks (mirrors safeKeyEqual).
func adminKeyEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ha, hb := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

// adminAuth — ADMIN_KEY guard (503 when unset) + 120 req/min per client IP,
// fail-open on limiter errors (redisx.Consume already fails open).
func adminAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		expected := os.Getenv("ADMIN_KEY")
		if expected == "" {
			httpx.Err(w, 503, "ADMIN_KEY not configured on server")
			return
		}
		if !adminKeyEqual(r.Header.Get("x-admin-key"), expected) {
			httpx.Err(w, 401, "Invalid admin key")
			return
		}
		ip := r.Header.Get("cf-connecting-ip")
		if ip == "" {
			ip = r.Header.Get("x-real-ip")
		}
		if ip == "" {
			ip = strings.Split(r.Header.Get("x-forwarded-for"), ",")[0]
		}
		if ip == "" {
			ip = authClientIP(r)
		}
		if ip == "" {
			ip = "admin"
		}
		ip = strings.TrimSpace(ip)
		rl := redisx.Consume(r.Context(), "admin:"+ip, 120, 60)
		if !rl.Allowed {
			httpx.Err(w, 429, "Rate limited", map[string]any{"retryAfter": rl.ResetInSec})
			return
		}
		next(w, r)
	}
}

// adminOnlineCount — see the divergence note in the file header.
func adminOnlineCount(r *http.Request) int64 {
	var n int64
	if err := db.SysPool.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM users WHERE online = TRUE`).Scan(&n); err != nil {
		return 0 // Node's default getOnlineCount is () => 0
	}
	return n
}

// ── GET /api/admin/stats ──────────────────────────────────────────────

func adminStats(w http.ResponseWriter, r *http.Request) {
	var totalUsers, totalMessages, activeSessions, dbSize int64
	err := db.SysPool.QueryRow(r.Context(), `
      SELECT
        (SELECT COUNT(*) FROM users WHERE is_deleted = FALSE)                               AS total_users,
        (SELECT COUNT(*) FROM messages)                                                     AS total_messages,
        (SELECT COUNT(*) FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > NOW()) AS active_sessions,
        (SELECT pg_database_size(current_database()))                                       AS db_size`).
		Scan(&totalUsers, &totalMessages, &activeSessions, &dbSize)
	if err != nil {
		httpx.Err(w, 500, "Failed to load stats")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"totalUsers":     totalUsers,
		"onlineNow":      adminOnlineCount(r),
		"totalMessages":  totalMessages,
		"activeSessions": activeSessions,
		"dbSizeMB":       math.Round(float64(dbSize)/1048576*10) / 10,
		"uptime":         int64(math.Round(time.Since(adminStart).Seconds())),
	})
}

// adminLimit mirrors Math.min(parseInt(v || '50', 10) || 50, 200) — NaN and 0
// both fall back to 50; negatives pass through (and 500 at the DB, like Node).
func adminLimit(v string) int64 {
	n, ok := httpx.ParseIntPrefix(v)
	if v == "" || !ok || n == 0 {
		n = 50
	}
	if n > 200 {
		n = 200
	}
	return n
}

// ── GET /api/admin/users?limit=&offset=&q= ────────────────────────────

func adminUsers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	limit := adminLimit(r.URL.Query().Get("limit"))
	offset, ok := httpx.ParseIntPrefix(r.URL.Query().Get("offset"))
	if !ok || offset < 0 {
		offset = 0
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	like := "%" + strings.NewReplacer("%", `\%`, "_", `\_`).Replace(q) + "%"

	where, li, oi := "", "$1", "$2"
	params := []any{limit, offset}
	if q != "" {
		where = `WHERE name ILIKE $1 OR email::text ILIKE $1 OR phone ILIKE $1`
		li, oi = "$2", "$3"
		params = []any{like, limit, offset}
	}

	rows, err := db.SysPool.Query(ctx,
		fmt.Sprintf(`SELECT id, name, email, phone, online, last_seen_at, created_at, is_deleted, auth_provider
         FROM users %s
        ORDER BY created_at DESC
        LIMIT %s OFFSET %s`, where, li, oi), params...)
	if err != nil {
		httpx.Err(w, 500, "Failed to load users")
		return
	}
	defer rows.Close()
	users := []map[string]any{}
	for rows.Next() {
		var id string
		var name, email, phone, authProvider *string
		var online *bool
		var lastSeen *time.Time
		var createdAt time.Time
		var isDeleted bool
		if err := rows.Scan(&id, &name, &email, &phone, &online, &lastSeen, &createdAt, &isDeleted, &authProvider); err != nil {
			httpx.Err(w, 500, "Failed to load users")
			return
		}
		users = append(users, map[string]any{
			"id": id, "displayName": name, "email": email, "phone": phone,
			"isOnline": online, "lastSeen": httpx.JST(lastSeen), "createdAt": httpx.JSTime(createdAt),
			"isDeleted": isDeleted, "authProvider": authProvider,
		})
	}

	var total int64
	totalSQL := `SELECT COUNT(*) AS n FROM users `
	totalParams := []any{}
	if q != "" {
		totalSQL += `WHERE name ILIKE $1 OR email::text ILIKE $1 OR phone ILIKE $1`
		totalParams = []any{like}
	}
	if err := db.SysPool.QueryRow(ctx, totalSQL, totalParams...).Scan(&total); err != nil {
		httpx.Err(w, 500, "Failed to load users")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"total": total, "limit": limit, "offset": offset, "users": users,
	})
}

// ── GET /api/admin/messages?limit= — METADATA ONLY (no content) ───────
//
// §15 finding 3: this feed does NOT select reply_to_id. It used to, and no
// operator surface ever rendered it — admin/index.html draws six columns
// (id, type, sender, chat, status, time) and never touched the field. What it
// did do is assemble the reply graph of finding 1 into an operator-facing
// live tail, which is the one thing envelope.proto:153-154 says the server has
// no need to build. The delivery sweep now reclaims the column
// (internal/jobs/jobs.go), but a row between send and sweep still carries it,
// and this was the only place it was readable as a feed. Do not add it back.
//
// `type` is still selected: the console renders it in a column, so removing it
// would blank an operator surface. That is finding 2, and it needs the coarse
// CC-Wire MessageClass first — see docs/METADATA_PRIVACY.md.

func adminMessages(w http.ResponseWriter, r *http.Request) {
	rows, err := db.SysPool.Query(r.Context(),
		`SELECT id, chat_id, sender_id, type, edited_at, deleted_at, created_at
         FROM messages ORDER BY id DESC LIMIT $1`,
		adminLimit(r.URL.Query().Get("limit")))
	if err != nil {
		httpx.Err(w, 500, "Failed to load messages")
		return
	}
	defer rows.Close()
	messages := []map[string]any{}
	for rows.Next() {
		var id int64
		var chatID, senderID, typ string
		var editedAt, deletedAt *time.Time
		var createdAt time.Time
		if err := rows.Scan(&id, &chatID, &senderID, &typ, &editedAt, &deletedAt, &createdAt); err != nil {
			httpx.Err(w, 500, "Failed to load messages")
			return
		}
		// No per-message delivery column exists (delivery tracked per member);
		// derive a coarse status from the metadata we DO have.
		status := "sent"
		if deletedAt != nil {
			status = "deleted"
		} else if editedAt != nil {
			status = "edited"
		}
		messages = append(messages, map[string]any{
			"id": strconv.FormatInt(id, 10), "chatId": chatID, "senderId": senderID, "type": typ,
			"status": status, "createdAt": httpx.JSTime(createdAt),
		})
	}
	httpx.JSON(w, 200, map[string]any{"messages": messages})
}

// ── GET /api/admin/sessions — active refresh tokens (= sessions) ──────

func adminSessions(w http.ResponseWriter, r *http.Request) {
	// rt.ip is INET; ::text matches node-pg's string form ("1.2.3.4", no /32).
	rows, err := db.SysPool.Query(r.Context(),
		`SELECT rt.id, rt.user_id, u.email, u.name, rt.user_agent, rt.ip::text,
              rt.created_at, rt.last_used_at, rt.expires_at
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.revoked_at IS NULL AND rt.expires_at > NOW()
        ORDER BY rt.last_used_at DESC NULLS LAST
        LIMIT 200`)
	if err != nil {
		httpx.Err(w, 500, "Failed to load sessions")
		return
	}
	defer rows.Close()
	sessions := []map[string]any{}
	for rows.Next() {
		var id int64
		var userID string
		var email, name, userAgent, ip *string
		var createdAt, expiresAt time.Time
		var lastUsedAt *time.Time
		if err := rows.Scan(&id, &userID, &email, &name, &userAgent, &ip, &createdAt, &lastUsedAt, &expiresAt); err != nil {
			httpx.Err(w, 500, "Failed to load sessions")
			return
		}
		device := "Unknown device"
		if userAgent != nil && *userAgent != "" {
			device = *userAgent
		}
		sessions = append(sessions, map[string]any{
			"id": strconv.FormatInt(id, 10), "userId": userID, "email": email, "name": name,
			"device": device, "ip": ip,
			"createdAt": httpx.JSTime(createdAt), "lastUsedAt": httpx.JST(lastUsedAt),
			"expiresAt": httpx.JSTime(expiresAt),
		})
	}
	httpx.JSON(w, 200, map[string]any{"sessions": sessions})
}

// ── DELETE /api/admin/sessions/:id — revoke ───────────────────────────

func adminSessionDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := httpx.ParseIntPrefix(r.PathValue("id"))
	if !ok {
		httpx.Err(w, 400, "invalid id")
		return
	}
	var revoked int64
	err := db.SysPool.QueryRow(r.Context(),
		`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
		id).Scan(&revoked)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Session not found or already revoked")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "Failed to revoke session")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "revoked": strconv.FormatInt(id, 10)})
}

// ── POST /api/admin/broadcast { type, text } ──────────────────────────

func adminBroadcast(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Type any `json:"type"`
		Text any `json:"text"`
	}
	_ = httpx.Body(r, &body)
	typ := fmt.Sprintf("%v", orEmpty(body.Type))
	if typ == "" {
		typ = "info"
	}
	typ = truncRunes(typ, 32)
	text := truncRunes(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(body.Text))), 1000)
	if text == "" {
		httpx.Err(w, 400, "text required")
		return
	}
	// Node: io.emit('system:announcement', payload) to EVERY socket; bridged
	// via /internal/emit {broadcast:true}. delivered = users.online count
	// (Node reports its in-process socket count — same steady-state truth).
	payload := map[string]any{"type": typ, "text": text, "ts": time.Now().UnixMilli()}
	emitx.Broadcast("system:announcement", payload)
	var online int
	if err := db.SysPool.QueryRow(r.Context(),
		`SELECT COUNT(*)::int FROM users WHERE online = TRUE`).Scan(&online); err != nil {
		online = 0
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "delivered": online, "payload": payload})
}

// ── GET /api/admin/health-detail ──────────────────────────────────────

func adminHealthDetail(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Postgres ping
	var pgMs any = nil
	pgOk := false
	if t := time.Now(); db.Pool.Ping(ctx) == nil {
		pgMs, pgOk = time.Since(t).Milliseconds(), true
	}

	// Redis ping
	var redisMs any = nil
	redisOk := false
	if redisx.Client != nil {
		if t := time.Now(); redisx.Client.Ping(ctx).Err() == nil {
			redisMs, redisOk = time.Since(t).Milliseconds(), true
		}
	}

	// App pg pool stats. pgxpool has no "waiting" gauge (Node reads
	// pg.Pool.waitingCount) — reported as null.
	st := db.Pool.Stat()
	poolStats := map[string]any{
		"total":   st.TotalConns(),
		"idle":    st.IdleConns(),
		"waiting": nil,
	}

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	httpx.JSON(w, 200, map[string]any{
		"postgres":  map[string]any{"ok": pgOk, "pingMs": pgMs},
		"redis":     map[string]any{"ok": redisOk, "pingMs": redisMs},
		"pgbouncer": poolStats,
		"system": map[string]any{
			"uptimeSec":  int64(math.Round(time.Since(adminStart).Seconds())),
			"loadAvg":    adminLoadAvg(),
			"cpuCount":   runtime.NumCPU(),
			"totalMemMB": adminMeminfoMB("MemTotal:"),
			"freeMemMB":  adminMeminfoMB("MemFree:"),
			"rssMB":      adminRSSMB(),
			"heapUsedMB": int64(math.Round(float64(mem.HeapAlloc) / 1048576)),
			// Runtime version of THIS process — Go here, Node's process.version
			// there. The console shows it verbatim; the divergence is honest.
			"nodeVersion": runtime.Version(),
		},
	})
}

// adminLoadAvg — /proc/loadavg on Linux; [0,0,0] elsewhere (what Node's
// os.loadavg() returns on Windows too).
func adminLoadAvg() []float64 {
	out := []float64{0, 0, 0}
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return out
	}
	fields := strings.Fields(string(data))
	for i := 0; i < 3 && i < len(fields); i++ {
		if f, err := strconv.ParseFloat(fields[i], 64); err == nil {
			out[i] = math.Round(f*100) / 100
		}
	}
	return out
}

// adminMeminfoMB — a /proc/meminfo field (kB) → MB; 0 when unreadable.
func adminMeminfoMB(field string) int64 {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, field) {
			f := strings.Fields(line)
			if len(f) >= 2 {
				if kb, err := strconv.ParseInt(f[1], 10, 64); err == nil {
					return int64(math.Round(float64(kb) / 1024))
				}
			}
		}
	}
	return 0
}

// adminRSSMB — VmRSS from /proc/self/status; 0 when unreadable.
func adminRSSMB() int64 {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				if kb, err := strconv.ParseInt(f[1], 10, 64); err == nil {
					return int64(math.Round(float64(kb) / 1024))
				}
			}
		}
	}
	return 0
}
