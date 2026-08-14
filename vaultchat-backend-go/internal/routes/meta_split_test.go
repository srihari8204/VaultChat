// meta_split_test.go — what the durable spine is allowed to keep.
//
// The split is the security boundary of this whole change: the ciphertext was
// never the only leak. messages.meta carried a 240px base64 JPEG of every photo
// and video, and it sat on a table with no expiry at all. These tests pin the
// boundary so a future field cannot drift back onto the spine unnoticed.
package routes

import (
	"strings"
	"testing"
)

func TestSplitMetaKeepsPrivateContentOffTheSpine(t *testing.T) {
	meta := map[string]any{
		"thumb":        "/9j/4AAQSkZJRgABAQ...", // base64 JPEG — the original leak
		"filename":     "passport-scan.pdf",
		"mime":         "application/pdf",
		"width":        1024,
		"height":       768,
		"durationMs":   4200,
		"waveform":     []any{1, 2, 3},
		"options":      []any{"Pizza", "Sushi", "Tacos"},
		"attachmentId": "att-1",
		"announcement": true,
		"silent":       true,
	}
	pub, priv := chatsSplitMeta(meta)

	for _, k := range []string{"thumb", "filename", "mime", "width", "height", "durationMs", "waveform", "options"} {
		if _, leaked := pub[k]; leaked {
			t.Errorf("%q stayed on the durable spine — it must travel with the body", k)
		}
		if _, ok := priv[k]; !ok {
			t.Errorf("%q was dropped entirely instead of moved to the body", k)
		}
	}
	// Routing metadata the SERVER reads must survive, or authorisation and push
	// stop working the moment the body expires.
	for _, k := range []string{"attachmentId", "announcement", "silent"} {
		if _, ok := pub[k]; !ok {
			t.Errorf("%q must stay on the spine — server code reads it", k)
		}
	}
}

func TestSplitMetaIsAnAllowList(t *testing.T) {
	// A field nobody has thought about must default to PRIVATE. A deny-list
	// would fail open: the next feature to add a meta key would silently park
	// it on a table that never expires.
	pub, priv := chatsSplitMeta(map[string]any{"someFutureField": "secret"})
	if _, leaked := pub["someFutureField"]; leaked {
		t.Fatal("an unknown meta field defaulted to the spine; the split must be an allow-list")
	}
	if priv["someFutureField"] != "secret" {
		t.Fatal("an unknown meta field was dropped rather than moved to the body")
	}
}

func TestSplitMetaDerivesOptionCountWithoutOptionText(t *testing.T) {
	// Polls must keep working after the body expires. The server needs the
	// COUNT to validate 0 <= index < n; it does not need to know the choices.
	pub, priv := chatsSplitMeta(map[string]any{
		"options":       []any{"Yes", "No", "Maybe"},
		"allowMultiple": true,
	})
	if pub["optionCount"] != 3 {
		t.Fatalf("optionCount = %v, want 3", pub["optionCount"])
	}
	if _, leaked := pub["options"]; leaked {
		t.Fatal("poll option TEXT stayed on the spine")
	}
	if _, ok := priv["options"]; !ok {
		t.Fatal("poll options were dropped instead of moved to the body")
	}
	if pub["allowMultiple"] != true {
		t.Fatal("allowMultiple must stay on the spine — the vote handler reads it")
	}
}

func TestSplitMetaDerivesMentionIdsWithoutMentionDetail(t *testing.T) {
	// chatsSendMessagePush overrides a MUTED chat for mentioned users and reads
	// only userId. Reducing to bare ids preserves that while the display detail
	// becomes ephemeral — and it is derived server-side, so no client change is
	// needed for it to work.
	pub, priv := chatsSplitMeta(map[string]any{
		"mentions": []any{
			map[string]any{"userId": "u1", "name": "Alice", "offset": 4},
			map[string]any{"userId": "u2", "name": "Bob", "offset": 12},
		},
	})
	ids, ok := pub["mentionUserIds"].([]any)
	if !ok || len(ids) != 2 || ids[0] != "u1" || ids[1] != "u2" {
		t.Fatalf("mentionUserIds = %v, want [u1 u2]", pub["mentionUserIds"])
	}
	if _, leaked := pub["mentions"]; leaked {
		t.Fatal("full mention objects (with display names) stayed on the spine")
	}
	if _, ok := priv["mentions"]; !ok {
		t.Fatal("mentions were dropped instead of moved to the body")
	}
}

func TestSplitMetaNilStaysNil(t *testing.T) {
	// A message with no metadata must not gain an empty object on either side —
	// that would be a wire change no client asked for.
	pub, priv := chatsSplitMeta(nil)
	if pub != nil || priv != nil {
		t.Fatalf("nil meta produced pub=%v priv=%v, want both nil", pub, priv)
	}
}

func TestMetaMergeRestoresTheClientView(t *testing.T) {
	// The read seam merges the two halves back into one `meta`, which is what
	// makes the split invisible to already-deployed clients. Pin the SQL shape:
	// spine first, body second (right-biased ||), and NULL preserved.
	sel := chatsMsgSelBody("m")
	if !strings.Contains(sel, "COALESCE(m.meta, '{}'::jsonb) || COALESCE(b.meta_private, '{}'::jsonb)") {
		t.Fatalf("meta is not re-merged on read:\n%s", sel)
	}
	if !strings.Contains(sel, "m.meta IS NULL AND b.meta_private IS NULL THEN NULL") {
		t.Fatalf("merge does not preserve a NULL meta:\n%s", sel)
	}
}
