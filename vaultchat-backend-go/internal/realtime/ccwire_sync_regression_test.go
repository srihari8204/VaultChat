package realtime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

func TestCursorScopeReachesCanonicalHandler(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /chats/delta", func(w http.ResponseWriter, r *http.Request) {
		scopes := CCWireSyncPositions(r)
		if len(scopes) != 2 || scopes["a"] != 10 || scopes["b"] != 500 {
			t.Fatalf("scope lost before SQL: %v", scopes)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"messages": []any{msg("501", "b")}, "more": false})
	})
	SetCCWireRoutes(mux)
	t.Cleanup(func() { SetCCWireRoutes(nil) })
	fakeFacts(t, map[int64]string{10: "a", 500: "b"}, 1000)
	s, f := newSession("u1", member(map[string]bool{"a": true, "b": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("a", 10), syncedAt("b", 500)))) {
		t.Fatal("sync failed")
	}
	pos := batchPositions(t, onlyBatch(t, f))
	if pos["a"] != 10 || pos["b"] != 501 {
		t.Fatalf("wrong per-chat progress: %v", pos)
	}
	req := httptest.NewRequest("GET", "/chats/delta?scopes=a", nil)
	req.Header.Set("X-CCWire", "1")
	if CCWireSyncPositions(req) != nil {
		t.Fatal("public input forged internal sync scope")
	}
}

func TestProtobufHelloDeviceAndUnknownFields(t *testing.T) {
	body := ccwire.AppendVarintField(nil, 1, 1)
	body = ccwire.AppendStringField(body, 5, "stable-install")
	// Future fixed32 and fixed64 fields are legal protobuf and must be skipped.
	body = append(body, 0x95, 0x03, 1, 2, 3, 4, 0x99, 0x03, 1, 2, 3, 4, 5, 6, 7, 8)
	s, _ := newSession("u1", nil)
	if !s.handle(frame(t, ccwire.Message{TrafficClass: ccwire.TrafficClassControl, BodyField: ccwire.BodyClientHello, Body: body})) {
		t.Fatal("compatible hello refused")
	}
	if s.deviceID != "stable-install" {
		t.Fatalf("device id not decoded: %q", s.deviceID)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /device", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Device-Id") != "stable-install" || !IsCCWire(r) {
			t.Fatal("loopback lost hello device")
		}
		_, _ = w.Write([]byte(`{}`))
	})
	SetCCWireRoutes(mux)
	t.Cleanup(func() { SetCCWireRoutes(nil) })
	if status, _ := s.call("GET", "/device", nil); status != 200 {
		t.Fatalf("loopback status %d", status)
	}
}

func TestCursorVarintDoesNotWrap(t *testing.T) {
	r := pbr{b: []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02}}
	if _, ok := r.varint(); ok {
		t.Fatal("uint64 overflow accepted")
	}
	if _, ok := ccwireDecodeCursor([]byte{0, 0}, ccwire.DefaultLimits()); ok {
		t.Fatal("field zero accepted")
	}
}
