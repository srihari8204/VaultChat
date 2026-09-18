// user_backup_meta_negotiation_test.go — GET /user/backup/meta answers the same
// metadata in two representations, and the JSON one did not move.
//
// The risk this covers is not "does protobuf encode four scalars". It is that
// the typed path invents a state the JSON path never had, and this endpoint has
// two ways to do that:
//
//  1. The no-backup answer is `{"exists":false}` — ONE key. The other three are
//     absent, not null, and lib/cloudBackup.ts types them optional. If the typed
//     path shipped zeros, app/restore-backup.tsx would offer to restore a
//     0-byte backup that does not exist.
//  2. The mirror: a backup that really is 0 bytes / 0 messages must arrive
//     PRESENT-and-zero. proto3 elides a plain zero, which is why the schema
//     marks all three `optional` — and why this file checks both directions
//     rather than only the one the ticket would have named.
//
// The database is not involved: userBackupMetaWrite is the whole negotiation,
// and it is driven here with fixed values.
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

func backupMetaFixture() userBackupMetaData {
	return userBackupMetaData{
		Exists: true, SizeBytes: 1234567, MessageCount: 42,
		UpdatedAt: time.Date(2026, 3, 4, 5, 6, 7, 890000000, time.UTC),
	}
}

// A backup row that exists and is empty — committed before the first upload.
// Every detail field is a real, chosen zero.
func backupMetaEmptyBackup() userBackupMetaData {
	return userBackupMetaData{
		Exists: true, SizeBytes: 0, MessageCount: 0,
		UpdatedAt: time.Date(2026, 3, 4, 5, 6, 7, 890000000, time.UTC),
	}
}

// No backup at all. The JSON is one key wide.
func backupMetaAbsent() userBackupMetaData { return userBackupMetaData{} }

func getBackupMeta(t *testing.T, accept string, d userBackupMetaData) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/user/backup/meta", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	userBackupMetaWrite(w, r, d)
	return w
}

// Hand-written from the handler's map literals, NOT captured from the
// serializer. encoding/json sorts map keys, so the order below is alphabetical
// and that is part of the pinned contract. It fails if JSTime drops its
// milliseconds, or if the absent answer ever grows three nulls.
const legacyBackupMetaJSON = `{"exists":true,"messageCount":42,"sizeBytes":1234567,` +
	`"updatedAt":"2026-03-04T05:06:07.890Z"}` + "\n"
const legacyBackupMetaAbsentJSON = `{"exists":false}` + "\n"

func TestBackupMetaJSONUnchangedWithoutNegotiation(t *testing.T) {
	for _, accept := range []string{
		"",
		"application/json",
		"*/*",
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	} {
		w := getBackupMeta(t, accept, backupMetaFixture())
		if w.Code != 200 {
			t.Fatalf("Accept %q: status %d, want 200", accept, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("Accept %q: Content-Type %q, want the JSON one", accept, ct)
		}
		if got := w.Body.String(); got != legacyBackupMetaJSON {
			t.Errorf("Accept %q: body changed\n got %s\nwant %s", accept, got, legacyBackupMetaJSON)
		}
		if got := getBackupMeta(t, accept, backupMetaAbsent()).Body.String(); got != legacyBackupMetaAbsentJSON {
			t.Errorf("Accept %q: absent body changed\n got %s\nwant %s",
				accept, got, legacyBackupMetaAbsentJSON)
		}
	}
}

// And the absent answer really is one key wide, checked structurally rather
// than only as a byte string, so a reordering refactor cannot hide a new key.
func TestBackupMetaAbsentJSONHasOnlyExists(t *testing.T) {
	var js map[string]any
	if err := json.Unmarshal(getBackupMeta(t, "application/json", backupMetaAbsent()).Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	if len(js) != 1 || js["exists"] != false {
		t.Errorf("absent answer = %#v, want exactly {\"exists\":false}", js)
	}
}

func decodeBackupMetaReply(t *testing.T, w *httptest.ResponseRecorder) *ccwirev1.BackupMeta {
	t.Helper()
	var reply ccwirev1.BackupMeta
	if err := proto.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatalf("response is not a valid BackupMeta: %v", err)
	}
	return &reply
}

func int64ptr(v int64) *int64 { return &v }
func int32ptr(v int32) *int32 { return &v }

func TestBackupMetaProtobufSameValues(t *testing.T) {
	w := getBackupMeta(t, protobufMediaType, backupMetaFixture())
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != protobufMediaType {
		t.Fatalf("Content-Type %q, want %s", ct, protobufMediaType)
	}
	want := &ccwirev1.BackupMeta{
		Exists:    true,
		SizeBytes: int64ptr(1234567), MessageCount: int32ptr(42),
		UpdatedAt: strptr("2026-03-04T05:06:07.890Z"),
	}
	if got := decodeBackupMetaReply(t, w); !proto.Equal(got, want) {
		t.Errorf("decoded reply = %v\nwant %v", got, want)
	}
}

// PRESENCE, asserted per field and in both directions. proto.Equal above would
// still pass if BOTH sides had been flattened together.
func TestBackupMetaPresencePerField(t *testing.T) {
	// No backup: exists is a real false, and nothing else is on the wire.
	absent := decodeBackupMetaReply(t, getBackupMeta(t, protobufMediaType, backupMetaAbsent()))
	if absent.Exists {
		t.Error("exists: no backup must decode as false")
	}
	for name, present := range map[string]bool{
		"sizeBytes":    absent.SizeBytes != nil,
		"messageCount": absent.MessageCount != nil,
		"updatedAt":    absent.UpdatedAt != nil,
	} {
		if present {
			t.Errorf("%s: must be ABSENT when there is no backup — the JSON has no such key", name)
		}
	}
	if n := len(getBackupMeta(t, protobufMediaType, backupMetaAbsent()).Body.Bytes()); n != 0 {
		t.Errorf("the no-backup answer encoded to %d bytes, want 0", n)
	}

	// A backup that exists and is empty: every zero is a CHOICE and must be
	// present-and-zero. This is the case plain proto3 fields would lose.
	empty := decodeBackupMetaReply(t, getBackupMeta(t, protobufMediaType, backupMetaEmptyBackup()))
	if !empty.Exists {
		t.Error("exists: an empty backup still exists")
	}
	if empty.SizeBytes == nil {
		t.Error("sizeBytes: an explicit 0 must be present, not absent")
	} else if *empty.SizeBytes != 0 {
		t.Errorf("sizeBytes = %d, want 0", *empty.SizeBytes)
	}
	if empty.MessageCount == nil {
		t.Error("messageCount: an explicit 0 must be present, not absent")
	} else if *empty.MessageCount != 0 {
		t.Errorf("messageCount = %d, want 0", *empty.MessageCount)
	}
	if empty.UpdatedAt == nil {
		t.Error("updatedAt: a present timestamp went missing")
	}

	// And the JSON path still ships those zeros as keys.
	var js map[string]any
	if err := json.Unmarshal(
		getBackupMeta(t, "application/json", backupMetaEmptyBackup()).Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	for _, k := range []string{"sizeBytes", "messageCount", "updatedAt"} {
		if _, ok := js[k]; !ok {
			t.Errorf("legacy JSON lost %s for an empty-but-existing backup", k)
		}
	}
}

// CROSS-LANGUAGE BYTE PIN. The TS side asserts this same hex
// (lib/backupMetaNegotiation.selftest.ts).
//
// Field by field: 0801 exists=true, 1087ad4b size_bytes=1234567 (three varint
// bytes), 182a message_count=42, 2218 + 24 bytes of the ISO timestamp verbatim.
const backupMetaGoldenWire = "08011087ad4b182a" +
	"2218323032362d30332d30345430353a30363a30372e3839305a"

// The empty-but-existing backup, pinned separately: 1000 and 1800 are the two
// bytes each that an explicit zero costs, and they are the whole reason the
// schema says `optional`. Absence costs none — see the zero-length assertion
// above — and the two must never be confused.
const backupMetaEmptyGoldenWire = "080110001800" +
	"2218323032362d30332d30345430353a30363a30372e3839305a"

func TestBackupMetaWireBytePin(t *testing.T) {
	if got := hex.EncodeToString(getBackupMeta(t, protobufMediaType, backupMetaFixture()).Body.Bytes()); got != backupMetaGoldenWire {
		t.Errorf("wire bytes = %s\n          want %s", got, backupMetaGoldenWire)
	}
	if got := hex.EncodeToString(getBackupMeta(t, protobufMediaType, backupMetaEmptyBackup()).Body.Bytes()); got != backupMetaEmptyGoldenWire {
		t.Errorf("empty-backup wire bytes = %s\n                    want %s", got, backupMetaEmptyGoldenWire)
	}
}
