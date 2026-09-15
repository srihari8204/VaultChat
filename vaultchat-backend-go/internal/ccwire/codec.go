// ccwire.v1.Frame — the top-level routing decode, with bounds.
//
// This is the THIRD implementation of the CC-Wire codec. The first is
// lib/ccwire/codec.ts, the second services/transport/rust/src/parse.rs. All
// three assert one committed fixture (lib/ccwire/__vectors__/codec.json), so a
// divergence fails a test rather than being discovered on the wire.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//
// It does not decode the 27 body types. It reads the routing header —
// request_id, traffic_class, stream, seq, depends_on — establishes WHICH body
// is set, and hands the body up as opaque bytes. Same rule frame.go states one
// layer down: the transport routes, the application interprets. envelope.proto
// is explicit that a crypto payload is "OPAQUE authenticated bytes" that must
// survive BYTE FOR BYTE; bytes never parsed are bytes that cannot be corrupted.
//
// The EPHEMERAL invariant is still enforced in full, on the FIELD NUMBER,
// before and independently of decoding any body — so it holds for all 27.
//
// ORDER OF CHECKS IS LOAD-BEARING, exactly as in frame.go: total size → depth →
// per-field bound → allocate. Nothing is sized from a length a peer declared
// until that length has been checked against a limit we chose.
package ccwire

import (
	"unicode/utf8"
)

// Limits mirrors Limits in proto/ccwire/v1/capabilities.proto, and the LIMITS
// object in lib/ccwire/codec.ts / the Rust parse::Limits. Decoder configuration
// is part of the contract, not an implementation detail (envelope.proto).
type Limits struct {
	MaxFrameBytes          int
	MaxOpaqueBytes         int
	MaxMessageBodyBytes    int
	MaxFragmentsPerMessage uint32
	MaxNestingDepth        uint32
	MaxRepeatedElements    int
	MaxStringFieldBytes    int
}

// DefaultLimits is what this build compiled with. A peer may tighten, never
// loosen.
func DefaultLimits() Limits {
	return Limits{
		MaxFrameBytes:          262144,
		MaxOpaqueBytes:         196608,
		MaxMessageBodyBytes:    1048576,
		MaxFragmentsPerMessage: 16,
		MaxNestingDepth:        6,
		MaxRepeatedElements:    1024,
		MaxStringFieldBytes:    4096,
	}
}

// Tighten applies a peer's proposal. A negotiated limit may only TIGHTEN —
// "a peer proposing a LARGER bound than this build compiled with does not get
// it; negotiation is not authority." Zero means "not proposed", never
// "unlimited".
func (l Limits) Tighten(p Limits) Limits {
	lo := func(cur, prop int) int {
		if prop > 0 && prop < cur {
			return prop
		}
		return cur
	}
	lo32 := func(cur, prop uint32) uint32 {
		if prop > 0 && prop < cur {
			return prop
		}
		return cur
	}
	return Limits{
		MaxFrameBytes:          lo(l.MaxFrameBytes, p.MaxFrameBytes),
		MaxOpaqueBytes:         lo(l.MaxOpaqueBytes, p.MaxOpaqueBytes),
		MaxMessageBodyBytes:    lo(l.MaxMessageBodyBytes, p.MaxMessageBodyBytes),
		MaxFragmentsPerMessage: lo32(l.MaxFragmentsPerMessage, p.MaxFragmentsPerMessage),
		MaxNestingDepth:        lo32(l.MaxNestingDepth, p.MaxNestingDepth),
		MaxRepeatedElements:    lo(l.MaxRepeatedElements, p.MaxRepeatedElements),
		MaxStringFieldBytes:    lo(l.MaxStringFieldBytes, p.MaxStringFieldBytes),
	}
}

// CodecError is why input was refused: a value, never a string to parse. The
// spellings match the CodecError union in codec.ts and the Rust enum, so one
// fixture serves all three.
type CodecError string

func (e CodecError) Error() string { return "ccwire: " + string(e) }

// Name is the wire-neutral spelling carried by the shared fixture.
func (e CodecError) Name() string { return string(e) }

// ErrorCode is the errors.proto ErrorCode to put in an Error frame. Kept beside
// the value rather than in a second switch that could disagree with this one.
func (e CodecError) ErrorCode() uint32 {
	switch e {
	case ErrSizeOverMax:
		return 7 // ERROR_CODE_FRAME_TOO_LARGE
	case ErrDuplicateBody, ErrProtocolViolation:
		return 11 // ERROR_CODE_PROTOCOL_VIOLATION
	default:
		return 8 // ERROR_CODE_PAYLOAD_INVALID
	}
}

const (
	ErrTruncated         CodecError = "TRUNCATED"
	ErrBadWireType       CodecError = "BAD_WIRE_TYPE"
	ErrVarintOverflow    CodecError = "VARINT_OVERFLOW"
	ErrFieldZero         CodecError = "FIELD_ZERO"
	ErrInvalidUTF8       CodecError = "INVALID_UTF8"
	ErrStringTooLong     CodecError = "STRING_TOO_LONG"
	ErrBytesTooLong      CodecError = "BYTES_TOO_LONG"
	ErrTooManyElements   CodecError = "TOO_MANY_ELEMENTS"
	ErrNestingTooDeep    CodecError = "NESTING_TOO_DEEP"
	ErrSizeOverMax       CodecError = "SIZE_OVER_MAX"
	ErrDuplicateBody     CodecError = "DUPLICATE_BODY"
	ErrProtocolViolation CodecError = "PROTOCOL_VIOLATION"
)

// TrafficClass values from envelope.proto. UNSPECIFIED is never valid on the
// wire, in either direction.
const (
	TrafficClassUnspecified uint32 = 0
	TrafficClassControl     uint32 = 1
	TrafficClassMessaging   uint32 = 2
	TrafficClassSync        uint32 = 3
	TrafficClassBulk        uint32 = 4
	TrafficClassEphemeral   uint32 = 5
)

// Frame.body field numbers, from envelope.proto.
const (
	BodyClientHello       uint32 = 16
	BodyServerHello       uint32 = 17
	BodyReAuth            uint32 = 18
	BodyPing              uint32 = 19
	BodyPong              uint32 = 20
	BodyGoAway            uint32 = 21
	BodyAck               uint32 = 22
	BodyError             uint32 = 23
	BodySubscribe         uint32 = 32
	BodyUnsubscribe       uint32 = 33
	BodySubmitMessage     uint32 = 48
	BodyDeliverMessage    uint32 = 49
	BodyEditMessage       uint32 = 50
	BodyDeleteMessage     uint32 = 51
	BodyReceipt           uint32 = 52
	BodyCursorSync        uint32 = 64
	BodyCursorBatch       uint32 = 65
	BodyPresenceUpdate    uint32 = 80
	BodyTypingState       uint32 = 81
	BodyViewerState       uint32 = 82
	BodyViewerList        uint32 = 83
	BodyGeoRelay          uint32 = 84
	BodyAttachmentControl uint32 = 96
	BodyDeviceEvent       uint32 = 97
	BodyCryptoControl     uint32 = 98
	BodyCallSignal        uint32 = 99
	BodyAppEvent          uint32 = 100
	BodyFragment          uint32 = 112
)

// BodyFields is every Frame.body field number, in schema order.
var BodyFields = [28]uint32{
	16, 17, 18, 19, 20, 21, 22, 23,
	32, 33,
	48, 49, 50, 51, 52,
	64, 65,
	80, 81, 82, 83, 84,
	96, 97, 98, 99, 100,
	112,
}

// EphemeralBodies is THE INVARIANT, from envelope.proto: an EPHEMERAL frame may
// carry ONLY typing_state (81), viewer_state (82) or geo_relay (84).
var EphemeralBodies = [3]uint32{81, 82, 84}

// IsBodyField reports whether f names one of the oneof arms.
func IsBodyField(f uint32) bool {
	for _, b := range BodyFields {
		if b == f {
			return true
		}
	}
	return false
}

func isEphemeralBody(f uint32) bool {
	for _, b := range EphemeralBodies {
		if b == f {
			return true
		}
	}
	return false
}

// ScopeKind values from envelope.proto. There is deliberately no SCOPE_KIND_USER.
const (
	ScopeKindUnspecified uint32 = 0
	ScopeKindChat        uint32 = 1
	ScopeKindChannel     uint32 = 2
	ScopeKindCall        uint32 = 3
	ScopeKindRun         uint32 = 4
	ScopeKindAdmin       uint32 = 5
)

// Message is a decoded ccwire.v1.Frame. Body and Unknown ALIAS the input buffer
// — a 256 KiB frame does not become 512 KiB resident, exactly as Frame.Payload
// in frame.go does. Copy at the call site if a message outlives its buffer.
type Message struct {
	RequestID    string
	TrafficClass uint32
	Stream       uint32
	// Seq and DependsOn are uint64 natively: Go has no 2^53 cliff, so the
	// JS_STRING dance codec.ts needs has no purpose here. The fixture stores
	// decimal strings and the test parses them, so all three agree on the VALUE.
	Seq       uint64
	DependsOn uint64
	// BodyField is 0 when no body was present — field number 0 is not a
	// representable proto field, so it cannot collide with a real arm. An EMPTY
	// body is still a body: a bare Ping is a zero-byte submessage, and
	// BodyField is what says one was set.
	BodyField uint32
	Body      []byte
	// Unknown holds unrecognised top-level fields, tag+value, in wire order.
	// NEVER dropped — envelope.proto requires unknown fields be PRESERVED.
	Unknown [][]byte
}

// ── reader ──────────────────────────────────────────────────────────────

type reader struct {
	b []byte
	p int
}

func (r *reader) varint64() (uint64, error) {
	var out uint64
	var shift uint32
	for i := 0; i < 10; i++ {
		if r.p >= len(r.b) {
			return 0, ErrTruncated
		}
		c := r.b[r.p]
		r.p++
		// Bits shifted past 64 are DISCARDED, matching codec.ts's
		// `out & (TWO64 - 1n)`. Go's << on uint64 already drops them for
		// shift >= 64, but the guard is kept explicit so the rule is visible
		// rather than inherited from a language detail.
		if shift < 64 {
			out |= uint64(c&0x7f) << shift
		}
		if c&0x80 == 0 {
			return out, nil
		}
		shift += 7
	}
	return 0, ErrVarintOverflow
}

// varint32 reads a varint in TAG or LENGTH position, capped at FIVE bytes.
//
// This is codec.ts's `varint32`, and it is the rule for the whole protocol: a
// varint longer than five bytes in a tag or a length is not a large number, it
// is an over-long encoding probing for a mismatch. Reading it as a full 64-bit
// varint here would refuse the same bytes for a DIFFERENT reason (TRUNCATED, or
// worse, accept them), which is exactly the parser differential this package
// exists to prevent.
func (r *reader) varint32() (uint64, error) {
	var out uint64
	var shift uint32
	for i := 0; i < 5; i++ {
		if r.p >= len(r.b) {
			return 0, ErrTruncated
		}
		c := r.b[r.p]
		r.p++
		out |= uint64(c&0x7f) << shift
		if c&0x80 == 0 {
			return out, nil
		}
		shift += 7
	}
	return 0, ErrVarintOverflow
}

func (r *reader) skipVarint() error {
	for i := 0; i < 10; i++ {
		if r.p >= len(r.b) {
			return ErrTruncated
		}
		c := r.b[r.p]
		r.p++
		if c&0x80 == 0 {
			return nil
		}
	}
	return ErrVarintOverflow
}

// lenSpan returns a length-delimited span as a VIEW. Bounds-checked BEFORE it
// is produced, so a declared length never sizes an allocation.
func (r *reader) lenSpan() ([]byte, error) {
	n, err := r.varint32()
	if err != nil {
		return nil, err
	}
	if n > uint64(maxInt) {
		return nil, ErrTruncated
	}
	end := r.p + int(n)
	if end < r.p || end > len(r.b) { // end < r.p catches int overflow
		return nil, ErrTruncated
	}
	s := r.b[r.p:end:end]
	r.p = end
	return s, nil
}

// tag reads one field header. Field number 0 is not representable, so its
// presence is not a mistake — it is an attack.
func (r *reader) tag() (uint32, uint8, error) {
	t, err := r.varint32()
	if err != nil {
		return 0, 0, err
	}
	f := t >> 3
	if f > uint64(^uint32(0)) {
		return 0, 0, ErrVarintOverflow
	}
	if f == 0 {
		return 0, 0, ErrFieldZero
	}
	return uint32(f), uint8(t & 7), nil
}

// skipField advances past a field we do not recognise. Wire types 3 and 4 are
// proto2 groups: not representable in proto3, and historically a source of
// parser-differential bugs. Refused, not skipped.
func (r *reader) skipField(wire uint8) error {
	fixed := func(n int) error {
		end := r.p + n
		if end < r.p || end > len(r.b) {
			return ErrTruncated
		}
		r.p = end
		return nil
	}
	switch wire {
	case 0:
		return r.skipVarint()
	case 1:
		return fixed(8)
	case 2:
		_, err := r.lenSpan()
		return err
	case 5:
		return fixed(4)
	default:
		return ErrBadWireType
	}
}

// DecodeMessage decodes one ccwire.v1.Frame.
//
// depth is the nesting level this frame already sits at — 0 off the wire, and
// depth+1 when a fragment reassembler re-decodes a reassembled payload. That is
// what stops a Fragment-in-Fragment bomb from recursing forever.
//
// maxBytes of 0 means "use the negotiated frame limit", matching the zero-value
// convention Options in frame.go already uses.
func DecodeMessage(buf []byte, lim Limits, maxBytes int, depth uint32) (Message, error) {
	c := maxBytes
	if c == 0 {
		c = lim.MaxFrameBytes
	}
	if c > MaxFrameBytes {
		c = MaxFrameBytes
	}

	// Whole-payload size FIRST, so every bound below it bounds something
	// already known to be small.
	if len(buf) > c {
		return Message{}, ErrSizeOverMax
	}
	if depth > lim.MaxNestingDepth {
		return Message{}, ErrNestingTooDeep
	}

	r := reader{b: buf}
	var m Message

	for r.p < len(r.b) {
		start := r.p
		field, wire, err := r.tag()
		if err != nil {
			return Message{}, err
		}

		switch {
		case field == 1 && wire == 2:
			span, err := r.lenSpan()
			if err != nil {
				return Message{}, err
			}
			// Bounded on the BYTE length, before UTF-8 decoding.
			if len(span) > lim.MaxStringFieldBytes {
				return Message{}, ErrStringTooLong
			}
			if !utf8.Valid(span) {
				return Message{}, ErrInvalidUTF8
			}
			m.RequestID = string(span)

		// Duplicate scalars are LAST-WINS — proto3's rule, and what the other
		// two implementations do. Deviating here is how a parser differential
		// is born.
		case field == 2 && wire == 0:
			v, err := r.varint64()
			if err != nil {
				return Message{}, err
			}
			m.TrafficClass = uint32(v & 0xffffffff)
		case field == 3 && wire == 0:
			v, err := r.varint64()
			if err != nil {
				return Message{}, err
			}
			m.Stream = uint32(v & 0xffffffff)
		case field == 4 && wire == 0:
			v, err := r.varint64()
			if err != nil {
				return Message{}, err
			}
			m.Seq = v
		case field == 5 && wire == 0:
			v, err := r.varint64()
			if err != nil {
				return Message{}, err
			}
			m.DependsOn = v

		case wire == 2 && IsBodyField(field):
			// A oneof is ONE field. proto3 says last-wins; this REFUSES,
			// because two bodies is a smuggling primitive: if one side took
			// the last and another the first, they would disagree about what
			// the peer said while both called it valid.
			if m.BodyField != 0 {
				return Message{}, ErrDuplicateBody
			}
			// The body is a nested message, so entering it costs depth even
			// though nothing here parses what is inside.
			if depth+1 > lim.MaxNestingDepth {
				return Message{}, ErrNestingTooDeep
			}
			body, err := r.lenSpan()
			if err != nil {
				return Message{}, err
			}
			m.BodyField = field
			m.Body = body

		default:
			// Unknown fields are preserved, but preservation is not unbounded.
			if len(m.Unknown) >= lim.MaxRepeatedElements {
				return Message{}, ErrTooManyElements
			}
			if err := r.skipField(wire); err != nil {
				return Message{}, err
			}
			m.Unknown = append(m.Unknown, buf[start:r.p:r.p])
		}
	}

	if err := checkInvariants(m.TrafficClass, m.BodyField); err != nil {
		return Message{}, err
	}
	return m, nil
}

// checkInvariants: envelope.proto says TRAFFIC_CLASS_UNSPECIFIED is "never
// valid on the wire; refuse", and an EPHEMERAL frame may carry only
// typing_state / viewer_state / geo_relay — "never handled leniently".
func checkInvariants(trafficClass, bodyField uint32) error {
	if trafficClass == TrafficClassUnspecified {
		return ErrProtocolViolation
	}
	if trafficClass == TrafficClassEphemeral && bodyField != 0 && !isEphemeralBody(bodyField) {
		return ErrProtocolViolation
	}
	return nil
}

// ── writer ──────────────────────────────────────────────────────────────

func putVarint(out []byte, v uint64) []byte {
	for v >= 0x80 {
		out = append(out, byte(v)|0x80)
		v >>= 7
	}
	return append(out, byte(v))
}

func putTag(out []byte, field uint32, wire uint8) []byte {
	return putVarint(out, uint64(field)*8+uint64(wire))
}

// EncodeMessage encodes a ccwire.v1.Frame.
//
// The invariant is checked HERE TOO, not only on decode — envelope.proto says
// "enforced at both encode and decode". A bug that produces a CryptoControl on
// EPHEMERAL should fail on the machine that has the stack trace, not on the
// peer that only has bytes.
//
// Field order and proto3 default-skipping mirror encodeFrameMessage exactly,
// which is what makes decode→encode byte-identical across all three languages.
func EncodeMessage(m Message, lim Limits, maxBytes int) ([]byte, error) {
	if err := checkInvariants(m.TrafficClass, m.BodyField); err != nil {
		return nil, err
	}

	c := maxBytes
	if c == 0 {
		c = lim.MaxFrameBytes
	}
	if c > MaxFrameBytes {
		c = MaxFrameBytes
	}

	var out []byte

	// proto3: a field at its default value is not written.
	if m.RequestID != "" {
		b := []byte(m.RequestID)
		if len(b) > lim.MaxStringFieldBytes {
			return nil, ErrStringTooLong
		}
		out = putTag(out, 1, 2)
		out = putVarint(out, uint64(len(b)))
		out = append(out, b...)
	}
	if m.TrafficClass != 0 {
		out = putTag(out, 2, 0)
		out = putVarint(out, uint64(m.TrafficClass))
	}
	if m.Stream != 0 {
		out = putTag(out, 3, 0)
		out = putVarint(out, uint64(m.Stream))
	}
	if m.Seq != 0 {
		out = putTag(out, 4, 0)
		out = putVarint(out, m.Seq)
	}
	if m.DependsOn != 0 {
		out = putTag(out, 5, 0)
		out = putVarint(out, m.DependsOn)
	}
	if m.BodyField != 0 {
		if !IsBodyField(m.BodyField) {
			return nil, ErrProtocolViolation
		}
		if len(m.Body) > lim.MaxMessageBodyBytes {
			return nil, ErrBytesTooLong
		}
		// Unlike every other field, an EMPTY body is written: a bare Ping is a
		// zero-byte submessage and dropping it would erase which body was set.
		out = putTag(out, m.BodyField, 2)
		out = putVarint(out, uint64(len(m.Body)))
		out = append(out, m.Body...)
	}
	for _, u := range m.Unknown {
		out = append(out, u...)
	}

	if len(out) > c {
		return nil, ErrSizeOverMax
	}
	return out, nil
}

// ── body builders ───────────────────────────────────────────────────────
//
// Just enough protobuf to author the handful of bodies the SERVER produces
// (ServerHello, Ack, Error, Limits, Capabilities). Not a general encoder, and
// deliberately not one: the bodies a client sends stay opaque, so only the
// server's own small, fixed set needs writing. Callers skip proto3 defaults
// themselves — the shape of each body is the caller's contract, not this
// layer's.

// AppendVarintField appends a varint-typed (wire 0) field.
func AppendVarintField(out []byte, field uint32, v uint64) []byte {
	out = putTag(out, field, 0)
	return putVarint(out, v)
}

// AppendBoolField appends a bool. False is a proto3 default and is not written.
func AppendBoolField(out []byte, field uint32, v bool) []byte {
	if !v {
		return out
	}
	return AppendVarintField(out, field, 1)
}

// AppendBytesField appends a length-delimited (wire 2) field: bytes, string or
// a nested message already encoded.
func AppendBytesField(out []byte, field uint32, b []byte) []byte {
	out = putTag(out, field, 2)
	out = putVarint(out, uint64(len(b)))
	return append(out, b...)
}

// AppendStringField appends a string. Empty is a proto3 default and is not
// written.
func AppendStringField(out []byte, field uint32, s string) []byte {
	if s == "" {
		return out
	}
	return AppendBytesField(out, field, []byte(s))
}

// ── the one body this layer does parse ──────────────────────────────────

// DecodeScope reads a Subscribe or Unsubscribe body: { ScopeKind kind = 1;
// string id = 2; }.
//
// This is the ONLY body decoded here, and only because the authorization gate
// needs to know WHICH scope is being asked for. Everything else stays opaque.
func DecodeScope(body []byte, lim Limits) (kind uint32, id string, err error) {
	r := reader{b: body}
	for r.p < len(r.b) {
		field, wire, e := r.tag()
		if e != nil {
			return 0, "", e
		}
		switch {
		case field == 1 && wire == 0:
			v, e := r.varint64()
			if e != nil {
				return 0, "", e
			}
			kind = uint32(v & 0xffffffff)
		case field == 2 && wire == 2:
			span, e := r.lenSpan()
			if e != nil {
				return 0, "", e
			}
			if len(span) > lim.MaxStringFieldBytes {
				return 0, "", ErrStringTooLong
			}
			if !utf8.Valid(span) {
				return 0, "", ErrInvalidUTF8
			}
			id = string(span)
		default:
			if e := r.skipField(wire); e != nil {
				return 0, "", e
			}
		}
	}
	return kind, id, nil
}

// EncodeScope is the mirror, used by tests and by any server-side Subscribe.
func EncodeScope(kind uint32, id string) []byte {
	var out []byte
	if kind != 0 {
		out = putTag(out, 1, 0)
		out = putVarint(out, uint64(kind))
	}
	if id != "" {
		out = putTag(out, 2, 2)
		out = putVarint(out, uint64(len(id)))
		out = append(out, id...)
	}
	return out
}
