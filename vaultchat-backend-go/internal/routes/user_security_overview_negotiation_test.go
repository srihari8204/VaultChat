// user_security_overview_negotiation_test.go — GET /user/security-overview
// answers the same overview in two representations, and the JSON one did not
// move.
//
// The risk this covers is not "does protobuf encode". It is that a negotiation
// added to a live endpoint changes what every existing client receives, or that
// the typed path invents a state the JSON path never had. Here that second risk
// is concrete and not theoretical: settings.discoverable / readReceipts /
// lastSeenVisible are nullable columns that reach the client as
// `boolean | null` (lib/security.ts), and the Security Hub draws null as "not
// set" — a different screen from "off". A null flattened to false on the wire
// would silently tell a user their account is undiscoverable when they have
// simply never chosen.
//
// The database is not involved: userSecurityOverviewWrite is the whole
// negotiation, and it is driven here with fixed values.
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

func boolptr(b bool) *bool { return &b }

// Everything populated, and the three-state settings exercised in one row:
// true, false, and NULL. A test that confuses null with false fails on the
// third.
func securityOverviewFixture() userSecurityOverviewData {
	t := time.Date(2026, 3, 4, 5, 6, 7, 890000000, time.UTC)
	return userSecurityOverviewData{
		Sessions: 3, Devices: 2, Blocks: 5, Keys: 1,
		CreatedAt:    &t,
		Discoverable: boolptr(true), ReadReceipts: boolptr(false),
		LastSeenVisible: nil,
	}
}

// The other end: a brand-new account. Every count 0, no identity key, no
// settings chosen, and — the case the users row is missing — no createdAt.
func securityOverviewEmpty() userSecurityOverviewData {
	return userSecurityOverviewData{}
}

func getSecurityOverview(t *testing.T, accept string, d userSecurityOverviewData) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/user/security-overview", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	userSecurityOverviewWrite(w, r, d)
	return w
}

// Hand-written from the handler's map literal, NOT captured from the
// serializer. encoding/json sorts map keys, so the order below is alphabetical
// and that is part of the pinned contract. It fails if a null becomes false or
// if JSTime drops its milliseconds.
const legacySecurityOverviewJSON = `{"accountCreatedAt":"2026-03-04T05:06:07.890Z",` +
	`"activeSessions":3,"blockedContacts":5,"e2eeKeyPublished":true,"linkedDevices":2,` +
	`"settings":{"discoverable":true,"lastSeenVisible":null,"readReceipts":false}}` + "\n"

const legacySecurityOverviewEmptyJSON = `{"accountCreatedAt":null,"activeSessions":0,` +
	`"blockedContacts":0,"e2eeKeyPublished":false,"linkedDevices":0,` +
	`"settings":{"discoverable":null,"lastSeenVisible":null,"readReceipts":null}}` + "\n"

func TestSecurityOverviewJSONUnchangedWithoutNegotiation(t *testing.T) {
	for _, accept := range []string{
		"",
		"application/json",
		"*/*",
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	} {
		w := getSecurityOverview(t, accept, securityOverviewFixture())
		if w.Code != 200 {
			t.Fatalf("Accept %q: status %d, want 200", accept, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("Accept %q: Content-Type %q, want the JSON one", accept, ct)
		}
		if got := w.Body.String(); got != legacySecurityOverviewJSON {
			t.Errorf("Accept %q: body changed\n got %s\nwant %s", accept, got, legacySecurityOverviewJSON)
		}
		if got := getSecurityOverview(t, accept, securityOverviewEmpty()).Body.String(); got != legacySecurityOverviewEmptyJSON {
			t.Errorf("Accept %q: empty body changed\n got %s\nwant %s",
				accept, got, legacySecurityOverviewEmptyJSON)
		}
	}
}

func decodeSecurityOverview(t *testing.T, w *httptest.ResponseRecorder) *ccwirev1.SecurityOverview {
	t.Helper()
	var reply ccwirev1.SecurityOverview
	if err := proto.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatalf("response is not a valid SecurityOverview: %v", err)
	}
	return &reply
}

func TestSecurityOverviewProtobufSameValues(t *testing.T) {
	w := getSecurityOverview(t, protobufMediaType, securityOverviewFixture())
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != protobufMediaType {
		t.Fatalf("Content-Type %q, want %s", ct, protobufMediaType)
	}
	want := &ccwirev1.SecurityOverview{
		ActiveSessions: 3, LinkedDevices: 2, BlockedContacts: 5,
		E2EeKeyPublished: true,
		AccountCreatedAt: strptr("2026-03-04T05:06:07.890Z"),
		Settings: &ccwirev1.SecuritySettings{
			Discoverable: boolptr(true), ReadReceipts: boolptr(false),
		},
	}
	if got := decodeSecurityOverview(t, w); !proto.Equal(got, want) {
		t.Errorf("decoded reply = %v\nwant %v", got, want)
	}
}

// PRESENCE, asserted per field. proto.Equal above would still pass if BOTH
// sides had been flattened together, so absence is checked directly — and so is
// the opposite direction, a value that exists must not go missing.
func TestSecurityOverviewPresencePerField(t *testing.T) {
	full := decodeSecurityOverview(t, getSecurityOverview(t, protobufMediaType, securityOverviewFixture()))

	// The three-state settings, all three states in one message.
	if full.Settings == nil {
		t.Fatal("settings must always be present — the JSON never ships null there")
	}
	if full.Settings.Discoverable == nil || !*full.Settings.Discoverable {
		t.Errorf("discoverable: true went missing, got %v", full.Settings.Discoverable)
	}
	// The one that matters: false is a CHOICE and must be present-and-false.
	if full.Settings.ReadReceipts == nil {
		t.Error("readReceipts: an explicit false must be present, not absent")
	} else if *full.Settings.ReadReceipts {
		t.Error("readReceipts: false decoded as true")
	}
	// And its mirror: NULL must be absent, never false.
	if full.Settings.LastSeenVisible != nil {
		t.Errorf("lastSeenVisible: null must be absent, got %v", *full.Settings.LastSeenVisible)
	}
	if full.AccountCreatedAt == nil {
		t.Error("accountCreatedAt: a present timestamp went missing")
	}

	empty := decodeSecurityOverview(t, getSecurityOverview(t, protobufMediaType, securityOverviewEmpty()))
	if empty.AccountCreatedAt != nil {
		t.Errorf("accountCreatedAt: null must be absent, got %q", *empty.AccountCreatedAt)
	}
	if empty.Settings == nil {
		t.Fatal("settings must be present even when every field inside it is absent")
	}
	for name, p := range map[string]*bool{
		"discoverable":    empty.Settings.Discoverable,
		"readReceipts":    empty.Settings.ReadReceipts,
		"lastSeenVisible": empty.Settings.LastSeenVisible,
	} {
		if p != nil {
			t.Errorf("%s: null must be absent, got %v", name, *p)
		}
	}
	// The counts are NOT optional: 0 is a real count, and the generated Go
	// gives them no pointer at all — this asserts the schema did not drift.
	if empty.ActiveSessions != 0 || empty.LinkedDevices != 0 || empty.BlockedContacts != 0 ||
		empty.E2EeKeyPublished {
		t.Errorf("collapsed fields wrong: %d/%d/%d e2ee=%v", empty.ActiveSessions,
			empty.LinkedDevices, empty.BlockedContacts, empty.E2EeKeyPublished)
	}
	// And the JSON path still says null for all three, not false.
	var js map[string]any
	if err := json.Unmarshal(
		getSecurityOverview(t, "application/json", securityOverviewEmpty()).Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	s, _ := js["settings"].(map[string]any)
	for _, k := range []string{"discoverable", "readReceipts", "lastSeenVisible"} {
		if v, ok := s[k]; !ok || v != nil {
			t.Errorf("legacy JSON settings.%s = %#v, want null", k, v)
		}
	}
}

// CROSS-LANGUAGE BYTE PIN. One fixed overview, its exact wire bytes. Pinning
// the bytes rather than only the semantics is what makes Go and TypeScript one
// contract instead of two independent readings of the schema: semantic
// agreement alone would let them drift onto different field numbers and both
// still "pass". The TS side asserts this same hex
// (lib/securityOverviewNegotiation.selftest.ts).
//
// Field by field: 0803 active_sessions=3, 1002 linked_devices=2,
// 2001 e2ee_key_published=true (#4), 2a18 + 24 bytes of the ISO timestamp
// verbatim (#5), 3204 settings (#6, 4 bytes) = 0801 discoverable=true,
// 1000 read_receipts=PRESENT AND FALSE. Absent by design and therefore not on
// the wire at all: blocked_contacts (0, a real count proto3 elides) and
// last_seen_visible (NULL). The 1000 is the whole point of the pin: an
// explicit false costs two bytes, absence costs none, and the two must never
// be confused.
const securityOverviewGoldenWire = "080310022001" +
	"2a18323032362d30332d30345430353a30363a30372e3839305a" +
	"320408011000"

func securityOverviewPinRow() userSecurityOverviewData {
	t := time.Date(2026, 3, 4, 5, 6, 7, 890000000, time.UTC)
	return userSecurityOverviewData{
		Sessions: 3, Devices: 2, Blocks: 0, Keys: 1,
		CreatedAt:    &t,
		Discoverable: boolptr(true), ReadReceipts: boolptr(false),
		LastSeenVisible: nil,
	}
}

func TestSecurityOverviewWireBytePin(t *testing.T) {
	w := getSecurityOverview(t, protobufMediaType, securityOverviewPinRow())
	if got := hex.EncodeToString(w.Body.Bytes()); got != securityOverviewGoldenWire {
		t.Errorf("wire bytes = %s\n          want %s", got, securityOverviewGoldenWire)
	}
}
