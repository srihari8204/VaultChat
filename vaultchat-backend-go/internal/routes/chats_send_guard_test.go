// chats_send_guard_test.go — the two guards on POST /chats/{id}/messages.
//
// (a) what is allowed onto the durable spine, and
// (b) how fast one account may drive the single-node realtime fan-out.
//
// Both were live holes: the meta allow-list existed but ran only inside a flag
// that production refuses at boot, and the hottest write path in the service had
// no rate limit at all.
package routes

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/redisx"
)

// ── (a) nothing content-bearing reaches messages.meta ─────────────────

// spineJSON is the exact value bound to the `meta` column — chatsSpineMeta's
// first return is what the INSERT in chatsMessagePost passes. Asserting on the
// bind param rather than on the intermediate map is the point: the map could be
// right and the wrong variable still be persisted, which is precisely the bug
// this file exists for.
func spineJSON(t *testing.T, meta map[string]any) string {
	t.Helper()
	param, _ := chatsSpineMeta(meta)
	if param == nil {
		return ""
	}
	s, ok := param.(string)
	if !ok {
		t.Fatalf("spine meta bind param is %T, want a JSON string — pgx cannot infer a type for a raw map under exec mode", param)
	}
	return s
}

func TestSpineMetaNeverPersistsAThumbnail(t *testing.T) {
	// The real shapes an older client sends. `thumb` is the headline — a base64
	// JPEG preview of the photo, on a table with no expiry — but every one of
	// these is message content the server has no reason to hold.
	cases := []struct {
		name    string
		meta    map[string]any
		private []string // must NOT appear in the persisted JSON
		public  []string // must survive: server code reads them
	}{
		{
			name: "image with preview",
			meta: map[string]any{
				"attachmentId": "att-1",
				"thumb":        "/9j/4AAQSkZJRgABAQAAAQABAAD-SECRET-PREVIEW",
				"filename":     "passport-scan.jpg",
				"mime":         "image/jpeg",
				"width":        1024,
				"height":       768,
			},
			private: []string{"thumb", "SECRET-PREVIEW", "filename", "passport-scan", "mime", "width", "height"},
			public:  []string{"attachmentId"},
		},
		{
			name: "video with preview and duration",
			meta: map[string]any{
				"attachmentId": "att-2",
				"thumb":        "BASE64VIDEOFRAME",
				"durationMs":   4200,
				"viewOnce":     true,
			},
			private: []string{"thumb", "BASE64VIDEOFRAME", "durationMs"},
			public:  []string{"attachmentId", "viewOnce"},
		},
		{
			name: "audio waveform",
			meta: map[string]any{
				"attachmentId": "att-3",
				"waveform":     []any{1, 2, 3},
				"filename":     "voice-note.m4a",
			},
			private: []string{"waveform", "filename", "voice-note"},
			public:  []string{"attachmentId"},
		},
		{
			name: "poll keeps the count, never the choices",
			meta: map[string]any{
				"options":       []any{"Resign", "Stay", "Abstain"},
				"allowMultiple": true,
			},
			private: []string{`"options"`, "Resign", "Abstain"},
			public:  []string{"allowMultiple", `"optionCount":3`},
		},
		{
			name: "mentions keep the ids, never the names",
			meta: map[string]any{
				"mentions": []any{map[string]any{"userId": "u1", "name": "Alice"}},
			},
			private: []string{`"mentions"`, "Alice"},
			public:  []string{"mentionUserIds", "u1"},
		},
		{
			name: "a key nobody has thought about defaults to private",
			meta: map[string]any{
				"attachmentId":      "att-4",
				"someFutureField":   "leak",
				"anotherNewFeature": map[string]any{"thumb": "nested"},
			},
			private: []string{"someFutureField", "leak", "anotherNewFeature", "nested"},
			public:  []string{"attachmentId"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := spineJSON(t, tc.meta)
			for _, needle := range tc.private {
				if strings.Contains(got, needle) {
					t.Errorf("%q reached the durable spine — messages.meta is plaintext and never expires:\n%s", needle, got)
				}
			}
			for _, needle := range tc.public {
				if !strings.Contains(got, needle) {
					t.Errorf("%q was stripped — server code reads it and stops working without it:\n%s", needle, got)
				}
			}
			// Whatever is left must still be a JSON object; the column is jsonb.
			var round map[string]any
			if err := json.Unmarshal([]byte(got), &round); err != nil {
				t.Fatalf("spine meta is not valid JSON (%v): %s", err, got)
			}
		})
	}
}

// THE REGRESSION THIS FILE IS NAMED AFTER.
//
// chatsSplitMeta was always correct. It was applied inside `if bodiesEnabled()`,
// and that flag is REFUSED at boot in production (jobs.bodyStoreRefused), so the
// split never ran and the full meta went onto the spine on every send. The split
// must therefore not depend on the flag in any way.
func TestSpineMetaIsIndependentOfTheBodyStoreFlag(t *testing.T) {
	meta := map[string]any{"attachmentId": "att-1", "thumb": "SECRET"}

	// bodiesEnabled() is whatever this environment says; assert the property
	// that must hold either way rather than trying to force the flag.
	got := spineJSON(t, meta)
	if strings.Contains(got, "SECRET") {
		t.Fatalf("bodiesEnabled()=%v and the thumbnail was persisted anyway.\n"+
			"The allow-list must run on EVERY send — the body store is refused in\n"+
			"production, so anything conditional on it never executes:\n%s",
			bodiesEnabled(), got)
	}
	if !strings.Contains(got, "att-1") {
		t.Fatalf("attachmentId was stripped; download authorisation joins on it:\n%s", got)
	}
}

func TestSpineMetaNilStaysNull(t *testing.T) {
	// A message with no metadata must bind NULL, not the string "null" and not
	// an empty object — either would be a wire change no client asked for.
	param, priv := chatsSpineMeta(nil)
	if param != nil {
		t.Fatalf("nil meta bound %#v, want a nil param so the column is NULL", param)
	}
	if priv != nil {
		t.Fatalf("nil meta produced a private half: %#v", priv)
	}
}

// ── (b) the per-account send limit ────────────────────────────────────

// fakeConsume is a fixed-window counter with the same contract as
// redisx.Consume: allowed while count <= limit.
func fakeConsume(counts map[string]int64) func(context.Context, string, int64, int64) redisx.RateResult {
	return func(_ context.Context, key string, limit, window int64) redisx.RateResult {
		counts[key]++
		n := counts[key]
		rem := limit - n
		if rem < 0 {
			rem = 0
		}
		return redisx.RateResult{Allowed: n <= limit, Remaining: rem, ResetInSec: window}
	}
}

func TestSendLimitTriggersAtTheBoundary(t *testing.T) {
	counts := map[string]int64{}
	orig := chatsSendConsume
	chatsSendConsume = fakeConsume(counts)
	t.Cleanup(func() { chatsSendConsume = orig })

	ctx := context.Background()

	// Exactly at the limit is still allowed — an off-by-one here rejects the
	// last message of a legitimate burst.
	for i := int64(1); i <= chatsSendBurstLimit; i++ {
		if ok, _ := chatsSendAllowed(ctx, "u1"); !ok {
			t.Fatalf("send %d of %d was refused; the burst limit must trigger AFTER the limit, not at it",
				i, chatsSendBurstLimit)
		}
	}
	ok, retry := chatsSendAllowed(ctx, "u1")
	if ok {
		t.Fatalf("send %d was allowed; the burst bucket (%d per %ds) never triggers",
			chatsSendBurstLimit+1, chatsSendBurstLimit, chatsSendBurstWindow)
	}
	if retry <= 0 {
		t.Fatalf("retryAfter = %d; a 429 with no wait hint makes clients hot-loop", retry)
	}

	// Keyed on the ACCOUNT: a second user is unaffected by the first's flood.
	// Per-chat keying would be evaded by rotating chats, which is exactly the
	// fan-out that hurts — so assert the key shape too.
	if ok, _ := chatsSendAllowed(ctx, "u2"); !ok {
		t.Fatal("a second account was throttled by the first account's burst; the bucket is not per-account")
	}
	if _, seen := counts["msg:send:u1"]; !seen {
		t.Fatalf("burst bucket key is not msg:send:<uid>: %v", counts)
	}
	if _, seen := counts["msg:send:h:u1"]; !seen {
		t.Fatalf("the sustained hourly bucket was never charged: %v", counts)
	}
}

func TestSendLimitSustainedBucketCatchesAPacedFlood(t *testing.T) {
	// A script that paces itself just under the burst window must still be
	// stopped. Charge only the hourly bucket to isolate it.
	counts := map[string]int64{}
	orig := chatsSendConsume
	chatsSendConsume = func(ctx context.Context, key string, limit, window int64) redisx.RateResult {
		if window == chatsSendBurstWindow {
			return redisx.RateResult{Allowed: true, Remaining: limit, ResetInSec: window}
		}
		return fakeConsume(counts)(ctx, key, limit, window)
	}
	t.Cleanup(func() { chatsSendConsume = orig })

	ctx := context.Background()
	for i := int64(1); i <= chatsSendHourLimit; i++ {
		if ok, _ := chatsSendAllowed(ctx, "u1"); !ok {
			t.Fatalf("send %d of %d refused by the hourly bucket", i, chatsSendHourLimit)
		}
	}
	if ok, _ := chatsSendAllowed(ctx, "u1"); ok {
		t.Fatalf("the hourly bucket (%d per %ds) never triggers — a paced flood is unbounded",
			chatsSendHourLimit, chatsSendHourWindow)
	}
}

// A Redis outage must NOT stop messaging.
//
// Same convention as callSessionStart: redisx.Consume fails OPEN when the client
// is nil or erroring, and this path inherits that deliberately. Failing closed
// here would turn a cache outage into "nobody on the platform can send a
// message" — strictly worse than the unlimited behaviour that shipped for years.
func TestSendLimitFailsOpenWithoutRedis(t *testing.T) {
	if redisx.Client != nil {
		t.Skip("a live Redis client is configured; this asserts the no-Redis path")
	}
	// No stub: the REAL redisx.Consume, with no Redis behind it.
	ctx := context.Background()
	for i := 0; i < int(chatsSendBurstLimit)*3; i++ {
		ok, _ := chatsSendAllowed(ctx, "u-no-redis")
		if !ok {
			t.Fatalf("send %d was refused with Redis unavailable — the limiter must fail OPEN", i+1)
		}
	}
}

func TestSendLimitsAreSaneForRealUsage(t *testing.T) {
	// Guardrails on the numbers themselves, so a later "tighten this" cannot
	// quietly land somewhere a real user reaches.
	//
	// A multi-select forward or a multi-photo picker fires one POST per item and
	// people routinely pick 20-30. The burst must clear that without pacing.
	if chatsSendBurstLimit < 30 {
		t.Fatalf("burst limit %d is under a 30-item multi-select forward", chatsSendBurstLimit)
	}
	// The sustained bucket must be strictly looser per-second than the burst, or
	// the burst allowance is unreachable and the two-bucket design is pointless.
	burstRate := float64(chatsSendBurstLimit) / float64(chatsSendBurstWindow)
	hourRate := float64(chatsSendHourLimit) / float64(chatsSendHourWindow)
	if hourRate >= burstRate {
		t.Fatalf("sustained rate %.2f/s >= burst rate %.2f/s; the burst bucket can never be the binding one",
			hourRate, burstRate)
	}
	// ...but still far above any human. 10/minute sustained is already heavy.
	if hourRate*60 < 10 {
		t.Fatalf("sustained allowance is %.1f messages/minute — a heavy legitimate user will hit it", hourRate*60)
	}
}
