// gif.go — KLIPY proxy for GIFs, stickers and emojis.
//
// WAS GIPHY. The route, the normalized result shape and the not_configured
// behaviour are unchanged, so an app build that predates this keeps working and
// keeps getting GIFs — it simply never asks for the other two types.
//
// WHY A SERVER PROXY AT ALL: the API key would be extractable from any shipped
// APK, and KLIPY bills per key. It stays in the server environment and the
// device never sees it. The 5-minute cache is the other half — a picker fires a
// request per keystroke, and trending is identical for every user.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"vaultchat/backend-go/internal/httpx"
)

const (
	gifTimeout  = 6 * time.Second
	gifCacheTTL = 5 * time.Minute
	gifPerPage  = 24
)

// The wire shape the app already parses. Unchanged from the GIPHY era on
// purpose: components/GifPicker.tsx reads exactly these fields.
type gifResult struct {
	ID      string `json:"id"`
	URL     string `json:"url"`
	GIF     string `json:"gif"`
	Preview string `json:"preview"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
}

type gifPage struct {
	Results []gifResult `json:"results"`
	Next    string      `json:"next"`
}

var (
	gifCacheMu sync.Mutex
	gifCache   = map[string]struct {
		at   time.Time
		data gifPage
	}{}
)

func RegisterGif(mux *http.ServeMux) {
	mux.HandleFunc("GET /gif/search", httpx.RequireAuth(gifSearch))
}

// ── KLIPY wire types ───────────────────────────────────────────────────
// GET https://api.klipy.com/api/v1/{KEY}/{type}/{trending|search}
//   → {"result":true,"data":{"data":[…],"current_page":1,"per_page":24,"has_next":true}}
// Every content type returns the identical envelope and item, which is why one
// decoder covers all three.

type klipyFile struct {
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Size   int64  `json:"size"`
}

// Per size bucket: gif / webp / jpg / mp4 / webm.
type klipyVariants map[string]klipyFile

type klipyItem struct {
	ID    any                      `json:"id"`
	Slug  string                   `json:"slug"`
	Title string                   `json:"title"`
	File  map[string]klipyVariants `json:"file"` // hd | md | sm → variants
}

type klipyResp struct {
	Result bool `json:"result"`
	Data   struct {
		Items       []klipyItem `json:"data"`
		CurrentPage int         `json:"current_page"`
		PerPage     int         `json:"per_page"`
		HasNext     bool        `json:"has_next"`
	} `json:"data"`
}

// Only these are exposed. `clips` also works upstream but is short-form video,
// not a picker item, and `memes` 404s on our key — so neither is offered rather
// than shipped as a tab that sometimes fails.
var klipyTypes = map[string]bool{"gifs": true, "stickers": true, "emojis": true}

func klipyFetch(ctx context.Context, kind, path string, params url.Values) (*klipyResp, error) {
	ctx, cancel := context.WithTimeout(ctx, gifTimeout)
	defer cancel()
	// The key is a PATH SEGMENT for KLIPY, not a query parameter or a header.
	endpoint := fmt.Sprintf("https://api.klipy.com/api/v1/%s/%s/%s?%s",
		url.PathEscape(os.Getenv("KLIPY_KEY")), kind, path, params.Encode())
	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("klipy %s %d", kind, resp.StatusCode)
	}
	var out klipyResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Format preference, and every part of this order is load-bearing.
//
// gif first: android/gradle.properties sets `expo.webp.animated=false`, so an
// animated webp decodes to a SINGLE FRAME. Serving webp would turn every
// animated tile into a still image — which reads as "the picker is broken" and
// would be miserable to trace back to a build flag.
//
// png second, and it is NOT optional: KLIPY emojis ship png + webp with NO gif
// variant at all. A gif-only picker returns nothing for the entire emoji tab.
//
// webp last, as a floor. It is static-only here, but a static tile beats a
// blank one, and nothing observed actually falls through to it.
var klipyFormats = []string{"gif", "png", "webp"}

// pickVariant walks size buckets in the given order and returns the first
// usable file, preferring formats as above within each bucket.
func pickVariant(file map[string]klipyVariants, buckets ...string) klipyFile {
	for _, bucket := range buckets {
		v, ok := file[bucket]
		if !ok {
			continue
		}
		for _, format := range klipyFormats {
			if f, ok := v[format]; ok && f.URL != "" {
				return f
			}
		}
	}
	return klipyFile{}
}

func gifSearch(w http.ResponseWriter, r *http.Request) {
	if os.Getenv("KLIPY_KEY") == "" {
		// Same contract the app already handles: an empty, non-error result.
		httpx.JSON(w, 200, map[string]any{"results": []any{}, "next": "", "error": "not_configured"})
		return
	}

	// Absent or unknown → gifs, so an older build (which sends no type at all)
	// behaves exactly as it did before, and a typo cannot 400 the picker.
	kind := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("type")))
	if !klipyTypes[kind] {
		kind = "gifs"
	}

	q := r.URL.Query().Get("q")
	if len(q) > 100 {
		q = q[:100]
	}
	// `pos` stays the cursor param for compatibility; for KLIPY it is a page
	// number rather than an offset. Page 0 and 1 both mean the first page.
	page, _ := strconv.Atoi(r.URL.Query().Get("pos"))
	if page < 1 {
		page = 1
	}
	key := fmt.Sprintf("%s|%s|%d", kind, q, page)

	gifCacheMu.Lock()
	if hit, ok := gifCache[key]; ok && time.Since(hit.at) < gifCacheTTL {
		gifCacheMu.Unlock()
		httpx.JSON(w, 200, hit.data)
		return
	}
	gifCacheMu.Unlock()

	params := url.Values{
		"page":     {strconv.Itoa(page)},
		"per_page": {strconv.Itoa(gifPerPage)},
	}
	path := "trending"
	if q != "" {
		path = "search"
		params.Set("q", q)
	}
	resp, err := klipyFetch(r.Context(), kind, path, params)
	if err != nil || !resp.Result {
		httpx.Err(w, 502, "gif search unavailable", map[string]any{"results": []any{}})
		return
	}

	results := []gifResult{}
	for _, it := range resp.Data.Items {
		// Grid tiles come from the SMALLEST bucket. Measured on real responses:
		// a GIF's xs is ~52 KB against ~240 KB for sm, so a 24-tile page is
		// ~1.2 MB instead of ~5.8 MB — on a picker the user scrolls casually.
		//
		// What gets SENT is sm: 220px is the right size for a chat bubble, and
		// md/hd run to 1.4 MB and 4.9 MB for a single GIF, which is a rude thing
		// to push down someone's mobile data for one reaction.
		preview := pickVariant(it.File, "xs", "sm", "md", "hd")
		send := pickVariant(it.File, "sm", "md", "xs", "hd")
		if send.URL == "" {
			send = preview
		}
		if preview.URL == "" {
			preview = send
		}
		if send.URL == "" {
			continue // no usable GIF variant — skip rather than render a blank tile
		}
		wpx, hpx := preview.Width, preview.Height
		if wpx == 0 {
			wpx = 200
		}
		if hpx == 0 {
			hpx = 200
		}
		results = append(results, gifResult{
			ID:      fmt.Sprintf("%v", it.ID),
			URL:     send.URL,
			GIF:     send.URL,
			Preview: preview.URL,
			Width:   wpx,
			Height:  hpx,
		})
	}

	// Empty string when there is no next page — the app treats that as "stop".
	next := ""
	if resp.Data.HasNext {
		next = strconv.Itoa(page + 1)
	}

	data := gifPage{Results: results, Next: next}
	gifCacheMu.Lock()
	gifCache[key] = struct {
		at   time.Time
		data gifPage
	}{time.Now(), data}
	if len(gifCache) > 300 {
		for k := range gifCache {
			delete(gifCache, k)
			break
		}
	}
	gifCacheMu.Unlock()
	httpx.JSON(w, 200, data)
}
