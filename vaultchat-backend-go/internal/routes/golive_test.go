package routes

import (
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/golive"
	"vaultchat/backend-go/internal/livekit"
)

// goliveEnv points the process at a Go Live project genuinely separate from the
// calling one. Every test here starts from that state, because "separate" is the
// precondition all of them are really checking.
func goliveEnv(t *testing.T) {
	t.Helper()
	t.Setenv("LIVEKIT_API_KEY", "calls-key")
	t.Setenv("LIVEKIT_API_SECRET", "calls-secret-long-enough")
	t.Setenv("LIVEKIT_URL", "ws://calls:7880")
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "golive-key")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "golive-secret-long-enough")
	t.Setenv("GOLIVE_LIVEKIT_URL", "ws://127.0.0.1:1/unreachable-on-purpose")
	t.Setenv("GOLIVE_ROOM_PREFIX", "")
}

func healthBody(t *testing.T) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	goliveHealth(rec, httptest.NewRequest(http.MethodGet, "/golive/health", nil))
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("health returned non-JSON %q: %v", rec.Body.String(), err)
	}
	return rec.Code, out
}

// The requirement stated as a test: a Go Live media failure produces
// GOLIVE_UNHEALTHY and says nothing at all about the calling cluster.
func TestGoLiveHealthUnhealthyWhenLiveKitUnreachable(t *testing.T) {
	goliveEnv(t)
	code, out := healthBody(t)

	if out["status"] != "GOLIVE_UNHEALTHY" {
		t.Fatalf("status = %v, want GOLIVE_UNHEALTHY", out["status"])
	}
	if code != 503 {
		t.Fatalf("code = %d, want 503 so a monitor sees it without parsing", code)
	}

	g, _ := out["golive"].(map[string]any)
	if g == nil {
		t.Fatal("no golive block in the response")
	}
	if g["configured"] != true {
		t.Fatal("configured should be true — the creds are set, the server is down")
	}
	if lk, _ := g["livekit"].(map[string]any); lk == nil || lk["ok"] != false {
		t.Fatalf("livekit block did not report the failure: %v", g["livekit"])
	}

	// The isolation assertion. Nothing about the CALLING deployment may appear
	// here — not its URL, not its key, not a health verdict for it.
	raw := strings.ToLower(mustJSON(t, out))
	for _, leak := range []string{"calls-key", "calls-secret", "calls:7880"} {
		if strings.Contains(raw, leak) {
			t.Fatalf("the Go Live health response leaked calling config %q: %s", leak, raw)
		}
	}
}

// An overlap must be visible in the health response rather than hiding behind a
// tier that appears to work perfectly.
func TestGoLiveHealthReportsOverlapWithCalling(t *testing.T) {
	goliveEnv(t)
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "calls-secret-long-enough")

	code, out := healthBody(t)
	g, _ := out["golive"].(map[string]any)
	if g == nil || g["sharesCallingProject"] != true {
		t.Fatalf("a shared secret was not reported: %v", out)
	}
	if out["status"] != "GOLIVE_UNHEALTHY" || code != 503 {
		t.Fatalf("an overlapping config reported healthy: %v (%d)", out["status"], code)
	}
}

func TestGoLiveHealthUnconfigured(t *testing.T) {
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "")
	t.Setenv("GOLIVE_LIVEKIT_URL", "")

	code, out := healthBody(t)
	if out["status"] != "GOLIVE_UNHEALTHY" || code != 503 {
		t.Fatalf("unconfigured Go Live reported %v (%d)", out["status"], code)
	}
	g, _ := out["golive"].(map[string]any)
	if g["configured"] != false {
		t.Fatal("configured should be false with no GOLIVE_LIVEKIT_* set")
	}
}

// The Go Live receiver must not accept deliveries signed by the CALLING
// project, and vice versa. If it did, either media server could drive the
// other's state and the two deployments would not be isolated at all.
func TestGoLiveWebhookRejectsCallingSignature(t *testing.T) {
	goliveEnv(t)
	cfg := golive.ConfigFromEnv()
	calls := whCfg // the calling project fixture from broadcast_webhook_test.go

	body := []byte(`{"event":"egress_started","egress_info":{"egress_id":"EG_x"}}`)

	if verifyLivekitSignature(cfg.Config, sign(t, calls, calls.APIKey, body, ""), body) {
		t.Fatal("the Go Live receiver accepted a delivery signed by the CALLING project")
	}
	if verifyLivekitSignature(calls, sign(t, cfg.Config, cfg.APIKey, body, ""), body) {
		t.Fatal("the CALLING receiver accepted a delivery signed by GO LIVE")
	}
	// ...and its own is accepted, or the receiver is simply broken.
	if !verifyLivekitSignature(cfg.Config, sign(t, cfg.Config, cfg.APIKey, body, ""), body) {
		t.Fatal("the Go Live receiver rejected its OWN correctly signed delivery")
	}
}

// An unconfigured or overlapping Go Live must refuse webhook deliveries outright
// — accepting them would let an unverifiable caller move broadcast state.
func TestGoLiveWebhookRefusesWhenUnusable(t *testing.T) {
	for name, setup := range map[string]func(){
		"unconfigured": func() {
			t.Setenv("GOLIVE_LIVEKIT_API_KEY", "")
			t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "")
		},
		"overlapping": func() {
			t.Setenv("LIVEKIT_API_KEY", "calls-key")
			t.Setenv("LIVEKIT_API_SECRET", "calls-secret-long-enough")
			t.Setenv("GOLIVE_LIVEKIT_API_KEY", "calls-key")
			t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "calls-secret-long-enough")
		},
	} {
		t.Run(name, func(t *testing.T) {
			setup()
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/internal/golive/webhook",
				strings.NewReader(`{"event":"egress_started"}`))
			goliveWebhook(rec, req)
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("code = %d, want 503", rec.Code)
			}
		})
	}
}

// Grepping [GOLIVE] must return the whole broadcasting story and nothing from
// calling. That only holds if every line carries the prefix and the ids.
func TestGoLiveLogFormat(t *testing.T) {
	line := captureLog(t, func() {
		goliveLog("HOST_JOINED", "bc-1", "golive_bc-1", "user-9", "role=host")
	})
	for _, want := range []string{
		"[GOLIVE]", "event=HOST_JOINED", "broadcast_id=bc-1",
		"room_id=golive_bc-1", "user_id=user-9", "role=host",
	} {
		if !strings.Contains(line, want) {
			t.Fatalf("log line %q is missing %q", line, want)
		}
	}
	// Empty fields are omitted rather than emitted as "broadcast_id=", which
	// would make a log query match rows that carry no id at all.
	blank := captureLog(t, func() { goliveLog("HOST_SWEEP_STARTED", "", "", "") })
	if strings.Contains(blank, "broadcast_id=") || strings.Contains(blank, "user_id=") {
		t.Fatalf("empty fields were emitted: %q", blank)
	}
}

// goliveMayWatch's decisions that need no database: the host, a public stream,
// and the fail-closed defaults. The invited-viewer branch is a query and is
// covered by the migration's RLS policy plus the handler tests that run against
// a live database.
func TestGoLiveMayWatchWithoutDB(t *testing.T) {
	pub := &broadcast{ID: "b1", HostID: "host-1", Visibility: "public"}
	priv := &broadcast{ID: "b2", HostID: "host-1", Visibility: "private"}

	if !goliveMayWatch(t.Context(), "anyone", pub) {
		t.Fatal("a public broadcast refused a stranger")
	}
	if !goliveMayWatch(t.Context(), "host-1", priv) {
		t.Fatal("a private broadcast refused its own host")
	}
	if goliveMayWatch(t.Context(), "", pub) {
		t.Fatal("an empty user id was allowed")
	}
	if goliveMayWatch(t.Context(), "anyone", nil) {
		t.Fatal("a nil broadcast was allowed")
	}
	// An unrecognised visibility must DENY. The thing being defaulted is access
	// to someone's private stream.
	if goliveMayWatch(t.Context(), "anyone", &broadcast{ID: "b3", HostID: "h", Visibility: "unlisted"}) {
		t.Fatal("an unknown visibility value defaulted to allow")
	}
	if goliveMayWatch(t.Context(), "anyone", &broadcast{ID: "b4", HostID: "h", Visibility: ""}) {
		t.Fatal("an empty visibility value defaulted to allow")
	}
}

// goliveRedact removes the playback ticket — the capability broadcast_hls.go
// accepts as a credential — and leaves an authorized viewer's untouched.
func TestGoLiveRedactStripsTicketForOutsiders(t *testing.T) {
	url := "https://api.example.com/broadcasts/b2/hls/index.m3u8?t=1.sig"

	priv := &broadcast{ID: "b2", HostID: "host-1", Visibility: "private", HLSURL: &url}
	goliveRedact(t.Context(), "stranger", priv)
	if priv.HLSURL != nil {
		t.Fatalf("a stranger kept the playback ticket for a private stream: %q", *priv.HLSURL)
	}

	kept := &broadcast{ID: "b2", HostID: "host-1", Visibility: "private", HLSURL: &url}
	goliveRedact(t.Context(), "host-1", kept)
	if kept.HLSURL == nil {
		t.Fatal("the host lost the playback ticket for their own stream")
	}

	open := &broadcast{ID: "b1", HostID: "host-1", Visibility: "public", HLSURL: &url}
	goliveRedact(t.Context(), "stranger", open)
	if open.HLSURL == nil {
		t.Fatal("a public stream was redacted")
	}
}

// captureLog runs fn with the standard logger redirected, and returns what it
// wrote. goliveLog goes through `log`, so this is the only way to assert on the
// format an operator will actually grep.
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf strings.Builder
	out, flags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() { log.SetOutput(out); log.SetFlags(flags) }()
	fn()
	return buf.String()
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// The egress worker joins the room it records, identified by its egress id.
// That is not a user, and letting it reach a uuid-typed column produced a
// SQLSTATE 22P02 on every egress join and leave — noise that buries real
// failures.
func TestGoLiveIgnoresNonUserParticipants(t *testing.T) {
	for _, id := range []string{
		"EG_MSQLSeWoothd", // the egress worker, as observed
		"", "not-a-uuid", "12345",
		"00000000-0000-4000-8000-00000000host",  // right length, bad hex
		"00000000-0000-4000-8000-0000000000a10", // one char too long
	} {
		if isUUID(id) {
			t.Errorf("isUUID(%q) = true, want false", id)
		}
	}
	for _, id := range []string{
		"00000000-0000-4000-8000-0000000000a1",
		"DF409925-1A01-43DE-AB21-8C5E10651C60", // upper case is still a uuid
	} {
		if !isUUID(id) {
			t.Errorf("isUUID(%q) = false, want true", id)
		}
	}
}

// ── stage roles (Gap 1) ───────────────────────────────────────────────
//
// The stage is capped at 20 while the audience is unbounded, so who lands on
// which side of that line is the whole feature. These pin the decisions that
// need no database; the invited-speaker branch is a query and is covered by the
// SQL suite and the live end-to-end run.

func TestGoLiveStageRoleHostAndFailClosed(t *testing.T) {
	const host = "00000000-0000-4000-8000-0000000000a1"
	const other = "00000000-0000-4000-8000-0000000000c3"

	if got := goliveStageRole(t.Context(), host, "b1", host); got != livekit.RoleHost {
		t.Fatalf("owner got role %q, want host", got)
	}
	// No user, no database, or simply not invited — every one of these must land
	// on audience. The thing being defaulted is permission to publish to an
	// unbounded audience, so the only safe default is no.
	if got := goliveStageRole(t.Context(), "", "b1", host); got != livekit.RoleAudience {
		t.Fatalf("empty uid got role %q, want audience", got)
	}
	// db.Pool is nil in unit tests, which exercises the fail-closed path.
	if got := goliveStageRole(t.Context(), other, "b1", host); got != livekit.RoleAudience {
		t.Fatalf("stranger with no DB got role %q, want audience", got)
	}
}

// canPublish must mirror the LiveKit grant exactly. If these drift, the UI shows
// controls the media server will refuse — or hides ones it would have allowed.
func TestGoLiveCanPublishMirrorsTheGrant(t *testing.T) {
	for _, r := range []livekit.Role{livekit.RoleHost, livekit.RoleCohost, livekit.RoleSpeaker} {
		if !goliveCanPublish(r) {
			t.Errorf("%s should be allowed to publish", r)
		}
		if !livekit.GrantFor(r, "golive_x").CanPublish {
			t.Errorf("%s: grant disagrees with goliveCanPublish", r)
		}
	}
	if goliveCanPublish(livekit.RoleAudience) {
		t.Error("audience must not publish")
	}
	if livekit.GrantFor(livekit.RoleAudience, "golive_x").CanPublish {
		t.Error("audience grant claims canPublish")
	}
}
