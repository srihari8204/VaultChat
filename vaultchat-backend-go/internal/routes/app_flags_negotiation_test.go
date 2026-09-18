// app_flags_negotiation_test.go — GET /app/flags answers the same kill switches
// in two representations, and the JSON one did not move.
//
// The risk here is not "does protobuf encode a list of strings". It is that the
// typed path erodes the ASYMMETRY this endpoint exists to enforce: the server
// can only turn features OFF, and a remote `true` must do nothing. There are
// three ways a migration can break that, and each has a test below:
//
//  1. a `true` leaks onto the wire in one representation but not the other, so
//     a capture looks like a remote-enable primitive (and a future client might
//     honour it);
//  2. the empty answer stops being empty, or stops being decodable — a zero-byte
//     body must mean "nothing is switched off", not "the request failed";
//  3. the two representations disagree about WHICH names are on the wire, or in
//     what order. Go randomises map iteration and encoding/json sorts object
//     keys, so without disabledNames()'s sort the typed bytes would differ run
//     to run while the JSON did not — and the cross-language byte pin below
//     would be unpinnable.
//
// Nothing but the env var drives this handler, so every case here is exact.
package routes

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	ccwirev1 "vaultchat/backend-go/internal/ccwire/gen/ccwire/v1"

	"google.golang.org/protobuf/proto"
)

// resetAppFlagsCache drops the 60s memo in appflags.go. appFlags() also keys the
// memo on the raw env string, so consecutive tests with different values would
// already miss — this is here so a test that reuses a value another test used
// still re-reads, and so ordering can never make a result stale.
func resetAppFlagsCache(t *testing.T) {
	t.Helper()
	flagsMu.Lock()
	flagsCache, flagsRaw = nil, ""
	flagsMu.Unlock()
}

func getAppFlags(t *testing.T, accept, env string) *httptest.ResponseRecorder {
	t.Helper()
	t.Setenv("VAULTCHAT_REMOTE_FLAGS", env)
	resetAppFlagsCache(t)
	r := httptest.NewRequest(http.MethodGet, "/app/flags", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	appFlagsGet(w, r)
	return w
}

// The fixture, and the only set of killed flags the byte pin covers. Written
// UNSORTED on purpose: "mini.games" sorts after "call.video", so a handler that
// forgot to sort would ship them in whatever order the map hands back.
const appFlagsEnv = `{"mini.games": false, "call.video": false}`

// Hand-written from the handler's map literal, NOT captured from the serializer.
// encoding/json sorts both the outer keys and the flags object, so this order is
// part of the pinned contract.
const legacyAppFlagsJSON = `{"flags":{"call.video":false,"mini.games":false},` +
	`"note":"false disables a feature; true is ignored. This endpoint cannot enable anything."}` + "\n"

const legacyAppFlagsEmptyJSON = `{"flags":{},` +
	`"note":"false disables a feature; true is ignored. This endpoint cannot enable anything."}` + "\n"

func TestAppFlagsJSONUnchangedWithoutNegotiation(t *testing.T) {
	for _, accept := range []string{
		"",
		"application/json",
		"*/*",
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	} {
		w := getAppFlags(t, accept, appFlagsEnv)
		if w.Code != 200 {
			t.Fatalf("Accept %q: status %d, want 200", accept, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("Accept %q: Content-Type %q, want the JSON one", accept, ct)
		}
		if got := w.Body.String(); got != legacyAppFlagsJSON {
			t.Errorf("Accept %q: body changed\n got %s\nwant %s", accept, got, legacyAppFlagsJSON)
		}
		if got := getAppFlags(t, accept, "").Body.String(); got != legacyAppFlagsEmptyJSON {
			t.Errorf("Accept %q: empty body changed\n got %s\nwant %s",
				accept, got, legacyAppFlagsEmptyJSON)
		}
	}
}

func decodeAppFlagsReply(t *testing.T, w *httptest.ResponseRecorder) *ccwirev1.AppFlags {
	t.Helper()
	var reply ccwirev1.AppFlags
	if err := proto.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatalf("response is not a valid AppFlags: %v", err)
	}
	return &reply
}

// EQUIVALENCE. The two representations must name exactly the same flags, so the
// client's persisted snapshot (vaultchat.remoteFlags.v1) is identical either
// way. Compared as a decoded object, not as text: the JSON path's `{name:false}`
// is rebuilt from the typed path's list and the two must match key for key.
func TestAppFlagsProtobufMatchesJSON(t *testing.T) {
	w := getAppFlags(t, protobufMediaType, appFlagsEnv)
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != protobufMediaType {
		t.Fatalf("Content-Type %q, want %s", ct, protobufMediaType)
	}
	want := &ccwirev1.AppFlags{Disabled: []string{"call.video", "mini.games"}}
	got := decodeAppFlagsReply(t, w)
	if !proto.Equal(got, want) {
		t.Errorf("decoded reply = %v\nwant %v", got, want)
	}

	// And now the same comparison the client makes: rebuild {name:false} from
	// the list and hold it against the JSON body's flags object.
	rebuilt := map[string]bool{}
	for _, n := range got.Disabled {
		rebuilt[n] = false
	}
	var js struct {
		Flags map[string]bool `json:"flags"`
	}
	if err := json.Unmarshal(getAppFlags(t, "application/json", appFlagsEnv).Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(rebuilt) != len(js.Flags) {
		t.Fatalf("typed path named %d flags, JSON path named %d: %v vs %v",
			len(rebuilt), len(js.Flags), rebuilt, js.Flags)
	}
	for k, v := range js.Flags {
		if rv, ok := rebuilt[k]; !ok || rv != v {
			t.Errorf("flag %q: JSON says %v, typed path says %v (present=%v)", k, v, rv, ok)
		}
	}
}

// THE EMPTY ANSWER. Nothing switched off ⇒ an empty repeated field ⇒ proto3
// writes NOTHING. Zero bytes is a complete, valid, meaningful answer here, and
// the client must decode it to `{}` rather than treat a zero-length body as a
// failure. Asserted on the length, because that is the thing a future field
// with a default value would silently change.
func TestAppFlagsEmptyAnswerIsZeroBytes(t *testing.T) {
	for _, env := range []string{"", "{}", "   ", "not json at all"} {
		w := getAppFlags(t, protobufMediaType, env)
		if w.Code != 200 {
			t.Fatalf("env %q: status %d, want 200", env, w.Code)
		}
		if n := len(w.Body.Bytes()); n != 0 {
			t.Errorf("env %q: no flags killed encoded to %d bytes, want 0 (%s)",
				env, n, hex.EncodeToString(w.Body.Bytes()))
		}
		if d := decodeAppFlagsReply(t, w).Disabled; len(d) != 0 {
			t.Errorf("env %q: zero bytes decoded to %v, want an empty list", env, d)
		}
	}
}

// NO REMOTE ENABLE. This is the whole security property: appFlags() deletes
// every `true`, so a flag an operator set to true must appear in NEITHER
// representation — not as a name in the list, not as a key in the JSON.
func TestAppFlagsTrueNeverReachesTheWire(t *testing.T) {
	const env = `{"mini.games": false, "call.video": true, "chat.search": true}`

	for _, n := range decodeAppFlagsReply(t, getAppFlags(t, protobufMediaType, env)).Disabled {
		if n != "mini.games" {
			t.Errorf("typed path carried %q — a flag set to true is not a kill switch", n)
		}
	}
	if got := hex.EncodeToString(getAppFlags(t, protobufMediaType, env).Body.Bytes()); got != appFlagsGoldenOne {
		t.Errorf("typed body = %s\n          want %s (mini.games alone)", got, appFlagsGoldenOne)
	}

	var js struct {
		Flags map[string]bool `json:"flags"`
	}
	if err := json.Unmarshal(getAppFlags(t, "application/json", env).Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(js.Flags) != 1 {
		t.Errorf("JSON path carried %v, want mini.games alone", js.Flags)
	}
	for k, v := range js.Flags {
		if v {
			t.Errorf("JSON path carried %q:true — this endpoint cannot enable anything", k)
		}
	}
}

// SORTED NAMES, asserted the only way a randomised iteration order can be
// asserted: repeatedly. Go picks a random start offset per range over a map, so
// a single unsorted run agrees with the pin about half the time; 64 runs make a
// missing sort.Strings a 1-in-2^64 escape rather than a coin flip.
func TestAppFlagsNamesAreSorted(t *testing.T) {
	flags := map[string]bool{
		"mini.games": false, "call.video": false, "chat.search": false, "app.themes": false,
	}
	want := []string{"app.themes", "call.video", "chat.search", "mini.games"}
	for i := 0; i < 64; i++ {
		got := disabledNames(flags)
		for j := range want {
			if got[j] != want[j] {
				t.Fatalf("run %d: disabledNames = %v, want %v — is sort.Strings still there?",
					i, got, want)
			}
		}
	}
}

// CROSS-LANGUAGE BYTE PIN. The TS side asserts these same hex strings
// (lib/appFlagsNegotiation.selftest.ts).
//
// Field by field: 0a is `repeated string disabled = 1` (field 1, length
// delimited), then the length, then the name verbatim in UTF-8. Two names, in
// sorted order — "call.video" before "mini.games" — so this string is also what
// breaks first if the sort goes away.
const appFlagsGoldenWire = "0a0a63616c6c2e766964656f" + "0a0a6d696e692e67616d6573"

// One name alone, used by the no-remote-enable test above.
const appFlagsGoldenOne = "0a0a6d696e692e67616d6573"

func TestAppFlagsWireBytePin(t *testing.T) {
	// Looped for the same reason as TestAppFlagsNamesAreSorted: the handler
	// re-ranges the cached map on every request, so an unsorted build is only
	// caught by asking more than once.
	for i := 0; i < 64; i++ {
		got := hex.EncodeToString(getAppFlags(t, protobufMediaType, appFlagsEnv).Body.Bytes())
		if got != appFlagsGoldenWire {
			t.Fatalf("run %d: wire bytes = %s\n          want %s", i, got, appFlagsGoldenWire)
		}
	}
	if got := hex.EncodeToString(getAppFlags(t, protobufMediaType, "").Body.Bytes()); got != "" {
		t.Errorf("the no-flags answer is %s, want zero bytes", got)
	}
}
