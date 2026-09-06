// uploads.go ← routes/uploads.js — attachment upload/download: multipart disk
// upload, presigned direct-to-store upload, resumable S3 multipart, view-once
// gate, encrypted-avatar stream-decrypt, S3 relay streaming.
package routes

import (
	"log"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/storage"
	"vaultchat/backend-go/internal/vault"
)

const upPartSize = 8 * 1024 * 1024

func upMaxBytes() int64 {
	if v, ok := httpx.ParseIntPrefix(os.Getenv("UPLOAD_MAX_BYTES")); ok && v > 0 {
		return v
	}
	return 100 * 1024 * 1024 // server-relay media cap (images/videos/docs); huge files use VaultBeam
}

func upMultipartMaxBytes() int64 {
	if v, ok := httpx.ParseIntPrefix(os.Getenv("MULTIPART_MAX_BYTES")); ok && v > 0 {
		return v
	}
	return 2 * 1024 * 1024 * 1024
}

func upDir() string {
	d := os.Getenv("UPLOAD_DIR")
	if d == "" {
		cwd, _ := os.Getwd()
		d = filepath.Join(cwd, "uploads")
	}
	abs, err := filepath.Abs(d)
	if err != nil {
		return d
	}
	return abs
}

// ─── attachment purpose (migration 100) ───────────────────────────────
//
// Every stored object declares what it is FOR, because retention differs by
// class and cannot be inferred afterwards. `attachments` is shared by chat
// media, avatars, group photos and story media; deducing purpose from whether
// a `messages` row referenced the object failed in both directions and
// silently deleted every avatar 14 days after upload (see migration 100).
//
// UNCLASSIFIED DEFAULTS TO 'unknown', NOT 'chat'.
//
// That is the safe direction and it is a deliberate trade. A client that does
// not declare a purpose — every build currently in the field — produces
// objects the cleanup will never touch, so storage grows until those clients
// update. The alternative default, 'chat', would apply a three-hour deletion
// timer to an avatar uploaded by an old client. Retaining bytes is recoverable;
// deleting a user's profile photo is not.
var upPurposes = map[string]bool{
	"chat": true, "profile": true, "group": true,
	"story": true, "mini_app": true, "unknown": true,
}

func upPurposeStr(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	if upPurposes[s] {
		return s
	}
	return "unknown"
}

// upPurpose reads the declared purpose from a multipart/query upload.
func upPurpose(r *http.Request) string {
	if v := r.FormValue("purpose"); v != "" {
		return upPurposeStr(v)
	}
	return upPurposeStr(r.URL.Query().Get("purpose"))
}

var upExtRe = regexp.MustCompile(`^\.[a-z0-9]{1,6}$`)

func upSafeExt(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	if !upExtRe.MatchString(ext) {
		return ""
	}
	return ext
}

func upShardPath(t time.Time) string {
	return filepath.Join(
		fmt.Sprintf("%04d", t.UTC().Year()),
		fmt.Sprintf("%02d", int(t.UTC().Month())),
		fmt.Sprintf("%02d", t.UTC().Day()))
}

// upUUID mirrors crypto.randomUUID (v4).
func upUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// upJSInt mirrors parseInt(x || '0', 10) || 0 for JSON any (number or string).
func upJSInt(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case string:
		if n, ok := httpx.ParseIntPrefix(t); ok {
			return n
		}
	}
	return 0
}

func upViewOnce(v any) bool {
	return v == true || v == float64(1) || v == "1"
}

func RegisterUploads(mux *http.ServeMux) {
	mux.HandleFunc("POST /uploads", httpx.RequireAuth(uploadsPost))
	mux.HandleFunc("POST /uploads/presign", httpx.RequireAuth(uploadsPresign))
	mux.HandleFunc("POST /uploads/multipart/init", httpx.RequireAuth(uploadsMPInit))
	mux.HandleFunc("POST /uploads/multipart/part-urls", httpx.RequireAuth(uploadsMPPartURLs))
	mux.HandleFunc("GET /uploads/multipart/{id}/parts", httpx.RequireAuth(uploadsMPParts))
	mux.HandleFunc("POST /uploads/multipart/complete", httpx.RequireAuth(uploadsMPComplete))
	mux.HandleFunc("POST /uploads/multipart/abort", httpx.RequireAuth(uploadsMPAbort))
	mux.HandleFunc("GET /uploads/{id}", httpx.RequireAuth(uploadsGet))
	mux.HandleFunc("POST /uploads/{id}/viewed", httpx.RequireAuth(uploadsViewed))
	mux.HandleFunc("POST /uploads/{id}/revoke", httpx.RequireAuth(uploadsRevoke))
}

// ── POST /uploads — multipart disk upload (multer parity) ──────────────

func uploadsPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	maxBytes := upMaxBytes()

	mr, err := r.MultipartReader()
	if err != nil {
		httpx.Err(w, 400, "file (multipart) required")
		return
	}
	var part *multipart.Part
	for {
		p, err := mr.NextPart()
		if err != nil {
			break
		}
		if p.FormName() == "file" {
			part = p
			break
		}
		_ = p.Close()
	}
	if part == nil {
		httpx.Err(w, 400, "file (multipart) required")
		return
	}
	defer part.Close()

	origName := part.FileName()
	viewOnce := r.URL.Query().Get("viewOnce") == "1" || r.URL.Query().Get("viewOnce") == "true"
	mimeType := part.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	var out struct {
		ID       string  `json:"id"`
		Mime     string  `json:"mime"`
		Size     int     `json:"size"`
		Filename *string `json:"filename"`
		ViewOnce bool    `json:"viewOnce"`
	}

	// R2/S3-backed server-relay: the client POSTs bytes to us (it can always
	// reach api.corefinite.com) and WE put them in R2. This is the reliable
	// path — the presigned direct-to-R2 PUT fails on some device networks,
	// leaving orphan rows (bytes never landed). Here the bytes are confirmed in
	// R2 before we ever write the row, so a row always has an object behind it.
	if storage.Enabled() {
		data, err := io.ReadAll(io.LimitReader(part, maxBytes+1))
		if err != nil {
			httpx.Err(w, 500, "Upload failed")
			return
		}
		if int64(len(data)) > maxBytes {
			httpx.Err(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("File too large (max %d bytes)", maxBytes))
			return
		}
		id := upUUID()
		key := "att/" + id + upSafeExt(origName)
		if err := storage.PutObject(ctx, key, data, mimeType); err != nil {
			// SAY WHY. The client can only report "Storage upload failed"; the
			// object store's own reason (AccessDenied, NoSuchBucket, a signature
			// mismatch) was discarded here, so a credential expiry looked
			// identical to a network blip and could only be found by probing R2
			// by hand. One line turns that into a grep.
			log.Printf("[storage] putObject %s: %v", key, err)
			httpx.Err(w, 502, "Storage upload failed")
			return
		}
		if err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
			var fn *string
			var vo bool
			e := tx.QueryRow(ctx,
				`INSERT INTO attachments
				   (id, owner_user_id, filename, mime_type, size_bytes, storage_path, view_once, storage_backend, purpose)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, 's3', $8)
				 RETURNING id, mime_type, size_bytes, filename, view_once`,
				id, user.ID, truncRunes(origName, 255), truncRunes(mimeType, 100), len(data),
				key, viewOnce, upPurpose(r)).Scan(&out.ID, &out.Mime, &out.Size, &fn, &vo)
			out.Filename, out.ViewOnce = fn, vo
			return e
		}); err != nil {
			storage.DeleteObject(ctx, key) // don't leave an R2 object with no row
			httpx.Err(w, 500, "Upload failed")
			return
		}
		httpx.JSON(w, 200, out)
		return
	}

	// No object store configured → local disk (dev / self-host fallback).
	dir := filepath.Join(upDir(), upShardPath(time.Now()))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		httpx.Err(w, 500, "Upload failed")
		return
	}
	diskName := upUUID() + upSafeExt(origName)
	absPath := filepath.Join(dir, diskName)
	f, err := os.Create(absPath)
	if err != nil {
		httpx.Err(w, 500, "Upload failed")
		return
	}
	written, err := io.Copy(f, io.LimitReader(part, maxBytes+1))
	f.Close()
	if err != nil {
		os.Remove(absPath)
		httpx.Err(w, 500, "Upload failed")
		return
	}
	if written > maxBytes {
		os.Remove(absPath)
		httpx.Err(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("File too large (max %d bytes)", maxBytes))
		return
	}

	relPath, _ := filepath.Rel(upDir(), absPath)
	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var fn *string
		var vo bool
		e := tx.QueryRow(ctx,
			`INSERT INTO attachments (owner_user_id, filename, mime_type, size_bytes, storage_path, view_once, purpose)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 RETURNING id, mime_type, size_bytes, filename, view_once`,
			user.ID, truncRunes(origName, 255), truncRunes(mimeType, 100), written,
			filepath.ToSlash(relPath), viewOnce, upPurpose(r)).Scan(&out.ID, &out.Mime, &out.Size, &fn, &vo)
		out.Filename, out.ViewOnce = fn, vo
		return e
	})
	if err != nil {
		os.Remove(absPath)
		httpx.Err(w, 500, "Upload failed")
		return
	}
	httpx.JSON(w, 200, out)
}

// ── POST /uploads/presign ──────────────────────────────────────────────

func uploadsPresign(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if !storage.Enabled() {
		httpx.Err(w, 503, "Object storage not configured")
		return
	}
	var b struct {
		Filename any `json:"filename"`
		Mime     any `json:"mime"`
		Size     any `json:"size"`
		ViewOnce any `json:"viewOnce"`
		// What this object is FOR — see upPurposeStr. Absent ⇒ "unknown",
		// which the cleanup never touches.
		Purpose string `json:"purpose"`
	}
	_ = httpx.Body(r, &b)
	filename := fmt.Sprintf("%v", orEmpty(b.Filename))
	if filename == "" {
		filename = "file"
	}
	filename = truncRunes(filename, 255)
	mime := fmt.Sprintf("%v", orEmpty(b.Mime))
	if mime == "" {
		mime = "application/octet-stream"
	}
	mime = truncRunes(mime, 100)
	size := upJSInt(b.Size)
	if size > upMaxBytes() {
		httpx.Err(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("File too large (max %d bytes)", upMaxBytes()))
		return
	}

	id := upUUID()
	key := "att/" + id + upSafeExt(filename)
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`INSERT INTO attachments
			   (id, owner_user_id, filename, mime_type, size_bytes, storage_path, view_once, storage_backend, purpose)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, 's3', $8)`,
			id, user.ID, filename, mime, size, key, upViewOnce(b.ViewOnce), upPurposeStr(b.Purpose))
		return e
	})
	if err != nil {
		httpx.Err(w, 500, "Presign failed")
		return
	}
	uploadURL, err := storage.PresignPut(ctx, key, mime, 900*time.Second)
	if err != nil {
		httpx.Err(w, 500, "Presign failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"id": id, "uploadUrl": uploadURL, "key": key})
}

// ── Resumable multipart ────────────────────────────────────────────────

type upAttachment struct {
	ID          string
	OwnerUserID string
	Filename    *string
	MimeType    string
	SizeBytes   int
	StoragePath string
}

// upOwnedAttachment mirrors ownedAttachment: loads + owner-asserts, writing
// the error response itself; nil means the response was already sent.
// errMsg = the calling route's catch-all 500 message (Node's try/catch scope).
func upOwnedAttachment(ctx context.Context, w http.ResponseWriter, userID string, id any, errMsg string) *upAttachment {
	att := &upAttachment{}
	err := db.WithUser(ctx, userID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT id, owner_user_id, filename, mime_type, size_bytes, storage_path
			   FROM attachments WHERE id = $1 LIMIT 1`, fmt.Sprintf("%v", orEmpty(id))).
			Scan(&att.ID, &att.OwnerUserID, &att.Filename, &att.MimeType, &att.SizeBytes, &att.StoragePath)
	})
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "Not found")
		} else {
			httpx.Err(w, 500, errMsg)
		}
		return nil
	}
	if att.OwnerUserID != userID {
		httpx.Err(w, 403, "Forbidden")
		return nil
	}
	return att
}

func uploadsMPInit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if !storage.Enabled() {
		httpx.Err(w, 503, "Object storage not configured")
		return
	}
	var b struct {
		Filename any `json:"filename"`
		Mime     any `json:"mime"`
		Size     any `json:"size"`
		ViewOnce any `json:"viewOnce"`
		// What this object is FOR — see upPurposeStr. Absent ⇒ "unknown",
		// which the cleanup never touches.
		Purpose string `json:"purpose"`
	}
	_ = httpx.Body(r, &b)
	filename := fmt.Sprintf("%v", orEmpty(b.Filename))
	if filename == "" {
		filename = "file"
	}
	filename = truncRunes(filename, 255)
	mime := fmt.Sprintf("%v", orEmpty(b.Mime))
	if mime == "" {
		mime = "application/octet-stream"
	}
	mime = truncRunes(mime, 100)
	size := upJSInt(b.Size)
	if size <= 0 {
		httpx.Err(w, 400, "size required")
		return
	}
	if size > upMultipartMaxBytes() {
		httpx.Err(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("File too large (max %d bytes)", upMultipartMaxBytes()))
		return
	}

	id := upUUID()
	key := "att/" + id + upSafeExt(filename)
	uploadID, err := storage.CreateMultipart(ctx, key, mime)
	if err != nil || uploadID == "" {
		httpx.Err(w, 500, "Could not start upload")
		return
	}
	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`INSERT INTO attachments
			   (id, owner_user_id, filename, mime_type, size_bytes, storage_path, view_once, storage_backend, purpose)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, 's3', $8)`,
			id, user.ID, filename, mime, size, key, upViewOnce(b.ViewOnce), upPurposeStr(b.Purpose))
		return e
	})
	if err != nil {
		httpx.Err(w, 500, "Init failed")
		return
	}
	partCount := (size + upPartSize - 1) / upPartSize
	httpx.JSON(w, 200, map[string]any{
		"id": id, "uploadId": uploadID, "key": key,
		"partSize": upPartSize, "partCount": partCount,
	})
}

func uploadsMPPartURLs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		ID          any   `json:"id"`
		UploadID    any   `json:"uploadId"`
		PartNumbers []any `json:"partNumbers"`
	}
	_ = httpx.Body(r, &b)
	att := upOwnedAttachment(ctx, w, user.ID, b.ID, "Presign failed")
	if att == nil {
		return
	}
	uploadID := fmt.Sprintf("%v", orEmpty(b.UploadID))
	if uploadID == "" {
		httpx.Err(w, 400, "uploadId required")
		return
	}
	if len(b.PartNumbers) == 0 || len(b.PartNumbers) > 1000 {
		httpx.Err(w, 400, "partNumbers: 1..1000")
		return
	}
	urls := map[string]string{}
	for _, raw := range b.PartNumbers {
		n := int(upJSInt(raw))
		if n < 1 || n > 10000 { // S3 part-number range
			continue
		}
		u, err := storage.PresignUploadPart(ctx, att.StoragePath, uploadID, n, 900*time.Second)
		if err != nil {
			httpx.Err(w, 500, "Presign failed")
			return
		}
		urls[fmt.Sprintf("%d", n)] = u
	}
	httpx.JSON(w, 200, map[string]any{"urls": urls})
}

func uploadsMPParts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	att := upOwnedAttachment(ctx, w, user.ID, r.PathValue("id"), "List failed")
	if att == nil {
		return
	}
	uploadID := r.URL.Query().Get("uploadId")
	if uploadID == "" {
		httpx.Err(w, 400, "uploadId required")
		return
	}
	parts, err := storage.ListParts(ctx, att.StoragePath, uploadID)
	if err != nil {
		httpx.Err(w, 500, "List failed")
		return
	}
	uploaded := []int{}
	for _, p := range parts {
		uploaded = append(uploaded, p.PartNumber)
	}
	httpx.JSON(w, 200, map[string]any{"uploaded": uploaded, "partSize": upPartSize})
}

func uploadsMPComplete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		ID       any `json:"id"`
		UploadID any `json:"uploadId"`
	}
	_ = httpx.Body(r, &b)
	att := upOwnedAttachment(ctx, w, user.ID, b.ID, "Complete failed")
	if att == nil {
		return
	}
	uploadID := fmt.Sprintf("%v", orEmpty(b.UploadID))
	if uploadID == "" {
		httpx.Err(w, 400, "uploadId required")
		return
	}
	parts, err := storage.ListParts(ctx, att.StoragePath, uploadID)
	if err != nil {
		httpx.Err(w, 500, "Complete failed")
		return
	}
	if len(parts) == 0 {
		httpx.Err(w, 400, "No parts uploaded")
		return
	}
	if err := storage.CompleteMultipart(ctx, att.StoragePath, uploadID, parts); err != nil {
		httpx.Err(w, 500, "Complete failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"id": att.ID, "mime": att.MimeType, "size": att.SizeBytes, "filename": att.Filename,
	})
}

func uploadsMPAbort(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		ID       any `json:"id"`
		UploadID any `json:"uploadId"`
	}
	_ = httpx.Body(r, &b)
	att := upOwnedAttachment(ctx, w, user.ID, b.ID, "Abort failed")
	if att == nil {
		return
	}
	if uploadID := fmt.Sprintf("%v", orEmpty(b.UploadID)); uploadID != "" {
		storage.AbortMultipart(ctx, att.StoragePath, uploadID)
	}
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `DELETE FROM attachments WHERE id = $1`, att.ID)
		return e
	})
	if err != nil {
		httpx.Err(w, 500, "Abort failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── GET /uploads/{id} ──────────────────────────────────────────────────

func uploadsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id := r.PathValue("id")

	var att struct {
		ID             string
		OwnerUserID    string
		Filename       string
		MimeType       *string
		SizeBytes      int64
		StoragePath    string
		ViewOnce       bool
		ViewedAt       *time.Time
		RevokedAt      *time.Time
		StorageBackend *string
	}
	found := true
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx,
			`SELECT id, owner_user_id, filename, mime_type, size_bytes, storage_path,
			        view_once, viewed_at, revoked_at, storage_backend
			 FROM attachments WHERE id = $1 LIMIT 1`, id).
			Scan(&att.ID, &att.OwnerUserID, &att.Filename, &att.MimeType, &att.SizeBytes,
				&att.StoragePath, &att.ViewOnce, &att.ViewedAt, &att.RevokedAt, &att.StorageBackend)
		if e != nil && db.NoRows(e) {
			found = false
			return nil
		}
		return e
	})
	if err != nil {
		httpx.Err(w, 500, "Download failed") // invalid uuid text etc. — Node's catch-all
		return
	}
	if !found {
		httpx.Err(w, 404, "Not found")
		return
	}

	// Revoke gate FIRST (mirrors Node): ahead of membership/view-once work so a
	// revoked attachment never touches storage, and the 410 is the wipe signal —
	// the client destroys its local key + plaintext when it sees revoked:true.
	if att.RevokedAt != nil {
		httpx.JSON(w, 410, map[string]any{"error": "This media was revoked by the sender.", "revoked": true})
		return
	}

	if att.OwnerUserID != user.ID {
		inChat := false
		err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
			var one int
			e := tx.QueryRow(ctx,
				`SELECT 1
				 FROM messages m
				 JOIN chat_members cm ON cm.chat_id = m.chat_id
				 WHERE cm.user_id = $2
				   AND cm.left_at IS NULL
				   AND m.meta->>'attachmentId' = $1
				 LIMIT 1`, att.ID, user.ID).Scan(&one)
			if e != nil && db.NoRows(e) {
				return nil
			}
			inChat = e == nil
			return e
		})
		if err != nil {
			httpx.Err(w, 500, "Download failed")
			return
		}
		if !inChat {
			asPhoto := false
			err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
				var one int
				e := tx.QueryRow(ctx,
					`SELECT 1 FROM users WHERE photo_url = $1 LIMIT 1`, att.ID).Scan(&one)
				if e != nil && db.NoRows(e) {
					return nil
				}
				asPhoto = e == nil
				return e
			})
			if err != nil {
				httpx.Err(w, 500, "Download failed")
				return
			}
			if !asPhoto {
				// Story media: viewable when the attachment backs an UNEXPIRED
				// story whose author shares an active chat with the caller and
				// neither has blocked the other — the exact visibility rule of
				// GET /stories/feed. Without this clause every OTHER user's
				// status media 403'd (latent gap inherited from Node uploads.js:
				// stories reference attachments directly, not via messages.meta).
				// Plain pool like storiesFeed (stories has no RLS policy).
				var one int
				e := db.SysPool.QueryRow(ctx,
					`SELECT 1 FROM stories s
					  WHERE s.attachment_id = $1
					    AND s.expires_at > NOW()
					    AND EXISTS (
					      SELECT 1 FROM chat_members cm_me
					       JOIN chat_members cm_them ON cm_them.chat_id = cm_me.chat_id
					       WHERE cm_me.user_id   = $2 AND cm_me.left_at   IS NULL
					         AND cm_them.user_id = s.user_id AND cm_them.left_at IS NULL
					    )
					    AND NOT EXISTS (
					      SELECT 1 FROM user_blocks ub
					       WHERE (ub.blocker_id = s.user_id AND ub.blocked_id = $2)
					          OR (ub.blocker_id = $2        AND ub.blocked_id = s.user_id)
					    )
					  LIMIT 1`, att.ID, user.ID).Scan(&one)
				if e != nil && !db.NoRows(e) {
					httpx.Err(w, 500, "Download failed")
					return
				}
				if e != nil { // no visible story either → not authorized
					httpx.Err(w, 403, "Forbidden")
					return
				}
			}
		}

		if inChat {
			// Record delivery for the retention sweeper (best-effort, like Node).
			_ = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
				_, e := tx.Exec(ctx,
					`INSERT INTO attachment_deliveries (attachment_id, user_id) VALUES ($1, $2)
					 ON CONFLICT DO NOTHING`, att.ID, user.ID)
				return e
			})
		}

		if att.ViewOnce && att.ViewedAt != nil {
			httpx.Err(w, http.StatusGone, "This media has already been viewed and is no longer available.")
			return
		}
	}

	// Encrypted avatar: stream-decrypt when this attachment backs a profile
	// photo with a wrapped key; fall through on any failure (never a broken image).
	var photoKeyCipher *string
	_ = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx,
			`SELECT photo_key_cipher FROM users WHERE photo_url = $1 AND photo_key_cipher IS NOT NULL LIMIT 1`,
			att.ID).Scan(&photoKeyCipher)
		if e != nil && db.NoRows(e) {
			return nil
		}
		return e
	})
	if photoKeyCipher != nil && *photoKeyCipher != "" {
		if plain, err := upDecryptAvatar(ctx, att.StorageBackend, att.StoragePath, *photoKeyCipher); err == nil {
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "private, max-age=86400")
			w.WriteHeader(200)
			_, _ = w.Write(plain)
			return
		}
	}

	if att.StorageBackend != nil && *att.StorageBackend == "s3" {
		obj := storage.GetObjectStream(ctx, att.StoragePath)
		if obj == nil {
			httpx.Err(w, 404, "File missing in storage")
			return
		}
		defer obj.Body.Close()
		ct := obj.ContentType
		if att.MimeType != nil && *att.MimeType != "" {
			ct = *att.MimeType
		}
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		if obj.ContentLength >= 0 {
			w.Header().Set("Content-Length", fmt.Sprintf("%d", obj.ContentLength))
		}
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, url.PathEscape(att.Filename)))
		w.Header().Set("Cache-Control", "private, max-age=86400")
		w.WriteHeader(200)
		_, _ = io.Copy(w, obj.Body)
		return
	}

	absPath := filepath.Join(upDir(), filepath.FromSlash(att.StoragePath))
	base := upDir()
	if !strings.HasPrefix(absPath, base+string(filepath.Separator)) && absPath != base {
		httpx.Err(w, 500, "Storage path corrupt")
		return
	}
	f, err := os.Open(absPath)
	if err != nil {
		httpx.Err(w, 404, "File missing on disk")
		return
	}
	defer f.Close()
	mt := "application/octet-stream"
	if att.MimeType != nil {
		mt = *att.MimeType
	}
	w.Header().Set("Content-Type", mt)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", att.SizeBytes))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, url.PathEscape(att.Filename)))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.WriteHeader(200)
	_, _ = io.Copy(w, f)
}

func upDecryptAvatar(ctx context.Context, backend *string, storagePath, keyCipher string) ([]byte, error) {
	var cipherBytes []byte
	var err error
	if backend != nil && *backend == "s3" {
		cipherBytes, err = storage.GetObject(ctx, storagePath)
	} else {
		cipherBytes, err = os.ReadFile(filepath.Join(upDir(), filepath.FromSlash(storagePath)))
	}
	if err != nil {
		return nil, err
	}
	dekHex, err := vault.Decrypt(keyCipher)
	if err != nil {
		return nil, err
	}
	return vault.DecryptWithKey(cipherBytes, dekHex)
}

// ── POST /uploads/{id}/viewed ──────────────────────────────────────────

func uploadsViewed(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id := r.PathValue("id")

	var ownerID string
	var viewOnce bool
	var viewedAt *time.Time
	found := true
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx,
			`SELECT owner_user_id, view_once, viewed_at FROM attachments WHERE id = $1 LIMIT 1`,
			id).Scan(&ownerID, &viewOnce, &viewedAt)
		if e != nil && db.NoRows(e) {
			found = false
			return nil
		}
		return e
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to mark viewed")
		return
	}
	if !found {
		httpx.Err(w, 404, "Not found")
		return
	}
	if !viewOnce {
		httpx.JSON(w, 200, map[string]any{"ok": true, "noop": true})
		return
	}
	if ownerID == user.ID {
		httpx.JSON(w, 200, map[string]any{"ok": true, "noop": true})
		return
	}
	if viewedAt != nil {
		httpx.JSON(w, 200, map[string]any{"ok": true, "alreadyViewed": true})
		return
	}
	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`UPDATE attachments SET viewed_at = NOW()
			  WHERE id = $1 AND view_once = TRUE AND viewed_at IS NULL`, id)
		return e
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to mark viewed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── POST /uploads/{id}/revoke ← Node routes/uploads.js ─────────────────
// VaultView remote revoke. OWNER ONLY. One-way and irreversible:
//  1. stamp revoked_at            → every later GET 410s, including the owner's
//  2. delete the stored bytes     → the server no longer holds a copy at all
//  3. broadcast 'media_revoked'   → online recipients destroy their per-file
//     media key and any decrypted plaintext
//
// Offline recipients converge without the socket event: their next fetch 410s
// and the client wipes on that signal. Deliberately NOT gated on view_once.
func uploadsRevoke(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id := r.PathValue("id")

	var ownerID, storagePath string
	var backend *string
	var revokedAt *time.Time
	found := true
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx,
			`SELECT owner_user_id, storage_path, storage_backend, revoked_at
			   FROM attachments WHERE id = $1 LIMIT 1`, id).
			Scan(&ownerID, &storagePath, &backend, &revokedAt)
		if e != nil && db.NoRows(e) {
			found = false
			return nil
		}
		return e
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to revoke media")
		return
	}
	if !found {
		httpx.Err(w, 404, "Not found")
		return
	}
	if ownerID != user.ID {
		httpx.Err(w, 403, "Only the sender can revoke this media")
		return
	}
	if revokedAt != nil {
		httpx.JSON(w, 200, map[string]any{"ok": true, "alreadyRevoked": true})
		return
	}

	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE attachments SET revoked_at = NOW() WHERE id = $1`, id)
		return e
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to revoke media")
		return
	}

	// Destroy the bytes. Best-effort per backend — the revoked_at stamp above is
	// the authoritative gate, so a storage hiccup can't leave the media reachable.
	if backend != nil && *backend == "s3" {
		storage.DeleteObject(ctx, storagePath)
	} else {
		abs := filepath.Join(upDir(), storagePath)
		if strings.HasPrefix(abs, upDir()+string(filepath.Separator)) {
			_ = os.Remove(abs)
		}
	}

	// Tell every chat that references this attachment, so recipients wipe now
	// rather than at next fetch.
	type ref struct{ chatID, messageID string }
	refs := []ref{}
	_ = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT DISTINCT m.chat_id, m.id FROM messages m
			  WHERE m.meta->>'attachmentId' = $1`, id)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var rf ref
			if rows.Scan(&rf.chatID, &rf.messageID) == nil {
				refs = append(refs, rf)
			}
		}
		return rows.Err()
	})
	now := time.Now().UTC().Format(time.RFC3339)
	for _, rf := range refs {
		emitx.ChatEvent(rf.chatID, "media_revoked", map[string]any{
			"chatId": rf.chatID, "messageId": rf.messageID, "attachmentId": id,
			"revokedBy": user.ID, "revokedAt": now,
		})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "chats": len(refs)})
}
