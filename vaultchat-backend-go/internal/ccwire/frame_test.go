package ccwire

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// vectorPath is the SHARED fixture, asserted by this file and by
// lib/ccwire/parity.selftest.ts. It follows the services/crypto/__vectors__
// pattern already used in this repo for cross-language crypto parity.
const vectorPath = "../../../lib/ccwire/__vectors__/frame.json"

// ---------------------------------------------------------------------------
// Vector file shape. Field names are what the TS side reads.
// ---------------------------------------------------------------------------

type encodeVec struct {
	Name       string `json:"name"`
	PayloadHex string `json:"payloadHex"`
	FrameHex   string `json:"frameHex"`
}

type decodeVec struct {
	Name       string `json:"name"`
	InputHex   string `json:"inputHex"`
	MaxBytes   int    `json:"maxBytes"` // 0 = hard max
	Strict     bool   `json:"strict"`
	OK         bool   `json:"ok"`
	Version    int    `json:"version"`
	PayloadHex string `json:"payloadHex"`
	Consumed   int    `json:"consumed"`
	Error      string `json:"error"` // "" when ok
}

type streamVec struct {
	Name      string   `json:"name"`
	InputHex  string   `json:"inputHex"`
	FramesHex []string `json:"framesHex"`
	Consumed  int      `json:"consumed"`
	Error     string   `json:"error"`
}

type vectorFile struct {
	Note           string      `json:"note"`
	FramingVersion int         `json:"framingVersion"`
	HeaderBytes    int         `json:"headerBytes"`
	MaxFrameBytes  int         `json:"maxFrameBytes"`
	Encode         []encodeVec `json:"encode"`
	Decode         []decodeVec `json:"decode"`
	Stream         []streamVec `json:"stream"`
}

// errName maps a Go error back to the TS FrameError string. Vectors carry the
// TS spelling so one file can serve both languages.
func errName(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrIncomplete):
		return "INCOMPLETE"
	case errors.Is(err, ErrBadVersion):
		return "BAD_VERSION"
	case errors.Is(err, ErrLengthOverMax):
		return "LENGTH_OVER_MAX"
	case errors.Is(err, ErrLengthOverflow):
		return "LENGTH_OVERFLOW"
	case errors.Is(err, ErrTrailingBytes):
		return "TRAILING_BYTES"
	}
	return "UNKNOWN:" + err.Error()
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

func repeatHex(b byte, n int) string { return hex.EncodeToString(bytes.Repeat([]byte{b}, n)) }

// ---------------------------------------------------------------------------
// The vectors. Every expected value here is a LITERAL, never computed by the
// implementation under test — otherwise the fixture would only prove the code
// agrees with itself.
// ---------------------------------------------------------------------------

func vectors() vectorFile {
	p300 := repeatHex(0x07, 300)
	return vectorFile{
		Note: "CC-Wire v1 framing parity vectors. Asserted by " +
			"vaultchat-backend-go/internal/ccwire/frame_test.go and by " +
			"lib/ccwire/parity.selftest.ts. Regenerate with " +
			"CCWIRE_WRITE_VECTORS=1 go test ./internal/ccwire/...",
		FramingVersion: int(FramingVersion),
		HeaderBytes:    HeaderBytes,
		MaxFrameBytes:  MaxFrameBytes,

		Encode: []encodeVec{
			{"empty payload is legal (a bare Ping is zero bytes in proto3)", "", "0100000000"},
			{"five bytes", "0102030405", "01000000050102030405"},
			{"high bytes are not sign-extended anywhere", "ffff", "0100000002ffff"},
			{"300 bytes exercises the multi-byte length path", p300, "010000012c" + p300},
		},

		Decode: []decodeVec{
			{Name: "round trip", InputHex: "01000000050102030405", OK: true, Version: 1, PayloadHex: "0102030405", Consumed: 10},
			{Name: "empty payload decodes to zero bytes, not an error", InputHex: "0100000000", OK: true, Version: 1, PayloadHex: "", Consumed: 5},
			{Name: "300-byte payload", InputHex: "010000012c" + p300, OK: true, Version: 1, PayloadHex: p300, Consumed: 305},

			{Name: "0 bytes is INCOMPLETE", InputHex: "", Error: "INCOMPLETE"},
			{Name: "1 byte is INCOMPLETE", InputHex: "01", Error: "INCOMPLETE"},
			{Name: "2 bytes is INCOMPLETE", InputHex: "0100", Error: "INCOMPLETE"},
			{Name: "3 bytes is INCOMPLETE", InputHex: "010000", Error: "INCOMPLETE"},
			{Name: "4 bytes is INCOMPLETE", InputHex: "01000000", Error: "INCOMPLETE"},

			{Name: "declares 10, carries 3", InputHex: "010000000a010203", Error: "INCOMPLETE"},
			{Name: "declares 100000, carries 0 (multi-byte length path)", InputHex: "010001869f", Error: "INCOMPLETE"},

			{Name: "a length of 4 GiB is refused before any allocation", InputHex: "01ffffffff", Error: "LENGTH_OVER_MAX"},
			{Name: "the sign bit set does not read as negative", InputHex: "0180000000", Error: "LENGTH_OVER_MAX"},
			{Name: "exactly the hard cap passes the bound check (body absent, so INCOMPLETE)", InputHex: "0100200000", Error: "INCOMPLETE"},
			{Name: "hard cap + 1 is refused", InputHex: "0100200001", Error: "LENGTH_OVER_MAX"},
			{Name: "a negotiated max ABOVE the hard max does not raise it", InputHex: "0100200001", MaxBytes: 99999999, Error: "LENGTH_OVER_MAX"},

			{Name: "unknown framing version is refused outright, not downgraded", InputHex: "6300000000", Error: "BAD_VERSION"},
			{Name: "version 0 is refused", InputHex: "0000000000", Error: "BAD_VERSION"},
			{Name: "version 2 is refused (no forward tolerance)", InputHex: "0200000000", Error: "BAD_VERSION"},
			{Name: "a bad version is rejected before the length is even read", InputHex: "63ffffffff", Error: "BAD_VERSION"},

			{Name: "trailing bytes are tolerated by default", InputHex: "0100000002010200 0000", OK: true, Version: 1, PayloadHex: "0102", Consumed: 7},
			{Name: "trailing bytes are refused under strict", InputHex: "01000000020102000000", Strict: true, Error: "TRAILING_BYTES"},
			{Name: "strict accepts an exact frame", InputHex: "0100000002 0102", Strict: true, OK: true, Version: 1, PayloadHex: "0102", Consumed: 7},

			{Name: "over the negotiated max but under the hard max", InputHex: "010000000a0102030405060708090a", MaxBytes: 4, Error: "LENGTH_OVER_MAX"},
			{Name: "the same frame passes at the hard max", InputHex: "010000000a0102030405060708090a", OK: true, Version: 1, PayloadHex: "0102030405060708090a", Consumed: 15},
			{Name: "a payload of exactly the negotiated max is accepted", InputHex: "010000000a0102030405060708090a", MaxBytes: 10, OK: true, Version: 1, PayloadHex: "0102030405060708090a", Consumed: 15},
		},

		Stream: []streamVec{
			// Built by concatenating frame literals; each of those shapes is
			// independently asserted in the Encode table above.
			{Name: "three concatenated frames",
				InputHex:  "010000000101" + "01000000020202" + "0100000003030303",
				FramesHex: []string{"01", "0202", "030303"}, Consumed: 21},
			{Name: "empty buffer yields nothing and consumes nothing", InputHex: "", FramesHex: []string{}, Consumed: 0},
			{Name: "a partial tail is retained for the next read", InputHex: "0100000003010101" + "010000",
				FramesHex: []string{"010101"}, Consumed: 8},
			{Name: "a header-only tail is retained", InputHex: "0100000001" + "09" + "0100000004",
				FramesHex: []string{"09"}, Consumed: 6},
			{Name: "a bad length stops the scan and reports (a stream cannot resynchronise)",
				InputHex: "010000000109" + "01ffffffff", FramesHex: []string{"09"}, Consumed: 6, Error: "LENGTH_OVER_MAX"},
			{Name: "a bad version mid-stream stops the scan",
				InputHex: "010000000109" + "6300000000", FramesHex: []string{"09"}, Consumed: 6, Error: "BAD_VERSION"},
		},
	}
}

// normalise strips the readability spaces used in a couple of the hex literals
// above so the on-disk fixture is canonical.
func normalise(v *vectorFile) {
	strip := func(s string) string {
		out := make([]byte, 0, len(s))
		for i := 0; i < len(s); i++ {
			if s[i] != ' ' {
				out = append(out, s[i])
			}
		}
		return string(out)
	}
	for i := range v.Encode {
		v.Encode[i].PayloadHex = strip(v.Encode[i].PayloadHex)
		v.Encode[i].FrameHex = strip(v.Encode[i].FrameHex)
	}
	for i := range v.Decode {
		v.Decode[i].InputHex = strip(v.Decode[i].InputHex)
		v.Decode[i].PayloadHex = strip(v.Decode[i].PayloadHex)
	}
	for i := range v.Stream {
		v.Stream[i].InputHex = strip(v.Stream[i].InputHex)
		for j := range v.Stream[i].FramesHex {
			v.Stream[i].FramesHex[j] = strip(v.Stream[i].FramesHex[j])
		}
	}
}

// ---------------------------------------------------------------------------
// Go side of the parity assertion: run every shared vector through the real
// implementation, then check the on-disk fixture still matches.
// ---------------------------------------------------------------------------

func TestSharedVectors(t *testing.T) {
	v := vectors()
	normalise(&v)

	for _, c := range v.Encode {
		t.Run("encode/"+c.Name, func(t *testing.T) {
			got, err := Encode(unhex(t, c.PayloadHex), Options{})
			if err != nil {
				t.Fatalf("Encode: %v", err)
			}
			if h := hex.EncodeToString(got); h != c.FrameHex {
				t.Fatalf("frame\n got %s\nwant %s", h, c.FrameHex)
			}
		})
	}

	for _, c := range v.Decode {
		t.Run("decode/"+c.Name, func(t *testing.T) {
			f, err := Decode(unhex(t, c.InputHex), Options{MaxBytes: c.MaxBytes, Strict: c.Strict})
			if name := errName(err); name != c.Error {
				t.Fatalf("error = %q, want %q (%v)", name, c.Error, err)
			}
			if !c.OK {
				return
			}
			if int(f.Version) != c.Version || f.Consumed != c.Consumed {
				t.Fatalf("version/consumed = %d/%d, want %d/%d", f.Version, f.Consumed, c.Version, c.Consumed)
			}
			if h := hex.EncodeToString(f.Payload); h != c.PayloadHex {
				t.Fatalf("payload\n got %s\nwant %s", h, c.PayloadHex)
			}
		})
	}

	for _, c := range v.Stream {
		t.Run("stream/"+c.Name, func(t *testing.T) {
			frames, consumed, err := DecodeStream(unhex(t, c.InputHex), Options{})
			if name := errName(err); name != c.Error {
				t.Fatalf("error = %q, want %q (%v)", name, c.Error, err)
			}
			if consumed != c.Consumed {
				t.Fatalf("consumed = %d, want %d", consumed, c.Consumed)
			}
			if len(frames) != len(c.FramesHex) {
				t.Fatalf("got %d frames, want %d", len(frames), len(c.FramesHex))
			}
			for i, want := range c.FramesHex {
				if h := hex.EncodeToString(frames[i]); h != want {
					t.Fatalf("frame %d\n got %s\nwant %s", i, h, want)
				}
			}
		})
	}
}

// TestVectorFileInSync keeps the committed fixture honest: if the table above
// changes and the file is not regenerated, TypeScript would silently keep
// asserting stale bytes. This fails instead.
func TestVectorFileInSync(t *testing.T) {
	v := vectors()
	normalise(&v)
	want, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')

	if os.Getenv("CCWIRE_WRITE_VECTORS") == "1" {
		if err := os.MkdirAll(filepath.Dir(vectorPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(vectorPath, want, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Log("wrote", vectorPath)
		return
	}

	got, err := os.ReadFile(vectorPath)
	if err != nil {
		t.Fatalf("%v (regenerate: CCWIRE_WRITE_VECTORS=1 go test ./internal/ccwire/...)", err)
	}
	if !bytes.Equal(bytes.ReplaceAll(got, []byte("\r\n"), []byte("\n")), want) {
		t.Fatalf("%s is stale — regenerate: CCWIRE_WRITE_VECTORS=1 go test ./internal/ccwire/...", vectorPath)
	}
}

// ---------------------------------------------------------------------------
// Go-specific cases with no TypeScript equivalent.
// ---------------------------------------------------------------------------

func TestGoSpecific(t *testing.T) {
	t.Run("nil slice is INCOMPLETE, same as empty", func(t *testing.T) {
		if _, err := Decode(nil, Options{}); !errors.Is(err, ErrIncomplete) {
			t.Fatalf("got %v", err)
		}
		if _, err := Decode([]byte{}, Options{}); !errors.Is(err, ErrIncomplete) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("nil payload encodes to a zero-length frame", func(t *testing.T) {
		f, err := Encode(nil, Options{})
		if err != nil || hex.EncodeToString(f) != "0100000000" {
			t.Fatalf("got %x, %v", f, err)
		}
		d, err := Decode(f, Options{})
		if err != nil || len(d.Payload) != 0 {
			t.Fatalf("got %v, %v", d, err)
		}
		// Non-nil empty, matching the TS subarray: len 0 but addressable.
		if d.Payload == nil {
			t.Fatal("payload should be an empty slice, not nil")
		}
	})

	t.Run("a length of exactly the cap round-trips", func(t *testing.T) {
		f, err := Encode(make([]byte, MaxFrameBytes), Options{})
		if err != nil {
			t.Fatalf("Encode: %v", err)
		}
		d, err := Decode(f, Options{})
		if err != nil || len(d.Payload) != MaxFrameBytes || d.Consumed != HeaderBytes+MaxFrameBytes {
			t.Fatalf("got %d/%d, %v", len(d.Payload), d.Consumed, err)
		}
	})

	t.Run("cap+1 is refused on encode and on decode", func(t *testing.T) {
		if _, err := Encode(make([]byte, MaxFrameBytes+1), Options{}); err == nil {
			t.Fatal("encoded past the hard cap")
		}
		// Decode side: a 5-byte header declaring cap+1. Nothing is allocated.
		hdr := []byte{1, 0x00, 0x20, 0x00, 0x01}
		if _, err := Decode(hdr, Options{}); !errors.Is(err, ErrLengthOverMax) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("a backing array larger than the length is not read past", func(t *testing.T) {
		full, _ := Encode([]byte{1, 2, 3}, Options{})
		big := make([]byte, 64)
		copy(big, full)
		short := big[:len(full)] // len 8, cap 64: the extra bytes must be invisible
		d, err := Decode(short, Options{Strict: true})
		if err != nil {
			t.Fatalf("strict decode of an exact frame with spare capacity: %v", err)
		}
		if cap(d.Payload) != 3 {
			t.Fatalf("payload cap = %d, want 3 (must be capped so append cannot stomp the next frame)", cap(d.Payload))
		}
		d.Payload = append(d.Payload, 0xff)
		if big[8] != 0 {
			t.Fatal("append through the payload slice overwrote the buffer beyond the frame")
		}
	})

	t.Run("payload aliases the input", func(t *testing.T) {
		f, _ := Encode([]byte{5, 6, 7}, Options{})
		d, _ := Decode(f, Options{})
		d.Payload[0] = 9
		if f[HeaderBytes] != 9 {
			t.Fatal("payload is a copy; it is documented as a view")
		}
	})

	t.Run("a negotiated max cannot exceed the hard max", func(t *testing.T) {
		if got := (Options{MaxBytes: MaxFrameBytes * 10}).cap(); got != MaxFrameBytes {
			t.Fatalf("cap = %d", got)
		}
		if got := (Options{MaxBytes: -1}).cap(); got != MaxFrameBytes {
			t.Fatalf("cap = %d", got)
		}
		if _, err := Encode(make([]byte, 11), Options{MaxBytes: 10}); err == nil {
			t.Fatal("encoded past the negotiated cap")
		}
	})

	t.Run("stream of empty-payload frames terminates", func(t *testing.T) {
		// A zero-length frame still consumes 5 bytes, so the scan must advance.
		buf := bytes.Repeat([]byte{1, 0, 0, 0, 0}, 3)
		frames, consumed, err := DecodeStream(buf, Options{})
		if err != nil || len(frames) != 3 || consumed != 15 {
			t.Fatalf("got %d frames, %d consumed, %v", len(frames), consumed, err)
		}
	})

	t.Run("errors.Is, not string matching", func(t *testing.T) {
		_, err := Decode([]byte{9, 0, 0, 0, 0}, Options{})
		if !errors.Is(err, ErrBadVersion) || errors.Is(err, ErrIncomplete) {
			t.Fatalf("taxonomy is not comparable: %v", err)
		}
	})
}
