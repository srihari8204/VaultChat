package realtime

// Covers the admin SSE firehose (admin_sse.go).
//
// SCOPE, STATED PLAINLY. These exercise the registry, the auth gate and the
// non-blocking drop policy directly. They do NOT prove that admin/index.html
// renders the stream, and they do not stand in for a browser: fetch() +
// ReadableStream behaviour against a live server is verified by opening the
// page, not here.
//
// The drop test is the one that matters. An admin console that can apply
// backpressure to EmitToRooms would be able to stall message fan-out to real
// users, which is a far worse outcome than an admin missing a few lines.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdminSSE_RequiresKey(t *testing.T) {
	h := &Hub{}
	mux := http.NewServeMux()
	RegisterAdminSSE(mux, h)

	// No ADMIN_KEY configured: the surface must be closed, not open.
	t.Setenv("ADMIN_KEY", "")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/admin/events", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no ADMIN_KEY configured: got %d, want 401", rec.Code)
	}

	// Configured, but the caller presents nothing / the wrong key.
	t.Setenv("ADMIN_KEY", "s3cret")
	for _, key := range []string{"", "wrong", "s3cre", "s3crett"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/admin/events", nil)
		if key != "" {
			req.Header.Set("x-admin-key", key)
		}
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("key %q: got %d, want 401", key, rec.Code)
		}
	}
}

func TestAdminSSE_PublishReachesSubscriber(t *testing.T) {
	h := &Hub{}
	sub := &adminSub{ch: make(chan adminEvent, perSubscriberQueue)}
	h.adminSSE.add(sub)
	defer h.adminSSE.remove(sub)

	if got := h.AdminStreamCount(); got != 1 {
		t.Fatalf("AdminStreamCount = %d, want 1", got)
	}

	h.publishAdmin("admin:event", map[string]any{"event": "new_message"})

	select {
	case ev := <-sub.ch:
		if ev.Event != "admin:event" {
			t.Fatalf("event = %q, want admin:event", ev.Event)
		}
	case <-time.After(time.Second):
		t.Fatal("published event never reached the subscriber")
	}
}

func TestAdminSSE_SlowSubscriberDropsAndNeverBlocks(t *testing.T) {
	h := &Hub{}
	// Attached but never drained — the wedged-admin-browser case.
	sub := &adminSub{ch: make(chan adminEvent, perSubscriberQueue)}
	h.adminSSE.add(sub)
	defer h.adminSSE.remove(sub)

	done := make(chan struct{})
	go func() {
		// Far more than the queue depth. If publish blocked on a full queue this
		// would never return, and in production that stall would be inside
		// EmitToRooms — i.e. holding up fan-out to real users.
		for i := 0; i < perSubscriberQueue*10; i++ {
			h.publishAdmin("admin:event", i)
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("publish blocked on a full subscriber queue — admin backpressure reached the emit path")
	}

	if got := sub.dropped.Load(); got == 0 {
		t.Fatal("expected drops once the queue filled, got 0")
	}
	if got := len(sub.ch); got != perSubscriberQueue {
		t.Fatalf("queue length = %d, want it capped at %d", got, perSubscriberQueue)
	}
}

func TestAdminSSE_RemovedSubscriberStopsReceiving(t *testing.T) {
	h := &Hub{}
	sub := &adminSub{ch: make(chan adminEvent, 4)}
	h.adminSSE.add(sub)
	h.adminSSE.remove(sub)

	if got := h.AdminStreamCount(); got != 0 {
		t.Fatalf("AdminStreamCount after remove = %d, want 0", got)
	}
	h.publishAdmin("admin:event", "after-disconnect")
	if got := len(sub.ch); got != 0 {
		t.Fatalf("a removed subscriber received %d events, want 0", got)
	}
}

func TestAdminSSE_StreamsHeadersAndEvent(t *testing.T) {
	t.Setenv("ADMIN_KEY", "s3cret")
	h := &Hub{}
	mux := http.NewServeMux()
	RegisterAdminSSE(mux, h)

	srv := httptest.NewServer(mux)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/admin/events", nil)
	req.Header.Set("x-admin-key", "s3cret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
	// Proxy buffering turns a live tail into nothing-then-everything.
	if nb := resp.Header.Get("X-Accel-Buffering"); nb != "no" {
		t.Fatalf("X-Accel-Buffering = %q, want no", nb)
	}

	// Wait for the handler to register before publishing, otherwise the event is
	// fanned out to nobody and this races.
	deadline := time.Now().Add(2 * time.Second)
	for h.AdminStreamCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.AdminStreamCount() == 0 {
		t.Fatal("handler never registered a subscriber")
	}
	h.publishAdmin("admin:event", map[string]any{"event": "new_message"})

	buf := make([]byte, 512)
	_ = resp.Body.(interface{ Close() error })
	n, err := resp.Body.Read(buf)
	if err != nil && n == 0 {
		t.Fatalf("read: %v", err)
	}
	got := string(buf[:n])
	// The ": connected" preamble may arrive in the same or an earlier read; what
	// must be true is that the stream is SSE-framed.
	if !strings.Contains(got, ":") {
		t.Fatalf("stream did not look like SSE: %q", got)
	}
}
