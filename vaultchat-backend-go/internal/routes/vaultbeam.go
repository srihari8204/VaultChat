// vaultbeam.go ← routes/vaultbeam.js — VaultBeam Tier-3 (Cloudflare R2) relay
// control plane. Same endpoints/statuses/error strings/shapes; recipient rings
// (vb_invite / vb_ready / vb_complete / vb_abort) bridge via emitx.ToUids.
//
// Storage: Node uses @aws-sdk/client-s3; here the three ops this route needs
// (presign PUT/GET, HEAD-verify, prefix purge) are implemented with stdlib
// SigV4 against the same S3_* env (path-style, UNSIGNED-PAYLOAD presigns with
// host-only signed headers — strictly more permissive than the SDK's
// content-type-signed URLs, so every Node-era client request still validates).
//
// VaultbeamSweepExpired replaces server.js's hourly
// setInterval(vaultbeamRouter.sweepExpired) — schedule it from the orchestrator.
package routes

import (
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

// Canonical sizing (client MUST use the same constants).
const (
	vbChunkBytes = 512 * 1024
	vbBlockBytes = 4 * 1024 * 1024
	vbMaxBytes   = float64(12) * 1024 * 1024 * 1024 // 12 GiB hard cap (v1 scope)
	vbPutTTL     = 900                              // 15 min presigned PUT
	vbGetTTL     = 3600                             // 1 h presigned GET
	vbMaxURLs    = 64                               // presigned URLs per batch call
	vbMinBlk     = 256 * 1024                       // smallest block size we'd ever use
)

var vbTransferIDRe = regexp.MustCompile(`^[A-Za-z0-9]{16,64}$`)

func vbRelayKey(transferID string, blockIndex int) string {
	return fmt.Sprintf("vault_relay/%s/%d", transferID, blockIndex)
}

func vbCeilDiv(a, b float64) int { return int(math.Ceil(a / b)) }

// vbNum mirrors JS Number(x) over JSON-decoded values; ok=false ⇒ NaN.
// (JSON null → NaN here, where JS Number(null)=0 — a garbage-input edge only.)
func vbNum(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0, true
		}
		n, err := strconv.ParseFloat(s, 64)
		return n, err == nil && !math.IsNaN(n)
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func vbIsInt(f float64, ok bool) bool {
	return ok && !math.IsInf(f, 0) && f == math.Trunc(f)
}

// ── BYTEA bitmask helpers (uploaded relay blocks) ───────────────────

func vbTestBit(buf []byte, i int) bool {
	if i < 0 || i>>3 >= len(buf) {
		return false
	}
	return (buf[i>>3]>>(i&7))&1 == 1
}

func vbSetBit(buf []byte, i int) {
	if i >= 0 && i>>3 < len(buf) {
		buf[i>>3] |= 1 << (i & 7)
	}
}

func vbMaskWidth(n int) int { return (n + 7) / 8 }

// vbUnionMask ORs `incoming` into `stored`, widened to hold chunkCount bits with
// any bits past the end masked off. UNION-ONLY by construction: a stale,
// duplicated or out-of-order post can never clear a bit, so convergence is
// monotone and ordering does not matter.
func vbUnionMask(stored, incoming []byte, chunkCount int) []byte {
	w := vbMaskWidth(chunkCount)
	out := make([]byte, w)
	copy(out, stored)
	for i := 0; i < w && i < len(incoming); i++ {
		out[i] |= incoming[i]
	}
	if rem := chunkCount % 8; rem != 0 && w > 0 {
		out[w-1] &= byte(1<<uint(rem)) - 1
	}
	return out
}

// vbStaleVersion reports whether a client-supplied session version disagrees
// with the stored one. An ABSENT version is not a mismatch: pre-vbm3 clients do
// not send it, and they also predate the canonical wire, so they are handled by
// the dual-read window rather than rejected here.
func vbStaleVersion(raw any, stored int) bool {
	f, ok := vbNum(raw)
	if !vbIsInt(f, ok) {
		return false
	}
	return int(f) != stored
}

func vbCountSet(buf []byte, n int) int {
	c := 0
	for i := 0; i < n; i++ {
		if vbTestBit(buf, i) {
			c++
		}
	}
	return c
}

// ── Transfer row + load/authorize ───────────────────────────────────

type vbTransfer struct {
	TransferID   string
	SenderID     string
	RecipientID  string
	ChatID       *string
	TotalBytes   int64
	BlockCount   int
	ChunkCount   int
	UploadedMask []byte
	State        string
	ExpiresAt    time.Time
	Plan         *string
	RecvMask     []byte
	Version      int
}

// vbLoadTransfer mirrors loadTransfer: authStatus 404 (missing) / 403 (not a
// party) / 0 (ok); dbErr ⇒ the route's fixed 500.
func vbLoadTransfer(ctx context.Context, transferID, userID string) (*vbTransfer, int, error) {
	t := &vbTransfer{}
	err := db.Pool.QueryRow(ctx,
		`SELECT transfer_id, sender_id, recipient_id, chat_id, total_bytes, block_count,
		        chunk_count, uploaded_mask, state, expires_at, plan,
		        COALESCE(recv_mask, ''::bytea), session_version
		   FROM vb_transfer WHERE transfer_id = $1`, transferID).
		Scan(&t.TransferID, &t.SenderID, &t.RecipientID, &t.ChatID, &t.TotalBytes,
			&t.BlockCount, &t.ChunkCount, &t.UploadedMask, &t.State, &t.ExpiresAt, &t.Plan,
			&t.RecvMask, &t.Version)
	if err != nil {
		if db.NoRows(err) {
			return nil, 404, nil
		}
		return nil, 0, err
	}
	if t.SenderID != userID && t.RecipientID != userID {
		return nil, 403, nil
	}
	return t, 0, nil
}

func vbAuthErr(w http.ResponseWriter, status int) {
	if status == 404 {
		httpx.Err(w, 404, "not found")
	} else {
		httpx.Err(w, 403, "forbidden")
	}
}

// ── S3/R2 via stdlib SigV4 (lib/storage.js ops this route uses) ─────

func vbStoreEnabled() bool {
	return vbServerEndpoint() != "" && vbAccessKey() != ""
}

// VAULTBEAM STORAGE IS ADDRESSABLE SEPARATELY FROM EVERYTHING ELSE.
//
// S3_BUCKET is read by three unrelated subsystems — user media (user.go),
// general storage (storage/storage.go) and this one. Repointing S3_BUCKET to
// move transfers would silently move ATTACHMENTS AND ALL OTHER MEDIA with
// them, to a bucket that does not contain them. The VAULTBEAM_* overrides
// below give transfers their own backend without touching the others, exactly
// as BROADCAST_BUCKET already does for HLS segments (storage.go:84).
//
// Every one falls back to the shared S3_* value, so with no VAULTBEAM_* set
// the behaviour is byte-identical to before this existed.
func vbEnv(vbKey, sharedKey, def string) string {
	if v := os.Getenv(vbKey); v != "" {
		return v
	}
	if v := os.Getenv(sharedKey); v != "" {
		return v
	}
	return def
}

func vbBucket() string    { return vbEnv("VAULTBEAM_S3_BUCKET", "S3_BUCKET", "vaultchat-media") }
func vbAccessKey() string { return vbEnv("VAULTBEAM_S3_ACCESS_KEY", "S3_ACCESS_KEY", "") }
func vbSecretKey() string { return vbEnv("VAULTBEAM_S3_SECRET_KEY", "S3_SECRET_KEY", "") }

func vbRegion() string { return vbEnv("VAULTBEAM_S3_REGION", "S3_REGION", "auto") }

// Presigned URLs encode the PUBLIC endpoint (what clients hit); server-side
// ops (HEAD/list/delete) use the INTERNAL endpoint — same split as storage.js.
func vbSignEndpoint() string {
	if e := vbPublicRaw(); e != "" {
		return e
	}
	return vbEnv("VAULTBEAM_S3_ENDPOINT", "S3_ENDPOINT", "")
}

// Split out so vbServerEndpoint can fall back to the public value without the
// two helpers calling each other in a loop.
func vbPublicRaw() string {
	return vbEnv("VAULTBEAM_S3_PUBLIC_ENDPOINT", "S3_PUBLIC_ENDPOINT", "")
}

func vbServerEndpoint() string {
	if e := vbEnv("VAULTBEAM_S3_ENDPOINT", "S3_ENDPOINT", ""); e != "" {
		return e
	}
	return vbPublicRaw()
}

// vbURIEscape is AWS SigV4 URI escaping (RFC 3986 unreserved; uppercase hex).
func vbURIEscape(s string, encodeSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '.' || c == '_' || c == '~' || (c == '/' && !encodeSlash) {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func vbHMAC(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

func vbSHA256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func vbSigningKey(secret, dateStamp, region string) []byte {
	k := vbHMAC([]byte("AWS4"+secret), []byte(dateStamp))
	k = vbHMAC(k, []byte(region))
	k = vbHMAC(k, []byte("s3"))
	return vbHMAC(k, []byte("aws4_request"))
}

func vbCanonicalQuery(params [][2]string) string {
	pairs := make([]string, 0, len(params))
	for _, p := range params {
		pairs = append(pairs, vbURIEscape(p[0], true)+"="+vbURIEscape(p[1], true))
	}
	sort.Strings(pairs)
	return strings.Join(pairs, "&")
}

func vbObjectPath(endpointPath, key string) string {
	p := strings.TrimSuffix(endpointPath, "/") + "/" + vbBucket()
	if key != "" {
		p += "/" + key
	}
	return p
}

// vbPresign builds a SigV4 query-presigned URL (path-style, UNSIGNED-PAYLOAD,
// host-only signed headers). "" when storage is disabled/misconfigured.
func vbPresign(method, key string, ttlSec int) string {
	if !vbStoreEnabled() {
		return ""
	}
	u, err := url.Parse(vbSignEndpoint())
	if err != nil || u.Host == "" {
		return ""
	}
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	region := vbRegion()
	scope := dateStamp + "/" + region + "/s3/aws4_request"
	canonPath := vbURIEscape(vbObjectPath(u.Path, key), false)
	q := vbCanonicalQuery([][2]string{
		{"X-Amz-Algorithm", "AWS4-HMAC-SHA256"},
		{"X-Amz-Credential", vbAccessKey() + "/" + scope},
		{"X-Amz-Date", amzDate},
		{"X-Amz-Expires", strconv.Itoa(ttlSec)},
		{"X-Amz-SignedHeaders", "host"},
	})
	canonReq := method + "\n" + canonPath + "\n" + q +
		"\nhost:" + u.Host + "\n\nhost\nUNSIGNED-PAYLOAD"
	sts := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + vbSHA256Hex([]byte(canonReq))
	sig := hex.EncodeToString(vbHMAC(vbSigningKey(vbSecretKey(), dateStamp, region), []byte(sts)))
	return u.Scheme + "://" + u.Host + canonPath + "?" + q + "&X-Amz-Signature=" + sig
}

var vbHTTPClient = &http.Client{Timeout: 30 * time.Second}

// vbS3Request performs a header-signed SigV4 request against the internal
// endpoint. key "" = bucket-level op. contentMD5 is required by DeleteObjects.
func vbS3Request(ctx context.Context, method, key string, query [][2]string, body []byte, contentMD5 string) (*http.Response, error) {
	u, err := url.Parse(vbServerEndpoint())
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("bad S3 endpoint")
	}
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	region := vbRegion()
	scope := dateStamp + "/" + region + "/s3/aws4_request"
	payloadHash := vbSHA256Hex(body)
	canonPath := vbURIEscape(vbObjectPath(u.Path, key), false)
	canonQuery := vbCanonicalQuery(query)

	hdrs := [][2]string{
		{"host", u.Host},
		{"x-amz-content-sha256", payloadHash},
		{"x-amz-date", amzDate},
	}
	if contentMD5 != "" {
		hdrs = append(hdrs, [2]string{"content-md5", contentMD5})
	}
	sort.Slice(hdrs, func(i, j int) bool { return hdrs[i][0] < hdrs[j][0] })
	canonHeaders := ""
	names := make([]string, 0, len(hdrs))
	for _, h := range hdrs {
		canonHeaders += h[0] + ":" + h[1] + "\n"
		names = append(names, h[0])
	}
	signedHeaders := strings.Join(names, ";")

	canonReq := method + "\n" + canonPath + "\n" + canonQuery + "\n" +
		canonHeaders + "\n" + signedHeaders + "\n" + payloadHash
	sts := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + vbSHA256Hex([]byte(canonReq))
	sig := hex.EncodeToString(vbHMAC(vbSigningKey(vbSecretKey(), dateStamp, region), []byte(sts)))

	full := u.Scheme + "://" + u.Host + canonPath
	if canonQuery != "" {
		full += "?" + canonQuery
	}
	req, err := http.NewRequestWithContext(ctx, method, full, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	req.Header.Set("X-Amz-Date", amzDate)
	if contentMD5 != "" {
		req.Header.Set("Content-MD5", contentMD5)
	}
	req.Header.Set("Authorization",
		"AWS4-HMAC-SHA256 Credential="+vbAccessKey()+"/"+scope+
			", SignedHeaders="+signedHeaders+", Signature="+sig)
	return vbHTTPClient.Do(req)
}

// vbObjectExists — storage.js objectExists (HEAD; any failure = false).
func vbObjectExists(ctx context.Context, key string) bool {
	if !vbStoreEnabled() {
		return false
	}
	resp, err := vbS3Request(ctx, "HEAD", key, nil, nil, "")
	if err != nil {
		return false
	}
	io.Copy(io.Discard, resp.Body) //nolint:errcheck
	resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

type vbListResult struct {
	IsTruncated bool   `xml:"IsTruncated"`
	NextToken   string `xml:"NextContinuationToken"`
	Contents    []struct {
		Key string `xml:"Key"`
	} `xml:"Contents"`
}

type vbDeleteObj struct {
	Key string `xml:"Key"`
}

type vbDeleteReq struct {
	XMLName xml.Name      `xml:"Delete"`
	Quiet   bool          `xml:"Quiet"`
	Objects []vbDeleteObj `xml:"Object"`
}

// vbDeletePrefix — best-effort wrapper, unchanged for every existing caller.
func vbDeletePrefix(ctx context.Context, prefix string) {
	_, _ = vbDeletePrefixCount(ctx, prefix)
}

// vbDeletePrefixCount — storage.js deletePrefix: list + batch DeleteObjects
// (each ListObjectsV2 page ≤ 1000 keys, matching the S3 DeleteObjects cap).
//
// RETURNS AN ERROR, and that is the point.
//
// The reaper must not drop a vb_transfer row until the objects it names are
// actually gone: transfer_id is the ONLY handle that maps a transfer to its
// `vault_relay/<id>/` prefix, so deleting the row first turns a transient R2
// failure into an object that nothing can ever enumerate again. The row is the
// work queue; it may only be discarded once the queue item is done.
//
// Returns the number of objects deleted, and a non-nil error if ANY page failed
// — a partially-deleted prefix counts as failure so it is retried.
func vbDeletePrefixCount(ctx context.Context, prefix string) (int, error) {
	if !vbStoreEnabled() {
		return 0, fmt.Errorf("relay storage not configured")
	}
	deleted := 0
	token := ""
	for {
		q := [][2]string{{"list-type", "2"}, {"prefix", prefix}}
		if token != "" {
			q = append(q, [2]string{"continuation-token", token})
		}
		resp, err := vbS3Request(ctx, "GET", "", q, nil, "")
		if err != nil {
			return deleted, err
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			return deleted, fmt.Errorf("list %d", resp.StatusCode)
		}
		var list vbListResult
		if err := xml.Unmarshal(data, &list); err != nil {
			return deleted, err
		}
		if len(list.Contents) > 0 {
			del := vbDeleteReq{Quiet: true}
			for _, c := range list.Contents {
				del.Objects = append(del.Objects, vbDeleteObj{Key: c.Key})
			}
			body, _ := xml.Marshal(del)
			sum := md5.Sum(body)
			dresp, err := vbS3Request(ctx, "POST", "", [][2]string{{"delete", ""}},
				body, base64.StdEncoding.EncodeToString(sum[:]))
			if err != nil {
				return deleted, err
			}
			io.Copy(io.Discard, dresp.Body) //nolint:errcheck
			dresp.Body.Close()
			if dresp.StatusCode != 200 {
				return deleted, fmt.Errorf("delete %d", dresp.StatusCode)
			}
			deleted += len(del.Objects)
		}
		if !list.IsTruncated || list.NextToken == "" {
			return deleted, nil
		}
		token = list.NextToken
	}
}

// ── Routes ──────────────────────────────────────────────────────────

func RegisterVaultbeam(mux *http.ServeMux) {
	mux.HandleFunc("POST /vaultbeam/relay/init", httpx.RequireAuth(vbRelayInit))
	mux.HandleFunc("POST /vaultbeam/relay/block-url", httpx.RequireAuth(vbRelayBlockURL))
	mux.HandleFunc("POST /vaultbeam/relay/uploaded", httpx.RequireAuth(vbRelayUploaded))
	mux.HandleFunc("POST /vaultbeam/relay/grow", httpx.RequireAuth(vbRelayGrow))
	mux.HandleFunc("POST /vaultbeam/relay/received", httpx.RequireAuth(vbRelayReceived))
	mux.HandleFunc("GET /vaultbeam/relay/{transferId}", httpx.RequireAuth(vbRelayState))
	mux.HandleFunc("POST /vaultbeam/relay/complete", httpx.RequireAuth(vbRelayComplete))
	mux.HandleFunc("POST /vaultbeam/relay/abort", httpx.RequireAuth(vbRelayAbort))
}

// POST /vaultbeam/relay/init — sender opens a relay transfer.
func vbRelayInit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	if !vbStoreEnabled() {
		httpx.Err(w, 503, "relay storage unavailable")
		return
	}
	rl := redisx.Consume(ctx, "vbinit:"+user.ID, 20, 60)
	if !rl.Allowed {
		httpx.Err(w, 429, "Too many transfers", map[string]any{"retryAfter": rl.ResetInSec})
		return
	}

	var b struct {
		TransferID  any `json:"transferId"`
		RecipientID any `json:"recipientId"`
		TotalBytes  any `json:"totalBytes"`
		ChatID      any `json:"chatId"`
		BlockCount  any `json:"blockCount"`
		Plan        any `json:"plan"`
	}
	_ = httpx.Body(r, &b)
	transferID := strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b.TransferID)))
	recipientID := strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b.RecipientID)))
	totalBytes, tbOK := vbNum(b.TotalBytes)
	var chatID *string
	if s, ok := b.ChatID.(string); ok && s != "" {
		chatID = &s
	}

	if !vbTransferIDRe.MatchString(transferID) {
		httpx.Err(w, 400, "invalid transferId")
		return
	}
	if recipientID == "" {
		httpx.Err(w, 400, "recipientId required")
		return
	}
	if recipientID == user.ID {
		httpx.Err(w, 400, "cannot send to self")
		return
	}
	if !tbOK || math.IsInf(totalBytes, 0) || totalBytes <= 0 {
		httpx.Err(w, 400, "invalid totalBytes")
		return
	}
	if totalBytes > vbMaxBytes {
		httpx.Err(w, 413, "exceeds 12GB cap")
		return
	}

	// Recipient must exist and not have blocked the sender.
	var one int
	err := db.Pool.QueryRow(ctx,
		`SELECT 1 FROM users WHERE id = $1 AND is_deleted = FALSE
		   AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = $1 AND ub.blocked_id = $2)`,
		recipientID, user.ID).Scan(&one)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 403, "recipient unavailable")
		} else {
			httpx.Err(w, 500, "init failed") // invalid uuid etc. — Node 500s the same way
		}
		return
	}

	chunkCount := vbCeilDiv(totalBytes, vbChunkBytes)
	// Segmented geometry (R3/v2): client-chosen block count within the sanity
	// cap; omitted ⇒ legacy uniform count. See vaultbeam.js for the rationale.
	capBlocks := vbCeilDiv(totalBytes, vbMinBlk)
	blockCount := vbCeilDiv(totalBytes, vbBlockBytes)
	if cb, ok := vbNum(b.BlockCount); vbIsInt(cb, ok) && cb >= 0 && int(cb) <= capBlocks {
		blockCount = int(cb)
	}
	var plan *string
	if s, ok := b.Plan.(string); ok {
		p := truncRunes(s, 200000)
		plan = &p
	}
	mask := make([]byte, vbCeilDiv(float64(blockCount), 8)) // all-zero: nothing uploaded yet

	var tbParam any = totalBytes
	if totalBytes == math.Trunc(totalBytes) {
		tbParam = int64(totalBytes)
	}

	// Idempotent: re-init by the same sender resets an in-flight transfer of
	// the same id (client retry). ON CONFLICT keeps ownership stable.
	var retID string
	var expiresAt time.Time
	sessionVersion := 1
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO vb_transfer
		   (transfer_id, sender_id, recipient_id, chat_id, total_bytes, block_count, chunk_count, uploaded_mask, state, plan)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)
		 ON CONFLICT (transfer_id) DO UPDATE
		   SET total_bytes = EXCLUDED.total_bytes, block_count = EXCLUDED.block_count,
		       chunk_count = EXCLUDED.chunk_count, plan = EXCLUDED.plan
		   WHERE vb_transfer.sender_id = $2 AND vb_transfer.state IN ('pending','ready')
		 RETURNING transfer_id, expires_at`,
		transferID, user.ID, recipientID, chatID, tbParam, blockCount, chunkCount, mask, plan).
		Scan(&retID, &expiresAt)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 409, "transferId already used")
		} else {
			httpx.Err(w, 500, "init failed")
		}
		return
	}

	// Opaque doorbell — name/type arrive over E2EE, not here.
	emitx.ToUids([]string{recipientID}, "vb_invite", map[string]any{
		"transferId": transferID, "senderId": user.ID, "totalBytes": tbParam,
		"blockCount": blockCount, "chunkCount": chunkCount, "chatId": chatID,
		"sessionVersion": sessionVersion,
	})

	httpx.JSON(w, 200, map[string]any{
		"transferId": transferID, "blockCount": blockCount, "chunkCount": chunkCount,
		"chunkBytes": vbChunkBytes, "blockBytes": vbBlockBytes,
		"expiresAt": httpx.JSTime(expiresAt), "sessionVersion": sessionVersion,
	})
}

// POST /vaultbeam/relay/block-url — batch-presign relay-block URLs.
func vbRelayBlockURL(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		TransferID any   `json:"transferId"`
		Op         any   `json:"op"`
		Blocks     []any `json:"blocks"`
	}
	_ = httpx.Body(r, &b)
	op := "put"
	if s, _ := b.Op.(string); s == "get" {
		op = "get"
	}
	tid := fmt.Sprintf("%v", orEmpty(b.TransferID))
	if tid == "" || len(b.Blocks) == 0 {
		httpx.Err(w, 400, "transferId + blocks[] required")
		return
	}
	if len(b.Blocks) > vbMaxURLs {
		httpx.Err(w, 413, fmt.Sprintf("max %d blocks per call", vbMaxURLs))
		return
	}

	t, status, err := vbLoadTransfer(ctx, tid, user.ID)
	if err != nil {
		httpx.Err(w, 500, "presign failed")
		return
	}
	if status != 0 {
		vbAuthErr(w, status)
		return
	}
	if op == "put" && t.SenderID != user.ID {
		httpx.Err(w, 403, "sender only")
		return
	}
	if op == "get" && t.RecipientID != user.ID {
		httpx.Err(w, 403, "recipient only")
		return
	}
	if t.State == "complete" || t.State == "aborted" {
		httpx.Err(w, 410, "transfer "+t.State)
		return
	}
	// THE 24H DEADLINE ENDS ACCESS, NOT JUST STORAGE.
	//
	// vbLoadTransfer reads expires_at but never compares it, so until this gate
	// the only thing that ended access was the hourly sweep. Measured on prod
	// 2026-08-20: a transfer whose deadline had passed two hours earlier still
	// minted a working presigned GET and R2 still served the bytes.
	//
	// The retention promise is that a relay object is unreachable once its
	// transfer expires — a sweep that has not run yet is not a reason to hand
	// out a fresh key to it. Deliberately gated HERE and not in vbLoadTransfer:
	// relay/complete and relay/abort must stay callable on an expired transfer,
	// because abort is a cleanup path and blocking it would strand objects.
	if !t.ExpiresAt.IsZero() && !time.Now().Before(t.ExpiresAt) {
		httpx.Err(w, 410, "transfer expired")
		return
	}

	urls := []map[string]any{}
	for _, raw := range b.Blocks {
		f, ok := vbNum(raw)
		if !vbIsInt(f, ok) {
			continue
		}
		i := int(f)
		if i < 0 || i >= t.BlockCount {
			continue
		}
		if op == "get" && !vbTestBit(t.UploadedMask, i) {
			continue // not uploaded yet — skip
		}
		var u string
		if op == "put" {
			u = vbPresign("PUT", vbRelayKey(tid, i), vbClampTTL(vbPutTTL, t.ExpiresAt))
		} else {
			u = vbPresign("GET", vbRelayKey(tid, i), vbClampTTL(vbGetTTL, t.ExpiresAt))
		}
		if u != "" {
			urls = append(urls, map[string]any{"blockIndex": i, "url": u})
		}
	}
	ttl := vbClampTTL(vbPutTTL, t.ExpiresAt)
	if op == "get" {
		ttl = vbClampTTL(vbGetTTL, t.ExpiresAt)
	}
	httpx.JSON(w, 200, map[string]any{"op": op, "ttl": ttl, "urls": urls})
}

// vbClampTTL shortens a presigned URL's lifetime so it cannot outlive the
// transfer's absolute deadline.
//
// Without this the deadline gate above is only half a fix: a URL minted one
// second before expiry stays valid for its full hour, which is a working key to
// an object the policy says is finished. Clamping is the difference between "we
// stop issuing keys" and "no key works past the deadline".
//
// Only ever SHORTENS — it cannot extend a TTL, and it never touches expires_at.
// A floor of 1s keeps a signature valid-but-useless rather than malformed;
// callers past the deadline are already refused above.
func vbClampTTL(ttlSec int, deadline time.Time) int {
	if deadline.IsZero() {
		return ttlSec
	}
	left := int(time.Until(deadline).Seconds())
	if left < 1 {
		return 1
	}
	if left < ttlSec {
		return left
	}
	return ttlSec
}

// POST /vaultbeam/relay/uploaded — sender reports finished PUTs (HEAD-verified).
func vbRelayUploaded(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		TransferID     any   `json:"transferId"`
		Blocks         []any `json:"blocks"`
		SessionVersion any   `json:"sessionVersion"`
	}
	_ = httpx.Body(r, &b)
	tid := fmt.Sprintf("%v", orEmpty(b.TransferID))
	if tid == "" || len(b.Blocks) == 0 {
		httpx.Err(w, 400, "transferId + blocks[] required")
		return
	}

	t, status, err := vbLoadTransfer(ctx, tid, user.ID)
	if err != nil {
		httpx.Err(w, 500, "mark failed")
		return
	}
	if status != 0 {
		vbAuthErr(w, status)
		return
	}
	if t.SenderID != user.ID {
		httpx.Err(w, 403, "sender only")
		return
	}
	// A COMPLETED session is immutable. Without this a sender still in flight
	// could set bits on a transfer the recipient already finished — the gap that
	// let a lost completion notification turn into a re-upload.
	if t.State == "complete" || t.State == "aborted" {
		httpx.Err(w, 410, "transfer "+t.State)
		return
	}
	if vbStaleVersion(b.SessionVersion, t.Version) {
		httpx.Err(w, 409, "stale session")
		return
	}

	mask := append([]byte(nil), t.UploadedMask...) // mutable copy
	blocks := b.Blocks
	if len(blocks) > vbMaxURLs {
		blocks = blocks[:vbMaxURLs]
	}
	for _, raw := range blocks {
		f, ok := vbNum(raw)
		if !vbIsInt(f, ok) {
			continue
		}
		i := int(f)
		if i < 0 || i >= t.BlockCount || vbTestBit(mask, i) {
			continue
		}
		if vbObjectExists(ctx, vbRelayKey(tid, i)) {
			vbSetBit(mask, i)
		}
	}
	done := vbCountSet(mask, t.BlockCount)
	ready := done == t.BlockCount
	if _, err := db.Pool.Exec(ctx,
		`UPDATE vb_transfer SET uploaded_mask = $1, state = CASE WHEN $2 THEN 'ready' ELSE state END
		   WHERE transfer_id = $3`, mask, ready, tid); err != nil {
		httpx.Err(w, 500, "mark failed")
		return
	}
	if ready {
		emitx.ToUids([]string{t.RecipientID}, "vb_ready", map[string]any{"transferId": tid})
	}
	httpx.JSON(w, 200, map[string]any{"uploaded": done, "blockCount": t.BlockCount, "ready": ready})
}

// POST /vaultbeam/relay/grow — v2 adaptive geometry (block_count only grows).
func vbRelayGrow(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		TransferID     any `json:"transferId"`
		BlockCount     any `json:"blockCount"`
		Plan           any `json:"plan"`
		SessionVersion any `json:"sessionVersion"`
	}
	_ = httpx.Body(r, &b)
	tid := fmt.Sprintf("%v", orEmpty(b.TransferID))
	newCountF, ncOK := vbNum(b.BlockCount)
	var plan *string
	if s, ok := b.Plan.(string); ok {
		p := truncRunes(s, 200000)
		plan = &p
	}
	if tid == "" {
		httpx.Err(w, 400, "transferId required")
		return
	}

	t, status, err := vbLoadTransfer(ctx, tid, user.ID)
	if err != nil {
		httpx.Err(w, 500, "grow failed")
		return
	}
	if status != 0 {
		vbAuthErr(w, status)
		return
	}
	if t.SenderID != user.ID {
		httpx.Err(w, 403, "sender only")
		return
	}
	if t.State == "complete" || t.State == "aborted" {
		httpx.Err(w, 410, "transfer "+t.State)
		return
	}
	if vbStaleVersion(b.SessionVersion, t.Version) {
		httpx.Err(w, 409, "stale session")
		return
	}

	capBlocks := vbCeilDiv(float64(t.TotalBytes), 256*1024)
	if !vbIsInt(newCountF, ncOK) || int(newCountF) < t.BlockCount || int(newCountF) > capBlocks {
		httpx.Err(w, 400, "blockCount must grow within cap")
		return
	}
	newCount := int(newCountF)
	// Extend the bitmask to the new width (append zero bytes — new blocks unset).
	need := vbCeilDiv(float64(newCount), 8)
	mask := append([]byte(nil), t.UploadedMask...)
	if need > len(mask) {
		mask = append(mask, make([]byte, need-len(mask))...)
	}
	if _, err := db.Pool.Exec(ctx,
		`UPDATE vb_transfer SET block_count = $1, uploaded_mask = $2, plan = COALESCE($3, plan),
		        state = CASE WHEN state = 'ready' THEN 'pending' ELSE state END
		   WHERE transfer_id = $4`, newCount, mask, plan, tid); err != nil {
		httpx.Err(w, 500, "grow failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"blockCount": newCount})
}

// POST /vaultbeam/relay/received — the recipient publishes its verified-chunk
// bitmap so the SENDER can skip what the peer already holds. This is the durable
// half of the PeerHave sync (the live half is the sealed `vaultbeam_have`
// signaling event); it covers an offline sender, an app restart and a reboot.
//
// Union-merge server-side, so a stale or out-of-order post can never clear a
// bit. The server cannot verify the claim and does not try — see the rationale
// in migration 070.
func vbRelayReceived(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		TransferID     any `json:"transferId"`
		Mask           any `json:"mask"`
		SessionVersion any `json:"sessionVersion"`
	}
	_ = httpx.Body(r, &b)
	tid := fmt.Sprintf("%v", orEmpty(b.TransferID))
	if tid == "" {
		httpx.Err(w, 400, "transferId required")
		return
	}
	maskStr, _ := b.Mask.(string)
	if maskStr == "" {
		httpx.Err(w, 400, "mask required")
		return
	}
	raw, derr := base64.StdEncoding.DecodeString(maskStr)
	if derr != nil {
		httpx.Err(w, 400, "invalid mask")
		return
	}

	t, status, err := vbLoadTransfer(ctx, tid, user.ID)
	if err != nil {
		httpx.Err(w, 500, "received failed")
		return
	}
	if status != 0 {
		vbAuthErr(w, status)
		return
	}
	if t.RecipientID != user.ID {
		httpx.Err(w, 403, "recipient only")
		return
	}
	if t.State == "complete" || t.State == "aborted" {
		httpx.Err(w, 410, "transfer "+t.State)
		return
	}
	if vbStaleVersion(b.SessionVersion, t.Version) {
		httpx.Err(w, 409, "stale session")
		return
	}
	// Reject a mask wider than the transfer could possibly need — a bad value
	// must not be able to allocate memory out of proportion to the transfer.
	if len(raw) > vbMaskWidth(t.ChunkCount)+8 {
		httpx.Err(w, 400, "mask too wide")
		return
	}

	merged := vbUnionMask(t.RecvMask, raw, t.ChunkCount)
	if _, err := db.Pool.Exec(ctx,
		`UPDATE vb_transfer SET recv_mask = $1 WHERE transfer_id = $2 AND session_version = $3`,
		merged, tid, t.Version); err != nil {
		httpx.Err(w, 500, "received failed")
		return
	}
	received := vbCountSet(merged, t.ChunkCount)
	// Nudge the sender so it re-derives its work-list immediately rather than
	// waiting for its next poll.
	emitx.ToUids([]string{t.SenderID}, "vb_have", map[string]any{
		"transferId": tid, "received": received, "chunkCount": t.ChunkCount, "sessionVersion": t.Version,
	})
	httpx.JSON(w, 200, map[string]any{
		"received": received, "chunkCount": t.ChunkCount, "complete": received == t.ChunkCount,
	})
}

// GET /vaultbeam/relay/:transferId — state + uploaded-block bitmap + plan.
func vbRelayState(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	t, status, err := vbLoadTransfer(ctx, r.PathValue("transferId"), user.ID)
	if err != nil {
		httpx.Err(w, 500, "state failed")
		return
	}
	if status != 0 {
		vbAuthErr(w, status)
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"transferId": t.TransferID, "state": t.State, "totalBytes": t.TotalBytes,
		"blockCount": t.BlockCount, "chunkCount": t.ChunkCount,
		"chunkBytes": vbChunkBytes, "blockBytes": vbBlockBytes, "plan": t.Plan,
		"uploadedMask": base64.StdEncoding.EncodeToString(t.UploadedMask),
		"uploaded":     vbCountSet(t.UploadedMask, t.BlockCount),
		// The receiver's verified-chunk bitmap — how a sender learns what the
		// peer already holds, so it never stages a delivered chunk again.
		"recvMask":       base64.StdEncoding.EncodeToString(t.RecvMask),
		"received":       vbCountSet(t.RecvMask, t.ChunkCount),
		"sessionVersion": t.Version,
		"isSender":       t.SenderID == user.ID, "expiresAt": httpx.JSTime(t.ExpiresAt),
	})
}

// POST /vaultbeam/relay/complete — recipient confirms → purge R2 + mark complete.
func vbRelayComplete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		TransferID     any `json:"transferId"`
		SessionVersion any `json:"sessionVersion"`
		Mask           any `json:"mask"`
	}
	_ = httpx.Body(r, &b)
	t, status, err := vbLoadTransfer(ctx, fmt.Sprintf("%v", orEmpty(b.TransferID)), user.ID)
	if err != nil {
		httpx.Err(w, 500, "complete failed")
		return
	}
	if status != 0 {
		vbAuthErr(w, status)
		return
	}
	if t.RecipientID != user.ID {
		httpx.Err(w, 403, "recipient only")
		return
	}
	// Idempotent: retrying after a transient error must not fail or change the
	// recorded outcome. The receiver retries with backoff, so this matters.
	if t.State == "complete" {
		httpx.JSON(w, 200, map[string]any{"ok": true})
		return
	}
	if t.State == "aborted" {
		httpx.Err(w, 410, "transfer aborted")
		return
	}
	if vbStaleVersion(b.SessionVersion, t.Version) {
		httpx.Err(w, 409, "stale session")
		return
	}
	// A completion claim carrying a bitmap must actually cover every chunk. The
	// server cannot verify the BYTES (it never sees plaintext), but it can
	// refuse a claim that does not even assert the whole file.
	if ms, ok := b.Mask.(string); ok && ms != "" {
		raw, derr := base64.StdEncoding.DecodeString(ms)
		if derr != nil {
			httpx.Err(w, 400, "invalid mask")
			return
		}
		merged := vbUnionMask(t.RecvMask, raw, t.ChunkCount)
		if vbCountSet(merged, t.ChunkCount) != t.ChunkCount {
			httpx.Err(w, 409, "incomplete mask")
			return
		}
	}
	// DELETION HAPPENS HERE AND NOWHERE EARLIER.
	//
	// Everything above is the integrity gate: recipient authorisation, session
	// version, and a completion claim whose bitmap must cover every chunk. A
	// per-block delete as each block downloaded would destroy the resume path
	// the moment a receiver's SHA-256 came out wrong, so the relay copy lives
	// until the receiver asserts the WHOLE file.
	vbCleanupRelay(ctx, t.TransferID, "SUCCESS")
	if _, err := db.Pool.Exec(ctx,
		`UPDATE vb_transfer SET state = 'complete', uploaded_mask = '\x' WHERE transfer_id = $1`,
		t.TransferID); err != nil {
		httpx.Err(w, 500, "complete failed")
		return
	}
	emitx.ToUids([]string{t.SenderID}, "vb_complete", map[string]any{
		"transferId": t.TransferID, "sessionVersion": t.Version,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// POST /vaultbeam/relay/abort — either party cancels → purge R2 + mark aborted.
func vbRelayAbort(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		TransferID any `json:"transferId"`
	}
	_ = httpx.Body(r, &b)
	t, status, err := vbLoadTransfer(ctx, fmt.Sprintf("%v", orEmpty(b.TransferID)), user.ID)
	if err != nil {
		httpx.Err(w, 500, "abort failed")
		return
	}
	if status != 0 {
		vbAuthErr(w, status)
		return
	}
	// A completed session is immutable — it cannot be walked back into aborted.
	if t.State == "complete" {
		httpx.Err(w, 410, "transfer complete")
		return
	}
	vbCleanupRelay(ctx, t.TransferID, "ABORTED")
	if _, err := db.Pool.Exec(ctx,
		`UPDATE vb_transfer SET state = 'aborted', uploaded_mask = '\x' WHERE transfer_id = $1`,
		t.TransferID); err != nil {
		httpx.Err(w, 500, "abort failed")
		return
	}
	other := t.RecipientID
	if t.SenderID != user.ID {
		other = t.SenderID
	}
	emitx.ToUids([]string{other}, "vb_abort", map[string]any{"transferId": t.TransferID})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// vbSweepBatch caps how many expired transfers one tick handles. Each costs a
// list + a delete against R2, and the sweep runs hourly — a bound keeps a
// backlog from turning one tick into a long-running storm.
const vbSweepBatch = 200

// vbCleanupRelay deletes a transfer's relay objects on a terminal transition
// (a verified receive, or an abort) and records what happened.
//
// NEVER fails the request. On the success path the file is already verified by
// the time this runs, and telling a receiver their transfer failed because a
// storage DELETE returned 500 would be a lie about the only thing they care
// about.
//
// On failure it pulls `expires_at` FORWARD to now so the hourly reaper retries
// within the hour rather than leaving objects for up to 24h. LEAST, never
// GREATEST: this may only ever SHORTEN retention. Nothing in this file may
// extend a deadline — that is the sliding-TTL the policy forbids, and a transfer
// that has just reached a terminal state has no retention left to claim anyway.
func vbCleanupRelay(ctx context.Context, transferID, reason string) {
	started := time.Now()
	n, err := vbDeletePrefixCount(ctx, "vault_relay/"+transferID+"/")
	if err == nil {
		log.Printf("RELAY_CLEANUP_SUCCESS transferId=%s reason=%s objects=%d durationMs=%d",
			transferID, reason, n, time.Since(started).Milliseconds())
		return
	}
	log.Printf("RELAY_CLEANUP_FAILED transferId=%s reason=%s objects=%d durationMs=%d err=%v",
		transferID, reason, n, time.Since(started).Milliseconds(), err)
	if _, uerr := db.Pool.Exec(ctx,
		`UPDATE vb_transfer SET expires_at = LEAST(expires_at, NOW()) WHERE transfer_id = $1`,
		transferID); uerr != nil {
		log.Printf("RELAY_CLEANUP_RETRY transferId=%s could not arm reaper: %v", transferID, uerr)
		return
	}
	log.Printf("RELAY_CLEANUP_RETRY transferId=%s armed for the next sweep", transferID)
}

// VaultbeamSweepExpired enforces the 24h relay retention ceiling.
//
// # WHAT THIS REPLACED, AND WHY IT WAS NOT ENOUGH
//
// It used to be one statement:
//
//	DELETE FROM vb_transfer WHERE expires_at < NOW()
//
// with a comment saying "objects are auto-purged by the 24h R2 lifecycle rule".
// That deletes the ROW ONLY. The application never deleted a single expired
// object, so the entire retention guarantee rested on a bucket lifecycle rule
// living outside this codebase — and on 2026-08-20 that rule could not be
// confirmed to exist (the API token is not permitted to read lifecycle config).
//
// Worse than unverified: transfer_id is the ONLY handle mapping a transfer to
// its `vault_relay/<id>/` prefix. Dropping the row first destroys the ability to
// ever enumerate those objects again, so if the rule is absent the leak is both
// permanent and invisible. A retention policy may not depend on something this
// process cannot see.
//
// Now: delete the objects, and drop the row ONLY once they are gone.
//
// # IDEMPOTENT BY CONSTRUCTION — no lock, no claim, no new state
//
// Deleting an absent prefix is a no-op and deleting an absent row is a no-op,
// so two workers racing the same transfer duplicate work and corrupt nothing.
// A failure leaves the row in place, which means the NEXT tick retries it: the
// row is the work queue, and that is what makes this survive an API restart, a
// crashed worker, and a receiver who never comes back — with no extra column
// and no migration.
func VaultbeamSweepExpired(ctx context.Context) error {
	rows, err := db.Pool.Query(ctx,
		`SELECT transfer_id, state FROM vb_transfer
		  WHERE expires_at < NOW()
		  ORDER BY expires_at
		  LIMIT $1`, vbSweepBatch)
	if err != nil {
		return err
	}
	type item struct{ id, state string }
	var todo []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.id, &it.state); err != nil {
			rows.Close()
			return err
		}
		todo = append(todo, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(todo) == 0 {
		return nil
	}

	started := time.Now()
	objects, cleared, failed := 0, 0, 0
	for _, it := range todo {
		n, derr := vbDeletePrefixCount(ctx, "vault_relay/"+it.id+"/")
		objects += n
		if derr != nil {
			// Row deliberately left in place: it is the retry ticket, and the
			// only way back to these object keys.
			failed++
			log.Printf("RELAY_CLEANUP_FAILED transferId=%s state=%s objects=%d err=%v — row kept for retry",
				it.id, it.state, n, derr)
			continue
		}
		if _, err := db.Pool.Exec(ctx, `DELETE FROM vb_transfer WHERE transfer_id = $1`, it.id); err != nil {
			// Objects are gone; the row will be re-selected next tick and its
			// (now empty) prefix deleted again as a no-op. Safe either way.
			failed++
			log.Printf("RELAY_CLEANUP_RETRY transferId=%s objects=%d rowErr=%v", it.id, n, err)
			continue
		}
		cleared++
		log.Printf("RELAY_CLEANUP_EXPIRED transferId=%s state=%s objects=%d", it.id, it.state, n)
	}
	log.Printf("RELAY_CLEANUP_COMPLETED scanned=%d cleared=%d failed=%d objects=%d durationMs=%d",
		len(todo), cleared, failed, objects, time.Since(started).Milliseconds())
	return nil
}
