// user_terms_negotiation_test.go — GET /user/terms answers the same state in
// two representations, and the JSON one did not move.
//
// This is the last authenticated cold-start request to migrate, and it is the
// one with the worst failure mode: if the typed path ever produces
// outstanding=true (or a requiredVersion) that the JSON path would not have, the
// user gets an acceptance screen. lib/terms.ts fails open on every error, so the
// only way to break that is to make the typed path succeed with wrong values.
//
// Two ways this endpoint could do that, and both are checked here:
//
//  1. acceptedAt. It is a *time.Time handed to encoding/json, so the JSON string
//     is RFC3339 with trailing zeros trimmed — time.RFC3339Nano — INCLUDING the
//     offset, because pgx can return a non-UTC location. It is NOT httpx.JSTime
//     ("2006-01-02T15:04:05.000Z"), which would both normalise the offset and
//     re-add the trimmed zeros. The fixture below deliberately carries a +05:30
//     offset and a trailing zero so either mistake is visible, and the test
//     compares against what encoding/json itself produces rather than a
//     hand-copied literal.
//  2. Null vs absent. A user who has never accepted gets two explicit JSON
//     nulls; on the wire those two fields are ABSENT (they are `optional`), and
//     lib/termsPolicy.ts maps absence back to null. Both halves are pinned.
//
// The database is not involved: termsGetWrite is the whole negotiation, and it
// is driven here with fixed values.
package routes

import (
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	ccwirev1 "vaultchat/backend-go/internal/ccwire/gen/ccwire/v1"

	"google.golang.org/protobuf/proto"
)

// A non-UTC location with a trailing zero in the fractional second. Both are
// deliberate: +05:30 catches a format that forces "Z", and .890 catches one that
// does not trim (RFC3339Nano renders it ".89").
var termsAcceptedAt = time.Date(2026, 3, 4, 5, 6, 7, 890000000,
	time.FixedZone("IST", 5*3600+30*60))

// A user who accepted an older label than the one now in force.
func termsFixture() termsGetData {
	at := termsAcceptedAt
	return termsGetData{
		RequiredVersion: "2026-09",
		AcceptedVersion: strptr("2026-03"),
		AcceptedAt:      &at,
		Outstanding:     true,
		URL:             defaultTermsURL,
	}
}

// A user who has never accepted anything. Two nulls in the JSON, two absent
// fields on the wire.
func termsNeverAccepted() termsGetData {
	return termsGetData{
		RequiredVersion: "2026-09",
		AcceptedVersion: nil,
		AcceptedAt:      nil,
		Outstanding:     true,
		URL:             defaultTermsURL,
	}
}

// No terms configured at all — requiredVersion is "" and nobody is asked. The
// proto3 wire elides both "" and false, so only `url` survives; the JSON still
// writes all five keys. This is the pair most likely to be quietly broken by a
// schema marked `optional` in the wrong places.
func termsNobodyAsked() termsGetData {
	return termsGetData{RequiredVersion: "", Outstanding: false, URL: defaultTermsURL}
}

func getTerms(t *testing.T, accept string, d termsGetData) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/user/terms", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	termsGetWrite(w, r, d)
	return w
}

// Hand-written from the handler's map literal, NOT captured from the serializer.
// encoding/json sorts map keys, so the order below is alphabetical and that is
// part of the pinned contract.
const legacyTermsJSON = `{"acceptedAt":"2026-03-04T05:06:07.89+05:30",` +
	`"acceptedVersion":"2026-03","outstanding":true,"requiredVersion":"2026-09",` +
	`"url":"https://api.corefinite.com/terms"}` + "\n"

const legacyTermsNeverAcceptedJSON = `{"acceptedAt":null,"acceptedVersion":null,` +
	`"outstanding":true,"requiredVersion":"2026-09",` +
	`"url":"https://api.corefinite.com/terms"}` + "\n"

func TestTermsJSONUnchangedWithoutNegotiation(t *testing.T) {
	for _, accept := range []string{
		"",
		"application/json",
		"*/*",
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	} {
		w := getTerms(t, accept, termsFixture())
		if w.Code != 200 {
			t.Fatalf("Accept %q: status %d, want 200", accept, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("Accept %q: Content-Type %q, want the JSON one", accept, ct)
		}
		if got := w.Body.String(); got != legacyTermsJSON {
			t.Errorf("Accept %q: body changed\n got %s\nwant %s", accept, got, legacyTermsJSON)
		}
		if got := getTerms(t, accept, termsNeverAccepted()).Body.String(); got != legacyTermsNeverAcceptedJSON {
			t.Errorf("Accept %q: never-accepted body changed\n got %s\nwant %s",
				accept, got, legacyTermsNeverAcceptedJSON)
		}
	}
}

// The JSON really does carry five keys with two of them null — checked
// structurally so a reordering refactor cannot hide a key that went missing.
// This is the assertion the TS decoder's `?? null` exists to match.
func TestTermsNeverAcceptedJSONHasExplicitNulls(t *testing.T) {
	var js map[string]any
	if err := json.Unmarshal(getTerms(t, "application/json", termsNeverAccepted()).Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(js) != 5 {
		t.Errorf("answer has %d keys, want 5: %#v", len(js), js)
	}
	for _, k := range []string{"acceptedVersion", "acceptedAt"} {
		v, ok := js[k]
		if !ok {
			t.Errorf("%s: key is MISSING; the JSON contract spells this null", k)
		} else if v != nil {
			t.Errorf("%s = %#v, want null", k, v)
		}
	}
}

func decodeTermsReply(t *testing.T, w *httptest.ResponseRecorder) *ccwirev1.TermsState {
	t.Helper()
	var reply ccwirev1.TermsState
	if err := proto.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatalf("response is not a valid TermsState: %v", err)
	}
	return &reply
}

func TestTermsProtobufSameValues(t *testing.T) {
	w := getTerms(t, protobufMediaType, termsFixture())
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != protobufMediaType {
		t.Fatalf("Content-Type %q, want %s", ct, protobufMediaType)
	}
	want := &ccwirev1.TermsState{
		RequiredVersion: "2026-09",
		AcceptedVersion: strptr("2026-03"),
		AcceptedAt:      strptr("2026-03-04T05:06:07.89+05:30"),
		Outstanding:     true,
		Url:             defaultTermsURL,
	}
	if got := decodeTermsReply(t, w); !proto.Equal(got, want) {
		t.Errorf("decoded reply = %v\nwant %v", got, want)
	}
}

// THE TIMESTAMP, against encoding/json itself rather than a literal.
//
// This is the check that fails the moment somebody "tidies" the format into
// httpx.JSTime: JSTime renders UTC with fixed milliseconds, so it would answer
// "2026-03-03T23:36:07.890Z" for this fixture — a different instant's spelling,
// a different offset, and a different string, all silently.
func TestTermsProtobufTimeMatchesEncodingJSON(t *testing.T) {
	at := termsAcceptedAt
	b, err := json.Marshal(&at)
	if err != nil {
		t.Fatalf("json: %v", err)
	}
	var viaJSON string
	if err := json.Unmarshal(b, &viaJSON); err != nil {
		t.Fatalf("json: %v", err)
	}
	got := decodeTermsReply(t, getTerms(t, protobufMediaType, termsFixture()))
	if got.AcceptedAt == nil {
		t.Fatal("acceptedAt: absent on a row that has one")
	}
	if *got.AcceptedAt != viaJSON {
		t.Errorf("acceptedAt on the wire = %q\nencoding/json writes  = %q", *got.AcceptedAt, viaJSON)
	}
	// And the exact spelling, pinned, so a change in Go's own marshaller is
	// visible here rather than only as a client-side surprise. Offset kept, and
	// the trailing zero of .890 trimmed — both are RFC3339Nano's doing.
	if *got.AcceptedAt != "2026-03-04T05:06:07.89+05:30" {
		t.Errorf("acceptedAt = %q, want 2026-03-04T05:06:07.89+05:30", *got.AcceptedAt)
	}
}

// PRESENCE, per field. proto.Equal above would still pass if the never-accepted
// case had been flattened to empty strings, because an empty string and an
// absent optional compare equal only when BOTH sides agree — and the wrong
// `want` is exactly what a careless fix would write.
func TestTermsPresencePerField(t *testing.T) {
	never := decodeTermsReply(t, getTerms(t, protobufMediaType, termsNeverAccepted()))
	if never.AcceptedVersion != nil {
		t.Errorf("acceptedVersion = %q, must be ABSENT so the client can write null", *never.AcceptedVersion)
	}
	if never.AcceptedAt != nil {
		t.Errorf("acceptedAt = %q, must be ABSENT so the client can write null", *never.AcceptedAt)
	}
	if never.RequiredVersion != "2026-09" || !never.Outstanding || never.Url != defaultTermsURL {
		t.Errorf("the other three fields moved: %v", never)
	}

	// An accepted version that is literally the empty string is a DIFFERENT
	// state from never having accepted, and `optional` is what keeps them apart.
	d := termsNeverAccepted()
	d.AcceptedVersion = strptr("")
	empty := decodeTermsReply(t, getTerms(t, protobufMediaType, d))
	if empty.AcceptedVersion == nil {
		t.Error("acceptedVersion: an explicit \"\" must be present, not absent")
	} else if *empty.AcceptedVersion != "" {
		t.Errorf("acceptedVersion = %q, want \"\"", *empty.AcceptedVersion)
	}

	// Nobody asked: requiredVersion "" and outstanding false are proto3 defaults
	// and vanish from the wire, which is correct — they decode back to "" and
	// false. The JSON still writes all five keys either way.
	asked := decodeTermsReply(t, getTerms(t, protobufMediaType, termsNobodyAsked()))
	if asked.RequiredVersion != "" || asked.Outstanding {
		t.Errorf("nobody-asked decoded to %v", asked)
	}
	if asked.Url != defaultTermsURL {
		t.Errorf("url = %q, want the default even when no terms are in force", asked.Url)
	}
}

// CROSS-LANGUAGE BYTE PIN. The TS side asserts these same hex strings
// (lib/termsNegotiation.selftest.ts). Semantic agreement alone would let the two
// languages drift onto different field numbers and still both pass; the byte pin
// is what makes them one contract.
//
// Field by field for the populated row: 0a07 required_version "2026-09",
// 1207 accepted_version "2026-03", 1a1c + 28 bytes of the timestamp verbatim
// (offset included — this is where a JSTime "fix" changes the bytes), 2001
// outstanding=true, 2a20 + the 32-byte default URL.
const termsGoldenWire = "0a07323032362d30391207323032362d3033" +
	"1a1c323032362d30332d30345430353a30363a30372e38392b30353a333020012a20" +
	"68747470733a2f2f6170692e636f726566696e6974652e636f6d2f7465726d73"

// The never-accepted row: fields 2 and 3 are simply not there. 18 bytes shorter,
// and the absence is the whole message.
const termsNeverAcceptedGoldenWire = "0a07323032362d30392001" +
	"2a2068747470733a2f2f6170692e636f726566696e6974652e636f6d2f7465726d73"

func TestTermsWireBytePin(t *testing.T) {
	if got := hex.EncodeToString(getTerms(t, protobufMediaType, termsFixture()).Body.Bytes()); got != termsGoldenWire {
		t.Errorf("wire bytes = %s\n          want %s", got, termsGoldenWire)
	}
	if got := hex.EncodeToString(getTerms(t, protobufMediaType, termsNeverAccepted()).Body.Bytes()); got != termsNeverAcceptedGoldenWire {
		t.Errorf("never-accepted wire bytes = %s\n                      want %s", got, termsNeverAcceptedGoldenWire)
	}
}
