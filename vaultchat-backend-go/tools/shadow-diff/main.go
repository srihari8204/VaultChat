// shadow-diff — replay identical requests against the Node and Go backends
// and structurally diff {status, JSON body}, masking volatile fields.
// Exit 1 on any divergence; part of every route's cutover checklist.
//
// One-off:
//
//	go run ./tools/shadow-diff -m GET -p /contacts/trusted -token $JWT
//
// Batch (one JSON object per line: {"method","path","body"?,"token"?}):
//
//	go run ./tools/shadow-diff -f requests.jsonl -token $DEFAULT_JWT
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

var (
	nodeURL = flag.String("node", "http://127.0.0.1:13000", "Node backend base URL")
	goURL   = flag.String("go", "http://127.0.0.1:14000", "Go backend base URL")
	method  = flag.String("m", "GET", "HTTP method (one-off mode)")
	path    = flag.String("p", "", "request path (one-off mode)")
	body    = flag.String("body", "", "JSON body (one-off mode)")
	token   = flag.String("token", "", "Bearer token (default for batch lines without one)")
	file    = flag.String("f", "", "JSONL file of requests (batch mode)")
	ignore  = flag.String("ignore", "id,chatId,messageId,createdAt,updatedAt,expiresAt,lastSeen,uploadUrl,code,retryAfter,uptime,token,jwt",
		"comma-separated field names masked before diffing (volatile per-request values)")
)

type request struct {
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Body   json.RawMessage `json:"body"`
	Token  string          `json:"token"`
}

// mask recursively replaces ignored fields so random ids/timestamps never flag.
func mask(v any, ign map[string]bool) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if ign[k] {
				out[k] = "<masked>"
			} else {
				out[k] = mask(val, ign)
			}
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = mask(val, ign)
		}
		return out
	default:
		return v
	}
}

func do(base string, r request) (int, any, error) {
	var rd io.Reader
	if len(r.Body) > 0 {
		rd = bytes.NewReader(r.Body)
	}
	req, err := http.NewRequest(r.Method, base+r.Path, rd)
	if err != nil {
		return 0, nil, err
	}
	if len(r.Body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	if r.Token != "" {
		req.Header.Set("Authorization", "Bearer "+r.Token)
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		parsed = string(data) // non-JSON bodies compared verbatim
	}
	return resp.StatusCode, parsed, nil
}

func pretty(v any) string {
	b, _ := json.MarshalIndent(v, "  ", "  ")
	return string(b)
}

func diffOne(r request, ign map[string]bool) bool {
	ns, nb, nerr := do(*nodeURL, r)
	gs, gb, gerr := do(*goURL, r)
	label := fmt.Sprintf("%s %s", r.Method, r.Path)
	if nerr != nil || gerr != nil {
		fmt.Printf("✗ %s — transport error: node=%v go=%v\n", label, nerr, gerr)
		return false
	}
	nm, gm := mask(nb, ign), mask(gb, ign)
	statusOK := ns == gs
	bodyOK := pretty(nm) == pretty(gm) // canonical JSON text compare (sorted keys)
	if statusOK && bodyOK {
		fmt.Printf("✓ %s — %d, bodies match\n", label, ns)
		return true
	}
	fmt.Printf("✗ %s — DIVERGED\n", label)
	if !statusOK {
		fmt.Printf("  status: node=%d go=%d\n", ns, gs)
	}
	if !bodyOK {
		fmt.Printf("  node body:\n  %s\n  go body:\n  %s\n", pretty(nm), pretty(gm))
	}
	return false
}

func main() {
	flag.Parse()
	ign := map[string]bool{}
	for _, k := range strings.Split(*ignore, ",") {
		if k = strings.TrimSpace(k); k != "" {
			ign[k] = true
		}
	}

	var reqs []request
	if *file != "" {
		f, err := os.Open(*file)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			var r request
			if err := json.Unmarshal([]byte(line), &r); err != nil {
				fmt.Fprintf(os.Stderr, "bad line: %s\n", line)
				os.Exit(2)
			}
			if r.Token == "" {
				r.Token = *token
			}
			if r.Method == "" {
				r.Method = "GET"
			}
			reqs = append(reqs, r)
		}
	} else {
		if *path == "" {
			fmt.Fprintln(os.Stderr, "need -p <path> or -f <file>")
			os.Exit(2)
		}
		var raw json.RawMessage
		if *body != "" {
			raw = json.RawMessage(*body)
		}
		reqs = []request{{Method: *method, Path: *path, Body: raw, Token: *token}}
	}

	failed := 0
	for _, r := range reqs {
		if !diffOne(r, ign) {
			failed++
		}
	}
	fmt.Printf("\n%d/%d matched\n", len(reqs)-failed, len(reqs))
	if failed > 0 {
		os.Exit(1)
	}
}
