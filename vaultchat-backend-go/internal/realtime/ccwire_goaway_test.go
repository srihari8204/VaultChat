package realtime

import (
	"errors"
	"testing"
	"time"

	"vaultchat/backend-go/internal/ccwire"
)

// GoAway existed on paper and on the client, and nowhere on the server.
//
// BodyGoAway (21) has been in the codec tables of all three implementations
// since the contract was written, and lib/ccwire/client.ts has always handled
// it: `case BODY.go_away` calls down('transport', ...), which is its RECONNECT
// path rather than its give-up path. Go had the constant and no sender, so a
// deploy or a SIGTERM reached the client as an abrupt socket close - which is
// indistinguishable from a network fault and draws the backoff meant for one.
// Every restart therefore cost the fleet a reconnect penalty it had not earned.
//
// Hub.Shutdown already called io.DisconnectSockets for Socket.IO clients.
// CC-Wire sessions are not Socket.IO sockets and live in their own registry
// (h.cwSessions), so nothing reached them at all.

func goAwayFields(t *testing.T, f *fakeConn) map[uint32][]pbVal {
	t.Helper()
	m := f.last(t)
	if m.BodyField != ccwire.BodyGoAway {
		t.Fatalf("expected body field %d (go_away), got %d", ccwire.BodyGoAway, m.BodyField)
	}
	return pbFields(t, m.Body)
}

func TestGoAwayIsActuallySent(t *testing.T) {
	s, f := newSession("u1", nil)

	if !s.sendGoAway(errInternal, 7500) {
		t.Fatal("sendGoAway reported failure on a writable session")
	}
	if m := f.last(t); m.TrafficClass != ccwire.TrafficClassControl {
		t.Fatalf("go_away must ride the control traffic class, got %d", m.TrafficClass)
	}
	goAwayFields(t, f) // asserts the body field
}

// drain_deadline_ms must carry the REAL remaining budget. A client told 10s and
// then cut off at 2s learns to ignore the field, which is worse than omitting it.
func TestGoAwayCarriesTheRealDrainDeadline(t *testing.T) {
	s, f := newSession("u1", nil)
	if !s.sendGoAway(errInternal, 4321) {
		t.Fatal("sendGoAway failed")
	}
	fields := goAwayFields(t, f)
	if len(fields[3]) == 0 {
		t.Fatal("drain_deadline_ms (field 3) missing")
	}
	if got := fields[3][0].num; got != 4321 {
		t.Fatalf("drain_deadline_ms = %d, want 4321", got)
	}
	if len(fields[1]) == 0 {
		t.Fatal("reason (field 1) missing")
	}
}

// last_accepted (2) and resume_token (4) are PROMISES: "everything up to here is
// durable" and "hand this back and I will restore your state". This server
// advertises no resumption capability and keeps no resume state, so emitting
// either would invite a client to skip a cold sync it genuinely needs.
func TestGoAwayPromisesNothingItCannotKeep(t *testing.T) {
	s, f := newSession("u1", nil)
	if !s.sendGoAway(errInternal, 1000) {
		t.Fatal("sendGoAway failed")
	}
	fields := goAwayFields(t, f)
	for _, field := range []uint32{2, 4} {
		if len(fields[field]) != 0 {
			t.Fatalf("go_away carries field %d, but this server supports neither "+
				"durable-cursor reporting nor resumption; a client would act on it", field)
		}
	}
}

// The whole point: a shutdown must reach CC-Wire sessions, which are invisible
// to io.DisconnectSockets.
func TestShutdownTellsCCWireSessionsToGoAway(t *testing.T) {
	h := &Hub{}
	s, f := registered(t, h, "u1")
	s.done = make(chan struct{})

	h.ccwireShutdown(3 * time.Second)

	if len(f.out) == 0 {
		t.Fatal("shutdown closed the CC-Wire session without sending go_away - the " +
			"client sees an abrupt close and backs off as if the network had failed")
	}
	// The advertised deadline must be one the server ACTUALLY honours, not the
	// caller's whole budget: Hub.Shutdown still has to close the Socket.IO server
	// inside the same window, and a client told 3000 then cut off at 0 learns to
	// ignore the field entirely.
	fields := goAwayFields(t, f)
	got := fields[3][0].num
	if got == 0 {
		t.Fatal("drain deadline advertised as 0 while the server does wait - either " +
			"honour a grace or advertise none")
	}
	if got > 3000 {
		t.Fatalf("advertised a %dms drain inside a 3000ms shutdown budget - the "+
			"server cannot keep that promise", got)
	}
	if !s.closed {
		t.Fatal("the session was not closed after the go_away")
	}
}

// Runs during SIGTERM, where a panic loses the whole graceful drain.
func TestShutdownIsSafeWithNoCCWireSessions(t *testing.T) {
	(&Hub{}).ccwireShutdown(time.Second)
	var h *Hub
	h.ccwireShutdown(time.Second)
}

// A peer that is already gone must not hold up everyone else's drain.
func TestShutdownContinuesPastAFailingWrite(t *testing.T) {
	h := &Hub{}
	bad, _ := registered(t, h, "u1")
	bad.w = func([]byte) error { return errors.New("peer gone") }
	bad.done = make(chan struct{})
	good, gf := registered(t, h, "u2")
	good.done = make(chan struct{})

	h.ccwireShutdown(time.Second)

	if len(gf.out) == 0 {
		t.Fatal("a session whose write failed prevented another session from being " +
			"told to go away")
	}
	if !bad.closed || !good.closed {
		t.Fatal("both sessions must be closed regardless of the write outcome")
	}
}

// One wedged peer must not consume the shutdown budget for everyone else.
//
// write() takes the session's write mutex and writeWS sets a 10s deadline, and
// drain() may already hold that mutex on a stalled fan-out write - so a serial
// loop cost up to 20s per dead socket BEFORE reaching the next session. The
// earlier version of this file only covered a write that FAILED instantly,
// which is the easy case and not the one that hurts.
func TestShutdownIsNotStalledByAWedgedPeer(t *testing.T) {
	h := &Hub{}
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })

	wedged, _ := registered(t, h, "u1")
	wedged.w = func([]byte) error { <-release; return nil } // blocks until the test ends
	wedged.done = make(chan struct{})
	good, gf := registered(t, h, "u2")
	good.done = make(chan struct{})

	start := time.Now()
	h.ccwireShutdown(2 * time.Second)
	elapsed := time.Since(start)

	if elapsed > 3*time.Second {
		t.Fatalf("shutdown took %s for one wedged peer - it is serialising on the "+
			"blocked write instead of fanning out", elapsed)
	}
	if len(gf.out) == 0 {
		t.Fatal("the healthy session was never told to go away; the wedged peer " +
			"starved it")
	}
	if !good.closed || !wedged.closed {
		t.Fatal("every session must be closed even when one write never returns")
	}
}
