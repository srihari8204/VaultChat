// The inbound bodies the Go server SERVES, and only those.
//
// codec.go's rule — "the transport routes, the application interprets, bodies
// stay opaque" — is still the rule. These are the exceptions it already names
// for DecodeScope: a body is parsed HERE only when the server must make an
// authorization or persistence decision from it, and then only the fields that
// decision needs.
//
// `sealed` is NOT among them. It is handed up as a view onto the input buffer,
// byte for byte, exactly as envelope.proto requires — the '\0vc1:' wrapper
// inside it is owned by lib/msgEnvelope.ts and this file does not know it
// exists.
//
// Every bound comes from Limits, and the ORDER OF CHECKS is the same as
// everywhere else in this package: length first, then contents.
package ccwire

import "unicode/utf8"

// str reads a length-delimited field as a bounded, UTF-8-valid string.
func (r *reader) str(lim Limits) (string, error) {
	span, err := r.lenSpan()
	if err != nil {
		return "", err
	}
	if len(span) > lim.MaxStringFieldBytes {
		return "", ErrStringTooLong
	}
	if !utf8.Valid(span) {
		return "", ErrInvalidUTF8
	}
	return string(span), nil
}

// PublicMeta mirrors ccwire.v1.PublicMeta, which itself mirrors
// jobs.MetaPublicKeys. It is not a superset and must never become one.
type PublicMeta struct {
	AttachmentID   string   // 1
	ViewOnce       bool     // 2
	Revoked        bool     // 3
	Announcement   bool     // 4
	Audience       string   // 5
	Silent         bool     // 6
	GroupID        string   // 7
	GifURL         string   // 8
	AllowMultiple  bool     // 9
	OptionCount    uint32   // 10
	MentionUserIDs []string // 11
	Encrypted      bool     // 12
	Game           string   // 13
	Room           string   // 14
}

// Submit is a decoded SubmitMessage.
//
// Envelope.message_id and Envelope.server_ts_ms are read but DISCARDED: they
// are server-assigned, so a client value for either is not a mistake to
// tolerate, it is a value to ignore. sender_uid is not a field at all
// (envelope.proto), which is the stronger version of the same rule.
type Submit struct {
	ChatID      string
	ClientMsgID string
	MsgClass    uint32
	Meta        PublicMeta
	Sealed      []byte // aliases the input buffer; copy if it must outlive it
}

// DecodeSubmit reads a SubmitMessage body: { Envelope envelope = 1; bytes sealed = 2; }
func DecodeSubmit(body []byte, lim Limits) (Submit, error) {
	var s Submit
	r := reader{b: body}
	for r.p < len(r.b) {
		field, wire, err := r.tag()
		if err != nil {
			return Submit{}, err
		}
		switch {
		case field == 1 && wire == 2:
			span, err := r.lenSpan()
			if err != nil {
				return Submit{}, err
			}
			if err := s.decodeEnvelope(span, lim); err != nil {
				return Submit{}, err
			}
		case field == 2 && wire == 2:
			span, err := r.lenSpan()
			if err != nil {
				return Submit{}, err
			}
			// The sealed body is bounded by max_message_body_bytes, the bound
			// capabilities.proto names for it — not by max_string_field_bytes,
			// which is for routing strings.
			if len(span) > lim.MaxMessageBodyBytes {
				return Submit{}, ErrBytesTooLong
			}
			s.Sealed = span
		default:
			if err := r.skipField(wire); err != nil {
				return Submit{}, err
			}
		}
	}
	return s, nil
}

func (s *Submit) decodeEnvelope(buf []byte, lim Limits) error {
	r := reader{b: buf}
	for r.p < len(r.b) {
		field, wire, err := r.tag()
		if err != nil {
			return err
		}
		var e error
		switch {
		case field == 1 && wire == 2:
			s.ChatID, e = r.str(lim)
		case field == 3 && wire == 2:
			s.ClientMsgID, e = r.str(lim)
		case field == 5 && wire == 0:
			var v uint64
			v, e = r.varint64()
			s.MsgClass = uint32(v & 0xffffffff)
		case field == 7 && wire == 2:
			var span []byte
			if span, e = r.lenSpan(); e == nil {
				e = s.Meta.decode(span, lim)
			}
		default:
			// Includes message_id (2) and server_ts_ms (4): server-assigned, so
			// a client's value is skipped rather than read.
			e = r.skipField(wire)
		}
		if e != nil {
			return e
		}
	}
	return nil
}

func (p *PublicMeta) decode(buf []byte, lim Limits) error {
	r := reader{b: buf}
	for r.p < len(r.b) {
		field, wire, err := r.tag()
		if err != nil {
			return err
		}
		var e error
		boolAt := func(dst *bool) {
			var v uint64
			v, e = r.varint64()
			*dst = v != 0
		}
		switch {
		case field == 1 && wire == 2:
			p.AttachmentID, e = r.str(lim)
		case field == 2 && wire == 0:
			boolAt(&p.ViewOnce)
		case field == 3 && wire == 0:
			boolAt(&p.Revoked)
		case field == 4 && wire == 0:
			boolAt(&p.Announcement)
		case field == 5 && wire == 2:
			p.Audience, e = r.str(lim)
		case field == 6 && wire == 0:
			boolAt(&p.Silent)
		case field == 7 && wire == 2:
			p.GroupID, e = r.str(lim)
		case field == 8 && wire == 2:
			p.GifURL, e = r.str(lim)
		case field == 9 && wire == 0:
			boolAt(&p.AllowMultiple)
		case field == 10 && wire == 0:
			var v uint64
			v, e = r.varint64()
			p.OptionCount = uint32(v & 0xffffffff)
		case field == 11 && wire == 2:
			if len(p.MentionUserIDs) >= lim.MaxRepeatedElements {
				return ErrTooManyElements
			}
			var id string
			if id, e = r.str(lim); e == nil {
				p.MentionUserIDs = append(p.MentionUserIDs, id)
			}
		case field == 12 && wire == 0:
			boolAt(&p.Encrypted)
		case field == 13 && wire == 2:
			p.Game, e = r.str(lim)
		case field == 14 && wire == 2:
			p.Room, e = r.str(lim)
		default:
			e = r.skipField(wire)
		}
		if e != nil {
			return e
		}
	}
	return nil
}

// ReceiptKind values from delivery.proto.
const (
	ReceiptKindUnspecified uint32 = 0
	ReceiptKindDelivered   uint32 = 1
	ReceiptKindRead        uint32 = 2
	ReceiptKindPlayed      uint32 = 3
)

// Receipt is a decoded inbound Receipt. user_id (4) and at_ms (5) are NOT
// read: delivery.proto says both are server-stamped, and "a client cannot
// assert a receipt on another user's behalf" is exactly the ungated
// new_message → message_delivered relay this transport must not repeat.
type Receipt struct {
	ChatID     string
	MessageIDs []string
	Kind       uint32
}

func DecodeReceipt(body []byte, lim Limits) (Receipt, error) {
	var rc Receipt
	r := reader{b: body}
	for r.p < len(r.b) {
		field, wire, err := r.tag()
		if err != nil {
			return Receipt{}, err
		}
		var e error
		switch {
		case field == 1 && wire == 2:
			rc.ChatID, e = r.str(lim)
		case field == 2 && wire == 2:
			if len(rc.MessageIDs) >= lim.MaxRepeatedElements {
				return Receipt{}, ErrTooManyElements
			}
			var id string
			if id, e = r.str(lim); e == nil {
				rc.MessageIDs = append(rc.MessageIDs, id)
			}
		case field == 3 && wire == 0:
			var v uint64
			v, e = r.varint64()
			rc.Kind = uint32(v & 0xffffffff)
		default:
			e = r.skipField(wire)
		}
		if e != nil {
			return Receipt{}, e
		}
	}
	return rc, nil
}

// DecodeTyping reads a TypingState body. sender_uid (3) is SERVER→CLIENT ONLY
// (envelope.proto) and is therefore skipped on the way in, never read — the
// server overwrites it from the session.
func DecodeTyping(body []byte, lim Limits) (chatID string, typing bool, err error) {
	r := reader{b: body}
	for r.p < len(r.b) {
		field, wire, e := r.tag()
		if e != nil {
			return "", false, e
		}
		switch {
		case field == 1 && wire == 2:
			chatID, e = r.str(lim)
		case field == 2 && wire == 0:
			var v uint64
			v, e = r.varint64()
			typing = v != 0
		default:
			e = r.skipField(wire)
		}
		if e != nil {
			return "", false, e
		}
	}
	return chatID, typing, nil
}

// Edit is a decoded EditMessage: { Envelope envelope = 1; bytes sealed = 2;
// uint64 edit_seq = 3; }
//
// Unlike Submit, Envelope.message_id IS read: on an edit it is not a
// server-assigned value, it NAMES THE TARGET. Everything else about the
// envelope is discarded for the same reasons Submit discards it.
//
// edit_seq (3) is skipped. The server keeps no per-message edit counter, and
// the REST edit is an UPDATE guarded by sender_id and the 15-minute window —
// replaying one produces the same row, not a second edit. A sequence number the
// server cannot check is a field it must not pretend to honour.
type Edit struct {
	ChatID    string
	MessageID string
	Sealed    []byte // aliases the input buffer
}

func DecodeEdit(body []byte, lim Limits) (Edit, error) {
	var ed Edit
	r := reader{b: body}
	for r.p < len(r.b) {
		field, wire, err := r.tag()
		if err != nil {
			return Edit{}, err
		}
		switch {
		case field == 1 && wire == 2:
			span, err := r.lenSpan()
			if err != nil {
				return Edit{}, err
			}
			if err := ed.decodeEnvelope(span, lim); err != nil {
				return Edit{}, err
			}
		case field == 2 && wire == 2:
			span, err := r.lenSpan()
			if err != nil {
				return Edit{}, err
			}
			if len(span) > lim.MaxMessageBodyBytes {
				return Edit{}, ErrBytesTooLong
			}
			ed.Sealed = span
		default:
			if err := r.skipField(wire); err != nil {
				return Edit{}, err
			}
		}
	}
	return ed, nil
}

func (ed *Edit) decodeEnvelope(buf []byte, lim Limits) error {
	r := reader{b: buf}
	for r.p < len(r.b) {
		field, wire, err := r.tag()
		if err != nil {
			return err
		}
		var e error
		switch {
		case field == 1 && wire == 2:
			ed.ChatID, e = r.str(lim)
		case field == 2 && wire == 2:
			ed.MessageID, e = r.str(lim)
		default:
			// Includes public_meta (7): an edit changes the ciphertext, not the
			// routing metadata, and the REST edit has no way to accept one —
			// so a meta on an edit is skipped rather than half-applied.
			e = r.skipField(wire)
		}
		if e != nil {
			return e
		}
	}
	return nil
}

// Delete is a decoded DeleteMessage:
// { string chat_id = 1; string message_id = 2; bool for_everyone = 3; }
type Delete struct {
	ChatID      string
	MessageID   string
	ForEveryone bool
}

func DecodeDelete(body []byte, lim Limits) (Delete, error) {
	var d Delete
	r := reader{b: body}
	for r.p < len(r.b) {
		field, wire, err := r.tag()
		if err != nil {
			return Delete{}, err
		}
		var e error
		switch {
		case field == 1 && wire == 2:
			d.ChatID, e = r.str(lim)
		case field == 2 && wire == 2:
			d.MessageID, e = r.str(lim)
		case field == 3 && wire == 0:
			var v uint64
			v, e = r.varint64()
			d.ForEveryone = v != 0
		default:
			e = r.skipField(wire)
		}
		if e != nil {
			return Delete{}, e
		}
	}
	return d, nil
}
