package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"vaultchat/backend-go/internal/ccwire"
)

func enableTestEvents(s *ccwireSession) {
	s.hello = true
	s.appEvents = true
	s.lim.MaxMessageBodyBytes = appEventLogicalLimit
	s.events = map[string]func(...any){}
	s.hub.registerChatHandlersPeer(s.eventPeer())
	s.hub.registerSignalHandlersPeer(s.eventPeer())
}

func TestAppEventsNegotiationRequiresBothSides(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		for _, offered := range []bool{false, true} {
			flag := ""
			if enabled {
				flag = "1"
			}
			t.Setenv("CCWIRE_APP_EVENTS", flag)
			s, _ := newSession("u1", nil)
			cap := ccwire.AppendBoolField(nil, 1, true)
			cap = ccwire.AppendBoolField(cap, 8, offered)
			body := ccwire.AppendBytesField(nil, 3, cap)
			if !s.handle(frame(t, ccwire.Message{TrafficClass: 1, BodyField: ccwire.BodyClientHello, Body: body})) {
				t.Fatal("hello refused")
			}
			if s.appEvents != (enabled && offered) {
				t.Fatalf("enabled=%v offered=%v negotiated=%v", enabled, offered, s.appEvents)
			}
		}
	}
}

func TestAppEventsSharedAuthorizationAndFanout(t *testing.T) {
	h := &Hub{}
	sender, _ := newSession("sender", map[string]cachedPerm{"chat": {ok: true, at: time.Now()}})
	receiver, out := newSession("receiver", nil)
	sender.hub, receiver.hub = h, h
	enableTestEvents(sender)
	enableTestEvents(receiver)
	sender.d.peerOk = map[string]cachedPerm{"receiver": {ok: true, at: time.Now()}, "stranger": {ok: false, at: time.Now()}}
	h.ccwireRegister(receiver)
	if !sender.handle(appEventFrame("webrtc_offer", map[string]any{"to": "receiver", "from": "forged", "sdp": "sealed"})) {
		t.Fatal("relay failed")
	}
	if len(out.out) != 1 || out.last(t).BodyField != ccwire.BodyAppEvent {
		t.Fatal("recipient missing event")
	}
	// Decode with the public protobuf reader shape and verify the server identity.
	r := pbr{b: out.last(t).Body}
	_, _ = r.varint()
	_, _ = r.span(64)
	_, _ = r.varint()
	payload, _ := r.span(maxPayloadLen)
	var value map[string]any
	_ = json.Unmarshal(payload, &value)
	if value["from"] != "sender" || value["fromUid"] != "sender" {
		t.Fatal("spoofed actor forwarded")
	}
	sender.handle(appEventFrame("webrtc_offer", map[string]any{"to": "stranger"}))
	if len(out.out) != 1 {
		t.Fatal("denied relay delivered")
	}
	sender.handle(appEventFrame("presence_changed", map[string]any{"userId": "stranger", "online": true}))
	if len(out.out) != 1 {
		t.Fatal("server-only event accepted")
	}
	receiver.handle(appEventFrame("channel_join", map[string]any{"channelId": "news"}))
	h.ccwireRooms([]string{"channel:news"}, "", "channel_updated", map[string]any{"id": "news"})
	if len(out.out) != 2 {
		t.Fatal("room delivery missing")
	}
	receiver.handle(appEventFrame("channel_leave", map[string]any{"channelId": "news"}))
	h.ccwireRooms([]string{"channel:news"}, "", "channel_updated", map[string]any{})
	if len(out.out) != 2 {
		t.Fatal("left room still receives")
	}
}

func TestAppEventsQueueByteLimit(t *testing.T) {
	s, _ := newSession("u1", nil)
	s.out = make(chan []byte, ccwireOutQueue)
	s.done = make(chan struct{})
	s.enqueue(make([]byte, ccwireOutBytes))
	s.enqueue([]byte{1})
	if !s.closed || s.queuedBytes != ccwireOutBytes {
		t.Fatal("byte limit failed")
	}
}

func TestAppEventsPreserveLegacyLargePayloads(t *testing.T) {
	for _, escaped := range []bool{false, true} {
		s, _ := newSession("u1", nil)
		enableTestEvents(s)
		character := "x"
		if escaped {
			character = "\x00"
		}
		payload := map[string]any{"sealed": strings.Repeat(character, 150000), "extra": strings.Repeat(character, 110000)}
		budget := maxPayloadLen
		if !bounded(payload, 0, &budget) {
			t.Fatal("fixture must be legacy-valid")
		}
		var got map[string]any
		s.events["echo"] = func(args ...any) { got = args[0].(map[string]any) }
		frames := appEventFrames("echo", payload)
		if len(frames) == 0 || (escaped && len(frames) < 2) {
			t.Fatal("large event dropped rather than fragmented")
		}
		for _, raw := range frames {
			if len(raw) > ccwire.HeaderBytes+s.lim.MaxFrameBytes {
				t.Fatal("physical frame limit widened")
			}
			if !s.handle(raw) {
				t.Fatal("fragment refused")
			}
		}
		if got == nil || got["sealed"] != payload["sealed"] || got["extra"] != payload["extra"] {
			t.Fatal("opaque strings changed or valid legacy event lost")
		}
		if s.frag != nil && len(s.frag.sets) != 0 {
			t.Fatal("completed fragments retained")
		}
	}
}

func TestAppEventsFragmentDoesNotWeakenDecodedBudget(t *testing.T) {
	s, out := newSession("u1", nil)
	enableTestEvents(s)
	called := false
	s.events["echo"] = func(...any) { called = true }
	payload := map[string]any{"a": strings.Repeat("a", 150000), "b": strings.Repeat("b", 150000)}
	frames := appEventFrames("echo", payload)
	if len(frames) < 2 {
		t.Fatal("expected fragments")
	}
	for _, raw := range frames {
		s.handle(raw)
	}
	if called || out.last(t).BodyField != ccwire.BodyError {
		t.Fatal("decoded object budget bypassed")
	}
	if s.frag != nil && len(s.frag.sets) != 0 {
		t.Fatal("rejected message fragments retained")
	}
}

func TestAppEventsSubscriptionBoundsAndRevocation(t *testing.T) {
	s, out := newSession("u1", map[string]cachedPerm{"gone": {ok: false, at: time.Now()}})
	for i := 0; i < ccwireMaxSubscriptions; i++ {
		if !s.joinEventRoom(fmt.Sprintf("channel:%d", i)) {
			t.Fatal("valid join refused")
		}
	}
	if !s.joinEventRoom("channel:0") {
		t.Fatal("idempotent join refused")
	}
	if s.joinEventRoom("channel:overflow") || len(s.subs) != ccwireMaxSubscriptions {
		t.Fatal("unbounded subscriptions")
	}
	if out.last(t).BodyField != ccwire.BodyError {
		t.Fatal("limit must be explicit")
	}
	s.subs = map[string]struct{}{"chat:gone": {}}
	if s.canReceiveRooms([]string{"chat:gone"}) {
		t.Fatal("revoked member receives saved room")
	}
}

func TestAppEventsPresenceIncludesOtherTransport(t *testing.T) {
	t.Setenv("REDIS_ADAPTER", "")
	h := &Hub{userSockets: map[string]map[string]struct{}{"u1": {"legacy": {}}}}
	h.trackIdentity("u1", "cw:test")
	h.untrackIdentity("u1", "legacy")
	if !h.hasLiveSocket("u1") || h.OnlineCount() != 1 || len(h.userSockets["u1"]) != 1 {
		t.Fatal("native connection lost presence after legacy disconnect")
	}
}

type heartbeatTestConn struct {
	incoming chan []byte
	done     chan struct{}
	once     sync.Once
}

func (c *heartbeatTestConn) Close() error                     { c.once.Do(func() { close(c.done) }); return nil }
func (c *heartbeatTestConn) SetReadDeadline(time.Time) error  { return nil }
func (c *heartbeatTestConn) SetWriteDeadline(time.Time) error { return nil }
func (c *heartbeatTestConn) WriteMessage(int, []byte) error   { return nil }
func (c *heartbeatTestConn) ReadMessage() (int, []byte, error) {
	select {
	case b := <-c.incoming:
		return websocket.BinaryMessage, b, nil
	case <-c.done:
		return 0, nil, errors.New("closed")
	}
}

func TestAppEventsSlowHandlerDoesNotBlockHeartbeat(t *testing.T) {
	s, _ := newSession("u1", nil)
	enableTestEvents(s)
	c := &heartbeatTestConn{incoming: make(chan []byte, 2), done: make(chan struct{})}
	s.conn = c
	s.done = make(chan struct{})
	entered, release := make(chan struct{}), make(chan struct{})
	s.events["slow"] = func(...any) { close(entered); <-release }
	writes := make(chan []byte, 4)
	s.w = func(b []byte) error { writes <- b; return nil }
	finished := make(chan struct{})
	go func() { s.run(); close(finished) }()
	defer func() { close(release); s.closeOnce(); <-finished }()
	c.incoming <- appEventFrame("slow", map[string]any{})
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("handler did not start")
	}
	c.incoming <- frame(t, ccwire.Message{TrafficClass: 1, BodyField: ccwire.BodyPing})
	select {
	case raw := <-writes:
		fr, _ := ccwire.Decode(raw, ccwire.Options{})
		m, _ := ccwire.DecodeMessage(fr.Payload, s.lim, 0, 0)
		if m.BodyField != ccwire.BodyPong {
			t.Fatal("expected pong")
		}
	case <-time.After(time.Second):
		t.Fatal("heartbeat blocked by handler")
	}
}

func TestAppEventsDisconnectCancelsCommandBeforeRoomCleanup(t *testing.T) {
	s, _ := newSession("u1", nil)
	enableTestEvents(s)
	s.ctx, s.cancel = context.WithCancel(context.Background())
	c := &heartbeatTestConn{incoming: make(chan []byte, 1), done: make(chan struct{})}
	s.conn = c
	s.done = make(chan struct{})
	s.w = func([]byte) error { return nil }
	entered := make(chan struct{})
	joined := make(chan bool, 1)
	s.events["blocking"] = func(...any) {
		ctx := s.eventPeer().Context()
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > realtimeCommandTimeout {
			joined <- true
			close(entered)
			return
		}
		close(entered)
		<-ctx.Done()
		joined <- s.joinEventRoom("channel:stale")
	}
	finished := make(chan struct{})
	go func() { s.run(); close(finished) }()
	c.incoming <- appEventFrame("blocking", map[string]any{})
	select {
	case <-entered:
	case <-time.After(time.Second):
		s.closeOnce()
		t.Fatal("command did not start")
	}
	s.closeOnce()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("disconnect did not cancel blocking command")
	}
	if <-joined || len(s.subs) != 0 {
		t.Fatal("cancelled worker mutated subscriptions")
	}
}
