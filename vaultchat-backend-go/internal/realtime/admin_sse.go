package realtime

// admin_sse.go — the admin firehose over Server-Sent Events, so the admin
// console stops being the last reason /socket.io/ has to stay mounted.
//
// WHY THIS EXISTS
//
// The mobile app is entirely on CC-Wire: socket.io-client is gone from its
// dependencies and lib/socket.ts selectTransport() returns 'ccwire' with no
// fallback. The ONLY remaining Socket.IO consumer is admin/index.html, which
// loads the library from a CDN and joins room "admin" for admin:event. Because
// of that one page the Go server ran two realtime stacks. This endpoint is what
// let the Socket.IO one be deleted.
//
// WHY SSE AND NOT CC-WIRE
//
// CC-Wire is a protobuf envelope with fragmentation, cursor resume and
// capability negotiation, built for a phone that loses its network and must
// reconcile durable state. An admin firehose needs none of that: it is a
// read-only tail of events that is worthless when stale, and a browser that
// missed 30 seconds wants the CURRENT events, not the ones it slept through.
// Porting CC-Wire into a plain HTML page would be a large amount of protocol
// code to deliver strictly less than these ~120 lines.
//
// AUTH: HEADER, NOT QUERY STRING
//
// This is deliberately NOT an EventSource endpoint. EventSource cannot set
// request headers, so every EventSource design ends up putting the admin key in
// the URL — where it lands in access logs, proxy logs and browser history. The
// client uses fetch() + ReadableStream instead and keeps the SAME x-admin-key
// header the other admin routes already use (routes/admin.go). The cost is that
// the client implements its own reconnect, which EventSource would have given
// for free; the benefit is that the admin key never appears in a URL.
//
// WHAT THIS IS NOT
//
// Not a delivery guarantee. A slow or wedged admin browser is DROPPED rather
// than allowed to apply backpressure to the emit path — an admin console must
// never be able to stall message fan-out to real users. Drops are counted and
// reported in the stream itself, so a gap is visible rather than silent.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// adminEvent is one line of the firehose, in the shape admin/index.html already
// consumes from Socket.IO: an event name plus its opaque payload.
type adminEvent struct {
	Event   string `json:"event"`
	Payload any    `json:"payload"`
}

// perSubscriberQueue is small ON PURPOSE. This is a live tail: an admin browser
// that cannot keep up wants the newest events, and a deep buffer would only
// delay the moment it notices. Overflow drops rather than blocks — see the file
// header on why the emit path must never wait for an admin console.
const perSubscriberQueue = 64

// sseSafe makes a string safe to place in an SSE field.
//
// Truncating rather than rejecting: the firehose is a diagnostic, and dropping
// an event because its name is odd loses the very signal an operator is
// watching for. Replacing the framing characters keeps the event visible and
// keeps it one event.
func sseSafe(s string) string {
	if len(s) > sseMaxFieldBytes {
		s = s[:sseMaxFieldBytes]
	}
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return '_'
		}
		return r
	}, s)
}

// sseMaxFieldBytes bounds an event name. appEventBuild already caps names at 64
// on the CC-Wire side; publishAdmin has no such bound, and an unbounded name is
// an unbounded line in every connected console.
const sseMaxFieldBytes = 128

// adminHeartbeat keeps intermediaries from reaping an idle stream. Caddy and
// most proxies will close a connection with no bytes for long enough, and a
// silent firehose is indistinguishable from a broken one.
const adminHeartbeat = 25 * time.Second

type adminSub struct {
	ch      chan adminEvent
	dropped atomic.Uint64
}

type adminSSE struct {
	mu   sync.RWMutex
	subs map[*adminSub]struct{}
}

func (a *adminSSE) add(s *adminSub) {
	a.mu.Lock()
	if a.subs == nil {
		a.subs = map[*adminSub]struct{}{}
	}
	a.subs[s] = struct{}{}
	a.mu.Unlock()
}

func (a *adminSSE) remove(s *adminSub) {
	a.mu.Lock()
	delete(a.subs, s)
	a.mu.Unlock()
}

// publish fans one event out to every attached admin stream. It never blocks:
// a full queue increments that subscriber's drop counter and moves on.
func (a *adminSSE) publish(ev adminEvent) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	for s := range a.subs {
		select {
		case s.ch <- ev:
		default:
			s.dropped.Add(1)
		}
	}
}

// Subscribers reports how many admin streams are attached. Used by the tests
// and worth having when deciding whether /socket.io/ still carries anyone.
func (h *Hub) AdminStreamCount() int {
	h.adminSSE.mu.RLock()
	defer h.adminSSE.mu.RUnlock()
	return len(h.adminSSE.subs)
}

// publishAdmin is the hook EmitToRooms/EmitBroadcast call. Kept separate so the
// Socket.IO path and the SSE path cannot drift: both are fed from one call site.
func (h *Hub) publishAdmin(event string, payload any) {
	if h == nil {
		return
	}
	h.adminSSE.publish(adminEvent{Event: event, Payload: payload})
}

// RegisterAdminSSE mounts GET /admin/events.
//
// Mounted unconditionally: it is additive and carries nothing until an
// authenticated admin attaches, so there is no flag to forget in a deploy — the
// failure this whole migration ran into once already (CCWIRE_WS living only in
// an overlay no deploy path passed).
func RegisterAdminSSE(mux *http.ServeMux, h *Hub) {
	mux.HandleFunc("GET /admin/events", func(w http.ResponseWriter, r *http.Request) {
		expected := os.Getenv("ADMIN_KEY")
		// No key configured means no admin surface, not an open one.
		if expected == "" || !safeKeyEqual(r.Header.Get("x-admin-key"), expected) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		// Caddy and nginx both buffer proxied responses by default, which turns a
		// live tail into nothing-then-everything.
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)

		sub := &adminSub{ch: make(chan adminEvent, perSubscriberQueue)}
		h.adminSSE.add(sub)
		defer h.adminSSE.remove(sub)

		fmt.Fprint(w, ": connected\n\n")
		flusher.Flush()

		ticker := time.NewTicker(adminHeartbeat)
		defer ticker.Stop()
		var reported uint64

		for {
			select {
			case <-r.Context().Done():
				return
			case ev := <-sub.ch:
				b, err := json.Marshal(ev)
				if err != nil {
					continue // one unmarshalable payload must not kill the stream
				}
				// The event NAME is data, and SSE is newline-framed. A name
				// carrying "\n\nevent: ...\ndata: ..." would inject a
				// fabricated event into every attached admin console —
				// /internal/emit takes a free-form name, so this reaches the
				// firehose from anything holding the internal key.
				if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", sseSafe(ev.Event), b); err != nil {
					return
				}
				flusher.Flush()
			case <-ticker.C:
				// A gap the viewer cannot otherwise see. Reported as a comment so
				// it never looks like a real event.
				if d := sub.dropped.Load(); d != reported {
					fmt.Fprintf(w, ": dropped %d\n\n", d-reported)
					reported = d
				}
				fmt.Fprint(w, ": ping\n\n")
				flusher.Flush()
			}
		}
	})
}
