// link.go ← routes/link.js — Open Graph link-preview fetcher with the same
// SSRF policy: public http(s) only, every resolved IP checked against
// private/loopback/link-local/CGNAT ranges, final-URL revalidation after
// redirects, 5 s timeout, 512 KB body cap, 30-min in-memory cache.
package routes

import (
	"context"
	"fmt"
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

// ── the only client this file may use ──────────────────────────────────
//
// http.DefaultClient FOLLOWS REDIRECTS BEFORE ANYTHING CHECKS THEM. The old
// code validated the hostname, issued the request with the default client, and
// re-validated `resp.Request.URL` afterwards — by which point a 302 to
// http://127.0.0.1:9200/ had already been connected to, sent, and answered.
// Rejecting the response after the fact is not a control; the request IS the
// vulnerability (OWASP SSRF Prevention: validate every hop, before following).
//
// Two things close it, and both are needed:
//
//  1. CheckRedirect validates EVERY hop — scheme, port and host — and refuses
//     rather than following. A redirect chain cannot walk out of the policy.
//  2. DialContext validates the address actually being connected to, at the
//     moment of connection. Checking the hostname and then letting the
//     transport resolve it again leaves a DNS-rebinding window where the
//     second lookup returns 127.0.0.1. Dialling the address we just checked
//     removes the second lookup entirely.
//
// Redirects are capped at 5: the default 10 is a lot of outbound requests for
// a preview, and each one is a fetch we make on a user's say-so.
const linkMaxRedirects = 5

var linkClient = &http.Client{
	Timeout: linkTimeout,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= linkMaxRedirects {
			return fmt.Errorf("link: too many redirects")
		}
		if err := assertFetchable(req.Context(), req.URL); err != nil {
			return fmt.Errorf("link: blocked redirect: %w", err)
		}
		return nil
	},
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			// The transport hands us the hostname it is about to resolve. Resolve
			// it ONCE here, keep the addresses we vetted, and dial those — so the
			// name cannot resolve to something else between check and connect.
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil || len(ips) == 0 {
				return nil, fmt.Errorf("link: cannot resolve %s", host)
			}
			var d net.Dialer
			for _, a := range ips {
				if isBlockedIP(a.IP.String()) {
					return nil, fmt.Errorf("link: blocked address %s", a.IP)
				}
			}
			// Every address vetted; dial the first that connects.
			var lastErr error
			for _, a := range ips {
				conn, err := d.DialContext(ctx, network, net.JoinHostPort(a.IP.String(), port))
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
		TLSHandshakeTimeout:   linkTimeout,
		ResponseHeaderTimeout: linkTimeout,
		MaxIdleConnsPerHost:   2,
	},
}

// assertFetchable is the whole policy for a URL this server may fetch: http(s)
// only, no odd ports, and a host that resolves entirely to public addresses.
// Used for the first request AND for every redirect hop.
func assertFetchable(ctx context.Context, u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	if p := u.Port(); p != "" && p != "80" && p != "443" {
		return fmt.Errorf("blocked port %q", p)
	}
	if !assertPublicHost(ctx, u.Hostname()) {
		return fmt.Errorf("non-public host %q", u.Hostname())
	}
	return nil
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

	if err := assertFetchable(ctx, u); err != nil {
		httpx.Err(w, 502, "preview unavailable")
		return
	}

	req, _ := http.NewRequestWithContext(ctx, "GET", key, nil)
	req.Header.Set("User-Agent", "VaultChatBot/1.0 (+link-preview)")
	req.Header.Set("Accept", "text/html")
	// linkClient, never http.DefaultClient: it refuses redirects that leave the
	// policy and dials only addresses it has just vetted. See its definition.
	resp, err := linkClient.Do(req)
	if err != nil {
		httpx.Err(w, 502, "preview unavailable")
		return
	}
	defer resp.Body.Close()

	// Belt and braces. CheckRedirect already refused any hop that failed the
	// policy, so reaching here with a non-public final URL should be impossible
	// — but a preview is not worth trusting "should be" on.
	if err := assertFetchable(ctx, resp.Request.URL); err != nil {
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
