# P1 — `/live/ws` scalability: profile, root cause, fix

**Scope:** LOCAL only (`vaultchat-games-integration`). Profile-first. Production untouched.

## 1. Root cause

**The O(N²) hypothesis is CONFIRMED — but the precise mechanism differs from the guess.**

- ✅ **Actual cause:** `LiveService.broadcastCount()`, called from `Connect()` (and `Queue`/`Disconnect`), fans a `"count"` frame out to **every** live connection on **every** connect/queue/disconnect event. So N users joining ⇒ N events × O(N) sends = **O(N²) WebSocket writes**.
- ❌ **NOT the global mutex.** `broadcastCount` snapshots the connection list under `l.mu` and then sends **outside** the lock (`localConns()` copies, then the loop runs unlocked). No slow operation runs under the global lock. The lock was not the bottleneck.
- ❌ **NOT `RecentResults()`.** It copies at most 12 rows under the store lock — O(1), independent of connection count. Not a factor.

So the earlier "O(N²) via RecentResults + broadcastCount + global mutex" was **half right**: the O(N²) is real and it is `broadcastCount`, but it is a **broadcast fan-out** cost, not lock contention and not `RecentResults`.

## 2. Evidence

Measured with a Go test/benchmark that isolates `Connect()` at a fixed pre-existing population N (`livescale_test.go`, local matchmaker, mock conns):

**Sends triggered per single `Connect()`** (the direct O(N) proof):

| N existing | Before | After |
|---:|---:|---:|
| 100 | **102** | **1** |
| 500 | **502** | **1** |
| 1000 | **1002** | **1** |
| 2000 | **2002** | **1** |

Before = exactly **N+2** (linear per connect ⇒ O(N²) for N connects). After = **1** (constant).

**`Connect()` wall-time** (`go test -bench`, 300×):

| N | Before ns/op | After ns/op | Speedup |
|---:|---:|---:|---:|
| 100 | 112,622 | 4,500 | 25× |
| 500 | 732,767 | 3,033 | 242× |
| 1000 | 1,906,922 | 3,459 | 551× |
| 2000 | 6,798,709 | 2,619 | **~2,600×** |

Before scales with N (O(N) per connect). After is **flat** (~2.6–4.5 µs, O(1)).

**Whole-burst sends** (connect N sockets at once):

| N | Before (≈N²/2) | After (measured) |
|---:|---:|---:|
| 2000 | ~2,000,000 | **4,000** (~2N) |

**Runtime docker CPU** (noisy single-snapshots, corroborating only): memory dropped 22.5 MiB → 15.6 MiB; the after-fix N=500 snapshot was idle because the burst cleared before the sample (before-fix it was still churning). *The benchmark, not docker CPU, is the load-bearing evidence.*

## 3. Code changes

**One file: `internal/realtime/live.go`** (P1-specific part):
- Added field `countPending bool` to `LiveService`.
- Added `const countDebounce = 200ms` and method `markCountDirty()` — coalesces the count broadcast: the first caller in a window arms a single flush, the rest are no-ops; the flush runs `broadcastCount()` once.
- Replaced the 3 `l.broadcastCount()` call sites (`Connect`, `Queue`, `Disconnect`) with `l.markCountDirty()`.

Why: the count fan-out is the O(N²) work. Coalescing a burst into one broadcast makes it **O(N) per window** instead of **O(N) per event**, so N connects cost O(N) total sends, not O(N²). The `"count"` protocol message is unchanged — clients still receive it, coalesced within ≤200 ms. `broadcastCount` still snapshots under the lock and sends outside it; the immediate per-socket `"live"` frame on connect is untouched (a joining user still gets their state instantly).

Nothing else changed: matchmaker, Redis Lua, `matchAuth`, `TableByID`, room identity, adaptive rank, presets, auth, protocol — all untouched.

## 4. Functional verification

Runtime, live redis-backed server, post-fix (`mm-accept.js`):

| | 10 users | 100 users |
|---|---|---|
| matched | 10 | 100 |
| distinct rooms | 5 | 50 |
| joined own room | 10 | 100 |
| landed practice | **0** | **0** |
| wrong room | **0** | **0** |
| `requestedRoomID == actualRoomID` | **TRUE** | **TRUE** |
| gameplay actions | 2,205 | 3,743 |

Adaptive tests A–G: **PASS**. Security isolation (`matchAuth`, cross-room): **preserved** (P0/adaptive tests green). All CRITICAL INVARIANTS hold.

## 5. Performance verification

| Users (N) | Before (per-connect) | After (per-connect) | Note |
|---:|---:|---:|---|
| 100 | 112.6 µs / 102 sends | 4.5 µs / 1 send | O(N) → O(1) |
| 500 | 732.8 µs / 502 sends | 3.0 µs / 1 send | |
| 1000 | 1.91 ms / 1002 sends | 3.5 µs / 1 send | |
| 2000 | 6.80 ms / 2002 sends | 2.6 µs / 1 send | ~2,600× |

Connection latency/matchmaking latency: unchanged by this fix (it only removes redundant broadcast work); matchmaking latency (P2) is a separate, untouched item.

## 6. Race detector

**NOT RUN — reason: this Windows machine has no C compiler; `go test -race` requires cgo (`CGO_ENABLED=1` + gcc), and gcc is not installed.** The change adds one bool guarded by the existing `l.mu` and one `time.AfterFunc`; the flush clears the flag under `l.mu`, unlocks, then calls `broadcastCount` (which locks only to snapshot, sends unlocked) — same locking discipline as the existing code. Recommend running `-race` in CI where cgo is available.

## 7. Remaining risks (unresolved, intentionally out of scope)

- Redis `maxmemory = 0` — untouched.
- Multi-node matchmaking / cross-node room state — untouched.
- Matchmaking latency (~7.6 s p50, P2) — untouched.
- Higher-scale (5k–100k) live testing — **NOT TESTED** here; the fix is proven O(1)-per-connect by benchmark up to N=2000, higher is **PROJECTED** not demonstrated.
- Race detector — not runnable locally (above).

## 8. Files changed

- Modified: `go-server/internal/realtime/live.go` (P1 fix).
- New: `go-server/internal/realtime/livescale_test.go` (evidence test + benchmark + burst-coalescing test).
- (Also in the working tree from prior tasks, unchanged by P1: `matchmaker.go`, `redismatchmaker.go`, `rooms.go`, `tables.go`, `ws.go`, `adaptivematch_test.go`, `rummymatch_test.go`.)

## 9. Git state

**Dirty / uncommitted.** 6 modified files (P0 + adaptive from prior tasks + this P1 live.go change) and 3 new test files. **Not committed** — no commit was requested.

## 10. Final status

**PARTIALLY READY — improvement verified but additional scale testing required.**

The O(N²) connect-storm cost is proven and removed: per-connect work went from O(N) (N+2 sends, up to 6.8 ms at N=2000) to O(1) (1 send, ~2.6 µs), a ~2,600× reduction at N=2000, with zero functional regression and all P0/adaptive invariants intact. This is **DEMONSTRATED up to N=2000** by benchmark and to 100 concurrent users at runtime. It is **not** a 5k–100k readiness claim — that scale, multi-node, Redis memory, and `-race` remain untested/out of scope.
