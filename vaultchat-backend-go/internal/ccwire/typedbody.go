// The six typed `ccwire.v1.Frame` bodies, decoded from the opaque bytes
// codec.go hands up.
//
// LAYERING. codec.go routes: it reads the header, says WHICH body is set and
// gives you the body as bytes. It does not look inside, and it must not — a
// transport that parses CryptoControl is a transport that can be attacked
// through CryptoControl. This file is the other half: a caller that has already
// decided it wants to interpret a body calls in here with those bytes. Nothing
// on the routing path, and nothing in internal/realtime, reaches this file.
//
// NOT bodies.go. That file decodes the three inbound bodies the SERVER SERVES,
// and only the fields an authorization or persistence decision needs — it drops
// server-assigned fields on purpose and does not preserve unknown fields,
// because it is not in the business of reproducing the peer's bytes. This file
// is the FULL decode, for parity: it is the Go half of the three-way agreement
// with lib/ccwire/codec.ts and services/transport/rust/src/body.rs, and it is
// exercised only by codec_parity_test.go.
//
// MIRRORS codec.ts AND body.rs FIELD FOR FIELD: same field numbers and wire
// types, proto3 defaults materialised on decode, duplicate scalars LAST-WINS,
// unknown fields PRESERVED verbatim (tag included, never walked into), the same
// bound on the same field, the same typed refusal for each, and the same depth
// charged for entering a submessage.
//
// One deliberate difference from codec.ts, not observable on the wire: 64-bit
// fields are native uint64/int64. The JS_STRING dance exists because a double
// rounds 2^53+1 away; Go has no such cliff. The fixture stores decimal strings
// and the test parses them, so all three agree on the VALUE.
package ccwire

// ── enum name surfacing ─────────────────────────────────────────────────
//
// codec.ts: "An enum value this build does not know is RETAINED AS ITS NUMBER
// and surfaced as *_UNSPECIFIED." The number is authoritative and is what
// re-encodes; the name is what application code branches on.

var (
	viewerActivityNames = [...]string{
		"VIEWER_ACTIVITY_UNSPECIFIED",
		"VIEWER_ACTIVITY_READING",
		"VIEWER_ACTIVITY_TYPING",
		"VIEWER_ACTIVITY_UPLOADING",
	}
	scopeKindNames = [...]string{
		"SCOPE_KIND_UNSPECIFIED",
		"SCOPE_KIND_CHAT",
		"SCOPE_KIND_CHANNEL",
		"SCOPE_KIND_CALL",
		"SCOPE_KIND_RUN",
		"SCOPE_KIND_ADMIN",
	}
	cryptoControlKindNames = [...]string{
		"CRYPTO_CONTROL_KIND_UNSPECIFIED",
		"CRYPTO_CONTROL_KIND_REKEY",
		"CRYPTO_CONTROL_KIND_MEDIA_KEY",
		"CRYPTO_CONTROL_KIND_PREKEY",
		"CRYPTO_CONTROL_KIND_GROUP_OP",
	}
	messageClassNames = [...]string{
		"MESSAGE_CLASS_UNSPECIFIED",
		"MESSAGE_CLASS_NORMAL",
		"MESSAGE_CLASS_SILENT",
		"MESSAGE_CLASS_SYSTEM",
		"MESSAGE_CLASS_CONTROL",
	}
)

func surface(names []string, n uint32) string {
	if int(n) < len(names) {
		return names[n]
	}
	return names[0]
}

// ── shapes ──────────────────────────────────────────────────────────────
//
// Unknown holds whole fields — tag and value — in wire order, verbatim. Every
// []byte here ALIASES the input buffer; copy at the call site if it must
// outlive it.

type TypingState struct {
	ChatID    string
	Typing    bool
	SenderUID string
	Unknown   [][]byte
}

type ViewerState struct {
	ChatID   string
	Activity uint32
	Leaving  bool
	Resync   bool
	Unknown  [][]byte
}

func (m ViewerState) ActivityName() string { return surface(viewerActivityNames[:], m.Activity) }

type GeoRelay struct {
	ScopeKind uint32
	ScopeID   string
	SubjectID string
	Sealed    []byte
	Ended     bool
	// UntilMS is int64 — signed, so an expiry before the epoch is representable.
	UntilMS   int64
	SenderUID string
	Unknown   [][]byte
}

func (m GeoRelay) ScopeKindName() string { return surface(scopeKindNames[:], m.ScopeKind) }

type CryptoControl struct {
	Kind   uint32
	ChatID string
	ToUID  string
	// Payload is OPAQUE authenticated bytes. Aliased, never rewritten.
	Payload       []byte
	Epoch         uint64
	PayloadFormat string
	Unknown       [][]byte
}

func (m CryptoControl) KindName() string { return surface(cryptoControlKindNames[:], m.Kind) }

// TypedPublicMeta is the full ccwire.v1.PublicMeta, unknown fields included.
//
// bodies.go already has a PublicMeta. It is a different thing: the server's own
// decode, which drops what it does not act on. This one reproduces the peer's
// message, which is what parity means. Two types beats one type with a mode.
type TypedPublicMeta struct {
	AttachmentID   string
	ViewOnce       bool
	Revoked        bool
	Announcement   bool
	Audience       string
	Silent         bool
	GroupID        string
	GifURL         string
	AllowMultiple  bool
	OptionCount    uint32
	MentionUserIDs []string
	Encrypted      bool
	Game           string
	Room           string
	Unknown        [][]byte
}

type Envelope struct {
	ChatID      string
	MessageID   string
	ClientMsgID string
	ServerTsMS  int64
	MsgClass    uint32
	CausalEpoch uint64
	// PublicMeta is a POINTER: presence is meaningful in proto3, and an absent
	// submessage must not be collapsed into an all-default one.
	PublicMeta *TypedPublicMeta
	Unknown    [][]byte
}

func (m Envelope) MsgClassName() string { return surface(messageClassNames[:], m.MsgClass) }

type SubmitMessage struct {
	Envelope *Envelope
	Sealed   []byte
	Unknown  [][]byte
}

type Fragment struct {
	FragmentID string
	Index      uint32
	Total      uint32
	TotalBytes uint64
	Chunk      []byte
	Last       bool
	Unknown    [][]byte
}

// TypedBodies is the body field numbers this file decodes. Mirrors TYPED_BODY
// in codec.ts and TYPED_BODIES in body.rs.
var TypedBodies = [6]uint32{48, 81, 82, 84, 98, 112}

// ── reader helpers ──────────────────────────────────────────────────────
//
// The reader itself is codec.go's, unchanged and unduplicated: its tag() and
// lenSpan() cap a tag/length varint at five bytes, which is the rule codec.ts
// has always had. varint64 stays for VALUES, where ten bytes is correct.

func (r *reader) bytesField(cap int) ([]byte, error) {
	span, err := r.lenSpan()
	if err != nil {
		return nil, err
	}
	if len(span) > cap {
		return nil, ErrBytesTooLong
	}
	return span, nil
}

func (r *reader) boolField() (bool, error) {
	v, err := r.varint64()
	return v != 0, err
}

func (r *reader) u32Field() (uint32, error) {
	v, err := r.varint64()
	return uint32(v & 0xffffffff), err
}

// i64Field reads the same 64 bits as two's complement.
func (r *reader) i64Field() (int64, error) {
	v, err := r.varint64()
	return int64(v), err
}

// keepUnknown copies the WHOLE field — tag included — verbatim and does NOT walk
// into it. Not walking is the security property: a nesting bomb inside a field
// this build cannot interpret costs nothing to skip, and a re-encode reproduces
// it exactly.
func (r *reader) keepUnknown(start int, wire uint8, into *[][]byte, lim Limits) error {
	if len(*into) >= lim.MaxRepeatedElements {
		return ErrTooManyElements
	}
	if err := r.skipField(wire); err != nil {
		return err
	}
	*into = append(*into, r.b[start:r.p:r.p])
	return nil
}

// nest enters a nested message. childDepth is the depth of the message being
// ENTERED, and it is checked BEFORE the length is read — exactly as codec.ts's
// `nest` does, and exactly as codec.go charges the body itself.
func (r *reader) nest(childDepth uint32, lim Limits) (reader, error) {
	if childDepth > lim.MaxNestingDepth {
		return reader{}, ErrNestingTooDeep
	}
	span, err := r.lenSpan()
	if err != nil {
		return reader{}, err
	}
	return reader{b: span}, nil
}

// ── decoders ────────────────────────────────────────────────────────────
//
// Each is the same skeleton: loop fields, switch on (number, wire type),
// anything else goes to keepUnknown. A field number that is KNOWN but arrives
// with the WRONG wire type is therefore an unknown field, not an error — that is
// what codec.ts and body.rs do, and disagreeing about it is a differential.

func readTypingState(r *reader, lim Limits) (TypingState, error) {
	var m TypingState
	for r.p < len(r.b) {
		start := r.p
		field, wire, err := r.tag()
		if err != nil {
			return TypingState{}, err
		}
		switch {
		case field == 1 && wire == 2:
			m.ChatID, err = r.str(lim)
		case field == 2 && wire == 0:
			m.Typing, err = r.boolField()
		case field == 3 && wire == 2:
			m.SenderUID, err = r.str(lim)
		default:
			err = r.keepUnknown(start, wire, &m.Unknown, lim)
		}
		if err != nil {
			return TypingState{}, err
		}
	}
	return m, nil
}

func readViewerState(r *reader, lim Limits) (ViewerState, error) {
	var m ViewerState
	for r.p < len(r.b) {
		start := r.p
		field, wire, err := r.tag()
		if err != nil {
			return ViewerState{}, err
		}
		switch {
		case field == 1 && wire == 2:
			m.ChatID, err = r.str(lim)
		case field == 2 && wire == 0:
			m.Activity, err = r.u32Field()
		case field == 3 && wire == 0:
			m.Leaving, err = r.boolField()
		case field == 4 && wire == 0:
			m.Resync, err = r.boolField()
		default:
			err = r.keepUnknown(start, wire, &m.Unknown, lim)
		}
		if err != nil {
			return ViewerState{}, err
		}
	}
	return m, nil
}

func readGeoRelay(r *reader, lim Limits) (GeoRelay, error) {
	var m GeoRelay
	for r.p < len(r.b) {
		start := r.p
		field, wire, err := r.tag()
		if err != nil {
			return GeoRelay{}, err
		}
		switch {
		case field == 1 && wire == 0:
			m.ScopeKind, err = r.u32Field()
		case field == 2 && wire == 2:
			m.ScopeID, err = r.str(lim)
		case field == 3 && wire == 2:
			m.SubjectID, err = r.str(lim)
		case field == 4 && wire == 2:
			m.Sealed, err = r.bytesField(lim.MaxOpaqueBytes)
		case field == 5 && wire == 0:
			m.Ended, err = r.boolField()
		case field == 6 && wire == 0:
			m.UntilMS, err = r.i64Field()
		case field == 7 && wire == 2:
			m.SenderUID, err = r.str(lim)
		default:
			err = r.keepUnknown(start, wire, &m.Unknown, lim)
		}
		if err != nil {
			return GeoRelay{}, err
		}
	}
	return m, nil
}

func readCryptoControl(r *reader, lim Limits) (CryptoControl, error) {
	var m CryptoControl
	for r.p < len(r.b) {
		start := r.p
		field, wire, err := r.tag()
		if err != nil {
			return CryptoControl{}, err
		}
		switch {
		case field == 1 && wire == 0:
			m.Kind, err = r.u32Field()
		case field == 2 && wire == 2:
			m.ChatID, err = r.str(lim)
		case field == 3 && wire == 2:
			m.ToUID, err = r.str(lim)
		case field == 4 && wire == 2:
			m.Payload, err = r.bytesField(lim.MaxOpaqueBytes)
		case field == 5 && wire == 0:
			m.Epoch, err = r.varint64()
		case field == 6 && wire == 2:
			m.PayloadFormat, err = r.str(lim)
		default:
			err = r.keepUnknown(start, wire, &m.Unknown, lim)
		}
		if err != nil {
			return CryptoControl{}, err
		}
	}
	return m, nil
}

func readTypedPublicMeta(r *reader, lim Limits) (TypedPublicMeta, error) {
	var m TypedPublicMeta
	for r.p < len(r.b) {
		start := r.p
		field, wire, err := r.tag()
		if err != nil {
			return TypedPublicMeta{}, err
		}
		switch {
		case field == 1 && wire == 2:
			m.AttachmentID, err = r.str(lim)
		case field == 2 && wire == 0:
			m.ViewOnce, err = r.boolField()
		case field == 3 && wire == 0:
			m.Revoked, err = r.boolField()
		case field == 4 && wire == 0:
			m.Announcement, err = r.boolField()
		case field == 5 && wire == 2:
			m.Audience, err = r.str(lim)
		case field == 6 && wire == 0:
			m.Silent, err = r.boolField()
		case field == 7 && wire == 2:
			m.GroupID, err = r.str(lim)
		case field == 8 && wire == 2:
			m.GifURL, err = r.str(lim)
		case field == 9 && wire == 0:
			m.AllowMultiple, err = r.boolField()
		case field == 10 && wire == 0:
			m.OptionCount, err = r.u32Field()
		case field == 11 && wire == 2:
			// Checked BEFORE the element is appended, so a repeated field cannot
			// grow the heap past the cap even by one.
			if len(m.MentionUserIDs) >= lim.MaxRepeatedElements {
				return TypedPublicMeta{}, ErrTooManyElements
			}
			var id string
			if id, err = r.str(lim); err == nil {
				m.MentionUserIDs = append(m.MentionUserIDs, id)
			}
		case field == 12 && wire == 0:
			m.Encrypted, err = r.boolField()
		case field == 13 && wire == 2:
			m.Game, err = r.str(lim)
		case field == 14 && wire == 2:
			m.Room, err = r.str(lim)
		default:
			err = r.keepUnknown(start, wire, &m.Unknown, lim)
		}
		if err != nil {
			return TypedPublicMeta{}, err
		}
	}
	return m, nil
}

func readEnvelope(r *reader, lim Limits, depth uint32) (Envelope, error) {
	var m Envelope
	for r.p < len(r.b) {
		start := r.p
		field, wire, err := r.tag()
		if err != nil {
			return Envelope{}, err
		}
		switch {
		case field == 1 && wire == 2:
			m.ChatID, err = r.str(lim)
		case field == 2 && wire == 2:
			m.MessageID, err = r.str(lim)
		case field == 3 && wire == 2:
			m.ClientMsgID, err = r.str(lim)
		case field == 4 && wire == 0:
			m.ServerTsMS, err = r.i64Field()
		case field == 5 && wire == 0:
			m.MsgClass, err = r.u32Field()
		case field == 6 && wire == 0:
			m.CausalEpoch, err = r.varint64()
		case field == 7 && wire == 2:
			var sub reader
			if sub, err = r.nest(depth+1, lim); err == nil {
				var pm TypedPublicMeta
				if pm, err = readTypedPublicMeta(&sub, lim); err == nil {
					m.PublicMeta = &pm
				}
			}
		default:
			err = r.keepUnknown(start, wire, &m.Unknown, lim)
		}
		if err != nil {
			return Envelope{}, err
		}
	}
	return m, nil
}

func readSubmitMessage(r *reader, lim Limits, depth uint32) (SubmitMessage, error) {
	var m SubmitMessage
	for r.p < len(r.b) {
		start := r.p
		field, wire, err := r.tag()
		if err != nil {
			return SubmitMessage{}, err
		}
		switch {
		case field == 1 && wire == 2:
			var sub reader
			if sub, err = r.nest(depth+1, lim); err == nil {
				var e Envelope
				if e, err = readEnvelope(&sub, lim, depth+1); err == nil {
					m.Envelope = &e
				}
			}
		case field == 2 && wire == 2:
			// The one field bounded at MaxMessageBodyBytes rather than
			// MaxOpaqueBytes: it is the message body, and it arrives reassembled
			// from fragments, so it legitimately exceeds a frame.
			m.Sealed, err = r.bytesField(lim.MaxMessageBodyBytes)
		default:
			err = r.keepUnknown(start, wire, &m.Unknown, lim)
		}
		if err != nil {
			return SubmitMessage{}, err
		}
	}
	return m, nil
}

func readFragment(r *reader, lim Limits) (Fragment, error) {
	var m Fragment
	for r.p < len(r.b) {
		start := r.p
		field, wire, err := r.tag()
		if err != nil {
			return Fragment{}, err
		}
		switch {
		case field == 1 && wire == 2:
			m.FragmentID, err = r.str(lim)
		case field == 2 && wire == 0:
			m.Index, err = r.u32Field()
		case field == 3 && wire == 0:
			if m.Total, err = r.u32Field(); err == nil && m.Total > lim.MaxFragmentsPerMessage {
				return Fragment{}, ErrTooManyElements
			}
		case field == 4 && wire == 0:
			// Declared up front, checked BEFORE anything is allocated from it.
			// The reassembler must not be handed a number it would trust.
			if m.TotalBytes, err = r.varint64(); err == nil && m.TotalBytes > uint64(lim.MaxMessageBodyBytes) {
				return Fragment{}, ErrBytesTooLong
			}
		case field == 5 && wire == 2:
			m.Chunk, err = r.lenSpan() // bounded by the frame itself
		case field == 6 && wire == 0:
			m.Last, err = r.boolField()
		default:
			err = r.keepUnknown(start, wire, &m.Unknown, lim)
		}
		if err != nil {
			return Fragment{}, err
		}
	}
	return m, nil
}

// DecodeBody decodes one typed body.
//
// field is Frame.BodyField, buf is Frame.Body, and depth is the depth the body
// message itself sits at — 1 for a body taken from a frame read off the wire,
// because codec.go has already charged one level for entering it.
//
// The returned value is one of TypingState, ViewerState, GeoRelay,
// CryptoControl, SubmitMessage or Fragment. It is nil, with a nil error, for
// a body number this build does not type: those stay opaque bytes, which is a
// decision, not a gap.
func DecodeBody(field uint32, buf []byte, lim Limits, depth uint32) (any, error) {
	if depth > lim.MaxNestingDepth {
		return nil, ErrNestingTooDeep
	}
	r := reader{b: buf}

	switch field {
	case BodySubmitMessage:
		m, err := readSubmitMessage(&r, lim, depth)
		return orNil(m, err)
	case BodyTypingState:
		m, err := readTypingState(&r, lim)
		return orNil(m, err)
	case BodyViewerState:
		m, err := readViewerState(&r, lim)
		return orNil(m, err)
	case BodyGeoRelay:
		m, err := readGeoRelay(&r, lim)
		return orNil(m, err)
	case BodyCryptoControl:
		m, err := readCryptoControl(&r, lim)
		return orNil(m, err)
	case BodyFragment:
		m, err := readFragment(&r, lim)
		return orNil(m, err)
	default:
		return nil, nil
	}
}

// orNil keeps a refusal from arriving as a typed non-nil `any` beside an error.
func orNil[T any](m T, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return m, nil
}
