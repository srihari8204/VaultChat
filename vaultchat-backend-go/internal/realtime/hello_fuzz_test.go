package realtime

// hello_fuzz_test.go — adversarial coverage of the LIVE-PATH protobuf reader.
//
// WHY THIS FILE EXISTS SEPARATELY
//
// internal/ccwire/fuzz_test.go fuzzes the canonical codec, and that codec is
// not what reads a ClientHello. This package has a SECOND protobuf reader
// (`pbr`, in ccwire_cursor.go) used by ccwireParseClientHello, parseStreamCursor,
// helloWantsResumption, noteProgress and ccwireDecodeCursors — everything on the
// handshake, cursor and keepalive path.
//
// Two readers means two behaviours, and the gap between them is where a parser
// differential lives. One was found by audit and fixed: `pbr.varint` accepted
// ten bytes in TAG and LENGTH position where all three canonical codecs cap
// those at five and refuse longer as VARINT_OVERFLOW — a refusal
// lib/ccwire/__vectors__/codec.json pins as a shared vector. The server was
// accepting, one layer up, bytes its own frame layer refuses.
//
// A fix without coverage is a fix that lasts until the next edit. These targets
// exist so the second reader is fuzzed like the first.
//
// WHAT IS ASSERTED
//
// Not "the parse succeeds" — almost every input here is garbage and refusal is
// the correct answer. What is asserted is that refusal is the WORST outcome: no
// panic, no unbounded allocation, no slice out of range, and no accepted result
// whose contents violate a bound the parser advertises. A parser that refuses
// cleanly in constant space is doing its job.

import (
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

// FuzzParseClientHello drives the handshake parser directly.
//
// This is the FIRST thing an unauthenticated-in-practice peer sends: the
// connection is authenticated at the upgrade, but the bytes here arrive before
// anything in this package has agreed to anything, so the parser is the trust
// boundary.
func FuzzParseClientHello(f *testing.F) {
	lim := ccwire.DefaultLimits()

	// Seeds are shapes worth starting from, not an exhaustive list. Each one is
	// a case the parser has to get right, and the fuzzer mutates outward.
	f.Add([]byte{})
	f.Add([]byte{8, 1})                                  // protocol_major only
	f.Add([]byte{8, 1, 0x2a, 3, 'd', 'e', 'v'})          // device_id
	f.Add([]byte{8, 1, 0x3a, 3, 't', 'o', 'k'})          // resume_token
	f.Add([]byte{8, 1, 0x42, 4, 0x08, 0x02, 0x10, 0x07}) // one resume_from cursor
	f.Add([]byte{8, 1, 0x1a, 6, 8, 1, 16, 1, 64, 1})     // capabilities
	f.Add([]byte{0x88, 0x80, 0x80, 0x80, 0x80, 0x80, 0}) // over-long tag varint
	f.Add([]byte{0x42, 0xff, 0xff, 0xff, 0xff, 0x0f})    // length past the buffer

	f.Fuzz(func(t *testing.T, b []byte) {
		h, ok := ccwireParseClientHello(b, lim)
		if !ok {
			return // refusal is the expected answer for almost everything here
		}
		// An ACCEPTED hello must respect every bound the parser advertises.
		// Accepting is the dangerous outcome, so it is the one with assertions.
		if len(h.deviceID) > lim.MaxStringFieldBytes {
			t.Fatalf("accepted device_id of %d bytes, bound is %d",
				len(h.deviceID), lim.MaxStringFieldBytes)
		}
		if len(h.resumeToken) > lim.MaxStringFieldBytes {
			t.Fatalf("accepted resume_token of %d bytes, bound is %d",
				len(h.resumeToken), lim.MaxStringFieldBytes)
		}
		if len(h.resumeFrom) > maxResumeFromEntries {
			t.Fatalf("accepted %d resume_from entries, bound is %d",
				len(h.resumeFrom), maxResumeFromEntries)
		}
	})
}

// FuzzNoteProgress drives the Ping.progress reader through a real session.
//
// Ping is the one frame a peer may send repeatedly forever, so its parser runs
// more often than any other. It also MOVES STATE — noteAcked releases retained
// frames — which makes "refuses cleanly" insufficient: what it accepts must not
// be able to push the session's acknowledged position past what was sent.
func FuzzNoteProgress(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte{0x12, 0x04, 0x08, 0x02, 0x10, 0x07})       // one cursor
	f.Add([]byte{0x12, 0x05, 0x08, 0x02, 0x10, 0xac, 0x02}) // seq 300
	f.Add([]byte{0x0a, 8, 0, 0, 0, 0, 0, 0, 0, 1})          // nonce only
	f.Add([]byte{0x12, 0xff, 0xff, 0xff, 0xff, 0x0f})       // length past the buffer

	f.Fuzz(func(t *testing.T, b []byte) {
		h := hubWithResume()
		s := sessionOn(h, "u1", "dev-1", "sess-1")
		capture(s)
		// A session with a known SENT position, so a claim past it is
		// detectable rather than merely unlikely.
		s.send(ccwire.Message{
			TrafficClass: ccwire.TrafficClassMessaging,
			Stream:       ccwireStreamMessaging,
			Seq:          10,
			BodyField:    ccwire.BodyTypingState,
			Body:         []byte{},
		})

		s.noteProgress(b)

		// The invariant that matters: a client cannot acknowledge what it was
		// never sent. Everything downstream — which frames the window releases,
		// where a resume replays from — is built on this holding.
		s.pos.mu.Lock()
		defer s.pos.mu.Unlock()
		for stream, acked := range s.acked {
			if sent := s.cursors[stream]; acked > sent {
				t.Fatalf("stream %d acknowledged %d but only %d was sent", stream, acked, sent)
			}
		}
	})
}
