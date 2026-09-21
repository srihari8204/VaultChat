// accept_negotiation_test.go — the ONE Accept rule, and the proof that all nine
// negotiated endpoints go through it.
//
// The per-endpoint negotiation tests next door each pin their own body bytes.
// None of them pins the QUESTION those bodies are chosen by, and that question
// used to be `strings.Contains(Accept, "application/protobuf")` written out six
// times. A substring test answers yes to two kinds of request that are not a
// request for protobuf:
//
//   - "application/protobuf;q=0" — RFC 9110 §12.5.1 makes a qvalue of 0 an
//     explicit REFUSAL. The old code answered the refusal with the very bytes
//     the client said it could not take. lib/appVersion.ts calls res.json() on
//     /app/version at cold start, so that lands as a parse error in front of the
//     blocking screen, on an endpoint that is deliberately unauthenticated and
//     deliberately the first thing the app asks for.
//   - "application/protobuf-text", "application/protobuffer" — different media
//     types that happen to start with the same characters.
//
// The endpoint sweep is what keeps the rule from being re-forked: adding a
// negotiated handler that calls strings.Contains again fails here, not in
// production.
//
// No database: every handler under test is either env-driven or has a …Write
// function that takes its data directly.
package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vaultchat/backend-go/internal/httpx"
)

func TestAcceptsProtobufRule(t *testing.T) {
	for _, tc := range []struct {
		accept string
		want   bool
		why    string
	}{
		{"", false, "no header at all — every client shipped so far"},
		{"application/json", false, "asked for JSON"},
		{"*/*", false, "a wildcard is not a request for protobuf"},
		{"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
			false, "a browser"},

		{"application/protobuf", true, "asked for it by name"},
		{"application/protobuf, application/json", true, "named it first"},
		{"application/json, application/protobuf", true, "named it second"},
		{" application/protobuf ", true, "OWS around the media range"},
		{"APPLICATION/PROTOBUF", true, "media types are case-insensitive"},
		{"application/protobuf;q=0.2", true, "a low preference is still a yes"},
		{"application/protobuf;q=1.0", true, "explicit full preference"},

		// The refusal. This is the one the substring test got wrong.
		{"application/protobuf;q=0", false, "q=0 means NOT ACCEPTABLE"},
		{"application/protobuf;q=0.0", false, "same refusal, written long"},
		{"application/protobuf; q=0", false, "OWS before the parameter"},
		{"application/protobuf;Q=0", false, "parameter names are case-insensitive"},
		{"application/json, application/protobuf;q=0", false,
			"refused protobuf while asking for JSON — the realistic form"},
		{"application/protobuf;charset=utf-8;q=0", false, "q is not the first parameter"},

		// Lookalikes. Different media types, matched by a prefix test.
		{"application/protobuf-text", false, "a DIFFERENT media type"},
		{"application/protobuffer", false, "also a different media type"},
		{"application/x-protobuf", false, "the vendor-prefixed name is not ours"},

		// A malformed qvalue is a broken client, not a refusal: it gets what it
		// would have got before it sent the parameter.
		{"application/protobuf;q=banana", true, "unparseable q is not a refusal"},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/app/version", nil)
		if tc.accept != "" {
			r.Header.Set("Accept", tc.accept)
		}
		if got := acceptsProtobuf(w, r); got != tc.want {
			t.Errorf("acceptsProtobuf(%q) = %v, want %v — %s", tc.accept, got, tc.want, tc.why)
		}
		if v := w.Header().Get("Vary"); v != "Accept" {
			t.Errorf("Accept %q: Vary = %q, want \"Accept\" — one URL, two bodies", tc.accept, v)
		}
	}
}

// acceptCase drives one negotiated endpoint with one Accept header. Every entry
// answers WITHOUT a database.
type acceptCase struct {
	name string
	call func(w http.ResponseWriter, r *http.Request)
}

func acceptNegotiatedEndpoints() []acceptCase {
	return []acceptCase{
		{"/app/version", appVersionGet},
		{"/app/flags", appFlagsGet},
		{"/chats", func(w http.ResponseWriter, r *http.Request) {
			chatsListWrite(w, r, []chatsListItem{})
		}},
		{"/chats/delta", func(w http.ResponseWriter, r *http.Request) {
			chatsDeltaWrite(w, r, []chatsPublicMsg{}, 0, false, "",
				[]chatsPublicMsg{}, "", httpx.JSTime(time.Unix(0, 0).UTC()))
		}},
		{"/chats/common", func(w http.ResponseWriter, r *http.Request) {
			chatsCommonWrite(w, r, []commonGroup{})
		}},
		{"/user/security-overview", func(w http.ResponseWriter, r *http.Request) {
			userSecurityOverviewWrite(w, r, userSecurityOverviewData{})
		}},
		// Registered the same day userProfileWrite gained its protobuf branch.
		// This list is the ONLY place the q=0-refusal, lookalike-media-type and
		// Vary rules are checked, and a new negotiating endpoint that is not
		// added here looks fully tested while none of those hold for it.
		{"/user/profile", func(w http.ResponseWriter, r *http.Request) {
			userProfileWrite(w, r, &userUsersRow{})
		}},
		{"/user/backup/meta", func(w http.ResponseWriter, r *http.Request) {
			userBackupMetaWrite(w, r, userBackupMetaData{})
		}},
		{"/user/contact-verifications", func(w http.ResponseWriter, r *http.Request) {
			userContactVerificationsWrite(w, r, []string{})
		}},
		{"/user/terms", func(w http.ResponseWriter, r *http.Request) {
			termsGetWrite(w, r, termsGetData{URL: defaultTermsURL})
		}},
	}
}

func acceptServe(c acceptCase, accept string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	c.call(w, r)
	return w
}

const acceptJSONContentType = "application/json; charset=utf-8"

// A client that named protobuf ONLY to refuse it must be answered in JSON —
// every endpoint, not just the one that was fixed first.
func TestNegotiatedEndpointsHonourProtobufRefusal(t *testing.T) {
	for _, c := range acceptNegotiatedEndpoints() {
		for _, accept := range []string{
			"application/protobuf;q=0",
			"application/json, application/protobuf;q=0",
			"application/protobuf; q=0.0",
		} {
			w := acceptServe(c, accept)
			if ct := w.Header().Get("Content-Type"); ct != acceptJSONContentType {
				t.Errorf("%s with Accept %q: Content-Type %q, want %q — q=0 is a refusal, "+
					"and this body is the one the client said it could not read",
					c.name, accept, ct, acceptJSONContentType)
			}
		}
	}
}

// A media type that merely starts with the same characters is a different media
// type, and must not switch the representation.
func TestNegotiatedEndpointsIgnoreLookalikeMediaTypes(t *testing.T) {
	for _, c := range acceptNegotiatedEndpoints() {
		for _, accept := range []string{
			"application/protobuf-text",
			"application/protobuffer",
			"application/x-protobuf",
		} {
			w := acceptServe(c, accept)
			if ct := w.Header().Get("Content-Type"); ct != acceptJSONContentType {
				t.Errorf("%s with Accept %q: Content-Type %q, want %q — that is not our media type",
					c.name, accept, ct, acceptJSONContentType)
			}
		}
	}
}

// Both representations come back from one URL, chosen by a request header, and
// two of these endpoints are unauthenticated GETs behind Caddy. A shared cache
// that does not know Accept is significant will serve one client's protobuf to
// the next client's res.json().
func TestNegotiatedEndpointsVaryOnAccept(t *testing.T) {
	for _, c := range acceptNegotiatedEndpoints() {
		for _, accept := range []string{"", "application/json", protobufMediaType} {
			w := acceptServe(c, accept)
			if v := w.Header().Get("Vary"); v != "Accept" {
				t.Errorf("%s with Accept %q: Vary %q, want \"Accept\"", c.name, accept, v)
			}
		}
	}
}

func TestNegotiatedEndpointsPreserveHeaderLists(t *testing.T) {
	for _, c := range acceptNegotiatedEndpoints() {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.Header.Add("Accept", "application/json")
			r.Header.Add("Accept", protobufMediaType)
			w := httptest.NewRecorder()
			w.Header().Add("Vary", "Origin")
			c.call(w, r)
			if got := w.Header().Get("Content-Type"); got != protobufMediaType {
				t.Fatalf("split Accept header: Content-Type = %q", got)
			}
			if got := strings.Join(w.Header().Values("Vary"), ","); got != "Origin,Accept" {
				t.Fatalf("Vary = %q, want Origin,Accept", got)
			}
		})
	}
}

// And the plain positive case still switches, so the three tests above cannot
// pass by the negotiation having been turned off.
func TestNegotiatedEndpointsStillServeProtobufWhenAsked(t *testing.T) {
	for _, c := range acceptNegotiatedEndpoints() {
		w := acceptServe(c, protobufMediaType)
		if ct := w.Header().Get("Content-Type"); ct != protobufMediaType {
			t.Errorf("%s: Content-Type %q, want %q", c.name, ct, protobufMediaType)
		}
	}
}
