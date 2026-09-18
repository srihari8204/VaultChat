// appflags.go — the kill switch. Turn a misbehaving feature off without a release.
//
// AUDIT F11 (second half). Every feature flag in this app is a build-time
// constant in constants/flags.ts, so disabling a feature that starts
// misbehaving means shipping a new build — and a new build reaches only the
// people who update. During an incident that is not a lever, it is a wish.
//
// A KILL SWITCH, NOT A LAUNCHER. This endpoint can only turn things OFF; the
// client applies `remote AND build-time` (see lib/remoteFlagPolicy.ts). That
// asymmetry is the whole safety argument:
//
//   - turning something off remotely is always safe — the worst case is a
//     feature the user cannot reach, which is exactly what was intended;
//   - turning something ON remotely would activate a code path that the
//     installed build may not have, may have shipped half-finished, or may
//     never have tested in that combination. An unauthenticated endpoint that
//     can do that is a remote-enable primitive pointed at every installation.
//
// So a flag set to true here does nothing at all. Only false is honoured.
//
// DELIBERATELY UNAUTHENTICATED, like /app/version next door: the client needs
// it before deciding what to render, which may be before it has a session. It
// reveals only which optional features an operator has switched off.
//
// DELIBERATELY ENV-DRIVEN. Killing a feature is an operational act taken in a
// hurry — an env var and a container restart beats a migration, and there is
// nothing to get out of sync between replicas.
//
//	VAULTCHAT_REMOTE_FLAGS  a JSON object, e.g. {"mini.games": false}
//
// Unset, empty, or unparseable all mean "{}" — nothing is overridden and every
// client behaves exactly as its build intends. A typo in an env var must never
// take features away from everyone.
package routes

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	ccwirev1 "vaultchat/backend-go/internal/ccwire/gen/ccwire/v1"
	"vaultchat/backend-go/internal/httpx"

	"google.golang.org/protobuf/proto"
)

// Parsed once and cached: this is read on every cold start of every client, and
// re-parsing a JSON blob per request to answer with the same handful of bytes
// is waste. The cache expires so an operator can change the variable and
// restart — or, if the platform rewrites env in place, see it within a minute.
var (
	flagsMu     sync.Mutex
	flagsCache  map[string]bool
	flagsRaw    string
	flagsExpiry time.Time
)

const flagsTTL = 60 * time.Second

func appFlags() map[string]bool {
	flagsMu.Lock()
	defer flagsMu.Unlock()

	raw := strings.TrimSpace(os.Getenv("VAULTCHAT_REMOTE_FLAGS"))
	if flagsCache != nil && raw == flagsRaw && time.Now().Before(flagsExpiry) {
		return flagsCache
	}

	out := map[string]bool{}
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &out); err != nil {
			// Loud, because the silent version of this is the dangerous one: an
			// operator types a broken JSON blob during an incident, believes a
			// feature is off, and it is not.
			log.Printf("[app/flags] VAULTCHAT_REMOTE_FLAGS is not a JSON object of booleans — ignoring it: %v", err)
			out = map[string]bool{}
		}
	}

	// Drop every `true`. The client ignores them anyway; removing them here
	// means the wire never carries something that looks like a remote enable,
	// so nobody reading a capture concludes that it is one.
	for k, v := range out {
		if v {
			delete(out, k)
		}
	}

	flagsCache, flagsRaw, flagsExpiry = out, raw, time.Now().Add(flagsTTL)
	return out
}

func RegisterAppFlags(mux *http.ServeMux) {
	mux.HandleFunc("GET /app/flags", appFlagsGet)
}

// disabledNames — the flags that are switched off, sorted.
//
// appFlags() has already dropped every `true`, so every remaining key is a
// feature an operator turned off. Sorted because Go randomises map iteration
// and encoding/json sorts object keys: without this the typed bytes would
// differ run to run while the JSON did not.
func disabledNames(flags map[string]bool) []string {
	names := make([]string, 0, len(flags))
	for k := range flags {
		names = append(names, k)
	}
	sort.Strings(names)
	return names
}

func appFlagsGet(w http.ResponseWriter, r *http.Request) {
	flags := appFlags()

	if acceptsProtobuf(w, r) {
		if b, err := proto.Marshal(&ccwirev1.AppFlags{Disabled: disabledNames(flags)}); err == nil {
			w.Header().Set("Content-Type", protobufMediaType)
			w.WriteHeader(200)
			_, _ = w.Write(b)
			return
		}
		// Marshal failing here is not reachable for a message this shape, and
		// falling through to JSON is the right answer if it ever became so: the
		// client understands both, and a cold start that gets no flags at all
		// is worse than one that gets them in the older representation.
	}

	httpx.JSON(w, 200, map[string]any{
		"flags": flags,
		// Stated on the wire so the contract is visible to anyone reading a
		// response, not only to anyone reading this file.
		"note": "false disables a feature; true is ignored. This endpoint cannot enable anything.",
	})
}
