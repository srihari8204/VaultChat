package emitx

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// EXECUTED, not asserted statically: every accepted fan-out actually runs.
//
// The old code spawned one goroutine per message on context.Background(); the
// fix routes through workx, whose queue is finite. Backpressure there means
// "run it inline on the caller", never "drop it" — because a dropped fan-out is
// a message the API already told the sender it delivered. This fires far more
// sends than the queue depth to prove that.
func TestLocalFanOutNeverDropsAcceptedWork(t *testing.T) {
	const n = 5000
	var wg sync.WaitGroup
	wg.Add(n)
	var mu sync.Mutex
	seen := map[string]int{}

	restore := LocalFanOutChat
	LocalFanOutChat = func(ctx context.Context, chatID, event string, payload any, senderID string) {
		mu.Lock()
		seen[chatID]++
		mu.Unlock()
		wg.Done()
	}
	defer func() { LocalFanOutChat = restore }()

	for i := 0; i < n; i++ {
		ChatNewMessage("c1", map[string]any{"senderId": "u1"})
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		mu.Lock()
		got := seen["c1"]
		mu.Unlock()
		t.Fatalf("only %d/%d fan-outs ran — accepted work was dropped or stalled", got, n)
	}
	if seen["c1"] != n {
		t.Fatalf("ran %d fan-outs, want %d", seen["c1"], n)
	}
}

// EXECUTED: the fan-out context can expire. context.Background() could not, so
// a stalled SysPool query (8 connections) parked a goroutine and a pool slot
// forever.
func TestLocalFanOutContextHasADeadline(t *testing.T) {
	type call struct {
		ctx      context.Context
		event    string
		senderID string
	}
	got := make(chan call, 2)
	restore := LocalFanOutChat
	LocalFanOutChat = func(ctx context.Context, chatID, event string, payload any, senderID string) {
		got <- call{ctx, event, senderID}
	}
	defer func() { LocalFanOutChat = restore }()

	ChatNewMessage("c1", map[string]any{"senderId": "u7"})
	ChatEvent("c1", "message_deleted", map[string]any{})

	for i := 0; i < 2; i++ {
		select {
		case c := <-got:
			dl, ok := c.ctx.Deadline()
			if !ok {
				t.Fatalf("%s fan-out ran on a context with no deadline", c.event)
			}
			if d := time.Until(dl); d <= 0 || d > fanOutTimeout+time.Second {
				t.Fatalf("%s deadline is %v, want ~%v", c.event, d, fanOutTimeout)
			}
			if c.event == "new_message" && c.senderID != "u7" {
				t.Fatalf("senderId lost: %q", c.senderID)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("fan-out never ran")
		}
	}
}

// SUPPLEMENT (static): the behavioural tests above pass just as well with a raw
// `go` spawn, so this pins the mechanism — the point of the fix is the bound,
// and an unbounded spawn is invisible until the node is already melting.
func TestFanOutGoesThroughTheBoundedPool(t *testing.T) {
	src, err := os.ReadFile("emitx.go")
	if err != nil {
		t.Fatal(err)
	}
	stripped := stripLineComments(string(src))
	if strings.Contains(stripped, "go LocalFanOutChat(") {
		t.Fatal("chat fan-out is raw-spawned again — unbounded goroutines against an 8-connection pool")
	}
	if !strings.Contains(stripped, "workx.Submit(") {
		t.Fatal("chat fan-out no longer routes through workx")
	}
	if strings.Contains(stripped, "context.Background(), chatID") {
		t.Fatal("fan-out is back on a context that can never expire")
	}
}

// stripLineComments removes `//` comments so a source assertion tests the code
// rather than the prose describing it. Naive by design (it does not know about
// strings containing "//"), which is safe because it is only ever used to make
// a substring search stricter.
func stripLineComments(src string) string {
	var b strings.Builder
	for _, line := range strings.Split(src, "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}
