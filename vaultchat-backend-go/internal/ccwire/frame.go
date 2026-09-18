// Package ccwire implements CC-Wire v1 length-prefixed framing.
//
// STATUS: LIVE. internal/realtime serves CC-Wire frames through this package,
// and Socket.IO is gone from the app, this backend and the admin console (see
// fuzz_test.go, which states the same). This is the Go
// counterpart of lib/ccwire/frame.ts and must match it byte for byte and
// rejection for rejection; the shared fixture in lib/ccwire/__vectors__ is what
// proves that (see frame_test.go).
//
// WIRE FORMAT
//
//	u8  framing_version
//	u32 length (big-endian)
//	... length bytes of opaque payload
//
// Deliberately protobuf-AGNOSTIC: the payload is bytes. That separation is the
// point — the bound on length is enforced BEFORE any buffer is allocated, which
// means before a decoder is ever handed the input. A decoder that allocates
// from a client-declared length is the classic memory-exhaustion bug.
package ccwire

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	// FramingVersion is bumped only for a breaking change to THIS header.
	FramingVersion uint8 = 1

	// HeaderBytes is 1 version + 4 length.
	HeaderBytes = 5

	// MaxFrameBytes is the hard ceiling on a single frame, independent of
	// negotiation. Derived from the current system rather than picked:
	//   - internal/realtime/server.go:144  opts.SetMaxHttpBufferSize(2 * 1024 * 1024)
	//   - internal/httpx/httpx.go:94       io.LimitReader(r.Body, 2<<20)
	// Both verified at 2 MiB. A negotiated max may be LOWER; never higher.
	MaxFrameBytes = 2 * 1024 * 1024
)

// Rejection reasons. Compared with errors.Is, never by string match. These
// mirror the TS FrameError union one-for-one.
var (
	ErrIncomplete     = errors.New("ccwire: INCOMPLETE")      // fewer bytes than the header, or than length claims
	ErrBadVersion     = errors.New("ccwire: BAD_VERSION")     // framing version we do not speak
	ErrLengthOverMax  = errors.New("ccwire: LENGTH_OVER_MAX") // declared length exceeds the configured ceiling
	ErrLengthOverflow = errors.New("ccwire: LENGTH_OVERFLOW") // declared length is not a usable int on this platform
	ErrTrailingBytes  = errors.New("ccwire: TRAILING_BYTES")  // buffer held more than the frame it declared
)

// Options mirrors the TS opts object. Zero value means "hard max, lenient".
type Options struct {
	// MaxBytes is a negotiated ceiling. <= 0 means MaxFrameBytes. Clamped down
	// to MaxFrameBytes: a peer cannot negotiate upward.
	MaxBytes int
	// Strict refuses a buffer carrying more than the single frame it declared.
	// A stream reader wants this off; a message transport (one WebSocket
	// message == one frame) wants it on.
	Strict bool
}

func (o Options) cap() int {
	if o.MaxBytes <= 0 || o.MaxBytes > MaxFrameBytes {
		return MaxFrameBytes
	}
	return o.MaxBytes
}

// Frame is a decoded frame.
type Frame struct {
	Version uint8
	// Payload ALIASES the input buffer — it is a slice of buf, not a copy, so a
	// 2 MiB frame does not become 4 MiB resident (the TS side returns a
	// subarray for the same reason). Consequences the caller owns:
	//   - mutating Payload mutates buf, and vice versa;
	//   - if buf is a reused read buffer, copy Payload before retaining it past
	//     the next read.
	// The slice is capped (buf[a:b:b]) so an append cannot silently overwrite
	// the bytes of the NEXT frame in a stream buffer — that is a Go-specific
	// footgun with no TS equivalent.
	// No defensive copy is made here: this package sits below the allocation
	// boundary it exists to protect, and copying every frame would reintroduce
	// exactly the doubled residency it is meant to avoid. Copy at the call site
	// if and when a frame outlives its buffer.
	Payload  []byte
	Consumed int
}

// Encode writes one frame. It returns an error only for a programming error on
// OUR side (an oversized payload we produced) — remote input never reaches it.
// The TS side throws here; Go returns an error, which is the same contract in
// the local idiom.
func Encode(payload []byte, opts Options) ([]byte, error) {
	c := opts.cap()
	if len(payload) > c {
		return nil, fmt.Errorf("ccwire: refusing to encode %d bytes, cap is %d", len(payload), c)
	}
	out := make([]byte, HeaderBytes+len(payload))
	out[0] = FramingVersion
	binary.BigEndian.PutUint32(out[1:5], uint32(len(payload)))
	copy(out[HeaderBytes:], payload)
	return out, nil
}

// Decode reads one frame from the head of buf.
//
// NEVER ALLOCATES BEFORE VALIDATING. The declared length is checked against the
// ceiling and then against how many bytes are actually present, in that order.
// A nil buf behaves exactly like an empty one: ErrIncomplete.
func Decode(buf []byte, opts Options) (Frame, error) {
	c := opts.cap()

	if len(buf) < HeaderBytes {
		return Frame{}, fmt.Errorf("%w: %d < %d", ErrIncomplete, len(buf), HeaderBytes)
	}

	version := buf[0]
	if version != FramingVersion {
		// Not a downgrade path: an unknown framing version is refused outright.
		// Capability negotiation happens INSIDE a frame we can already parse.
		return Frame{}, fmt.Errorf("%w: got %d, speak %d", ErrBadVersion, version, FramingVersion)
	}

	// Read as UNSIGNED. The TS side needs >>> 0 here because << is signed in
	// JS; binary.BigEndian.Uint32 is unsigned by construction, so the hazard
	// does not exist in Go — but the rejection for 0x80000000 must still match.
	n := binary.BigEndian.Uint32(buf[1:5])

	// Unreachable on 64-bit (max u32 fits int comfortably) and on 32-bit only
	// if int were smaller than the u32 plus the header. Kept as the structural
	// mirror of the TS Number.isSafeInteger guard: the conversion below must
	// never be the thing that decides the bound.
	if uint64(n)+uint64(HeaderBytes) > uint64(maxInt) {
		return Frame{}, fmt.Errorf("%w: %d", ErrLengthOverflow, n)
	}
	if int(n) > c {
		// THE CHECK THIS PACKAGE EXISTS FOR: refused before any allocation.
		return Frame{}, fmt.Errorf("%w: %d > %d", ErrLengthOverMax, n, c)
	}

	end := HeaderBytes + int(n)
	if len(buf) < end {
		return Frame{}, fmt.Errorf("%w: need %d, have %d", ErrIncomplete, end, len(buf))
	}
	if opts.Strict && len(buf) > end {
		return Frame{}, fmt.Errorf("%w: %d extra", ErrTrailingBytes, len(buf)-end)
	}

	return Frame{Version: version, Payload: buf[HeaderBytes:end:end], Consumed: end}, nil
}

const maxInt = int(^uint(0) >> 1)

// DecodeStream pulls as many whole frames as buf currently holds.
//
// Returns the frames plus the bytes consumed, so the caller keeps the remainder
// for the next read. A malformed frame STOPS the scan and is reported — a
// length-prefixed stream cannot be resynchronised after a bad length, because
// the next frame's offset is unknowable. ErrIncomplete is not an error at this
// level: it means "await more bytes", so it is reported as a clean stop with a
// partial tail left unconsumed.
func DecodeStream(buf []byte, opts Options) (frames [][]byte, consumed int, err error) {
	opts.Strict = false // meaningless mid-stream; every frame but the last has a tail
	off := 0
	for {
		f, e := Decode(buf[off:], opts)
		if e != nil {
			if errors.Is(e, ErrIncomplete) {
				return frames, off, nil
			}
			return frames, off, e
		}
		frames = append(frames, f.Payload)
		off += f.Consumed
		if off >= len(buf) {
			return frames, off, nil
		}
	}
}
