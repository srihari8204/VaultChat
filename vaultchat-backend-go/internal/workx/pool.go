// Package workx — a small bounded worker pool for fire-and-forget side work
// (presence flips, unread bumps, push sends). Replaces raw `go fn()` spawns on
// hot paths (P2.2): an unbounded spawn per message/reconnect lets a burst
// create tens of thousands of goroutines, each potentially holding a DB pool
// connection. The pool caps concurrency and queues the overflow; when even the
// queue is full the task runs INLINE on the caller (backpressure — the caller
// slows down instead of the node melting), so no task is ever silently dropped.
package workx

import (
	"log"
	"os"
	"runtime"
	"strconv"
	"sync/atomic"
)

var (
	queue   chan func()
	dropped atomic.Int64 // tasks that had to run inline (saturation indicator)
)

func init() {
	workers := runtime.NumCPU() * 4
	if v, err := strconv.Atoi(os.Getenv("WORKX_WORKERS")); err == nil && v > 0 {
		workers = v
	}
	depth := workers * 64
	if v, err := strconv.Atoi(os.Getenv("WORKX_QUEUE")); err == nil && v > 0 {
		depth = v
	}
	queue = make(chan func(), depth)
	for i := 0; i < workers; i++ {
		go func() {
			for fn := range queue {
				run(fn)
			}
		}()
	}
}

func run(fn func()) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[workx] task panic: %v", r)
		}
	}()
	fn()
}

// Submit runs fn on the pool. If the queue is saturated the task runs inline —
// callers must treat Submit like a possibly-blocking call for pathological
// bursts (that inline slowdown IS the backpressure).
func Submit(fn func()) {
	select {
	case queue <- fn:
	default:
		n := dropped.Add(1)
		if n%1000 == 1 {
			log.Printf("[workx] queue saturated (%d inline runs) — raise WORKX_WORKERS/WORKX_QUEUE or investigate a stall", n)
		}
		run(fn)
	}
}

// InlineRuns reports how many tasks ran inline due to saturation (metrics).
func InlineRuns() int64 { return dropped.Load() }
