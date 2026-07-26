// gif.go ← routes/gif.js — GIPHY search proxy: same normalize shape, same
// not_configured behavior without GIPHY_KEY, same 5-min cache + pg-13 rating.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"

	"vaultchat/backend-go/internal/httpx"
)

const (
	gifTimeout  = 6 * time.Second
	gifCacheTTL = 5 * time.Minute
)

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

type giphyImage struct {
	URL    string `json:"url"`
	Width  string `json:"width"`
	Height string `json:"height"`
}
type giphyResp struct {
	Data []struct {
		ID     any                   `json:"id"`
		Images map[string]giphyImage `json:"images"`
	} `json:"data"`
	Pagination struct {
		Offset int `json:"offset"`
		Count  int `json:"count"`
	} `json:"pagination"`
}

func giphyFetch(ctx context.Context, path string, params url.Values) (*giphyResp, error) {
	params.Set("api_key", os.Getenv("GIPHY_KEY"))
	params.Set("rating", "pg-13")
	ctx, cancel := context.WithTimeout(ctx, gifTimeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET",
		"https://api.giphy.com/v1/gifs/"+path+"?"+params.Encode(), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("giphy %d", resp.StatusCode)
	}
	var out giphyResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

func gifSearch(w http.ResponseWriter, r *http.Request) {
	if os.Getenv("GIPHY_KEY") == "" {
		httpx.JSON(w, 200, map[string]any{"results": []any{}, "next": "", "error": "not_configured"})
		return
	}

	q := r.URL.Query().Get("q")
	if len(q) > 100 {
		q = q[:100]
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("pos"))
	key := fmt.Sprintf("%s|%d", q, offset)

	gifCacheMu.Lock()
	if hit, ok := gifCache[key]; ok && time.Since(hit.at) < gifCacheTTL {
		gifCacheMu.Unlock()
		httpx.JSON(w, 200, hit.data)
		return
	}
	gifCacheMu.Unlock()

	var resp *giphyResp
	var err error
	if q != "" {
		resp, err = giphyFetch(r.Context(), "search", url.Values{
			"q": {q}, "limit": {"24"}, "offset": {strconv.Itoa(offset)},
			"bundle": {"messaging_non_clips"},
		})
	} else {
		resp, err = giphyFetch(r.Context(), "trending", url.Values{
			"limit": {"24"}, "offset": {strconv.Itoa(offset)},
		})
	}
	if err != nil {
		httpx.Err(w, 502, "gif search unavailable", map[string]any{"results": []any{}})
		return
	}

	results := []gifResult{}
	for _, g := range resp.Data {
		im := g.Images
		fw, dn, orig := im["fixed_width"], im["downsized"], im["original"]
		sm := im["fixed_width_small"]
		if sm.URL == "" {
			sm = im["preview_gif"]
		}
		first := func(vals ...string) string {
			for _, v := range vals {
				if v != "" {
					return v
				}
			}
			return ""
		}
		wpx, _ := strconv.Atoi(fw.Width)
		hpx, _ := strconv.Atoi(fw.Height)
		if wpx == 0 {
			wpx = 200
		}
		if hpx == 0 {
			hpx = 200
		}
		item := gifResult{
			ID:      fmt.Sprintf("%v", g.ID),
			URL:     first(fw.URL, dn.URL, orig.URL),
			GIF:     first(dn.URL, fw.URL, orig.URL),
			Preview: first(sm.URL, fw.URL),
			Width:   wpx,
			Height:  hpx,
		}
		if item.URL != "" || item.GIF != "" {
			results = append(results, item)
		}
	}

	data := gifPage{Results: results, Next: strconv.Itoa(resp.Pagination.Offset + resp.Pagination.Count)}
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
