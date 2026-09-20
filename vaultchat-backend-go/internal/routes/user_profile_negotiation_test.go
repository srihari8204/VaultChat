// user_profile_negotiation_test.go — GET /user/profile answers the same row in
// two representations, and the JSON one did not move.
//
// The risk is not "does protobuf encode". It is that a content negotiation
// added to the first authenticated read of the cold-start path changes what
// every installed build receives, or that the typed path invents a state the
// JSON path has never had: a null flattened to "", a timestamp re-formatted by
// a second hand-written layout string.
//
// So three things are pinned here:
//   - the exact JSON bytes for the Accept headers real clients send today,
//   - presence per field, in both directions (nil must be ABSENT, "" must be
//     present-and-empty — for `status` that is "not set" vs "cleared"),
//   - the timestamps, compared against the JSON path's own output rather than
//     a literal, because userProfileTimeLayout is a SECOND copy of the format
//     inside httpx.JSTime.MarshalJSON and a copy is what drifts.
//
// The database is not involved: userProfileWrite is the whole negotiation, and
// it is driven here with fixed rows. Cipher columns are left nil throughout, so
// vault.Identity falls through to the legacy plaintext columns and no vault key
// is needed.
package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ccwirev1 "vaultchat/backend-go/internal/ccwire/gen/ccwire/v1"

	"google.golang.org/protobuf/proto"
)

// Two rows, chosen so every presence case is exercised:
//   - everything populated, including all three timestamps and a PIN,
//   - every nullable column nil, so nothing may arrive as "" or 0.
func userProfileFullRow() *userUsersRow {
	dob := time.Date(1990, 7, 21, 0, 0, 0, 0, time.UTC)
	lastSeen := time.Date(2026, 3, 4, 5, 6, 7, 890000000, time.UTC)
	verified := time.Date(2025, 12, 31, 23, 59, 59, 999000000, time.UTC)
	return &userUsersRow{
		ID:              "u_full",
		Email:           strptr("a@example.test"),
		Name:            strptr("Ada Lovelace"),
		Phone:           strptr("+15550001111"),
		PhotoURL:        strptr("https://cdn.test/a.png"),
		VaultID:         strptr("vdeadbeefcafe"),
		DOB:             &dob,
		Status:          strptr("Busy"),
		Online:          true,
		LastSeenAt:      &lastSeen,
		AuthProvider:    strptr("google"),
		PinHash:         strptr("$2b$10$notarealhash"),
		FaceCount:       3,
		EmailVerifiedAt: &verified,
		CreatedAt:       time.Date(2024, 1, 2, 3, 4, 5, 60000000, time.UTC),
	}
}

func userProfileEmptyRow() *userUsersRow {
	return &userUsersRow{
		ID:        "u_empty",
		CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
}

func getUserProfile(t *testing.T, accept string, u *userUsersRow) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/user/profile", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	userProfileWrite(w, r, u)
	return w
}

// public() returns a map, so encoding/json sorts the keys. Hand-written from
// user.go, NOT captured from the serializer: it fails if a key is renamed
// (photoURL is not photoUrl), if a null becomes "", if hasPin starts leaking
// the hash, or if JSTime drops its milliseconds.
const legacyUserProfileFullJSON = `{"authProvider":"google","createdAt":"2024-01-02T03:04:05.060Z",` +
	`"dob":"Sat Jul 21 1990 00:00:00 GMT+0000 (Coordinated Universal Time)",` +
	`"email":"a@example.test","emailVerifiedAt":"2025-12-31T23:59:59.999Z","faceCount":3,` +
	`"hasPin":true,"id":"u_full","lastSeen":"2026-03-04T05:06:07.890Z","name":"Ada Lovelace",` +
	`"online":true,"phone":"+15550001111","photoURL":"https://cdn.test/a.png","status":"Busy",` +
	`"vaultId":"vdeadbeefcafe"}` + "\n"

const legacyUserProfileEmptyJSON = `{"authProvider":null,"createdAt":"2026-01-01T00:00:00.000Z",` +
	`"dob":null,"email":null,"emailVerifiedAt":null,"faceCount":0,"hasPin":false,"id":"u_empty",` +
	`"lastSeen":null,"name":null,"online":false,"phone":null,"photoURL":null,"status":null,` +
	`"vaultId":null}` + "\n"

func TestUserProfileJSONUnchangedWithoutNegotiation(t *testing.T) {
	for _, row := range []struct {
		name string
		u    *userUsersRow
		want string
	}{
		{"populated", userProfileFullRow(), legacyUserProfileFullJSON},
		{"all nulls", userProfileEmptyRow(), legacyUserProfileEmptyJSON},
	} {
		for _, accept := range []string{
			"",
			"application/json",
			"*/*",
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		} {
			w := getUserProfile(t, accept, row.u)
			if w.Code != 200 {
				t.Fatalf("%s, Accept %q: status %d, want 200", row.name, accept, w.Code)
			}
			if ct := w.Header().Get("Content-Type"); ct != acceptJSONContentType {
				t.Errorf("%s, Accept %q: Content-Type %q, want the JSON one", row.name, accept, ct)
			}
			if got := w.Body.String(); got != row.want {
				t.Errorf("%s, Accept %q: body changed\n got %s\nwant %s",
					row.name, accept, got, row.want)
			}
		}
	}
}

// userProfileJSON reads back exactly what public() writes. Pointers, so a JSON
// null stays distinguishable from "".
type userProfileJSON struct {
	ID              string  `json:"id"`
	Email           *string `json:"email"`
	Name            *string `json:"name"`
	Phone           *string `json:"phone"`
	PhotoURL        *string `json:"photoURL"`
	VaultID         *string `json:"vaultId"`
	DOB             *string `json:"dob"`
	Status          *string `json:"status"`
	Online          bool    `json:"online"`
	LastSeen        *string `json:"lastSeen"`
	AuthProvider    *string `json:"authProvider"`
	HasPin          bool    `json:"hasPin"`
	FaceCount       int32   `json:"faceCount"`
	EmailVerifiedAt *string `json:"emailVerifiedAt"`
	CreatedAt       string  `json:"createdAt"`
}

func decodeUserProfileJSON(t *testing.T, u *userUsersRow) userProfileJSON {
	t.Helper()
	var js userProfileJSON
	if err := json.Unmarshal(getUserProfile(t, "application/json", u).Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	return js
}

func decodeUserProfilePB(t *testing.T, u *userUsersRow) *ccwirev1.UserProfile {
	t.Helper()
	w := getUserProfile(t, protobufMediaType, u)
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != protobufMediaType {
		t.Fatalf("Content-Type %q, want %s", ct, protobufMediaType)
	}
	if w.Body.Len() == 0 {
		t.Fatal("empty protobuf body")
	}
	var pb ccwirev1.UserProfile
	if err := proto.Unmarshal(w.Body.Bytes(), &pb); err != nil {
		t.Fatalf("response is not a valid UserProfile: %v", err)
	}
	return &pb
}

func TestUserProfileProtobufWhenAsked(t *testing.T) {
	// The header combination a negotiating client actually sends.
	w := getUserProfile(t, "application/protobuf, application/json", userProfileFullRow())
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != protobufMediaType {
		t.Fatalf("Content-Type %q, want %s", ct, protobufMediaType)
	}
	if w.Body.Len() == 0 {
		t.Fatal("empty protobuf body")
	}
	var pb ccwirev1.UserProfile
	if err := proto.Unmarshal(w.Body.Bytes(), &pb); err != nil {
		t.Fatalf("response is not a valid UserProfile: %v", err)
	}
	if pb.Id != "u_full" {
		t.Errorf("id = %q, want u_full", pb.Id)
	}
}

// eqStrPtr reports whether the two representations agree about one nullable
// field: both absent, or both present with the same bytes.
func eqStrPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func fmtStrPtr(p *string) string {
	if p == nil {
		return "<absent/null>"
	}
	return `"` + *p + `"`
}

// FIELD PARITY: every field of the protobuf equals the JSON field public()
// emits for the SAME row. Compared against the live JSON output, so a change to
// either path that is not made to the other fails here.
func TestUserProfileFieldParity(t *testing.T) {
	for _, row := range []struct {
		name string
		u    *userUsersRow
	}{
		{"populated", userProfileFullRow()},
		{"all nulls", userProfileEmptyRow()},
	} {
		t.Run(row.name, func(t *testing.T) {
			js, pb := decodeUserProfileJSON(t, row.u), decodeUserProfilePB(t, row.u)

			if pb.Id != js.ID {
				t.Errorf("id: protobuf %q, json %q", pb.Id, js.ID)
			}
			for _, f := range []struct {
				name     string
				pb, json *string
			}{
				{"email", pb.Email, js.Email},
				{"name", pb.Name, js.Name},
				{"phone", pb.Phone, js.Phone},
				{"photo_url/photoURL", pb.PhotoUrl, js.PhotoURL},
				{"vault_id/vaultId", pb.VaultId, js.VaultID},
				{"dob", pb.Dob, js.DOB},
				{"status", pb.Status, js.Status},
				{"last_seen/lastSeen", pb.LastSeen, js.LastSeen},
				{"auth_provider/authProvider", pb.AuthProvider, js.AuthProvider},
				{"email_verified_at/emailVerifiedAt", pb.EmailVerifiedAt, js.EmailVerifiedAt},
			} {
				if !eqStrPtr(f.pb, f.json) {
					t.Errorf("%s: protobuf %s, json %s", f.name,
						fmtStrPtr(f.pb), fmtStrPtr(f.json))
				}
			}
			if pb.Online != js.Online {
				t.Errorf("online: protobuf %v, json %v", pb.Online, js.Online)
			}
			if pb.HasPin != js.HasPin {
				t.Errorf("has_pin: protobuf %v, json %v", pb.HasPin, js.HasPin)
			}
			if pb.FaceCount != js.FaceCount {
				t.Errorf("face_count: protobuf %d, json %d", pb.FaceCount, js.FaceCount)
			}
			if pb.CreatedAt != js.CreatedAt {
				t.Errorf("created_at: protobuf %q, json %q", pb.CreatedAt, js.CreatedAt)
			}
		})
	}
}

// PRESENCE. Parity above would still pass if BOTH representations had been
// flattened the same way, so absence is asserted directly: a nil *string is
// ABSENT on the wire and `null` in the JSON, never "".
func TestUserProfilePresence(t *testing.T) {
	empty := userProfileEmptyRow()
	js, pb := decodeUserProfileJSON(t, empty), decodeUserProfilePB(t, empty)

	for name, p := range map[string]*string{
		"email": pb.Email, "name": pb.Name, "phone": pb.Phone, "photo_url": pb.PhotoUrl,
		"vault_id": pb.VaultId, "dob": pb.Dob, "status": pb.Status,
		"last_seen": pb.LastSeen, "auth_provider": pb.AuthProvider,
		"email_verified_at": pb.EmailVerifiedAt,
	} {
		if p != nil {
			t.Errorf("%s: a null column must be ABSENT in protobuf, got %q", name, *p)
		}
	}
	for name, p := range map[string]*string{
		"email": js.Email, "name": js.Name, "phone": js.Phone, "photoURL": js.PhotoURL,
		"vaultId": js.VaultID, "dob": js.DOB, "status": js.Status,
		"lastSeen": js.LastSeen, "authProvider": js.AuthProvider,
		"emailVerifiedAt": js.EmailVerifiedAt,
	} {
		if p != nil {
			t.Errorf("%s: a null column must stay null in JSON, got %q", name, *p)
		}
	}

	// And the other direction: present values survive.
	full := userProfileFullRow()
	pbFull := decodeUserProfilePB(t, full)
	for name, p := range map[string]*string{
		"email": pbFull.Email, "name": pbFull.Name, "phone": pbFull.Phone,
		"photo_url": pbFull.PhotoUrl, "vault_id": pbFull.VaultId, "dob": pbFull.Dob,
		"status": pbFull.Status, "last_seen": pbFull.LastSeen,
		"auth_provider": pbFull.AuthProvider, "email_verified_at": pbFull.EmailVerifiedAt,
	} {
		if p == nil {
			t.Errorf("%s: a present value went missing", name)
		}
	}
}

// `status` is the field where the difference costs something: nil is "never set
// a status", "" is "deliberately cleared it". proto3 without `optional` cannot
// tell them apart, so this is the test that fails if the `optional` is dropped.
func TestUserProfileStatusClearedIsNotUnset(t *testing.T) {
	unset := userProfileEmptyRow()
	cleared := userProfileEmptyRow()
	cleared.Status = strptr("")

	if p := decodeUserProfilePB(t, unset).Status; p != nil {
		t.Errorf("status never set: want ABSENT, got %q", *p)
	}
	clearedPB := decodeUserProfilePB(t, cleared).Status
	if clearedPB == nil {
		t.Fatal(`status cleared to "": want present-and-empty, got absent — ` +
			`"cleared" is now indistinguishable from "never set"`)
	}
	if *clearedPB != "" {
		t.Errorf("status cleared: got %q, want \"\"", *clearedPB)
	}
	// The JSON path draws the same line: null vs "".
	if p := decodeUserProfileJSON(t, unset).Status; p != nil {
		t.Errorf("json status never set: want null, got %q", *p)
	}
	if p := decodeUserProfileJSON(t, cleared).Status; p == nil || *p != "" {
		t.Errorf("json status cleared: want \"\", got %s", fmtStrPtr(p))
	}
}

// TIMESTAMP IDENTITY — the property most likely to regress, because
// userProfileTimeLayout is a second copy of the format inside
// httpx.JSTime.MarshalJSON. Asserted against the JSON path's own output, not
// against a literal: a literal would have to be edited twice to stay wrong,
// this fails the moment the two copies disagree by a digit.
//
// The instants are chosen to catch the ways a re-typed layout breaks: a
// truncated millisecond (.060), a trailing-zero one (.890), .999 rolling, a
// whole second (.000), and a non-UTC zone that must be normalised to Z.
func TestUserProfileTimestampsByteIdenticalToJSON(t *testing.T) {
	ist := time.FixedZone("IST", 5*3600+1800)
	for _, tc := range []struct {
		name string
		at   time.Time
	}{
		{"truncated ms", time.Date(2024, 1, 2, 3, 4, 5, 60000000, time.UTC)},
		{"trailing zero ms", time.Date(2026, 3, 4, 5, 6, 7, 890000000, time.UTC)},
		{"999 ms", time.Date(2025, 12, 31, 23, 59, 59, 999000000, time.UTC)},
		{"whole second", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
		{"sub-ms truncation", time.Date(2026, 6, 6, 6, 6, 6, 123999999, time.UTC)},
		{"non-UTC zone", time.Date(2026, 8, 9, 10, 11, 12, 345000000, ist)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := userProfileEmptyRow()
			u.CreatedAt = tc.at
			u.LastSeenAt = &tc.at
			u.EmailVerifiedAt = &tc.at

			js, pb := decodeUserProfileJSON(t, u), decodeUserProfilePB(t, u)
			if pb.CreatedAt != js.CreatedAt {
				t.Errorf("created_at: protobuf %q, json %q", pb.CreatedAt, js.CreatedAt)
			}
			if !eqStrPtr(pb.LastSeen, js.LastSeen) {
				t.Errorf("last_seen: protobuf %s, json %s",
					fmtStrPtr(pb.LastSeen), fmtStrPtr(js.LastSeen))
			}
			if !eqStrPtr(pb.EmailVerifiedAt, js.EmailVerifiedAt) {
				t.Errorf("email_verified_at: protobuf %s, json %s",
					fmtStrPtr(pb.EmailVerifiedAt), fmtStrPtr(js.EmailVerifiedAt))
			}
			// Shape, once: UTC, three digits, literal Z. If both paths drifted
			// together the comparisons above would not notice.
			if _, err := time.Parse("2006-01-02T15:04:05.000Z", pb.CreatedAt); err != nil {
				t.Errorf("created_at %q is not JSTime's format: %v", pb.CreatedAt, err)
			}
		})
	}
}

// has_pin is DERIVED, and the derivation has three cases, not two: a row can
// carry a present-but-empty hash. Both representations must call that "no PIN",
// and neither may ever carry the hash itself.
func TestUserProfileHasPinDerived(t *testing.T) {
	for _, tc := range []struct {
		name string
		hash *string
		want bool
	}{
		{"no hash column", nil, false},
		{"empty hash is not a PIN", strptr(""), false},
		{"a real hash", strptr("$2b$10$notarealhash"), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := userProfileEmptyRow()
			u.PinHash = tc.hash
			if got := decodeUserProfilePB(t, u).HasPin; got != tc.want {
				t.Errorf("protobuf has_pin = %v, want %v", got, tc.want)
			}
			if got := decodeUserProfileJSON(t, u).HasPin; got != tc.want {
				t.Errorf("json hasPin = %v, want %v", got, tc.want)
			}
			// The hash never leaves the server, in either representation.
			if tc.hash != nil && *tc.hash != "" {
				if body := getUserProfile(t, protobufMediaType, u).Body.String(); strings.Contains(body, *tc.hash) {
					t.Error("the pin hash is in the protobuf body")
				}
				if body := getUserProfile(t, "application/json", u).Body.String(); strings.Contains(body, *tc.hash) {
					t.Error("the pin hash is in the JSON body")
				}
			}
		})
	}
}
