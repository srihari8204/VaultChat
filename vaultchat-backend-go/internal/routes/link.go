// link.go ← routes/link.js — Open Graph link-preview fetcher with the same
// SSRF policy: public http(s) only, every resolved IP checked against
// private/loopback/link-local/CGNAT ranges, final-URL revalidation after
// redirects, 5 s timeout, 512 KB body cap, 30-min in-memory cache.
package routes

import (
	"context"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"vaultchat/backend-go/internal/httpx"
)

const (
	linkTimeout  = 5 * time.Second
	linkMaxBytes = 512 * 1024
	linkCacheTTL = 30 * time.Minute
)

type linkPreview struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Image       string `json:"image"`
}

var (
	linkCacheMu sync.Mutex
	linkCache   = map[string]struct {
		at   time.Time
		data linkPreview
	}{}
)

func RegisterLink(mux *http.ServeMux) {
	mux.HandleFunc("GET /link/preview", httpx.RequireAuth(linkPreviewHandler))
}

func isPrivateIPv4(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil {
		return true
	}
	a, b := v4[0], v4[1]
	return a == 10 || a == 127 || a == 0 ||
		(a == 172 && b >= 16 && b <= 31) ||
		(a == 192 && b == 168) ||
		(a == 169 && b == 254) ||
		(a == 100 && b >= 64 && b <= 127)
}

func isBlockedIP(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return true
	}
	if ip.To4() != nil && !strings.Contains(ipStr, ":") {
		return isPrivateIPv4(ip)
	}
	x := strings.ToLower(ipStr)
	return x == "::1" || x == "::" || strings.HasPrefix(x, "fc") || strings.HasPrefix(x, "fd") ||
		strings.HasPrefix(x, "fe80") || strings.HasPrefix(x, "::ffff:")
}

var blockedHostRe = regexp.MustCompile(`(?i)^(localhost|.*\.local|.*\.internal)$`)

func assertPublicHost(ctx context.Context, hostname string) bool {
	if ip := net.ParseIP(hostname); ip != nil {
		return !isBlockedIP(hostname)
	}
	if blockedHostRe.MatchString(hostname) {
		return false
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, hostname)
	if err != nil || len(addrs) == 0 {
		return false
	}
	for _, a := range addrs {
		if isBlockedIP(a.IP.String()) {
			return false
		}
	}
	return true
}

func decodeEntities(s string) string { return html.UnescapeString(s) }

func pickMeta(page, prop string) string {
	q := regexp.QuoteMeta(prop)
	re1 := regexp.MustCompile(`(?i)<meta[^>]+(?:property|name)=["']` + q + `["'][^>]+content=["']([^"']*)["']`)
	re2 := regexp.MustCompile(`(?i)<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']` + q + `["']`)
	if m := re1.FindStringSubmatch(page); m != nil {
		return strings.TrimSpace(decodeEntities(m[1]))
	}
	if m := re2.FindStringSubmatch(page); m != nil {
		return strings.TrimSpace(decodeEntities(m[1]))
	}
	return ""
}

var titleRe = regexp.MustCompile(`(?i)<title[^>]*>([^<]*)</title>`)

func linkPreviewHandler(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		httpx.Err(w, 400, "invalid url")
		return
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		httpx.Err(w, 400, "unsupported scheme")
		return
	}
	if p := u.Port(); p != "" && p != "80" && p != "443" {
		httpx.Err(w, 400, "blocked port")
		return
	}
	if u.Path == "" {
		u.Path = "/" // Node's WHATWG URL.toString() adds it; the url echo must match
	}

	key := u.String()
	linkCacheMu.Lock()
	if hit, ok := linkCache[key]; ok && time.Since(hit.at) < linkCacheTTL {
		linkCacheMu.Unlock()
		httpx.JSON(w, 200, hit.data)
		return
	}
	linkCacheMu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), linkTimeout)
	defer cancel()

	if !assertPublicHost(ctx, u.Hostname()) {
		httpx.Err(w, 502, "preview unavailable")
		return
	}

	req, _ := http.NewRequestWithContext(ctx, "GET", key, nil)
	req.Header.Set("User-Agent", "VaultChatBot/1.0 (+link-preview)")
	req.Header.Set("Accept", "text/html")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		httpx.Err(w, 502, "preview unavailable")
		return
	}
	defer resp.Body.Close()

	// Re-validate the FINAL url after redirects.
	finalURL := resp.Request.URL
	if !assertPublicHost(ctx, finalURL.Hostname()) {
		httpx.Err(w, 400, "blocked redirect")
		return
	}

	if !strings.Contains(resp.Header.Get("Content-Type"), "text/html") {
		httpx.JSON(w, 200, linkPreview{URL: key})
		return
	}

	body, _ := io.ReadAll(io.LimitReader(resp.Body, linkMaxBytes))
	page := string(body)

	titleTag := ""
	if m := titleRe.FindStringSubmatch(page); m != nil {
		titleTag = m[1]
	}
	image := pickMeta(page, "og:image")
	if image == "" {
		image = pickMeta(page, "twitter:image")
	}
	if strings.HasPrefix(image, "//") {
		image = u.Scheme + ":" + image
	} else if strings.HasPrefix(image, "/") {
		image = u.Scheme + "://" + u.Host + image
	}

	title := pickMeta(page, "og:title")
	if title == "" {
		title = strings.TrimSpace(decodeEntities(titleTag))
	}
	desc := pickMeta(page, "og:description")
	if desc == "" {
		desc = pickMeta(page, "description")
	}

	data := linkPreview{URL: key, Title: title, Description: desc, Image: image}
	linkCacheMu.Lock()
	linkCache[key] = struct {
		at   time.Time
		data linkPreview
	}{time.Now(), data}
	if len(linkCache) > 500 {
		for k := range linkCache {
			delete(linkCache, k)
			break
		}
	}
	linkCacheMu.Unlock()
	httpx.JSON(w, 200, data)
}
