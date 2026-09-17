package ccwire

// fuzz_test.go — adversarial coverage of the CC-Wire decode path.
//
// WHY THIS EXISTS
//
// CC-Wire is the only application realtime protocol left: Socket.IO is gone
// from the app, this backend and the admin console. Every realtime byte a
// client sends reaches these decoders, and until this file there was no
// adversarial coverage of them at all — `grep -rc 'func Fuzz'` over the whole
// backend returned 0.
//
// The protocol already declares strict bounds (Limits: frame size, nesting
// depth, repeated elements, reassembly budget). Those are exactly the kind of
// invariant that holds under hand-written examples and fails on the one input
// nobody thought of. The existing tests prove the encoders AGREE on valid input
// — the golden vectors in lib/ccwire/__vectors__ do that across Go and TS.
// Nothing proved what happens on input no compliant encoder would produce.
//
// WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT
//
// Asserted: the decoder RETURNS. It may return an error, it may return a
// value, but it must not panic, must not read out of bounds, and must not hang.
// A malformed frame is a protocol error to report, never a process outcome —
// a crash here is a gateway outage rather than one bad session.
//
// NOT asserted: specific error codes. Freezing internal error classification
// would make these brittle against honest refactors and would test the
// taxonomy rather than the safety property.
//
// Reassembly is covered SEPARATELY, in internal/realtime/reasm_fuzz_test.go —
// a reassembler is stateful, so its failures need a fragment SEQUENCE that no
// single malformed buffer here can express. Rust companion:
// services/transport/rust/tests/reasm_adversarial.rs.
//
// Seeds come from the SHARED corpus at lib/ccwire/__vectors__/adversarial.json,
// the same fixture services/transport/rust/tests/adversarial.rs reads. One file
// so the two implementations cannot drift into disagreeing about what is
// refusable — the convention frame.json and codec.json already follow.
//
// Seeds run as ordinary unit tests under `go test ./...` with no -fuzz flag,
// so the regression value lands in the existing gate with no CI change. A
// campaign is opt-in:
//
//	go test ./internal/ccwire -run=FuzzDecodeFrame -fuzz=FuzzDecodeFrame -fuzztime=60s

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// adversarialVectorPath is the SHARED corpus, also read by
// services/transport/rust/tests/adversarial.rs.
const adversarialVectorPath = "../../../lib/ccwire/__vectors__/adversarial.json"

type adversarialCase struct {
	Name   string `json:"name"`
	Hex    string `json:"hex"`
	Accept bool   `json:"accept"`
	Why    string `json:"why"`
}

// sharedCorpus reads the fixture. A missing or malformed corpus FAILS rather
// than silently degrading to the in-code seeds: a fuzz target quietly running
// on fewer inputs than it claims is worse than one that does not run.
func sharedCorpus(t testing.TB) []adversarialCase {
	t.Helper()
	raw, err := os.ReadFile(adversarialVectorPath)
	if err != nil {
		t.Fatalf("cannot read shared adversarial corpus at %s: %v", adversarialVectorPath, err)
	}
	var doc struct {
		Cases []adversarialCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("shared adversarial corpus is not valid JSON: %v", err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("shared adversarial corpus is empty")
	}
	return doc.Cases
}

// Hex decoding reuses the package's existing unhex from frame_test.go rather
// than defining a second one.
func corpusBytes(t testing.TB, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.Join(strings.Fields(s), ""))
	if err != nil {
		t.Fatalf("bad hex in corpus: %v", err)
	}
	return b
}

// Every target fuzzes against DefaultLimits() on purpose: a bound that only
// holds under a generous test-only limit is not the bound the gateway runs with.

// adversarialSeeds are the structural classes the protocol has to survive.
// Kept as raw bytes rather than built through the encoder on purpose — an
// encoder cannot produce most of these, which is exactly why they matter.
func adversarialSeeds() [][]byte {
	// Structural shapes that are easier to build than to spell in hex. The
	// SHARED corpus carries the wire-level cases; these carry the generated
	// ones (deep nesting, long repeats) that would be unreadable as a literal.
	seeds := [][]byte{
		{},                       // empty
		{0x00},                   // single zero byte
		{0xFF},                   // single high byte
		{0x08},                   // tag with no value
		{0x08, 0xFF},             // varint truncated mid-continuation
		{0x0A, 0x7F},             // length-delimited claiming 127 bytes, none present
		{0x0A, 0xFF, 0xFF, 0xFF}, // length itself malformed
		// Overlong varint: ten continuation bytes exceeds 64 bits.
		{0x08, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF},
		// Field 0 is not legal in protobuf.
		{0x00, 0x01},
		// Wire type 6 and 7 are reserved/invalid.
		{0x0E, 0x01},
		{0x0F, 0x01},
		// Declared length far beyond any frame limit, with no payload behind
		// it. The decoder must refuse WITHOUT allocating the declared size.
		{0x0A, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F},
	}

	// Deep nesting: each level is a length-delimited field wrapping the next.
	// Must be refused by max_nesting_depth rather than recursing to a stack
	// overflow — a panic Go cannot recover.
	deep := []byte{0x08, 0x01}
	for i := 0; i < 200; i++ {
		inner := append([]byte{0x0A, byte(len(deep))}, deep...)
		deep = inner
		if len(deep) > 60000 {
			break
		}
	}
	seeds = append(seeds, deep)

	// A long run of repeated fields, to press max_repeated_elements.
	var many bytes.Buffer
	for i := 0; i < 5000; i++ {
		many.Write([]byte{0x08, 0x01})
	}
	seeds = append(seeds, many.Bytes())

	// Numeric extremes on a varint field: 0, 2^53 (JS safe-integer edge),
	// 2^63, 2^64-1. seq and depends_on are uint64 and carried as JS_STRING
	// precisely so JavaScript cannot silently truncate past 2^53.
	for _, v := range []uint64{0, 1 << 53, 1 << 63, ^uint64(0)} {
		seeds = append(seeds, AppendVarintField(nil, 4, v))
	}

	return seeds
}

// FuzzDecodeMessage drives the generic protobuf-ish message decoder, which is
// the innermost layer every body ultimately goes through.
func FuzzDecodeMessage(f *testing.F) {
	for _, c := range sharedCorpus(f) {
		f.Add(corpusBytes(f, c.Hex))
	}
	for _, s := range adversarialSeeds() {
		f.Add(s)
	}
	lim := DefaultLimits()
	f.Fuzz(func(t *testing.T, data []byte) {
		// Must return, whatever the bytes are. A panic fails the test by
		// propagating — that is the assertion.
		_, _ = DecodeMessage(data, lim, lim.MaxFrameBytes, 0)
	})
}

// FuzzDecodeFrame drives the outer framing layer — the first code any hostile
// byte on the wire reaches.
func FuzzDecodeFrame(f *testing.F) {
	for _, c := range sharedCorpus(f) {
		f.Add(corpusBytes(f, c.Hex))
	}
	for _, s := range adversarialSeeds() {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		_, _ = Decode(data, Options{})
	})
}

// FuzzDecodeStream drives the multi-frame reader. Framing bugs that need two
// frames to express — a length that overlaps the next frame's header — are
// only reachable here.
func FuzzDecodeStream(f *testing.F) {
	for _, c := range sharedCorpus(f) {
		f.Add(corpusBytes(f, c.Hex))
	}
	for _, s := range adversarialSeeds() {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		frames, consumed, err := DecodeStream(data, Options{})
		if err != nil {
			return
		}
		// consumed must stay inside the buffer. A consumed count past the end
		// would advance a real reader past unread bytes and desynchronise the
		// stream — silent corruption rather than a clean refusal.
		if consumed < 0 || consumed > len(data) {
			t.Fatalf("DecodeStream consumed %d of %d bytes", consumed, len(data))
		}
		for _, fr := range frames {
			if len(fr) > len(data) {
				t.Fatalf("frame of %d bytes from a %d byte buffer", len(fr), len(data))
			}
		}
	})
}

// FuzzDecodeBody drives the typed-body dispatch across EVERY body field
// number, including ones this build does not know. Body decoding is where the
// per-type parsers live, so the outer frame targets alone never reach it.
func FuzzDecodeBody(f *testing.F) {
	for _, c := range sharedCorpus(f) {
		for _, field := range []uint32{48, 52, 81, 96, 99, 200} {
			f.Add(field, corpusBytes(f, c.Hex))
		}
	}
	for _, s := range adversarialSeeds() {
		// 48 = submit_message, 52 = receipt, 81 = typing_state,
		// 96 = attachment_control, 99 = call_signal, 200 = unknown-to-us.
		for _, field := range []uint32{48, 52, 81, 96, 99, 200} {
			f.Add(field, s)
		}
	}
	lim := DefaultLimits()
	f.Fuzz(func(t *testing.T, field uint32, data []byte) {
		_, _ = DecodeBody(field, data, lim, 0)
	})
}

// FuzzDecodeScope drives subscription scope parsing. Scope decides WHICH chat
// a session may join, so a parser defect here is an authorization-adjacent
// surface, not merely a decoding one.
func FuzzDecodeScope(f *testing.F) {
	for _, c := range sharedCorpus(f) {
		f.Add(corpusBytes(f, c.Hex))
	}
	for _, s := range adversarialSeeds() {
		f.Add(s)
	}
	lim := DefaultLimits()
	f.Fuzz(func(t *testing.T, data []byte) {
		_, id, err := DecodeScope(data, lim)
		if err != nil {
			return
		}
		// A scope id accepted past the declared string bound would mean the
		// limit is enforced by the encoder alone, which is not enforcement.
		if len(id) > lim.MaxStringFieldBytes {
			t.Fatalf("scope id of %d bytes exceeds MaxStringFieldBytes=%d",
				len(id), lim.MaxStringFieldBytes)
		}
	})
}

// TestSharedCorpusAgreesWithGo is the Go half of the cross-implementation
// check. services/transport/rust/tests/adversarial.rs asserts the SAME
// `accept` column against the Rust decoder, so a divergence shows up as one of
// the two failing rather than as a silent difference in what the two ends of
// the protocol consider refusable.
//
// It asserts only the accept/reject DECISION, never the error variant: the two
// implementations classify errors differently on purpose, and freezing that
// would test the taxonomy instead of the contract.
func TestSharedCorpusAgreesWithGo(t *testing.T) {
	lim := DefaultLimits()
	for _, c := range sharedCorpus(t) {
		buf := corpusBytes(t, c.Hex)
		_, err := DecodeMessage(buf, lim, lim.MaxFrameBytes, 0)
		if c.Accept && err != nil {
			t.Errorf("%s: corpus says acceptable, Go refused it: %v (why: %s)", c.Name, err, c.Why)
		}
		if !c.Accept && err == nil {
			t.Errorf("%s: corpus says unrepresentable, Go accepted it (why: %s)", c.Name, c.Why)
		}
	}
}
