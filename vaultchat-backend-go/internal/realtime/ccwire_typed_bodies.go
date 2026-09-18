package realtime

import "vaultchat/backend-go/internal/ccwire"

// helloTypedAppBodies reports whether ClientHello negotiated
// Capabilities.typed_app_bodies (9) — "this peer ACCEPTS typed app-domain
// bodies inbound (typing_state 81, viewer_state 82, …) instead of the same
// events wrapped as app_event (100) JSON".
//
// WHY THIS EXISTS. The server already ADVERTISES field 9 (ccwire.go
// capabilities()), and the TS client reads it to decide whether to EMIT typed
// bodies. The reverse direction had no reader at all: helloAppEvents
// (ccwire_app_events.go) models fields 1+8 and helloWantsResumption
// (ccwire_resume.go) models field 2, so a client's field 9 was invisible here.
// The generated codec knows the field; the hand-written handshake path did not.
//
// WHAT THIS IS NOT FOR — read this before wiring it to anything.
//
// The server ALREADY emits typed app-domain bodies today, unconditionally and
// correctly: deliverOne (ccwire_messages.go:567, the else-branch of
// `if s.appEvents`) sends DeliverMessage (50), EditMessage (48),
// DeleteMessage (51), TypingState (81) and Receipt (52) to every session that
// did NOT negotiate app_events. That predates field 9 and needs no capability:
// such a client asked for the typed protocol by not asking for app_events.
//
// So do NOT retro-gate deliverOne on s.typedAppBodies. Every already-shipped
// client that does not set field 9 would silently stop receiving messages,
// edits, deletes, typing and receipts.
//
// This reader is for the OTHER case: sending a typed body to a session that
// DID negotiate app_events and therefore expects app_event (100). That is the
// one where guessing is unsafe, because the failure is silent — the client
// drops a frame it cannot route, with no error and no log. Gate that, and only
// that, on s.typedAppBodies.
//
// An earlier version of this comment claimed the gate existed "before its
// first caller". That was false: the caller above has always existed. Recorded
// because believing it is how someone breaks delivery for every shipped build.
//
// Deliberately one job, matching helloWantsResumption's own note about not
// threading a second boolean through helloAppEvents.
//
// FAILS CLOSED. Every malformed, truncated or absent case returns false, which
// means "keep sending app_event" — the direction that cannot break an existing
// client.
func helloTypedAppBodies(body []byte, lim ccwire.Limits) bool {
	r := pbr{b: body}
	for r.p < len(r.b) {
		t, ok := r.tag()
		if !ok {
			return false
		}
		if t>>3 == 3 && t&7 == 2 { // capabilities
			b, ok := r.span(lim.MaxStringFieldBytes)
			if !ok {
				return false
			}
			c := pbr{b: b}
			// LAST occurrence wins, which is what protobuf says about a repeated
			// scalar and what helloAppEvents next door already does. Returning on
			// the FIRST one read `typed_app_bodies:true, typed_app_bodies:false`
			// — a legal encoding, and the one a concatenating encoder or a
			// middlebox that appends a correction produces — as TRUE, i.e. as
			// consent from a client whose final word was no. This gate exists to
			// decide whether the server may send a frame the client would
			// silently drop, so reading a retracted yes is the one mistake it
			// must not make.
			got := false
			for c.p < len(c.b) {
				ct, ok := c.tag()
				if !ok {
					return false
				}
				if ct>>3 == 9 && ct&7 == 0 { // typed_app_bodies
					v, ok := c.varint()
					if !ok {
						return false
					}
					got = v != 0
					continue
				}
				if !c.skip(uint8(ct&7), lim) {
					return false
				}
			}
			return got
		}
		if !r.skip(uint8(t&7), lim) {
			return false
		}
	}
	return false
}
