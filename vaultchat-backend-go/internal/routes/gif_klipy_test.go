// gif_klipy_test.go — the KLIPY normalizer, against REAL captured responses.
//
// testdata/klipy_{gifs,stickers,emojis}.json are verbatim bodies from
// api.klipy.com, not hand-written fixtures. That matters: reading the docs
// produced a decoder that would have returned NOTHING for the entire emoji tab,
// because KLIPY emojis ship png + webp and carry no gif variant at all. Only
// the real payload said so.
//
// These run with no key and no network.
package routes

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func loadKlipy(t *testing.T, name string) klipyResp {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	var r klipyResp
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
	if !r.Result {
		t.Fatalf("%s: result was false", name)
	}
	if len(r.Data.Items) == 0 {
		t.Fatalf("%s: no items decoded — the envelope shape has changed", name)
	}
	return r
}

// Every content type must yield a usable preview AND a usable send URL. A type
// that silently yields neither is an empty tab, which looks like a broken
// picker rather than a decoding bug.
func TestKlipyEveryTypeNormalizes(t *testing.T) {
	for _, tc := range []struct{ file, wantType string }{
		{"klipy_gifs.json", "gif"},
		{"klipy_stickers.json", "sticker"},
		{"klipy_emojis.json", "emoji"},
	} {
		r := loadKlipy(t, tc.file)
		for i, it := range r.Data.Items {
			preview := pickVariant(it.File, "xs", "sm", "md", "hd")
			send := pickVariant(it.File, "sm", "md", "xs", "hd")

			if preview.URL == "" {
				t.Errorf("%s item %d: no preview — this tab would render blank tiles", tc.file, i)
			}
			if send.URL == "" {
				t.Errorf("%s item %d: no sendable URL — tapping a tile would send nothing", tc.file, i)
			}
			if preview.Width == 0 || preview.Height == 0 {
				t.Errorf("%s item %d: preview has no dimensions (%dx%d) — the grid needs them to lay out",
					tc.file, i, preview.Width, preview.Height)
			}
			if !strings.HasPrefix(preview.URL, "https://") {
				t.Errorf("%s item %d: preview is not https (%q)", tc.file, i, preview.URL)
			}
		}
	}
}

// THE BUG THIS FILE EXISTS FOR. Emojis have no gif variant; a gif-only picker
// returns nothing for all of them. Assert the png fallback is what rescues it,
// so nobody "simplifies" klipyFormats back down to gif.
func TestKlipyEmojisFallBackToPNG(t *testing.T) {
	r := loadKlipy(t, "klipy_emojis.json")
	it := r.Data.Items[0]

	for bucket, variants := range it.File {
		if _, hasGIF := variants["gif"]; hasGIF {
			t.Fatalf("emoji bucket %q now HAS a gif variant — this test's premise changed, re-check the picker", bucket)
		}
	}

	got := pickVariant(it.File, "xs", "sm", "md", "hd")
	if got.URL == "" {
		t.Fatal("emoji produced no variant at all — the emoji tab is empty")
	}
	if !strings.Contains(got.URL, ".png") {
		t.Errorf("expected the png fallback, got %q", got.URL)
	}
}

// Animated types must resolve to GIF, because expo.webp.animated=false makes an
// animated webp a single still frame. If this ever fails, the picker is about
// to look frozen.
func TestKlipyAnimatedTypesPreferGIF(t *testing.T) {
	for _, f := range []string{"klipy_gifs.json", "klipy_stickers.json"} {
		it := loadKlipy(t, f).Data.Items[0]
		got := pickVariant(it.File, "xs", "sm", "md", "hd")
		if !strings.Contains(got.URL, ".gif") {
			t.Errorf("%s: picked %q, expected a .gif — animated webp renders as one frame in this app", f, got.URL)
		}
	}
}

// The grid must come from the cheapest bucket. On the captured GIF a page of 24
// is ~1.2 MB from xs against ~5.8 MB from sm, and this is a surface people
// scroll idly.
func TestKlipyPreviewPrefersSmallestBucket(t *testing.T) {
	it := loadKlipy(t, "klipy_gifs.json").Data.Items[0]
	preview := pickVariant(it.File, "xs", "sm", "md", "hd")
	sm := it.File["sm"]["gif"]
	if sm.Size > 0 && preview.Size >= sm.Size {
		t.Errorf("preview (%d bytes) is not smaller than sm (%d) — the xs bucket is being skipped",
			preview.Size, sm.Size)
	}
}

// Falling back UP matters as much as down: an item carrying only hd must still
// produce something rather than being dropped from the grid.
func TestKlipyFallsBackUpwards(t *testing.T) {
	only := map[string]klipyVariants{
		"hd": {"gif": klipyFile{URL: "https://x/hd.gif", Width: 10, Height: 10}},
	}
	if got := pickVariant(only, "xs", "sm", "md", "hd"); got.URL != "https://x/hd.gif" {
		t.Errorf("hd-only item was dropped, got %q", got.URL)
	}
	if got := pickVariant(map[string]klipyVariants{}, "xs", "sm"); got.URL != "" {
		t.Errorf("an item with no files should yield nothing, got %q", got.URL)
	}
}

// An unknown or absent type must fall back to gifs — older app builds send no
// type at all, and a typo must not 400 the picker.
func TestKlipyTypeAllowlist(t *testing.T) {
	for _, ok := range []string{"gifs", "stickers", "emojis"} {
		if !klipyTypes[ok] {
			t.Errorf("%q should be offered", ok)
		}
	}
	for _, no := range []string{"clips", "memes", "", "GIFS", "../admin"} {
		if klipyTypes[no] {
			t.Errorf("%q must not be accepted — the handler coerces it to gifs", no)
		}
	}
}
