// user_contact_verifications_negotiation_test.go — GET /user/contact-verifications
// answers the same list in two representations, and the JSON one did not move.
//
// The risk this covers is not "does protobuf encode a list of strings". It is
// that a negotiation added to a live endpoint changes what every existing
// client receives. The specific hazard here is the EMPTY case: proto3 elides an
// empty repeated field, so "no verified contacts" is a zero-byte body. A
// decoder that treated a zero-byte body as an error, or as `undefined`, would
// turn "this user has verified nobody" into "the call failed" — and
// app/verify-contact.tsx would render every contact as unverified-because-error
// rather than unverified-because-true. The JSON side must keep saying `[]`, and
// this pins that it does.
//
// The database is not involved: userContactVerificationsWrite is the whole
// negotiation, and it is driven here with fixed values.
package routes

import (
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"

	ccwirev1 "vaultchat/backend-go/internal/ccwire/gen/ccwire/v1"

	"google.golang.org/protobuf/proto"
)

func getContactVerifications(t *testing.T, accept string, verified []string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/user/contact-verifications", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	userContactVerificationsWrite(w, r, verified)
	return w
}

// Hand-written from the handler's map literal, NOT captured from the
// serializer. The empty form is `[]` and not `null` because the handler seeds
// the slice — that distinction is the contract, and a future refactor that
// declared `var verified []string` instead would emit null and fail here.
const legacyContactVerificationsJSON = `{"verified":["alice","bob"]}` + "\n"
const legacyContactVerificationsEmptyJSON = `{"verified":[]}` + "\n"

func TestContactVerificationsJSONUnchangedWithoutNegotiation(t *testing.T) {
	for _, accept := range []string{
		"",
		"application/json",
		"*/*",
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	} {
		w := getContactVerifications(t, accept, []string{"alice", "bob"})
		if w.Code != 200 {
			t.Fatalf("Accept %q: status %d, want 200", accept, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("Accept %q: Content-Type %q, want the JSON one", accept, ct)
		}
		if got := w.Body.String(); got != legacyContactVerificationsJSON {
			t.Errorf("Accept %q: body changed\n got %s\nwant %s",
				accept, got, legacyContactVerificationsJSON)
		}
		if got := getContactVerifications(t, accept, []string{}).Body.String(); got != legacyContactVerificationsEmptyJSON {
			t.Errorf("Accept %q: empty body changed\n got %s\nwant %s",
				accept, got, legacyContactVerificationsEmptyJSON)
		}
	}
}

func decodeContactVerificationsReply(t *testing.T, w *httptest.ResponseRecorder) *ccwirev1.ContactVerifications {
	t.Helper()
	var reply ccwirev1.ContactVerifications
	if err := proto.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatalf("response is not a valid ContactVerifications: %v", err)
	}
	return &reply
}

func TestContactVerificationsProtobufSameValues(t *testing.T) {
	w := getContactVerifications(t, protobufMediaType, []string{"alice", "bob"})
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != protobufMediaType {
		t.Fatalf("Content-Type %q, want %s", ct, protobufMediaType)
	}
	want := &ccwirev1.ContactVerifications{Verified: []string{"alice", "bob"}}
	if got := decodeContactVerificationsReply(t, w); !proto.Equal(got, want) {
		t.Errorf("decoded reply = %v\nwant %v", got, want)
	}
	// Order is what the handler appended, not a set: a reordering here would be
	// a silent behaviour change for anything that ever compared the two
	// representations positionally.
	if got := decodeContactVerificationsReply(t, w).Verified; got[0] != "alice" || got[1] != "bob" {
		t.Errorf("order changed: %v", got)
	}
}

// THE EMPTY CASE, both directions. A zero-byte body is the correct encoding of
// an empty list, and it must decode back to an empty list rather than to
// nothing at all.
func TestContactVerificationsEmptyIsAZeroByteBody(t *testing.T) {
	w := getContactVerifications(t, protobufMediaType, []string{})
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if n := w.Body.Len(); n != 0 {
		t.Errorf("empty list encoded to %d bytes (%s), want 0 — proto3 elides it",
			n, hex.EncodeToString(w.Body.Bytes()))
	}
	if got := decodeContactVerificationsReply(t, w).Verified; len(got) != 0 {
		t.Errorf("zero-byte body decoded to %v, want an empty list", got)
	}
}

// CROSS-LANGUAGE BYTE PIN. Pinning the bytes rather than only the semantics is
// what makes Go and TypeScript one contract instead of two independent readings
// of the schema: semantic agreement alone would let them drift onto different
// field numbers and both still "pass". The TS side asserts this same hex
// (lib/contactVerificationsNegotiation.selftest.ts).
//
// Field by field: 0a05 + "alice" (field 1, 5 bytes), 0a03 + "bob" (field 1
// again — a repeated string is simply the tag written once per element).
const contactVerificationsGoldenWire = "0a05616c6963650a03626f62"

func TestContactVerificationsWireBytePin(t *testing.T) {
	w := getContactVerifications(t, protobufMediaType, []string{"alice", "bob"})
	if got := hex.EncodeToString(w.Body.Bytes()); got != contactVerificationsGoldenWire {
		t.Errorf("wire bytes = %s\n          want %s", got, contactVerificationsGoldenWire)
	}
}
