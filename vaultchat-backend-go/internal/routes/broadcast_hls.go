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
//
// THE EXPIRY IS BUCKETED, AND THAT IS WHAT MAKES WORLDWIDE STREAMING POSSIBLE.
//
// Minting `now + 24h` gave every viewer — and every playlist refresh — a
// DIFFERENT `exp`, so the same segment had a different URL for every person
// watching. A CDN in front of this would have cached each of them separately and
// missed on all of them: a hundred thousand viewers meant a hundred thousand
// origin fetches of identical bytes, which is precisely the shape that makes
// "all video bytes transit go-api" (see the header) unfixable by adding a CDN.
//
// Rounding the deadline UP to a fixed boundary means every viewer in the same
// window derives the SAME url for the same segment. One origin fetch per segment
// globally; every other viewer is served from the edge. The change is four
// lines and it is the difference between a few thousand concurrent viewers and
// an unbounded audience.
//
// Security is unchanged in kind: the signature still covers the expiry, so the
// deadline cannot be edited, and the ticket is still unguessable without
// JWT_SECRET. What changes is that two people watching the same broadcast now
// share a URL — which is fine, because they are both entitled to those bytes.
// The bucket does mean a ticket outlives its window by up to one full period,
// which is why the period is a fraction of the TTL rather than equal to it.
func hlsTicket(id string) string {
	exp := hlsBucketExp(time.Now())
	return strconv.FormatInt(exp, 10) + "." + hlsSign(id, exp)
}

// hlsBucketWindow is how long one ticket value is reused for.
//
// Chosen against the two failure modes it sits between. Too short and a long
// broadcast rolls the ticket often, and every roll is a full cache miss on every
// segment still in the playlist window. Too long and a revoked viewer keeps
// access for that much longer, and the CDN holds keys well past their usefulness.
//
// An hour is comfortably longer than the ~30s of segments an HLS player keeps in
// its window, so a roll costs almost nothing, and it is short enough that a
// ticket is never valid for more than the 24h TTL plus one window.
const hlsBucketWindow = time.Hour

// hlsStartOffset is where a joining player is told to begin, as seconds back
// from the live edge.
//
// WHY THIS EXISTS
// ---------------
// Without an explicit instruction, an HLS player picks its own start point, and
// the rule it uses — from the spec, and what ExoPlayer and AVPlayer both do — is
// to begin THREE TARGET DURATIONS from the end. At 2s segments that is 6s of
// latency the player chose on its own, on top of encode, upload and CDN, and no
// amount of shortening segments removes it: cutting to 1s segments would only
// take it to 3s while quadrupling request volume.
//
// #EXT-X-START overrides that choice directly, and it is free — the playlist is
// already being rewritten here to re-mint segment tickets, so this is one more
// line in a response that was being generated anyway. No client change, no new
// dependency, and it applies to every player including a browser.
//
// WHY -4 AND NOT SMALLER
// ----------------------
// This is a BUFFER, not just a target: it is how much video the player holds
// before it has to have the next segment. Two segments' worth is the smallest
// honest figure at 2s — one segment of margin plus the one being played. Asking
// for less does not make the stream arrive sooner, it makes a phone on a weak
// network rebuffer, and a stall costs the viewer far more than the second it
// was trying to save.
//
// PRECISE=YES so the player starts exactly here rather than snapping back to
// the preceding segment boundary, which would hand back most of the gain.
const hlsStartOffset = "-4"

// injectStartOffset adds #EXT-X-START to a live playlist.
//
// Inserted directly after #EXTM3U because the tag must appear before the first
// media segment; anywhere in the header is legal, and right at the top is the
// one position that cannot drift as the playlist grows.
//
// Left ALONE if the encoder ever starts emitting its own — a second
// #EXT-X-START is invalid and players disagree about which wins, so the safe
// reading of "already present" is that someone upstream meant it.
func injectStartOffset(playlist string) string {
	if strings.Contains(playlist, "#EXT-X-START") {
		return playlist
	}
	const head = "#EXTM3U"
	i := strings.Index(playlist, head)
	if i < 0 {
		// Not a playlist we recognise. Returning it untouched is strictly better
		// than corrupting a response that was working.
		return playlist
	}
	cut := i + len(head)
	return playlist[:cut] +
		"\n#EXT-X-START:TIME-OFFSET=" + hlsStartOffset + ",PRECISE=YES" +
		playlist[cut:]
}

// hlsBucketExp rounds the deadline up to the next window boundary.
//
// Rounding UP rather than truncating matters: truncating would hand out a
// deadline in the past for anyone minting near a boundary, and every one of
// those tickets would fail verification immediately.
func hlsBucketExp(now time.Time) int64 {
	exp := now.Add(hlsTicketTTL).Unix()
	w := int64(hlsBucketWindow / time.Second)
	return ((exp + w - 1) / w) * w
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
		out := injectStartOffset(strings.Join(lines, "\n"))
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		// A live playlist gains a segment every ~4s, so it is the one thing here
		// that must not be cached for long. Two seconds is enough for the
		// thundering herd of a viral moment — ten thousand players refreshing in
		// the same second collapse to a single origin fetch — while staying well
		// inside the segment duration, so no viewer sees a stale live edge.
		w.Header().Set("Cache-Control", "public, max-age=2")
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
	// PUBLIC, not private — this is the header that decides whether worldwide
	// streaming is possible at all.
	//
	// `private` forbids every SHARED cache, so a CDN placed in front of this
	// origin would refuse to store a single segment and every viewer on earth
	// would pull their bytes through go-api. It was not protecting anything: the
	// URL already carries its own capability (the ticket), the bucket is still
	// private, and a segment is meaningless without the signed query string.
	//
	// With `public` and a bucketed ticket (hlsTicket) every viewer of a given
	// broadcast requests the SAME url for a given segment, so the edge serves all
	// of them from one origin fetch. `immutable` stops players revalidating
	// content that can never change — a segment is written once and never
	// rewritten.
	//
	// Access control does not weaken: an unticketed or forged request is still
	// refused here, and the CDN only ever caches a response it was allowed to
	// fetch in the first place.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(200)
	_, _ = io.Copy(w, obj.Body)
}
