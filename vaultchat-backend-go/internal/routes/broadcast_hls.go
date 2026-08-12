// broadcast_hls.go — authorized playback for Go Live, with the bucket private.
//
// THE PROBLEM
// -----------
// Playback URLs were permanent, unsigned and deterministic from the broadcast
// UUID (livekit/egress.go PlaybackURL). Nothing expired them, ending a stream
// did not invalidate them, and every segment ever written stayed addressable
// forever. The only reason that was not already a public archive is that
// nothing in the repo creates the bucket or sets a policy on it — MinIO
// defaults to private — so playback worked only if an operator had opened the
// bucket by hand. Either way the URL carried no authorization at all.
//
// WHY THE OBVIOUS FIXES DO NOT WORK
// ---------------------------------
// Per-segment presigning: playlist segment URIs are RELATIVE, so a query
// parameter on the .m3u8 does not propagate — the player resolves siblings and
// drops it. Rewriting every entry to an absolute presigned URL does work, but a
// SigV4 URL is ~400 bytes and a two-hour stream at 4s segments is ~1800
// entries: a ~700 KB playlist, re-fetched every 4 seconds, per viewer.
//
// Header auth: expo-av does support source={uri, headers} and the headers do
// reach segment requests — but they are pinned at source creation, while the
// access token TTL is 15 minutes (JWT_ACCESS_TTL, auth.go). Any broadcast
// longer than fifteen minutes would 401 mid-stream with no refresh path. That
// is the non-obvious one, and it is why this file exists instead.
//
// WHAT THIS DOES
// --------------
// A per-broadcast HMAC ticket in the query string, and an origin relay that
// rewrites the playlist so each segment carries a FRESH ticket. The bucket
// stays private; no client change; no new dependency; no new env var.
//
// ponytail: all video bytes now transit go-api. Correct into the low thousands
// of concurrent viewers, wrong at the millions-of-users bar. The upgrade needs
// no code change — move this same ticket check into a CDN edge worker (signed
// cookie scoped to /broadcasts/{id}/hls/) and let the edge read the private
// bucket with credentials; URL shape and ticket format are unchanged, so it
// becomes a deploy. Do not build that until viewer counts ask for it.
package routes

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/livekit"
	"vaultchat/backend-go/internal/storage"
)

// A ticket outlives an access token on purpose.
//
// It is a far weaker capability: read-only, scoped to ONE broadcast id, and it
// grants nothing but bytes that every authenticated user could already fetch
// through the metadata API. Tying it to the 15-minute access-token TTL would
// break exactly the long streams this is for.
const hlsTicketTTL = 24 * time.Hour

func hlsSecret() []byte { return []byte(os.Getenv("JWT_SECRET")) }

func hlsSign(id string, exp int64) string {
	m := hmac.New(sha256.New, hlsSecret())
	m.Write([]byte(id + "." + strconv.FormatInt(exp, 10)))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// hlsTicket mints "<exp>.<sig>" for one broadcast.
func hlsTicket(id string) string {
	exp := time.Now().Add(hlsTicketTTL).Unix()
	return strconv.FormatInt(exp, 10) + "." + hlsSign(id, exp)
}

// hlsTicketOK verifies a ticket against a broadcast id.
//
// Constant-time compare, and the signature covers the expiry so the deadline
// cannot be edited. An empty JWT_SECRET would make every ticket verify against
// every other, so that is refused outright rather than silently accepted.
func hlsTicketOK(id, ticket string) bool {
	if len(hlsSecret()) == 0 || ticket == "" {
		return false
	}
	dot := strings.IndexByte(ticket, '.')
	if dot <= 0 {
		return false
	}
	exp, err := strconv.ParseInt(ticket[:dot], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	return hmac.Equal([]byte(ticket[dot+1:]), []byte(hlsSign(id, exp)))
}

// broadcastHLSURL is the playback URL handed to viewers, ticket included.
// Derived from the broadcast id, which is also why the arbitrary-URL write in
// broadcastSetHLS can no longer influence what a viewer actually fetches.
func broadcastHLSURL(id string) string {
	return livekit.PlaybackURL(id) + "?t=" + hlsTicket(id)
}

// broadcastHLS serves the playlist and its segments from the private bucket.
//
// Deliberately NOT wrapped in httpx.RequireAuth, unlike every sibling route: a
// video player cannot attach an Authorization header to the segment requests it
// generates itself, so the query ticket IS the credential here. That is the
// whole reason the ticket exists.
func broadcastHLS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	file := r.PathValue("file")
	if id == "" || file == "" {
		httpx.Err(w, 400, "not found")
		return
	}
	if !hlsTicketOK(id, r.URL.Query().Get("t")) {
		// 404, not 403: an invalid ticket should not confirm that a broadcast
		// with this id exists.
		httpx.Err(w, 404, "not found")
		return
	}

	// path.Base defeats traversal, and it normalises both playlist shapes
	// LiveKit egress can emit — a bare basename, or "<id>/segment.ts" — without
	// this handler needing to know which one it is dealing with.
	key := id + "/" + path.Base(file)

	obj := storage.GetBroadcastObject(r.Context(), key)
	if obj == nil {
		httpx.Err(w, 404, "not found")
		return
	}
	defer obj.Body.Close()

	if strings.HasSuffix(key, ".m3u8") {
		body, err := io.ReadAll(io.LimitReader(obj.Body, 8<<20))
		if err != nil {
			httpx.Err(w, 502, "playlist unavailable")
			return
		}
		// Re-mint rather than echo the caller's ticket. A two-hour stream
		// outlives a ticket minted at minute zero; issuing a fresh one on every
		// playlist refresh is what stops segments 401ing mid-broadcast.
		fresh := hlsTicket(id)
		lines := strings.Split(string(body), "\n")
		for i, ln := range lines {
			t := strings.TrimSpace(ln)
			if t == "" || strings.HasPrefix(t, "#") {
				continue // directive or blank — only URIs get a ticket
			}
			sep := "?"
			if strings.Contains(t, "?") {
				sep = "&"
			}
			lines[i] = t + sep + "t=" + fresh
		}
		out := strings.Join(lines, "\n")
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Length", strconv.Itoa(len(out)))
		w.WriteHeader(200)
		_, _ = io.WriteString(w, out)
		return
	}

	ct := obj.ContentType
	if ct == "" {
		ct = "video/mp2t"
	}
	w.Header().Set("Content-Type", ct)
	if obj.ContentLength >= 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", obj.ContentLength))
	}
	// Segments are immutable once written; the ticket, not the cache, is what
	// bounds access. `private` keeps them out of shared caches.
	w.Header().Set("Cache-Control", "private, max-age=31536000")
	w.WriteHeader(200)
	_, _ = io.Copy(w, obj.Body)
}
