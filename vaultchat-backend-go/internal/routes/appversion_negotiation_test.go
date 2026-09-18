// appversion_negotiation_test.go — GET /app/version answers the same gate in
// two representations, and the JSON one did not move.
//
// The risk this covers is not "does protobuf encode". It is that a content
// negotiation added to a live handler changes what every existing client
// receives. So the first test pins the exact JSON bytes, including the
// trailing newline json.Encoder writes, for the header combinations real
// clients send today: none, the app's own `application/json`, and a browser's
// `*/*`. If that string ever changes, this fails.
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

// The floors are env-driven, so the test sets them; t.Setenv restores them.
func withGateEnv(t *testing.T) {
	t.Helper()
	t.Setenv("VAULTCHAT_MIN_BUILD", "24")
	t.Setenv("VAULTCHAT_ADVISE_BUILD", "30")
	t.Setenv("VAULTCHAT_UPDATE_URL", "https://example.test/update")
	t.Setenv("VAULTCHAT_UPDATE_MESSAGE", "Security fix in 1.2.16")
}

func getAppVersion(t *testing.T, accept string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/app/version", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	appVersionGet(w, r)
	return w
}

const legacyJSON = `{"adviseBuild":30,"message":"Security fix in 1.2.16","minBuild":24,"updateUrl":"https://example.test/update"}` + "\n"

func TestAppVersionJSONUnchangedWithoutNegotiation(t *testing.T) {
	withGateEnv(t)
	for _, accept := range []string{"", "application/json", "*/*", "text/html,application/xhtml+xml"} {
		w := getAppVersion(t, accept)
		if w.Code != 200 {
			t.Fatalf("Accept %q: status %d, want 200", accept, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("Accept %q: Content-Type %q, want the JSON one", accept, ct)
		}
		if got := w.Body.String(); got != legacyJSON {
			t.Errorf("Accept %q: body changed\n got %q\nwant %q", accept, got, legacyJSON)
		}
	}
}

func TestAppVersionProtobufSameSemantics(t *testing.T) {
	withGateEnv(t)
	w := getAppVersion(t, "application/protobuf")
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/protobuf" {
		t.Fatalf("Content-Type %q, want application/protobuf", ct)
	}
	var got ccwirev1.AppVersionGate
	if err := proto.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("response is not a valid AppVersionGate: %v", err)
	}
	want := &ccwirev1.AppVersionGate{
		MinBuild: 24, AdviseBuild: 30,
		UpdateUrl: "https://example.test/update",
		Message:   "Security fix in 1.2.16",
	}
	if !proto.Equal(&got, want) {
		t.Errorf("decoded gate = %v, want %v", &got, want)
	}
	// The same bytes the TypeScript client is tested against
	// (lib/appVersionNegotiation.selftest.ts pins this exact hex). Pinning the
	// bytes, not just the semantics, is what makes the two languages one
	// contract rather than two independent readings of the schema.
	if got := hex.EncodeToString(w.Body.Bytes()); got != goldenWire {
		t.Errorf("wire bytes = %s, want %s", got, goldenWire)
	}
}

const goldenWire = "0818101e1a1b68747470733a2f2f6578616d706c652e746573742f757064617465221653656375726974792066697820696e20312e322e3136"

// The two representations must not disagree about policy. The advisory floor
// being lifted to the hard floor is the one derived value in this handler, and
// an unset update URL is the one default — both are asserted through both
// representations so a future edit cannot fix one and forget the other.
func TestAppVersionRepresentationsAgree(t *testing.T) {
	cases := []struct {
		name                  string
		min, advise, url, msg string
		wantMin, wantAdvise   int64
		wantURL               string
	}{
		{"unset config blocks nobody", "", "", "", "", 0, 0, defaultUpdateURL},
		{"advisory below the floor is lifted", "40", "10", "", "", 40, 40, defaultUpdateURL},
		{"garbage floors are zero, not a lockout", "banana", "-7", "https://u.test", "m", 0, 0, "https://u.test"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("VAULTCHAT_MIN_BUILD", c.min)
			t.Setenv("VAULTCHAT_ADVISE_BUILD", c.advise)
			t.Setenv("VAULTCHAT_UPDATE_URL", c.url)
			t.Setenv("VAULTCHAT_UPDATE_MESSAGE", c.msg)

			var pb ccwirev1.AppVersionGate
			if err := proto.Unmarshal(getAppVersion(t, "application/protobuf").Body.Bytes(), &pb); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if pb.MinBuild != c.wantMin || pb.AdviseBuild != c.wantAdvise || pb.UpdateUrl != c.wantURL || pb.Message != c.msg {
				t.Errorf("protobuf gate = %v, want min=%d advise=%d url=%q msg=%q",
					&pb, c.wantMin, c.wantAdvise, c.wantURL, c.msg)
			}

			// Same values, read back out of the JSON the untouched branch writes.
			var js struct {
				MinBuild    int64  `json:"minBuild"`
				AdviseBuild int64  `json:"adviseBuild"`
				UpdateURL   string `json:"updateUrl"`
				Message     string `json:"message"`
			}
			if err := json.Unmarshal(getAppVersion(t, "application/json").Body.Bytes(), &js); err != nil {
				t.Fatalf("json: %v", err)
			}
			if js.MinBuild != pb.MinBuild || js.AdviseBuild != pb.AdviseBuild ||
				js.UpdateURL != pb.UpdateUrl || js.Message != pb.Message {
				t.Errorf("representations disagree: json %+v vs protobuf %v", js, &pb)
			}
		})
	}
}
