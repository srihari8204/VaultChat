package realtime

import (
	"testing"
	"time"
)

// A panic inside a CC-Wire command must kill the SESSION, not the PROCESS.
//
// Why this needs its own test rather than trusting net/http: the command worker
// started in run() is our goroutine, not a request goroutine. net/http's
// per-request recover does not reach it. The handlers it runs are the real
// production write paths -- chatsMessagePost, chatsMessagePatch,
// chatsMessageDelete, chatsDelivered, chatsRead, chatsDelta
// (internal/routes/chats.go:112-128) -- so before the recover in run(), a
// single nil map or slice index in any of them would take the whole binary
// down and disconnect EVERY user, not just the one who sent the frame.
//
// This test is unusually blunt about proving that: a panic escaping a goroutine
// is unrecoverable in Go, so without the fix this does not report a failed
// assertion, it terminates the entire test binary and every other test in the
// package with it. That is the same blast radius as the production bug, which
// is the point.
func TestCommandWorkerPanicClosesSessionAndNotTheProcess(t *testing.T) {
	s, _ := newSession("u1", nil)
	enableTestEvents(s)

	c := &heartbeatTestConn{incoming: make(chan []byte, 2), done: make(chan struct{})}
	s.conn = c
	s.done = make(chan struct{})
	s.w = func([]byte) error { return nil }
	s.events["boom"] = func(...any) { panic("deliberate panic from a chat handler") }

	finished := make(chan struct{})
	go func() { s.run(); close(finished) }()

	c.incoming <- appEventFrame("boom", map[string]any{})

	select {
	case <-finished:
		// run() returned: the panic was recovered, the session was torn down,
		// and this process is still here to assert it.
	case <-time.After(3 * time.Second):
		s.closeOnce()
		t.Fatal("run() did not return after the handler panicked -- the worker is wedged")
	}

	if !s.closed {
		t.Error("session not marked closed after a panicking command; closeOnce did not run")
	}
}

// The recover must not become a swallow-and-continue. A session whose handler
// panicked has whatever state the panic left behind, and serving more commands
// from it is a worse failure than making that one client reconnect -- silent
// wrong answers instead of a visible disconnect.
func TestCommandWorkerDoesNotKeepServingAfterAPanic(t *testing.T) {
	s, _ := newSession("u1", nil)
	enableTestEvents(s)

	c := &heartbeatTestConn{incoming: make(chan []byte, 4), done: make(chan struct{})}
	s.conn = c
	s.done = make(chan struct{})
	s.w = func([]byte) error { return nil }

	secondRan := make(chan struct{}, 1)
	s.events["boom"] = func(...any) { panic("deliberate panic from a chat handler") }
	s.events["after"] = func(...any) { secondRan <- struct{}{} }

	finished := make(chan struct{})
	go func() { s.run(); close(finished) }()

	c.incoming <- appEventFrame("boom", map[string]any{})
	c.incoming <- appEventFrame("after", map[string]any{})

	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		s.closeOnce()
		t.Fatal("run() did not return after the handler panicked")
	}

	select {
	case <-secondRan:
		t.Error("a command queued behind the panicking one still ran; the session should have been torn down")
	default:
	}
}
