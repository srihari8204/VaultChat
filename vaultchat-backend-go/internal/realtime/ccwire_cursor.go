// CC-Wire catch-up — cursor_sync (body 64) in, cursor_batch (body 65) out.
//
// THE DIRECTIONS ARE NOT SYMMETRIC, and cursor.proto is what says so:
//
//	message CursorSync  { repeated Cursor cursors = 1; }              // <= 256
//	message CursorBatch { repeated Cursor cursors = 1;
//	                      bool more = 2; string continuation = 3; }   // server-authored
//
// One CursorSync already carries up to max_batch_items scopes, so there is no
// second inbound body for "many cursors" — a batch catch-up is a CursorSync
// with more than one cursor in it. CursorBatch is the REPLY: `continuation` is
// explicitly server-authored and `more` answers a question rather than asking
// one, so a client cannot legitimately originate it. Body 65 is therefore NOT
// served inbound; it falls through serveBody to UNKNOWN_OPERATION.
//
// THE SERVER HAS EXACTLY ONE CATCH-UP, AND IT IS `GET /chats/delta`.
// lib/syncEngine.ts drives it over REST; this file drives the SAME handler,
// through the same in-process loopback ccwire_messages.go uses for sends. There
// is no second sync engine here, no second cursor store, no second pagination
// and no second visibility rule — chatsDelta's
//
//	JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
//	                    AND cm.left_at IS NULL AND cm.hidden = FALSE
//
// is what decides which rows exist at all, exactly as it does on REST, and the
// cold-sync guard (since=0 on an unrecognised device) applies to this transport
// for free because the request genuinely goes through it.
//
// WHAT A CURSOR FRAME PRODUCES. Backfilled messages are sent as ordinary
// DeliverMessage bodies, encoded by ccwireDeliverBody — the same encoder the
// live fan-out uses, so a catch-up message and a live message are
// indistinguishable to a client, which is the only way a client can merge them
// without a second code path. They go out on STREAM_ID_SYNC (3), not on the
// messaging stream, so a large backfill cannot reorder or starve live traffic;
// the closing CursorBatch rides the SAME stream, which is what guarantees the
// new watermark arrives AFTER the messages it covers (per-stream FIFO,
// envelope.proto §Frame.stream).
//
// WHY A CURSOR IS NOT AN INTEGER THE CLIENT GETS TO CHOOSE. messages.id is one
// global BIGSERIAL, so a cursor lifted from chat B parses perfectly as a cursor
// for chat A and silently skips every chat-A message below it. That is data
// loss the client would never see, so provenance is checked rather than
// assumed. See ccwireCursorCheck for the whole decision table.
package realtime

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/metrics"
)

// ccwireMaxBatchItems is Limits.max_batch_items — the 256 encodeLimits already
// advertises in ServerHello field 11. A client that read the handshake knows
// this bound, so exceeding it is a client bug, answered as one.
const ccwireMaxBatchItems = 256

const ccwireCursorMinInterval = time.Second

// ccwireBackfillLimit is the page size asked of /chats/delta. chatsDelta's own
// default; it caps itself at 500 regardless, and `more` tells the client to ask
// again. Paging is the REST handler's, not restated here.
const ccwireBackfillLimit = 200

const ccwireStreamSync uint32 = 3

// CursorKind, cursor.proto.
const (
	cursorKindUnspecified uint32 = 0
	cursorKindRead        uint32 = 1
	cursorKindDelivered   uint32 = 2
	cursorKindSynced      uint32 = 3
)

// ccwireCursor is one decoded cursor.proto Cursor. updated_at_ms (4) is not
// read: it is a client's clock reading about a server-issued ordinal, and the
// server has no use for it that would not amount to trusting it.
type ccwireCursor struct {
	ChatID   string
	Kind     uint32
	Position uint64
}

type ccwireSyncPositionsKey struct{}

// CCWireSyncPositions narrows the canonical SQL query before LIMIT is applied.
// Only the validated in-process loopback can set this context value; public
// headers and query parameters cannot impersonate it.
func CCWireSyncPositions(r *http.Request) map[string]uint64 {
	positions, _ := r.Context().Value(ccwireSyncPositionsKey{}).(map[string]uint64)
	return positions
}

// ── decode ──────────────────────────────────────────────────────────────
//
// internal/ccwire's reader is unexported and this package must not grow a
// decoder into that one's file, so the ~40 lines below are a bounded protobuf
// reader for exactly these two bodies. Same order of checks as everywhere else
// in the codec: length first, then contents.

type pbr struct {
	b []byte
	p int
}

func (r *pbr) varint() (uint64, bool) {
	var v uint64
	for shift := uint(0); r.p < len(r.b); shift += 7 {
		if shift >= 64 {
			return 0, false
		}
		c := r.b[r.p]
		r.p++
		if shift == 63 && c > 1 {
			return 0, false
		}
		v |= uint64(c&0x7f) << shift
		if c&0x80 == 0 {
			return v, true
		}
	}
	return 0, false
}

// tag reads a field tag.
//
// A TAG is bounded at five bytes, not ten. internal/ccwire's codec, the
// TypeScript codec and the Rust parser all cap tag and length varints at
// varint32 and refuse anything longer as VARINT_OVERFLOW — and codec.json pins
// that refusal as a shared vector. This reader accepted ten, which made the
// live handshake, cursor and Ping path accept bytes the frame layer of the same
// server refuses: a parser differential reintroduced one layer up, in exactly
// the place all three implementations wrote a comment saying they must not.
func (r *pbr) tag() (uint64, bool) {
	return r.varint32()
}

// varint32 is a varint that cannot describe more than 32 bits.
//
// Used for tags and lengths, where the protocol has no value that needs more.
// Plain varint() stays for VALUE positions, where uint64 is legitimate — seq
// and depends_on really are 64-bit.
func (r *pbr) varint32() (uint64, bool) {
	start := r.p
	v, ok := r.varint()
	if !ok || r.p-start > 5 || v > uint64(^uint32(0)) {
		return 0, false
	}
	return v, true
}

func (r *pbr) span(max int) ([]byte, bool) {
	n, ok := r.varint32()
	if !ok || n > uint64(len(r.b)-r.p) || int(n) > max {
		return nil, false
	}
	s := r.b[r.p : r.p+int(n)]
	r.p += int(n)
	return s, true
}

// skip accepts ordinary protobuf wire types for forward-compatible unknown
// fields. Deprecated groups (3/4) are refused.
func (r *pbr) skip(wire uint8, lim ccwire.Limits) bool {
	switch wire {
	case 0:
		_, ok := r.varint()
		return ok
	case 2:
		_, ok := r.span(lim.MaxFrameBytes)
		return ok
	case 1:
		if len(r.b)-r.p < 8 {
			return false
		}
		r.p += 8
		return true
	case 5:
		if len(r.b)-r.p < 4 {
			return false
		}
		r.p += 4
		return true
	default:
		return false
	}
}

// ccwireDecodeCursors reads CursorSync. Its optional mutation continuation was
// issued by a previous CursorBatch and is passed through opaque; the canonical
// /chats/delta handler validates its syntax before using it.
//
// It stops at limitN+1 entries so the caller can tell "at the bound" from "over
// it" and refuse the second explicitly. Nothing is truncated here.
func ccwireDecodeCursors(body []byte, lim ccwire.Limits, limitN int) ([]ccwireCursor, string, bool) {
	out := []ccwireCursor{}
	mutationContinuation := ""
	r := pbr{b: body}
	for r.p < len(r.b) {
		tag, ok := r.tag()
		if !ok {
			return nil, "", false
		}
		field, wire := uint32(tag>>3), uint8(tag&7)
		if field == 0 {
			return nil, "", false
		}
		if field == 2 && wire == 2 {
			s, ok := r.span(lim.MaxStringFieldBytes)
			if !ok {
				return nil, "", false
			}
			mutationContinuation = string(s) // duplicate scalar: protobuf last-wins
			continue
		}
		if field != 1 || wire != 2 {
			if !r.skip(wire, lim) {
				return nil, "", false
			}
			continue
		}
		sub, ok := r.span(lim.MaxFrameBytes)
		if !ok {
			return nil, "", false
		}
		if len(out) > limitN {
			// Already over the bound; stop reading rather than allocate for a
			// batch that is going to be refused anyway.
			return out, mutationContinuation, true
		}
		c, ok := ccwireDecodeCursor(sub, lim)
		if !ok {
			return nil, "", false
		}
		out = append(out, c)
	}
	return out, mutationContinuation, true
}

func ccwireDecodeCursor(buf []byte, lim ccwire.Limits) (ccwireCursor, bool) {
	var c ccwireCursor
	r := pbr{b: buf}
	for r.p < len(r.b) {
		tag, ok := r.tag()
		if !ok || tag>>3 == 0 {
			return c, false
		}
		field, wire := uint32(tag>>3), uint8(tag&7)
		switch {
		case field == 1 && wire == 2:
			s, ok := r.span(lim.MaxStringFieldBytes)
			if !ok {
				return c, false
			}
			c.ChatID = string(s)
		case field == 2 && wire == 0:
			v, ok := r.varint()
			if !ok {
				return c, false
			}
			c.Kind = uint32(v & 0xffffffff)
		case field == 3 && wire == 0:
			v, ok := r.varint()
			if !ok {
				return c, false
			}
			c.Position = v
		default:
			// updated_at_ms (4) and anything a newer peer adds.
			if !r.skip(wire, lim) {
				return c, false
			}
		}
	}
	return c, true
}

// ── provenance ──────────────────────────────────────────────────────────

// ccwireCursorFacts is the one database read this file makes: for the positions
// in a frame, which chat each of them actually belongs to, plus the highest
// message id that has ever existed.
//
// The owner lookup runs UNDER RLS AS THE CALLER (db.WithUser), so it can only
// resolve messages the caller may already see — it is not an existence oracle
// for anyone else's chats. The ceiling is read on SysPool because it is not
// user data: it is the message sequence high-water mark, which anyone holding
// any recent message id already knows to within a rounding error.
//
// It is a package var so the decision logic above it can be driven without a
// database, the same seam ccwireSession.w uses for the socket.
var ccwireCursorFacts = ccwireCursorFactsDB

func ccwireCursorFactsDB(ctx context.Context, uid string, pos []int64) (map[int64]string, uint64, error) {
	owners := map[int64]string{}
	if len(pos) > 0 {
		err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx,
				`SELECT id, chat_id::text FROM messages WHERE id = ANY($1::bigint[])`, pos)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id int64
				var chat string
				if err := rows.Scan(&id, &chat); err != nil {
					return err
				}
				owners[id] = chat
			}
			return rows.Err()
		})
		if err != nil {
			return nil, 0, err
		}
	}
	var maxID int64
	// Allocation high-water survives hard deletion of the newest message.
	if err := db.SysPool.QueryRow(ctx, `SELECT COALESCE(pg_sequence_last_value(pg_get_serial_sequence('messages','id')::regclass), (SELECT COALESCE(MAX(id), 0) FROM messages))`).Scan(&maxID); err != nil {
		return nil, 0, err
	}
	return owners, uint64(maxID), nil
}

// ccwireCursorCheck is the whole cursor decision table, in one place.
//
//	position 0                     → accepted. "I have nothing", the cold start
//	                                 chatsDelta already has a guard for.
//	position > the sequence high   → REFUSED. No server ever issued it.
//	row resolves to another chat   → REFUSED. This is the cross-chat cursor:
//	                                 messages.id is global, so it parses, and
//	                                 honouring it would silently skip every
//	                                 message in THIS chat below that id.
//	row does not resolve at all    → accepted. A message whose row is gone —
//	                                 purged history, an expired disappearing
//	                                 message, a body reclaimed after delivery —
//	                                 is a LEGITIMATE place to have got to. The
//	                                 ordinal is still a valid position in the
//	                                 global sequence; refusing here would strand
//	                                 exactly the clients that have been offline
//	                                 longest, which is the case catch-up exists
//	                                 for.
func ccwireCursorCheck(c ccwireCursor, owners map[int64]string, maxID uint64) bool {
	if c.Position == 0 {
		return true
	}
	if c.Position > maxID {
		return false
	}
	owner, known := owners[int64(c.Position)]
	return !known || owner == c.ChatID
}

// ── the handler ─────────────────────────────────────────────────────────

// cursorSync serves body 64 — the ONLY inbound cursor body.
//
// ONE FRAME CARRIES 1..max_batch_items SCOPES. cursor.proto:
//
//	message CursorSync  { repeated Cursor cursors = 1; }  // <= 256
//
// so a multi-scope catch-up IS a CursorSync; there is no separate "batch"
// request to send. Body 65 (CursorBatch) is the REPLY shape and is not served
// inbound at all: its `continuation` is documented "opaque, server-authored",
// which a client has no way to author, and `more` is an answer to a question
// rather than part of one. A CursorBatch arriving from a client therefore falls
// through serveBody to ERROR_CODE_UNKNOWN_OPERATION, which is the correct
// answer and not a gap.
//
// EVERY REFUSAL IS WHOLE-FRAME. A frame naming one chat the caller is not in is
// refused entirely rather than served for the other entries, for two reasons:
// a partial answer would have to say WHICH entry failed, which turns the error
// channel into a membership oracle over arbitrary chat ids; and a client that
// receives a short answer has no way to tell "you are not in that chat" from
// "that chat had nothing new" — it would silently stop catching up. One
// NOT_PERMITTED for the frame is the honest answer, and it is retryable
// (ERROR_CLASS_RETRYABLE), so the client drops the bad entry and asks again.
func (s *ccwireSession) cursorSync(m ccwire.Message) bool {
	// ponytail: one catch-up per second per session. A general inbound frame
	// limiter belongs in handle() for every body; this bounds the expensive one
	// now. RETRYABLE, so the client backs off rather than losing the transport.
	if now := time.Now(); now.Sub(s.lastCursorAt) < ccwireCursorMinInterval {
		metrics.Inc("ccwire_cursor_rate_limited")
		return s.sendError(m.RequestID, errRateLimited, "catch-up too frequent")
	} else {
		s.lastCursorAt = now
	}
	cur, mutationContinuation, ok := ccwireDecodeCursors(m.Body, s.lim, ccwireMaxBatchItems)
	if !ok {
		return s.sendError(m.RequestID, errPayloadInvalid, "cursors")
	}
	if len(cur) == 0 {
		return s.sendError(m.RequestID, errPayloadInvalid, "at least one cursor required")
	}
	// REFUSED, NEVER TRUNCATED. Serving the first max_batch_items entries of an
	// oversized frame would return a CursorBatch that looks complete and quietly
	// leaves the rest of the client's chats behind forever.
	if len(cur) > ccwireMaxBatchItems {
		metrics.Inc("ccwire_cursor_batch_too_large")
		return s.sendError(m.RequestID, errPayloadInvalid, "too many cursors in one frame")
	}

	// since is the LOWEST position asked for: one /chats/delta page covers every
	// requested chat, and each chat's own cursor filters its own rows below.
	// One query per frame, not one per chat.
	since := ^uint64(0)
	want := make(map[string]uint64, len(cur))
	pos := make([]int64, 0, len(cur))
	for _, c := range cur {
		if !ccwireSafeID(c.ChatID) {
			return s.sendError(m.RequestID, errPayloadInvalid, "chat_id required")
		}
		// READ and DELIVERED are receipt pointers and POST /chats/{id}/read and
		// /delivered own them — reached over this transport by the Receipt body,
		// which runs the reciprocity rule and the Vanish-Mode sweep with them. A
		// second write path for the same pointers, here, would be a second
		// policy. Refused the way RECEIPT_KIND_PLAYED is.
		if c.Kind != cursorKindSynced {
			metrics.Inc("ccwire_cursor_kind_refused")
			return s.sendError(m.RequestID, errUnknownOperation, "only the synced cursor is served here")
		}
		if _, dup := want[c.ChatID]; dup {
			// Two cursors for one chat is not a merge the server may pick a
			// winner for — the client must say which position it means.
			return s.sendError(m.RequestID, errPayloadInvalid, "duplicate chat_id")
		}
		// THE authorization gate, and it is the one join_chat, Subscribe and
		// typing already use: same cached `chat_members … left_at IS NULL`
		// check, same generation, so BumpChatPermissions revokes catch-up at the
		// instant it revokes everything else.
		if !s.hub.chatMemberAllowed(s.d, c.ChatID) {
			metrics.Inc("ccwire_cursor_refused")
			return s.sendError(m.RequestID, errNotPermitted, "not permitted")
		}
		want[c.ChatID] = c.Position
		if c.Position < since {
			since = c.Position
		}
		if c.Position > 0 {
			pos = append(pos, int64(c.Position))
		}
	}

	owners, maxID, err := ccwireCursorFacts(s.ctxOrBG(), s.d.uid, pos)
	if err != nil {
		return s.sendError(m.RequestID, errInternal, "cursor check failed")
	}
	for _, c := range cur {
		if !ccwireCursorCheck(c, owners, maxID) {
			metrics.Inc("ccwire_cursor_invalid")
			return s.sendError(m.RequestID, errPayloadInvalid, "cursor was not issued for this chat")
		}
	}

	// THE canonical catch-up. Membership, the hidden-chat rule, the expiry
	// filter, the cold-sync cap, the undelivered-only filter, the page size and
	// `more` are all chatsDelta's — inherited, not restated.
	//
	// callContext forwards the session's ClientHello device_id as X-Device-Id.
	// This is install continuity metadata, not authenticated device ownership.
	//
	ctx := context.WithValue(s.ctxOrBG(), ccwireSyncPositionsKey{}, want)
	path := "/chats/delta?since=" + strconv.FormatUint(since, 10) +
		"&limit=" + strconv.Itoa(ccwireBackfillLimit)
	if mutationContinuation != "" {
		path += "&mutationCursor=" + url.QueryEscape(mutationContinuation)
	}
	status, resp := s.callContext(ctx, http.MethodGet,
		path, nil)
	if status != http.StatusOK {
		metrics.Inc("ccwire_cursor_delta_refused")
		return s.sendError(m.RequestID, statusToErrorCode(status), "catch-up refused")
	}

	// Backfill. Every row here came back out of chatsDelta, which means the
	// caller is a member of its chat — the filter below narrows to the chats
	// this FRAME asked about, it is not what makes the answer safe.
	sent := 0
	rows, _ := resp["messages"].([]any)
	for _, raw := range rows {
		row, _ := raw.(map[string]any)
		if row == nil {
			continue
		}
		chatID, _ := row["chatId"].(string)
		at, ok := want[chatID]
		if !ok {
			continue // another of the caller's chats; not what this frame asked for
		}
		id, err := strconv.ParseUint(idOf(row), 10, 64)
		if err != nil || id <= at {
			continue
		}
		// The SAME encoder the live fan-out uses. A catch-up message and a live
		// message must be byte-identical in shape or the client needs two
		// merge paths.
		if !s.send(ccwire.Message{
			RequestID:    m.RequestID,
			TrafficClass: ccwire.TrafficClassSync,
			Stream:       ccwireStreamSync,
			BodyField:    ccwire.BodyDeliverMessage,
			Body:         ccwireDeliverBody(row),
		}) {
			return false
		}
		sent++
		if id > want[chatID] {
			want[chatID] = id
		}
	}
	metrics.Add("ccwire_cursor_backfilled", uint64(sent))

	// Mutations use the same EditMessage/DeleteMessage bodies as live fan-out.
	// They stay on the sync stream so the closing continuation follows them.
	mutations, _ := resp["mutations"].([]any)
	for _, raw := range mutations {
		row, _ := raw.(map[string]any)
		if row == nil {
			continue
		}
		chatID, _ := row["chatId"].(string)
		if _, asked := want[chatID]; !asked {
			continue
		}
		id := idOf(row)
		if id == "" {
			continue
		}
		var body []byte
		var bodyField uint32
		if deletedAt, _ := row["deletedAt"].(string); deletedAt != "" {
			body = ccwire.AppendStringField(body, 1, chatID)
			body = ccwire.AppendStringField(body, 2, id)
			body = ccwire.AppendBoolField(body, 3, true)
			bodyField = ccwire.BodyDeleteMessage
		} else {
			env := ccwire.AppendStringField(nil, 1, chatID)
			env = ccwire.AppendStringField(env, 2, id)
			body = ccwire.AppendBytesField(body, 1, env)
			if content, ok := row["content"].(string); ok && content != "" {
				body = ccwire.AppendBytesField(body, 2, []byte(content))
			}
			bodyField = ccwire.BodyEditMessage
		}
		if !s.send(ccwire.Message{RequestID: m.RequestID, TrafficClass: ccwire.TrafficClassSync,
			Stream: ccwireStreamSync, BodyField: bodyField, Body: body}) {
			return false
		}
	}
	metrics.Inc("ccwire_cursor_sync")

	// The closing watermark, on the same stream as the messages it covers, so
	// per-stream FIFO puts it after them. A chat that got no rows keeps the
	// position it came in with — advancing it would acknowledge messages the
	// page had no room for.
	var b []byte
	for _, c := range cur {
		e := ccwire.AppendStringField(nil, 1, c.ChatID)
		e = ccwire.AppendVarintField(e, 2, uint64(cursorKindSynced))
		e = ccwire.AppendVarintField(e, 3, want[c.ChatID])
		e = ccwire.AppendVarintField(e, 4, uint64(time.Now().UnixMilli()))
		b = ccwire.AppendBytesField(b, 1, e)
	}
	more := truthy(resp["more"]) || len(mutations) == 500
	b = ccwire.AppendBoolField(b, 2, more)
	// continuation (field 3) is DELIBERATELY NOT SENT.
	//
	// It used to carry chatsDelta's nextSince, with the client told to echo it
	// back as the next position. nextSince is a GLOBAL messages.id; Cursor
	// .position is PER CHAT. Handing one back as the other is exactly the
	// cross-chat cursor this file's header refuses - it silently skips every
	// message in that chat below the global id. It was also self-defeating:
	// ccwireCursorCheck refuses an echoed position whose row belongs to another
	// chat, so a client following the instruction got PAYLOAD_INVALID.
	//
	// `more` plus the per-chat positions already in field 1 ARE the next message
	// request; field 3 therefore remains empty.
	nextMutation, _ := resp["nextMutationCursor"].(string)
	if nextMutation == "" {
		nextMutation = mutationContinuation
	}
	if nextMutation == "" {
		// Bootstrap a new peer at a server clock sampled by the canonical handler.
		// Existing REST sync remains the source for mutations predating adoption.
		if serverTime, ok := resp["serverTime"].(string); ok && serverTime != "" {
			nextMutation = serverTime + "|0"
		}
	}
	b = ccwire.AppendStringField(b, 4, nextMutation)
	return s.send(ccwire.Message{
		RequestID:    m.RequestID,
		TrafficClass: ccwire.TrafficClassSync,
		Stream:       ccwireStreamSync,
		BodyField:    ccwire.BodyCursorBatch,
		Body:         b,
	})
}

// ctxOrBG is the session's authenticated context, or the package background one
// in the tests that build a session without a request.
func (s *ccwireSession) ctxOrBG() context.Context {
	if s.commandCtx != nil {
		return s.commandCtx
	}
	if s.ctx != nil {
		return s.ctx
	}
	return bg
}

// idOf reads a public message id, which chatsPublicMsg renders as a decimal
// string but a JSON round trip of a number would give back as a float64.
func idOf(row map[string]any) string {
	switch v := row["id"].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatInt(int64(v), 10)
	default:
		return ""
	}
}

func jsonNum(v any) string {
	switch n := v.(type) {
	case string:
		return n
	case float64:
		return strconv.FormatInt(int64(n), 10)
	default:
		return "0"
	}
}
