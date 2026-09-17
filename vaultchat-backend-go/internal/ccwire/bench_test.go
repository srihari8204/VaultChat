package ccwire

// bench_test.go — CC-Wire codec benchmarks, on the real encode/decode path.
//
// WHY THIS EXISTS
//
// The repository's benchmark harness (scripts/bench) needs socket.io-client,
// which was correctly removed, so it cannot run. docs/PERF_BASELINE.md has had
// empty result tables since it was written: "Results — EMPTY, PENDING A RUN".
// Every performance claim about CC-Wire so far has therefore been an assertion.
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT
//
// Measures: the codec. Bytes to structure and back, which is the per-frame CPU
// every message on every connection pays on the gateway.
//
// Does NOT measure: connection establishment, throughput under concurrency,
// end-to-end latency, or anything requiring a server, a network or a second
// process. Those need infrastructure this cannot stand up, and a codec number
// must never be reported as a throughput number.
//
// Run:
//	go test ./internal/ccwire -bench=. -benchmem -run='^$'
//
// -benchmem is not optional here. Allocations per frame are the number that
// decides whether a gateway holding 100k connections spends its life in GC, and
// ns/op alone hides that completely.

import (
	"strings"
	"testing"
)

// benchFrames are shapes representative of real traffic, not synthetic
// best-cases. A codec benchmarked only on its happy path reports the speed of
// the path nobody takes.
func benchFrames() []struct {
	name string
	msg  Message
} {
	return []struct {
		name string
		msg  Message
	}{
		{
			// The overwhelmingly common frame: an ephemeral typing indicator.
			// Small, frequent, and the one most likely to dominate frame COUNT.
			name: "typing/ephemeral",
			msg: Message{
				TrafficClass: TrafficClassEphemeral,
				Stream:       5,
				BodyField:    81,
				Body:         []byte{0x0a, 0x04, 't', 'e', 's', 't'},
			},
		},
		{
			// A durable message with a small sealed payload — the frame that
			// actually matters to a user.
			name: "message/small",
			msg: Message{
				RequestID:    "b3d1c2e4-0000-4000-8000-000000000001",
				TrafficClass: TrafficClassMessaging,
				Stream:       2,
				Seq:          12345,
				BodyField:    48,
				Body:         append([]byte{0x0a, 0x20}, make([]byte, 32)...),
			},
		},
		{
			// 4 KiB of ciphertext: a long message or a small attachment's
			// metadata. Exercises the bulk-copy path rather than the header path.
			name: "message/4KiB",
			msg: Message{
				RequestID:    "b3d1c2e4-0000-4000-8000-000000000002",
				TrafficClass: TrafficClassMessaging,
				Stream:       2,
				Seq:          67890,
				BodyField:    48,
				Body:         append([]byte{0x0a, 0x80, 0x20}, make([]byte, 4096)...),
			},
		},
		{
			// Control traffic, which is strict-priority and therefore on the
			// latency-critical path even though it is rare.
			name: "control/ping",
			msg: Message{
				TrafficClass: TrafficClassControl,
				Stream:       1,
				BodyField:    19,
				Body:         []byte{0x0a, 0x08, 1, 2, 3, 4, 5, 6, 7, 8},
			},
		},
	}
}

func BenchmarkEncodeMessage(b *testing.B) {
	lim := DefaultLimits()
	for _, f := range benchFrames() {
		b.Run(f.name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if _, err := EncodeMessage(f.msg, lim, lim.MaxFrameBytes); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkDecodeMessage(b *testing.B) {
	lim := DefaultLimits()
	for _, f := range benchFrames() {
		buf, err := EncodeMessage(f.msg, lim, lim.MaxFrameBytes)
		if err != nil {
			b.Fatalf("%s: encode: %v", f.name, err)
		}
		b.Run(f.name, func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(buf)))
			for i := 0; i < b.N; i++ {
				if _, err := DecodeMessage(buf, lim, lim.MaxFrameBytes, 0); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkRoundTrip is the number that maps to a real gateway: a frame arrives,
// is decoded, and a response is encoded.
func BenchmarkRoundTrip(b *testing.B) {
	lim := DefaultLimits()
	for _, f := range benchFrames() {
		buf, err := EncodeMessage(f.msg, lim, lim.MaxFrameBytes)
		if err != nil {
			b.Fatalf("%s: encode: %v", f.name, err)
		}
		b.Run(f.name, func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(buf)))
			for i := 0; i < b.N; i++ {
				m, err := DecodeMessage(buf, lim, lim.MaxFrameBytes, 0)
				if err != nil {
					b.Fatal(err)
				}
				if _, err := EncodeMessage(m, lim, lim.MaxFrameBytes); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkDecodeRejection measures the cost of REFUSING hostile input. It
// belongs in the same file as the happy path because an attacker chooses which
// one the gateway runs: if rejection is dramatically more expensive than
// acceptance, the parser's strictness is itself the denial-of-service vector.
func BenchmarkDecodeRejection(b *testing.B) {
	lim := DefaultLimits()
	cases := []struct {
		name string
		buf  []byte
	}{
		{"truncated", []byte{0x0a, 0x7f}},
		{"overlong-varint", []byte{0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}},
		{"oversized-declaration", []byte{0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f}},
		{"deep-nesting", deepNest(64)},
		{"long-repeats", []byte(strings.Repeat("\x08\x01", 2048))},
	}
	for _, c := range cases {
		b.Run(c.name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_, _ = DecodeMessage(c.buf, lim, lim.MaxFrameBytes, 0)
			}
		})
	}
}

func deepNest(levels int) []byte {
	out := []byte{0x08, 0x01}
	for i := 0; i < levels; i++ {
		if len(out) > 60000 {
			break
		}
		out = append([]byte{0x0a, byte(len(out) & 0x7f)}, out...)
	}
	return out
}
