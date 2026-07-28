// vaultlens.go ← routes/vaultlens.js — VaultLens AI-avatar mini-app control
// plane. Same endpoints, same status codes, same error strings, same shapes.
//
// The render worker STAYS in Node (workers/vaultlens.js), as does the
// QueueEvents listener in server.js that emits vaultlens:ready/failed. This
// port only has to enqueue jobs in a way that worker accepts, so vlEnqueue
// EVALs the exact addStandardJob-9 Lua script extracted from
// vaultchat-backend/node_modules/bullmq@5.81.2 (vaultlens_addjob.lua) with the
// same KEYS/ARGV bullmq's Queue.add produces: INCR bull:vaultlens:id, HMSET
// bull:vaultlens:<jobId> {name,data,opts,timestamp,delay,priority}, LPUSH
// bull:vaultlens:wait, XADD bull:vaultlens:events (added + waiting events).
//
// >>> SOAK-TEST ITEM: the vlEnqueue path. Byte shapes were verified against
// bullmq 5.81.2 source (dist/cjs/classes/scripts.js addStandardJobArgs +
// commands/addStandardJob-9.lua); the bench Redis (127.0.0.1:16379) was down
// so a live job could not be diffed. Run one Go enqueue against the Node
// worker before cutover. Pin bullmq in package.json — a bullmq major bump can
// change the script/ARGV contract.
package routes

import (
	"context"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/storage"
)

// Catalog copied from vaultchat-backend/vaultlens-catalog.json (source of
// truth — re-copy on catalog updates; Node serves the same file).
//
//go:embed vaultlens_catalog.json
var vlCatalogRaw []byte

//go:embed vaultlens_addjob.lua
var vlAddJobLua string

const (
	vlFreeDaily = 3
	vlFreeWidth = 512
	vlResultTTL = 3600 * time.Second // presigned output URL lifetime
	vlMaxFace   = 8 * 1024 * 1024
)

func vlFaceKey(uid string) string        { return "vaultlens/faces/" + uid + ".jpg" }
func vlPreviewKey(styleID string) string { return "vaultlens/previews/" + styleID + ".jpg" }

type vlStyle struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type vlPack struct {
	ID     string    `json:"id"`
	Name   string    `json:"name"`
	Emoji  string    `json:"emoji"`
	Styles []vlStyle `json:"styles"`
}

var vlCatalog struct {
	Version json.RawMessage `json:"version"`
	Packs   []vlPack        `json:"packs"`
}

// styleId → packId (prompts stay server-side in the Node worker; the Go API
// only validates ids and records pack_id).
var vlPackByStyle = map[string]string{}

func init() {
	if err := json.Unmarshal(vlCatalogRaw, &vlCatalog); err != nil {
		panic("vaultlens catalog: " + err.Error())
	}
	for _, p := range vlCatalog.Packs {
		for _, s := range p.Styles {
			vlPackByStyle[s.ID] = p.ID
		}
	}
}

func vlModelslabEnabled() bool { return os.Getenv("MODELSLAB_API_KEY") != "" }

func RegisterVaultlens(mux *http.ServeMux) {
	// PUBLIC (mounted before requireAuth in Node): style preview thumbnails.
	mux.HandleFunc("GET /vaultlens/preview/{styleId}", vlPreview)
	mux.HandleFunc("GET /vaultlens/catalog", httpx.RequireAuth(vlCatalogGet))
	mux.HandleFunc("GET /vaultlens/quota", httpx.RequireAuth(vlQuotaGet))
	mux.HandleFunc("POST /vaultlens/face", httpx.RequireAuth(vlFacePost))
	mux.HandleFunc("DELETE /vaultlens/face", httpx.RequireAuth(vlFaceDelete))
	mux.HandleFunc("POST /vaultlens/generate", httpx.RequireAuth(vlGenerate))
	mux.HandleFunc("GET /vaultlens/result/{id}", httpx.RequireAuth(vlResult))
}

// ── Quota (free 3/day, IST midnight reset, 'failed' rows auto-refund) ──

// vlNextIstMidnightISO mirrors nextIstMidnightISO: integer ceil on the "IST
// epoch", back to UTC, ISO string.
func vlNextIstMidnightISO() string {
	const ist = int64(5.5 * 3600 * 1000)
	const day = int64(86400000)
	istNow := time.Now().UnixMilli() + ist
	next := ((istNow + day - 1) / day) * day
	return time.UnixMilli(next - ist).UTC().Format("2006-01-02T15:04:05.000Z")
}

type vlQuota struct {
	Used      int    `json:"used"`
	Limit     int    `json:"limit"`
	Remaining int    `json:"remaining"`
	ResetAt   string `json:"resetAt"`
	Tier      string `json:"tier"`
}

func vlUsedToday(ctx context.Context, userID string) (int, error) {
	var n int
	err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*)::int AS n FROM vaultlens_generation
      WHERE user_id = $1 AND status <> 'failed'
        AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
		userID).Scan(&n)
	return n, err
}

func vlQuotaOf(ctx context.Context, userID string) (vlQuota, error) {
	used, err := vlUsedToday(ctx, userID)
	if err != nil {
		return vlQuota{}, err
	}
	rem := vlFreeDaily - used
	if rem < 0 {
		rem = 0
	}
	return vlQuota{Used: used, Limit: vlFreeDaily, Remaining: rem,
		ResetAt: vlNextIstMidnightISO(), Tier: "free"}, nil
}

// ── GET /vaultlens/preview/:styleId — public, streamed, empty bodies ──

func vlPreview(w http.ResponseWriter, r *http.Request) {
	if _, ok := vlPackByStyle[r.PathValue("styleId")]; !ok {
		w.WriteHeader(404) // res.status(404).end() — no JSON body
		return
	}
	obj := storage.GetObjectStream(r.Context(), vlPreviewKey(r.PathValue("styleId")))
	if obj == nil {
		w.WriteHeader(404)
		return
	}
	defer obj.Body.Close()
	ct := obj.ContentType
	if ct == "" {
		ct = "image/jpeg"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = io.Copy(w, obj.Body) // mid-stream error → connection drops, like res.destroy()
}

// ── GET /vaultlens/catalog — client-safe projection (NO prompts) ──────

func vlCatalogGet(w http.ResponseWriter, _ *http.Request) {
	type styleOut struct {
		ID        string `json:"id"`
		Pack      string `json:"pack"`
		Name      string `json:"name"`
		Thumbnail string `json:"thumbnail"`
	}
	type packOut struct {
		ID     string     `json:"id"`
		Name   string     `json:"name"`
		Emoji  string     `json:"emoji"`
		Styles []styleOut `json:"styles"`
	}
	packs := []packOut{}
	for _, p := range vlCatalog.Packs {
		styles := []styleOut{}
		for _, s := range p.Styles {
			styles = append(styles, styleOut{ID: s.ID, Pack: p.ID, Name: s.Name,
				Thumbnail: "/vaultlens/preview/" + s.ID})
		}
		packs = append(packs, packOut{ID: p.ID, Name: p.Name, Emoji: p.Emoji, Styles: styles})
	}
	httpx.JSON(w, 200, map[string]any{"version": vlCatalog.Version, "packs": packs})
}

// ── GET /vaultlens/quota ──────────────────────────────────────────────

func vlQuotaGet(w http.ResponseWriter, r *http.Request) {
	q, err := vlQuotaOf(r.Context(), httpx.UserFrom(r).ID)
	if err != nil {
		httpx.Err(w, 500, "quota failed")
		return
	}
	httpx.JSON(w, 200, q)
}

// ── POST /vaultlens/face — cache/replace the face reference ───────────

func vlFacePost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if !storage.Enabled() {
		httpx.Err(w, 503, "storage unavailable")
		return
	}
	mr, err := r.MultipartReader()
	if err != nil {
		httpx.Err(w, 400, "file required")
		return
	}
	var buf []byte
	for {
		p, err := mr.NextPart()
		if err != nil {
			break
		}
		if p.FormName() == "file" {
			buf, err = io.ReadAll(io.LimitReader(p, vlMaxFace+1))
			p.Close()
			if err != nil {
				httpx.Err(w, 500, "face upload failed")
				return
			}
			break
		}
		p.Close()
	}
	if len(buf) == 0 {
		httpx.Err(w, 400, "file required")
		return
	}
	if len(buf) > vlMaxFace {
		// Node's multer fileSize cap rejects >8MB before the route's own 413
		// branch can run; we surface the route's intended 413 instead of
		// multer's opaque 500.
		httpx.Err(w, http.StatusRequestEntityTooLarge, "too large")
		return
	}
	if err := storage.PutObject(ctx, vlFaceKey(user.ID), buf, "image/jpeg"); err != nil {
		httpx.Err(w, 500, "face upload failed")
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO vaultlens_face (user_id, storage_key, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET storage_key = EXCLUDED.storage_key, updated_at = NOW()`,
		user.ID, vlFaceKey(user.ID)); err != nil {
		httpx.Err(w, 500, "face upload failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── DELETE /vaultlens/face — wipe face reference + ALL outputs ────────

func vlFaceDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	storage.DeletePrefix(ctx, "vaultlens/faces/"+user.ID)
	storage.DeletePrefix(ctx, "vaultlens/"+user.ID+"/")
	if _, err := db.Pool.Exec(ctx, `DELETE FROM vaultlens_generation WHERE user_id = $1`, user.ID); err != nil {
		httpx.Err(w, 500, "delete failed")
		return
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM vaultlens_face WHERE user_id = $1`, user.ID); err != nil {
		httpx.Err(w, 500, "delete failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── POST /vaultlens/generate — enqueue a generation ───────────────────

var vlIDRe = regexp.MustCompile(`^[0-9A-Za-z]{20,32}$`)

func vlGenerate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if !storage.Enabled() || !vlModelslabEnabled() {
		httpx.Err(w, 503, "VaultLens is warming up — try again shortly.",
			map[string]any{"code": "not_configured"})
		return
	}

	var body struct {
		ID      any `json:"id"`
		StyleID any `json:"styleId"`
	}
	_ = httpx.Body(r, &body)
	id := strings.TrimSpace(fmt.Sprintf("%v", orEmpty(body.ID)))
	styleID := strings.TrimSpace(fmt.Sprintf("%v", orEmpty(body.StyleID)))
	if !vlIDRe.MatchString(id) {
		httpx.Err(w, 400, "invalid id")
		return
	}
	packID, ok := vlPackByStyle[styleID]
	if !ok {
		httpx.Err(w, 400, "unknown style")
		return
	}

	rl := redisx.Consume(ctx, "vlgen:"+user.ID, 12, 60)
	if !rl.Allowed {
		httpx.Err(w, 429, "Too fast — give it a moment.",
			map[string]any{"retryAfter": rl.ResetInSec})
		return
	}

	var faceKey string
	err := db.Pool.QueryRow(ctx,
		`SELECT storage_key FROM vaultlens_face WHERE user_id = $1`, user.ID).Scan(&faceKey)
	if db.NoRows(err) {
		httpx.Err(w, 400, "Add your photo first", map[string]any{"code": "no_face"})
		return
	}
	if err != nil {
		httpx.Err(w, 500, "generate failed")
		return
	}

	q, err := vlQuotaOf(ctx, user.ID)
	if err != nil {
		httpx.Err(w, 500, "generate failed")
		return
	}
	if q.Remaining <= 0 {
		httpx.Err(w, 429, "Daily limit reached",
			map[string]any{"code": "quota_exhausted", "quota": q})
		return
	}

	// Idempotent insert (client retry with same ULID is a no-op).
	var insID string
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO vaultlens_generation (id, user_id, style_id, pack_id, status, width)
       VALUES ($1, $2, $3, $4, 'queued', $5)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
		id, user.ID, styleID, packID, vlFreeWidth).Scan(&insID)
	if db.NoRows(err) { // already enqueued
		httpx.JSON(w, 200, map[string]any{"id": id, "status": "queued", "duplicate": true, "quota": q})
		return
	}
	if err != nil {
		httpx.Err(w, 500, "generate failed")
		return
	}

	if err := vlEnqueue(ctx, id, user.ID, styleID); err != nil {
		httpx.Err(w, 500, "generate failed")
		return
	}

	q2, err := vlQuotaOf(ctx, user.ID)
	if err != nil {
		httpx.Err(w, 500, "generate failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"id": id, "status": "queued", "quota": q2})
}

// ── GET /vaultlens/result/:id — status + fresh signed URL ─────────────

func vlResult(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var (
		id, styleID, status        string
		packID, storageKey, genErr *string
		width                      int
		createdAt                  time.Time
		completedAt                *time.Time
	)
	err := db.Pool.QueryRow(ctx,
		`SELECT id, style_id, pack_id, status, storage_key, width, error, created_at, completed_at
         FROM vaultlens_generation WHERE id = $1 AND user_id = $2`,
		r.PathValue("id"), user.ID).
		Scan(&id, &styleID, &packID, &status, &storageKey, &width, &genErr, &createdAt, &completedAt)
	if db.NoRows(err) {
		httpx.Err(w, 404, "not found")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "result failed")
		return
	}
	var url *string
	if status == "done" && storageKey != nil {
		u, err := storage.PresignGet(ctx, *storageKey, vlResultTTL)
		if err != nil {
			httpx.Err(w, 500, "result failed")
			return
		}
		url = &u
	}
	httpx.JSON(w, 200, struct {
		ID          string        `json:"id"`
		StyleID     string        `json:"styleId"`
		PackID      *string       `json:"packId"`
		Status      string        `json:"status"`
		Width       int           `json:"width"`
		URL         *string       `json:"url"`
		Error       *string       `json:"error"`
		CreatedAt   httpx.JSTime  `json:"createdAt"`
		CompletedAt *httpx.JSTime `json:"completedAt"`
	}{id, styleID, packID, status, width, url, genErr, httpx.JSTime(createdAt), httpx.JST(completedAt)})
}

// ── BullMQ enqueue (bullmq@5.81.2 addStandardJob protocol) ────────────
//
// Mirrors Queue('vaultlens').add('generate', {generationId,userId,styleId,width},
// {jobId, attempts:2, backoff:{type:'fixed',delay:3000}, removeOnComplete:50,
// removeOnFail:50}) from lib/vaultlensQueue.js + routes/vaultlens.js:159.
// KEYS/ARGV per dist/cjs/classes/scripts.js addStandardJobArgs; ARGV[1]/ARGV[3]
// are msgpack (cmsgpack-decoded inside the script).

func vlEnqueue(ctx context.Context, genID, userID, styleID string) error {
	if redisx.Client == nil {
		return errors.New("redis unavailable")
	}
	const prefix = "bull:vaultlens:"
	keys := []string{
		prefix + "wait", prefix + "paused", prefix + "meta", prefix + "id",
		prefix + "completed", prefix + "delayed", prefix + "active",
		prefix + "events", prefix + "marker",
	}
	data, err := json.Marshal(struct {
		GenerationID string `json:"generationId"`
		UserID       string `json:"userId"`
		StyleID      string `json:"styleId"`
		Width        int    `json:"width"`
	}{genID, userID, styleID, vlFreeWidth})
	if err != nil {
		return err
	}
	res, err := redisx.Client.Eval(ctx, vlAddJobLua, keys,
		vlPackAddArgs(prefix, genID, "generate", time.Now().UnixMilli()),
		string(data), vlPackAddOpts(genID)).Result()
	if err != nil {
		return err
	}
	if n, ok := res.(int64); ok && n < 0 {
		return fmt.Errorf("addStandardJob error code %d", n)
	}
	return nil
}

// Minimal msgpack writers for the two fixed ARGV shapes (no dependency; the
// Lua side accepts any valid msgpack encoding).

func vlMpStr(b []byte, s string) []byte {
	n := len(s)
	switch {
	case n < 32:
		b = append(b, 0xa0|byte(n))
	case n < 256:
		b = append(b, 0xd9, byte(n))
	default:
		b = append(b, 0xda, byte(n>>8), byte(n))
	}
	return append(b, s...)
}

func vlMpInt(b []byte, v int64) []byte {
	if v >= 0 && v < 128 {
		return append(b, byte(v))
	}
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(v))
	return append(append(b, 0xd3), buf[:]...)
}

// ARGV[1]: [keyPrefix, customId, name, timestamp, parentKey, parentDepsKey,
// parent, repeatJobKey, deduplicationKey] — the last five are nil for a plain
// Queue.add with no parent/repeat/dedup.
func vlPackAddArgs(prefix, jobID, name string, ts int64) []byte {
	b := []byte{0x99} // fixarray(9)
	b = vlMpStr(b, prefix)
	b = vlMpStr(b, jobID)
	b = vlMpStr(b, name)
	b = vlMpInt(b, ts)
	return append(b, 0xc0, 0xc0, 0xc0, 0xc0, 0xc0)
}

// ARGV[3]: the job opts map exactly as Job.optsAsJSON leaves it (attempts is
// hoisted first by the Job constructor's Object.assign({attempts:0}, opts)).
func vlPackAddOpts(jobID string) []byte {
	b := []byte{0x85} // fixmap(5)
	b = vlMpStr(b, "attempts")
	b = vlMpInt(b, 2)
	b = vlMpStr(b, "jobId")
	b = vlMpStr(b, jobID)
	b = vlMpStr(b, "backoff")
	b = append(b, 0x82) // fixmap(2)
	b = vlMpStr(b, "type")
	b = vlMpStr(b, "fixed")
	b = vlMpStr(b, "delay")
	b = vlMpInt(b, 3000)
	b = vlMpStr(b, "removeOnComplete")
	b = vlMpInt(b, 50)
	b = vlMpStr(b, "removeOnFail")
	b = vlMpInt(b, 50)
	return b
}
