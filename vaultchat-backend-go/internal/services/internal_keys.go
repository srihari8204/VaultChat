package services

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"
)

// InternalCaller authenticates a call to one of core's service endpoints
// (/internal/emit, /internal/chat-event, /internal/notify,
// /internal/users/cards) by its X-Internal-Key header.
//
// Two sources of keys, both optional:
//
//   - INTERNAL_EMIT_KEY — the one shared key the bridge has always used. The
//     caller is reported as "internal".
//   - INTERNAL_SERVICE_KEYS — one key per feature service, as
//     "golive=<key>,family=<key>". A leaked Go Live key can then be rotated
//     without touching any other service, and logs say who called.
//
// Every configured key is compared in constant time, and with no key
// configured nothing is accepted.
func InternalCaller(r *http.Request) (string, bool) {
	got := []byte(r.Header.Get("X-Internal-Key"))
	if len(got) == 0 {
		return "", false
	}
	caller, ok := "", false
	check := func(name, key string) {
		if key != "" && subtle.ConstantTimeCompare(got, []byte(key)) == 1 && !ok {
			caller, ok = name, true
		}
	}
	check("internal", os.Getenv("INTERNAL_EMIT_KEY"))
	for _, entry := range strings.Split(os.Getenv("INTERNAL_SERVICE_KEYS"), ",") {
		name, key, found := strings.Cut(strings.TrimSpace(entry), "=")
		if name = strings.TrimSpace(name); found && isKnown(name) {
			check(name, strings.TrimSpace(key))
		}
	}
	return caller, ok
}
