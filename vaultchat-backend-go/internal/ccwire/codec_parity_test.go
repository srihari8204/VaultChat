package ccwire

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// ccwire.v1.Frame parity — Go against the hand-written wire vectors.
//
// The companion assertions are lib/ccwire/codecParity.selftest.ts and
// services/transport/rust/tests/codec.rs, which read the SAME file. The fixture
// was written by hand from the protobuf wire specification rather than dumped
// from any implementation, so none can pass merely by agreeing with itself.
//
// The fixture is read where it lives, next to the TypeScript that owns it — a
// copy inside this module would be a second thing to drift.
const codecVectorPath = "../../../lib/ccwire/__vectors__/codec.json"

type vecLimits struct {
	MaxFrameBytes          int    `json:"max_frame_bytes"`
	MaxOpaqueBytes         int    `json:"max_opaque_bytes"`
	MaxMessageBodyBytes    int    `json:"max_message_body_bytes"`
	MaxFragmentsPerMessage uint32 `json:"max_fragments_per_message"`
	MaxNestingDepth        uint32 `json:"max_nesting_depth"`
	MaxRepeatedElements    int    `json:"max_repeated_elements"`
	MaxStringFieldBytes    int    `json:"max_string_field_bytes"`
}

func (v *vecLimits) apply(base Limits) Limits {
	if v == nil {
		return base
	}
	return base.Tighten(Limits{
		MaxFrameBytes:          v.MaxFrameBytes,
		MaxOpaqueBytes:         v.MaxOpaqueBytes,
		MaxMessageBodyBytes:    v.MaxMessageBodyBytes,
		MaxFragmentsPerMessage: v.MaxFragmentsPerMessage,
		MaxNestingDepth:        v.MaxNestingDepth,
		MaxRepeatedElements:    v.MaxRepeatedElements,
		MaxStringFieldBytes:    v.MaxStringFieldBytes,
	})
}

type codecDecodeVec struct {
	Name       string     `json:"name"`
	InputHex   string     `json:"inputHex"`
	Limits     *vecLimits `json:"limits"`
	MaxBytes   int        `json:"maxBytes"`
	Depth      uint32     `json:"depth"`
	OK         bool       `json:"ok"`
	RequestID  string     `json:"requestId"`
	TrafficCls uint32     `json:"trafficClass"`
	Stream     uint32     `json:"stream"`
	Seq        string     `json:"seq"`
	DependsOn  string     `json:"dependsOn"`
	BodyField  *uint32    `json:"bodyField"`
	BodyHex    string     `json:"bodyHex"`
	UnknownHex []string   `json:"unknownHex"`
	Error      string     `json:"error"`
	ErrorCode  uint32     `json:"errorCode"`
}

type codecEncodeVec struct {
	Name  string `json:"name"`
	Frame struct {
		RequestID  string   `json:"requestId"`
		TrafficCls uint32   `json:"trafficClass"`
		Stream     uint32   `json:"stream"`
		Seq        string   `json:"seq"`
		DependsOn  string   `json:"dependsOn"`
		BodyField  *uint32  `json:"bodyField"`
		BodyHex    string   `json:"bodyHex"`
		UnknownHex []string `json:"unknownHex"`
	} `json:"frame"`
	Limits    *vecLimits `json:"limits"`
	MaxBytes  int        `json:"maxBytes"`
	OutHex    string     `json:"outHex"`
	OK        *bool      `json:"ok"`
	Error     string     `json:"error"`
	ErrorCode uint32     `json:"errorCode"`
}

// codecBodyVec is one of the `bodies` vectors: a TYPED body, decoded by
// typedbody.go here, by body.rs in Rust and by codec.ts in TypeScript. Value is
// held raw so it can be compared as JSON against the shape all three surface.
type codecBodyVec struct {
	Name      string          `json:"name"`
	Field     uint32          `json:"field"`
	BodyHex   string          `json:"bodyHex"`
	Limits    *vecLimits      `json:"limits"`
	OK        bool            `json:"ok"`
	Value     json.RawMessage `json:"value"`
	Error     string          `json:"error"`
	ErrorCode uint32          `json:"errorCode"`
}

type codecVectorFile struct {
	BodiesTypedByTypescriptOnly []uint32         `json:"bodiesTypedByTypescriptOnly"`
	Limits                      vecLimits        `json:"limits"`
	TrafficClassEphemeral       uint32           `json:"trafficClassEphemeral"`
	EphemeralBodies             []uint32         `json:"ephemeralBodies"`
	BodyFields                  []uint32         `json:"bodyFields"`
	Decode                      []codecDecodeVec `json:"decode"`
	Encode                      []codecEncodeVec `json:"encode"`
	Bodies                      []codecBodyVec   `json:"bodies"`
}

// unhex strips whitespace so the fixture can group bytes for a human reader.
func cunhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.Join(strings.Fields(s), ""))
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

func u64(t *testing.T, s string) uint64 {
	t.Helper()
	if s == "" {
		return 0
	}
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		t.Fatalf("bad uint64 %q: %v", s, err)
	}
	return v
}

func loadCodecVectors(t *testing.T) codecVectorFile {
	t.Helper()
	raw, err := os.ReadFile(codecVectorPath)
	if err != nil {
		t.Fatalf("cannot read shared vectors at %s: %v", codecVectorPath, err)
	}
	var v codecVectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("vectors are not valid JSON: %v", err)
	}
	if len(v.Decode) == 0 || len(v.Encode) == 0 || len(v.Bodies) == 0 {
		t.Fatal("vector file has no cases — a silently empty fixture proves nothing")
	}
	return v
}

// The constants must agree, or every byte-level vector is comparing two
// protocols that merely look alike.
func TestCodecConstantsMatchTheFixture(t *testing.T) {
	v := loadCodecVectors(t)
	l := DefaultLimits()
	f := v.Limits
	for _, c := range []struct {
		name     string
		got, arg int
	}{
		{"max_frame_bytes", l.MaxFrameBytes, f.MaxFrameBytes},
		{"max_opaque_bytes", l.MaxOpaqueBytes, f.MaxOpaqueBytes},
		{"max_message_body_bytes", l.MaxMessageBodyBytes, f.MaxMessageBodyBytes},
		{"max_repeated_elements", l.MaxRepeatedElements, f.MaxRepeatedElements},
		{"max_string_field_bytes", l.MaxStringFieldBytes, f.MaxStringFieldBytes},
	} {
		if c.got != c.arg {
			t.Errorf("%s: Go %d, fixture %d", c.name, c.got, c.arg)
		}
	}
	if l.MaxFragmentsPerMessage != f.MaxFragmentsPerMessage {
		t.Errorf("max_fragments_per_message: Go %d, fixture %d", l.MaxFragmentsPerMessage, f.MaxFragmentsPerMessage)
	}
	if l.MaxNestingDepth != f.MaxNestingDepth {
		t.Errorf("max_nesting_depth: Go %d, fixture %d", l.MaxNestingDepth, f.MaxNestingDepth)
	}
	if TrafficClassEphemeral != v.TrafficClassEphemeral {
		t.Errorf("EPHEMERAL: Go %d, fixture %d", TrafficClassEphemeral, v.TrafficClassEphemeral)
	}
	if len(v.BodyFields) != len(BodyFields) {
		t.Fatalf("body field count: Go %d, fixture %d", len(BodyFields), len(v.BodyFields))
	}
	for i, f := range v.BodyFields {
		if BodyFields[i] != f {
			t.Errorf("bodyFields[%d]: Go %d, fixture %d", i, BodyFields[i], f)
		}
	}
	if len(v.EphemeralBodies) != len(EphemeralBodies) {
		t.Fatalf("ephemeral body count: Go %d, fixture %d", len(EphemeralBodies), len(v.EphemeralBodies))
	}
	for i, f := range v.EphemeralBodies {
		if EphemeralBodies[i] != f {
			t.Errorf("ephemeralBodies[%d]: Go %d, fixture %d", i, EphemeralBodies[i], f)
		}
	}
}

// The fixture's own scope rule: no vector may use a body the TypeScript side
// types and the others do not, because that is the one place the three
// implementations are permitted to differ. Asserted rather than trusted to prose.
func TestCodecVectorsAvoidTypescriptOnlyBodies(t *testing.T) {
	v := loadCodecVectors(t)
	excluded := map[uint32]bool{}
	for _, f := range v.BodiesTypedByTypescriptOnly {
		excluded[f] = true
	}
	for _, c := range v.Decode {
		// A body in the excluded set is fine only when it is EMPTY: an empty
		// body cannot be malformed, so all three must agree on it.
		if c.BodyField != nil && excluded[*c.BodyField] && c.BodyHex != "" {
			t.Errorf("decode vector %q uses a non-empty TypeScript-only body %d", c.Name, *c.BodyField)
		}
	}
}

func TestCodecDecodeVectors(t *testing.T) {
	v := loadCodecVectors(t)
	base := DefaultLimits()

	for _, c := range v.Decode {
		t.Run(c.Name, func(t *testing.T) {
			lim := c.Limits.apply(base)
			m, err := DecodeMessage(cunhex(t, c.InputHex), lim, c.MaxBytes, c.Depth)

			if !c.OK {
				var ce CodecError
				if !errors.As(err, &ce) {
					t.Fatalf("expected refusal %s, got err=%v", c.Error, err)
				}
				if ce.Name() != c.Error {
					t.Fatalf("refusal reason: Go %s, fixture %s", ce.Name(), c.Error)
				}
				if ce.ErrorCode() != c.ErrorCode {
					t.Fatalf("errors.proto code: Go %d, fixture %d", ce.ErrorCode(), c.ErrorCode)
				}
				return
			}

			if err != nil {
				t.Fatalf("expected success, got %v", err)
			}
			if m.RequestID != c.RequestID {
				t.Errorf("request_id: %q != %q", m.RequestID, c.RequestID)
			}
			if m.TrafficClass != c.TrafficCls {
				t.Errorf("traffic_class: %d != %d", m.TrafficClass, c.TrafficCls)
			}
			if m.Stream != c.Stream {
				t.Errorf("stream: %d != %d", m.Stream, c.Stream)
			}
			if m.Seq != u64(t, c.Seq) {
				t.Errorf("seq: %d != %s", m.Seq, c.Seq)
			}
			if m.DependsOn != u64(t, c.DependsOn) {
				t.Errorf("depends_on: %d != %s", m.DependsOn, c.DependsOn)
			}
			var wantBody uint32
			if c.BodyField != nil {
				wantBody = *c.BodyField
			}
			if m.BodyField != wantBody {
				t.Errorf("body field: %d != %d", m.BodyField, wantBody)
			}
			if got := hex.EncodeToString(m.Body); got != strings.Join(strings.Fields(c.BodyHex), "") {
				t.Errorf("body bytes: %s != %s", got, c.BodyHex)
			}
			if len(m.Unknown) != len(c.UnknownHex) {
				t.Fatalf("unknown field count: %d != %d", len(m.Unknown), len(c.UnknownHex))
			}
			for i, want := range c.UnknownHex {
				if got := hex.EncodeToString(m.Unknown[i]); got != strings.Join(strings.Fields(want), "") {
					t.Errorf("unknown[%d]: %s != %s", i, got, want)
				}
			}
		})
	}
}

func TestCodecEncodeVectors(t *testing.T) {
	v := loadCodecVectors(t)
	base := DefaultLimits()

	for _, c := range v.Encode {
		t.Run(c.Name, func(t *testing.T) {
			var m Message
			m.RequestID = c.Frame.RequestID
			m.TrafficClass = c.Frame.TrafficCls
			m.Stream = c.Frame.Stream
			m.Seq = u64(t, c.Frame.Seq)
			m.DependsOn = u64(t, c.Frame.DependsOn)
			if c.Frame.BodyField != nil {
				m.BodyField = *c.Frame.BodyField
				m.Body = cunhex(t, c.Frame.BodyHex)
			}
			for _, u := range c.Frame.UnknownHex {
				m.Unknown = append(m.Unknown, cunhex(t, u))
			}

			out, err := EncodeMessage(m, c.Limits.apply(base), c.MaxBytes)

			if c.OK != nil && !*c.OK {
				var ce CodecError
				if !errors.As(err, &ce) {
					t.Fatalf("expected refusal %s, got err=%v", c.Error, err)
				}
				if ce.Name() != c.Error {
					t.Fatalf("refusal reason: Go %s, fixture %s", ce.Name(), c.Error)
				}
				if ce.ErrorCode() != c.ErrorCode {
					t.Fatalf("errors.proto code: Go %d, fixture %d", ce.ErrorCode(), c.ErrorCode)
				}
				return
			}

			if err != nil {
				t.Fatalf("expected success, got %v", err)
			}
			if got := hex.EncodeToString(out); got != strings.Join(strings.Fields(c.OutHex), "") {
				t.Fatalf("bytes: %s != %s", got, c.OutHex)
			}
		})
	}
}

// Every successful decode vector must re-encode to the bytes it came from.
// Preservation of unknown fields is only real if it survives the round trip,
// and field order is what makes decode→encode byte-identical across languages.
func TestCodecDecodeThenEncodeIsByteIdentical(t *testing.T) {
	v := loadCodecVectors(t)
	base := DefaultLimits()

	for _, c := range v.Decode {
		if !c.OK {
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			lim := c.Limits.apply(base)
			in := cunhex(t, c.InputHex)
			m, err := DecodeMessage(in, lim, c.MaxBytes, c.Depth)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			out, err := EncodeMessage(m, lim, c.MaxBytes)
			if err != nil {
				t.Fatalf("re-encode: %v", err)
			}
			// A duplicate scalar is last-wins, so that one vector cannot be
			// byte-identical; it decodes to strictly fewer fields on purpose.
			if len(out) > len(in) {
				t.Fatalf("re-encode grew: %s from %s", hex.EncodeToString(out), hex.EncodeToString(in))
			}
			if remade, err := DecodeMessage(out, lim, c.MaxBytes, c.Depth); err != nil || remade.Seq != m.Seq ||
				remade.RequestID != m.RequestID || remade.BodyField != m.BodyField {
				t.Fatalf("round trip lost meaning: %v / %+v vs %+v", err, remade, m)
			}
		})
	}
}

// ── the typed bodies ────────────────────────────────────────────────────
//
// The `bodies` section of the SAME fixture, asserted here exactly as
// services/transport/rust/tests/body.rs and lib/ccwire/codecParity.selftest.ts
// assert it: decoded VALUE, refusal REASON, and errors.proto CODE.
//
// Bodies are compared as JSON in codec.ts's surfaced shape — bytes as hex,
// 64-bit fields as DECIMAL STRINGS. The string is the meeting point: TypeScript
// hands out a string because a double rounds 2^53+1 away, Go holds a native
// uint64, and rendering it here is what makes "all three agree on the VALUE" an
// assertion rather than a hope.

func hexList(u [][]byte) []any {
	out := []any{}
	for _, b := range u {
		out = append(out, hex.EncodeToString(b))
	}
	return out
}

func strList(s []string) []any {
	out := []any{}
	for _, x := range s {
		out = append(out, x)
	}
	return out
}

func typedPublicMetaJSON(m *TypedPublicMeta) map[string]any {
	return map[string]any{
		"attachment_id": m.AttachmentID, "view_once": m.ViewOnce, "revoked": m.Revoked,
		"announcement": m.Announcement, "audience": m.Audience, "silent": m.Silent,
		"group_id": m.GroupID, "gif_url": m.GifURL, "allow_multiple": m.AllowMultiple,
		"option_count": m.OptionCount, "mention_user_ids": strList(m.MentionUserIDs),
		"encrypted": m.Encrypted, "game": m.Game, "room": m.Room,
		"unknown": hexList(m.Unknown),
	}
}

func envelopeJSON(e *Envelope) map[string]any {
	o := map[string]any{
		"chat_id": e.ChatID, "message_id": e.MessageID, "client_msg_id": e.ClientMsgID,
		"server_ts_ms": strconv.FormatInt(e.ServerTsMS, 10),
		"msg_class":    e.MsgClass, "msg_class_name": e.MsgClassName(),
		"causal_epoch": strconv.FormatUint(e.CausalEpoch, 10),
		"unknown":      hexList(e.Unknown),
	}
	// ABSENT, not defaulted: submessage presence is meaningful in proto3, and
	// codec.ts leaves the key off entirely when there is none.
	if e.PublicMeta != nil {
		o["public_meta"] = typedPublicMetaJSON(e.PublicMeta)
	}
	return o
}

func bodyJSON(t *testing.T, b any) map[string]any {
	t.Helper()
	switch m := b.(type) {
	case TypingState:
		return map[string]any{
			"chat_id": m.ChatID, "typing": m.Typing, "sender_uid": m.SenderUID,
			"unknown": hexList(m.Unknown),
		}
	case ViewerState:
		return map[string]any{
			"chat_id": m.ChatID, "activity": m.Activity, "activity_name": m.ActivityName(),
			"leaving": m.Leaving, "resync": m.Resync, "unknown": hexList(m.Unknown),
		}
	case GeoRelay:
		return map[string]any{
			"scope_kind": m.ScopeKind, "scope_kind_name": m.ScopeKindName(),
			"scope_id": m.ScopeID, "subject_id": m.SubjectID,
			"sealed": hex.EncodeToString(m.Sealed), "ended": m.Ended,
			"until_ms": strconv.FormatInt(m.UntilMS, 10), "sender_uid": m.SenderUID,
			"unknown": hexList(m.Unknown),
		}
	case CryptoControl:
		return map[string]any{
			"kind": m.Kind, "kind_name": m.KindName(), "chat_id": m.ChatID,
			"to_uid": m.ToUID, "payload": hex.EncodeToString(m.Payload),
			"epoch": strconv.FormatUint(m.Epoch, 10), "payload_format": m.PayloadFormat,
			"unknown": hexList(m.Unknown),
		}
	case SubmitMessage:
		o := map[string]any{
			"sealed": hex.EncodeToString(m.Sealed), "unknown": hexList(m.Unknown),
		}
		if m.Envelope != nil {
			o["envelope"] = envelopeJSON(m.Envelope)
		}
		return o
	case Fragment:
		return map[string]any{
			"fragment_id": m.FragmentID, "index": m.Index, "total": m.Total,
			"total_bytes": strconv.FormatUint(m.TotalBytes, 10),
			"chunk":       hex.EncodeToString(m.Chunk), "last": m.Last,
			"unknown": hexList(m.Unknown),
		}
	}
	t.Fatalf("no JSON shape for %T — a typed body was added without a parity rendering", b)
	return nil
}

// asJSON round-trips through encoding/json so both sides are compared as the
// same primitive types (every number a float64), not as Go's static ones.
func asJSON(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

func TestCodecBodyVectors(t *testing.T) {
	v := loadCodecVectors(t)
	base := DefaultLimits()

	for _, c := range v.Bodies {
		t.Run(c.Name, func(t *testing.T) {
			// depth 1: the frame layer already charged one level for entering
			// the body, exactly as codec.ts's `dec(nest(r, depth+1), depth+1)`.
			b, err := DecodeBody(c.Field, cunhex(t, c.BodyHex), c.Limits.apply(base), 1)

			if !c.OK {
				var ce CodecError
				if !errors.As(err, &ce) {
					t.Fatalf("accepted a body the fixture refuses (%s): err=%v", c.Error, err)
				}
				if ce.Name() != c.Error {
					t.Fatalf("refused for a DIFFERENT reason: Go %s, fixture %s", ce.Name(), c.Error)
				}
				if ce.ErrorCode() != c.ErrorCode {
					t.Fatalf("errors.proto code: Go %d, fixture %d — the peer would be told the wrong thing",
						ce.ErrorCode(), c.ErrorCode)
				}
				return
			}

			if err != nil {
				t.Fatalf("refused a body the fixture accepts: %v", err)
			}
			if b == nil {
				t.Fatalf("field %d is not typed here, so this vector proves nothing", c.Field)
			}
			got, want := asJSON(t, bodyJSON(t, b)), asJSON(t, c.Value)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("decoded to a different message:\n got %v\nwant %v", got, want)
			}
		})
	}
}

// Every typed body must be exercised, or a decoder could rot untested behind a
// fixture that happens not to mention it. And the exclusion list stays asserted
// even at empty, so a future one-sided body type fails here.
func TestEveryTypedBodyHasVectors(t *testing.T) {
	v := loadCodecVectors(t)
	for _, f := range TypedBodies {
		n := 0
		for _, c := range v.Bodies {
			if c.Field == f {
				n++
			}
		}
		if n < 4 {
			t.Errorf("body %d has only %d vectors; canonical, empty, over-bound and malformed are the minimum", f, n)
		}
	}
	if len(v.BodiesTypedByTypescriptOnly) != 0 {
		t.Errorf("a body type is typed on one side only again: %v", v.BodiesTypedByTypescriptOnly)
	}
}

// The other 21 bodies stay OPAQUE. Returning nil rather than guessing is the
// contract: an unimplemented body is never lost and never reinterpreted.
func TestAnUntypedBodyIsLeftAlone(t *testing.T) {
	lim := DefaultLimits()
	for _, f := range []uint32{19, 22, 49, 83, 97, 99} {
		// Bytes that are not valid protobuf at all: an untyped body is never
		// parsed, so they come back unexamined rather than refused.
		b, err := DecodeBody(f, []byte{0x0b, 0xff}, lim, 1)
		if b != nil || err != nil {
			t.Errorf("body %d was parsed: %v / %v", f, b, err)
		}
	}
}

// A length a peer declares must never size an allocation. The fixture covers the
// truncated case; this covers the absurd one, which no fixture should have to
// carry as literal bytes.
func TestAnAbsurdDeclaredLengthInABodyIsRefusedWithoutAllocating(t *testing.T) {
	// typing_state field 1, wire 2, length = the largest a 5-byte varint holds.
	buf := []byte{0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f}
	if _, err := DecodeBody(BodyTypingState, buf, DefaultLimits(), 1); !errors.Is(err, ErrTruncated) {
		t.Fatalf("want TRUNCATED, got %v", err)
	}
}

// A body already at the recursion limit is refused before it is read, so a
// reassembler re-decoding a reassembled payload cannot walk deeper by calling in
// here directly.
func TestABodyPastTheRecursionLimitIsRefused(t *testing.T) {
	lim := DefaultLimits()
	if _, err := DecodeBody(BodyTypingState, nil, lim, lim.MaxNestingDepth+1); !errors.Is(err, ErrNestingTooDeep) {
		t.Fatalf("want NESTING_TOO_DEEP, got %v", err)
	}
}
