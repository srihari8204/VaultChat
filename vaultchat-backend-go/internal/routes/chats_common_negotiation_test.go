// chats_common_negotiation_test.go — GET /chats/common/{userId} answers the
// same groups in two representations, and the JSON one did not move.
//
// The risk covered here is not "does protobuf encode". It is that a content
// negotiation added to a live handler changes what every existing client
// receives — and this is the first endpoint whose client goes through
// lib/api.ts, the single funnel 331 contracts share. So the first test pins
// the exact JSON bytes, trailing newline included, for the Accept headers real
// clients send today: none, the app's own `application/json`, a browser's
// `*/*`, and a full browser string. If that ever changes, this fails.
//
// The database is not involved: chatsCommonWrite is the whole negotiation, and
// it is driven here with fixed rows.
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

func strptr(s string) *string { return &s }

// Two rows, chosen so presence is exercised in both directions: a named group
// with no photo, and a photo with no name. Flattening either null to "" would
// change the pinned bytes below.
func commonGroupFixture() []commonGroup {
	return []commonGroup{
		{ID: "cg_alpha", Name: strptr("Alpha"), PhotoURL: nil},
		{ID: "cg_beta", Name: nil, PhotoURL: strptr("https://cdn.test/b.png")},
	}
}

func getCommonGroups(t *testing.T, accept string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/chats/common/u2", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	chatsCommonWrite(w, r, commonGroupFixture())
	return w
}

const legacyCommonJSON = `{"groups":[{"id":"cg_alpha","name":"Alpha","photoURL":null},` +
	`{"id":"cg_beta","name":null,"photoURL":"https://cdn.test/b.png"}]}` + "\n"

func TestChatsCommonJSONUnchangedWithoutNegotiation(t *testing.T) {
	for _, accept := range []string{
		"",
		"application/json",
		"*/*",
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	} {
		w := getCommonGroups(t, accept)
		if w.Code != 200 {
			t.Fatalf("Accept %q: status %d, want 200", accept, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("Accept %q: Content-Type %q, want the JSON one", accept, ct)
		}
		if got := w.Body.String(); got != legacyCommonJSON {
			t.Errorf("Accept %q: body changed\n got %q\nwant %q", accept, got, legacyCommonJSON)
		}
	}
}

// An empty result is the common case (most pairs share no group) and it is the
// one shape a repeated field could plausibly get wrong: proto3 writes nothing
// at all, while the JSON branch must keep writing `[]` and never `null`.
func TestChatsCommonEmptyIsEmptyInBoth(t *testing.T) {
	for _, accept := range []string{"", "application/protobuf"} {
		r := httptest.NewRequest(http.MethodGet, "/chats/common/u2", nil)
		if accept != "" {
			r.Header.Set("Accept", accept)
		}
		w := httptest.NewRecorder()
		chatsCommonWrite(w, r, []commonGroup{})
		if accept == "" {
			if got, want := w.Body.String(), "{\"groups\":[]}\n"; got != want {
				t.Errorf("empty JSON body = %q, want %q", got, want)
			}
			continue
		}
		if w.Body.Len() != 0 {
			t.Errorf("empty protobuf body = %x, want zero bytes", w.Body.Bytes())
		}
		var pb ccwirev1.CommonGroupsReply
		if err := proto.Unmarshal(w.Body.Bytes(), &pb); err != nil || len(pb.Groups) != 0 {
			t.Errorf("empty reply did not decode to no groups: %v %v", pb.Groups, err)
		}
	}
}

func TestChatsCommonProtobufSameValues(t *testing.T) {
	w := getCommonGroups(t, "application/protobuf")
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/protobuf" {
		t.Fatalf("Content-Type %q, want application/protobuf", ct)
	}
	var got ccwirev1.CommonGroupsReply
	if err := proto.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("response is not a valid CommonGroupsReply: %v", err)
	}
	want := &ccwirev1.CommonGroupsReply{Groups: []*ccwirev1.CommonGroup{
		{Id: "cg_alpha", Name: strptr("Alpha")},
		{Id: "cg_beta", PhotoUrl: strptr("https://cdn.test/b.png")},
	}}
	if !proto.Equal(&got, want) {
		t.Errorf("decoded reply = %v, want %v", &got, want)
	}

	// NULL IS ABSENT, NOT "". This is the one representation this endpoint
	// could quietly change, and proto.Equal above would still pass if both
	// sides had been flattened together — so assert presence directly.
	if got.Groups[0].PhotoUrl != nil {
		t.Errorf("a group with no photo must be absent, got %q", *got.Groups[0].PhotoUrl)
	}
	if got.Groups[1].Name != nil {
		t.Errorf("a group with no name must be absent, got %q", *got.Groups[1].Name)
	}

	// The same bytes the TypeScript client is tested against
	// (lib/chatsCommonNegotiation.selftest.ts pins this exact hex). Pinning the
	// bytes, not just the semantics, is what makes the two languages one
	// contract rather than two independent readings of the schema: semantic
	// agreement alone would let them drift onto different field numbers and
	// still both "pass".
	if got := hex.EncodeToString(w.Body.Bytes()); got != commonGroupsGoldenWire {
		t.Errorf("wire bytes = %s, want %s", got, commonGroupsGoldenWire)
	}
}

const commonGroupsGoldenWire = "0a110a0863675f616c7068611205416c706861" +
	"0a210a0763675f626574611a1668747470733a2f2f63646e2e746573742f622e706e67"

// The two representations must not disagree about the rows themselves.
func TestChatsCommonRepresentationsAgree(t *testing.T) {
	var pb ccwirev1.CommonGroupsReply
	if err := proto.Unmarshal(getCommonGroups(t, "application/protobuf").Body.Bytes(), &pb); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	var js struct {
		Groups []struct {
			ID       string  `json:"id"`
			Name     *string `json:"name"`
			PhotoURL *string `json:"photoURL"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(getCommonGroups(t, "application/json").Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(js.Groups) != len(pb.Groups) {
		t.Fatalf("group count differs: json %d, protobuf %d", len(js.Groups), len(pb.Groups))
	}
	eq := func(a, b *string) bool {
		if a == nil || b == nil {
			return a == nil && b == nil
		}
		return *a == *b
	}
	for i := range js.Groups {
		if js.Groups[i].ID != pb.Groups[i].Id ||
			!eq(js.Groups[i].Name, pb.Groups[i].Name) ||
			!eq(js.Groups[i].PhotoURL, pb.Groups[i].PhotoUrl) {
			t.Errorf("row %d disagrees: json %+v vs protobuf %v", i, js.Groups[i], pb.Groups[i])
		}
	}
}
