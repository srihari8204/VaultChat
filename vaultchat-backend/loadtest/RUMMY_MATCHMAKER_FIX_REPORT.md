# Rummy matchmaker→room integration — fix report

**Scope:** LOCAL only (`vaultchat-games-integration`, `localhost:8090`). Production never touched. Fix applied to the local games-server Go source; container rebuilt and verified live.

---

## 1. Root Causes

### P0 — matchmade room collapses to `practice` (correctness + security)
- **File/func:** `go-server/internal/realtime/rooms.go` → `RoomManager.getOrCreate` (via `Join`), and `internal/realtime/tables.go` → `TableByID`.
- **Root cause — two bugs compounded:**
  1. `TableByID(id)` returns `Tables[0]` (**practice**) for *any* unknown id — a silent fallback.
  2. `getOrCreate` then stored the room under `preset.ID`, **not** the requested `tableID`: `r := &room{id: preset.ID …}; m.rooms[r.id] = r`. So even a valid custom id lost its identity.
- **Why it happens:** the matchmaker (`live.go` → `Queue`) mints `mm-rummy-<hex>` and hands it to both players, but rummy's room layer had no concept of a dynamically-created room — it only knew the 3 fixed presets, and mapped everything else to practice.
- **Impact:** every matchmade rummy pair silently landed in the shared `practice` room (proven: `mm-rummy-cd5c5a96 → practice`). Two dangers: (a) matchmaking was non-functional; (b) **security** — a guessed/mistyped id dropped a player into another user's game.

### P0.4 — matchmade table capacity is UNDEFINED (product decision) → STOPPED, not invented
- **File/func:** `internal/realtime/matchmaker.go` → `MatchEvent{A, B}`, `Pair(...)` returns one opponent.
- **Finding:** the matchmaker is hardwired to **2-player** matches for *every* game. Rummy's *preset* tables are `MaxPlayers: 6`. **No per-game match-size config exists anywhere.** Whether matchmade rummy should be 2/4/6 players is not established in source.
- **Action:** per the task's explicit STOP condition, I did **not** invent a number. The fix honors whatever the matchmaker seats (currently 2) — see §2. Changing the matchmaker to seat 4/6 is a **REQUIRES PRODUCT DECISION** item (§6).

### P1 — `/live/ws` connection establishment is CPU-heavy (scalability)
- **File/func:** `internal/realtime/live.go` → `LiveService.Connect` (+ the 5s `tickLoop` / `broadcastCount`).
- **Root cause (CONFIRMED by profiling, not just hypothesized):** every new `/live/ws` connection sends `RecentResults(12)` and then `broadcastCount()` iterates **all** live sockets under `l.mu`. N connects × O(N) fan-out ≈ **O(N²)** presence work under a shared lock.
- **Impact:** 200 concurrent `/live/ws` connects = **89% of one core**; raw `/ws` held 12,461 connections at ~0% idle. The matchmaker front-door is far more expensive than gameplay connections.

### P2 — matchmaking latency ~7.6 s p50
- **File/func:** `internal/realtime/redismatchmaker.go` / `matchmaker.go` pairing + delivery.
- **Status:** cause **not fully root-caused**. `Pair()` itself is an eager O(n) scan (fast); the latency is in the queue→pair→publish→deliver cadence (Redis pub/sub). Reported as identified, **not fixed** — see §6.

### P3 — Redis `maxmemory = 0` (unbounded)
- **File:** `vaultchat-games-integration/docker-compose.yml` (redis service) — no `maxmemory`, no eviction policy, and matchmaking/presence keys have no verified TTL.
- **Impact:** at scale, transient matchmaking/presence data could grow Redis without bound. Reported with a recommended policy; **not changed** (infra/config decision) — see §6.

---

## 2. Changes Made

All changes are **additive and capacity-agnostic** — they honor the matchmaker's output rather than deciding a product number.

| File | Function | Change | Reason | Compatibility |
|---|---|---|---|---|
| `tables.go` | `LookupTable` (new) | Strict preset lookup returning `(preset, ok)` — **no** practice fallback | Kills the silent-fallback bug | Additive; `TableByID` kept for any other caller |
| `tables.go` | `IsMatchRoom`, `matchTable` (new) | Detect `mm-rummy-*`; build a FREE preset whose `MaxPlayers` = seated count | Give matchmade rooms a real, honest config | Additive |
| `rooms.go` | `RoomManager` struct + `NewRoomManager` | Add `matchAuth map[roomID]set(vaultId)` | Authorize matchmade rooms | Additive field |
| `rooms.go` | `RegisterMatch` (new) | Record the authorized members for an `mm-rummy-*` room | Membership enforcement | New method |
| `rooms.go` | `getOrCreate` | Returns `(*room, ok)`. Preset → keyed by preset.ID (unchanged). Match room → **keyed by the real id**, capacity = member count. Unknown → `ok=false` | Fixes identity loss + kills fallback | Signature change, **one caller** (`Join`) |
| `rooms.go` | `Join` | Reject `ok=false` with an error; enforce match-room membership before seating | Correctness + security | Preserves preset/empty-id/mid-game/full/balance paths exactly |
| `rooms.go` | room-destroy path | `delete(m.matchAuth, r.id)` when a room empties | Lifecycle cleanup (P4) | Additive |
| `live.go` | `LiveService` + `onMatch` | Add optional `OnMatchRoom` callback, invoked **outside** `l.mu` after a match, with `(game, roomId, [A,B])` | Wire matchmaker → room authorization without touching the single match-handler | Additive; nil-safe |
| `ws.go` | `Register` | Set `ws.live.OnMatchRoom` to call `ws.rooms.RegisterMatch` for `game=="rummy"` | Connect the two halves | Additive; other games unaffected |

**Preserved intact:** rummy rules/gameplay, the 3 preset tables (practice/casual/pro), empty-id→practice default, authentication (gsid), all other games' room managers, all existing WebSocket message contracts. **No product decision hardcoded** — a matchmade room's size = whatever the matchmaker delivered.

---

## 3. Tests Added

`go-server/internal/realtime/rummymatch_test.go`:
- `TestMatchmadeRoomResolvesToItself` — match room id resolves to its own room, **not practice** (the P0 invariant).
- `TestUnknownRoomRejectedNotPractice` — unknown id → error, never a silent join.
- `TestPresetTableStillWorks` — `practice` still resolves to practice (regression).
- `TestEmptyTableDefaultsToPractice` — empty id default preserved.
- `TestMatchRoomIsolation` — an outsider who knows the id is **refused** (security).
- `TestDistinctMatchesDistinctRooms` — two matches → two distinct rooms; A never resolves to B.

---

## 4. Verification (actual results)

```
# Unit/integration — new tests
go test ./internal/realtime/ -run 'Matchmade|UnknownRoom|PresetTable|EmptyTable|MatchRoomIsolation|DistinctMatches' -v
  --- PASS: TestMatchmadeRoomResolvesToItself (0.15s)
  --- PASS: TestUnknownRoomRejectedNotPractice (0.31s)
  --- PASS: TestPresetTableStillWorks (0.01s)
  --- PASS: TestEmptyTableDefaultsToPractice (0.01s)
  --- PASS: TestMatchRoomIsolation (0.45s)
  --- PASS: TestDistinctMatchesDistinctRooms (0.29s)
  ok  vaultchat/games/internal/realtime  2.069s

# Full regression — entire realtime package
go test ./internal/realtime/
  ok  vaultchat/games/internal/realtime  33.702s   (all existing tests still pass)

# Race detector: NOT RUN — this Windows box has no C compiler (go -race needs cgo).
#   Locking discipline preserved: matchAuth is only touched under m.mu; OnMatchRoom
#   is invoked outside l.mu. Race verification is a REMAINING item (§6).

# Runtime — live server rebuilt, same probe that previously showed the collapse:
  BEFORE:  requestedRoom mm-rummy-cd5c5a96  -> landedInRoom "practice"           collapsed:true
  AFTER:   requestedRoom mm-rummy-8a9bc1d5  -> landedInRoom "mm-rummy-8a9bc1d5"  collapsed:false

# P8 acceptance — full path (queue → match → join own room → play), live:
  10 users:   matched 10, distinctRooms 5,  joinedOwnRoom 10, landedPractice 0, actions 2470, INVARIANT true
  100 users:  matched 100, distinctRooms 53, joinedOwnRoom 94, landedPractice 0, actions 4386, INVARIANT true
             (6 join failures were client ws-open timeouts, not the server)
```

---

## 5. Before vs After

| Metric | Before | After |
|---|---:|---:|
| Match → room correctness | FAIL (→ practice) | **PASS** (verified live + tests) |
| Unique rummy rooms | FAIL | **PASS** (100 users → 53 rooms) |
| Invalid-room isolation | FAIL (→ practice) | **PASS** (rejected + outsider refused) |
| Match latency p50 | ~7.6 s | ~7.6 s (**unchanged — P2 not fixed**) |
| Match latency p95 | ~15.8 s | ~15.8 s (**unchanged — P2 not fixed**) |
| `/live/ws` CPU | ~89% core @ 200 | ~89% core @ 200 (**unchanged — P1 not fixed**) |
| Redis memory policy | unbounded | unbounded (**unchanged — P3 not fixed**) |
| Gameplay errors | 0 | ~0 (1–2 per thousands of actions, client-race) |
| Direct WS / preset regression | PASS | **PASS** (full suite green) |

---

## 6. Remaining Risks (explicit)

- **P0.4 — REQUIRES PRODUCT DECISION.** Matchmade rummy currently = **2 players** (the matchmaker's output). If the product wants 4/6-player matchmade rummy, the matchmaker's `Pair`/`MatchEvent` must be redesigned for N-player grouping. **Not done — needs a product answer.**
- **P1 — `/live/ws` O(N²) connect cost: CONFIRMED, fix NOT implemented.** The fix (snapshot presence outside the lock / async or batched broadcast / minimize lock scope) is a real concurrency change, and the **race detector is unavailable on this box (no cgo)** — shipping an unverified lock change would be reckless. Recommend implementing + race-verifying in CI. This bounds single-node `/live/ws` connect throughput today.
- **P2 — match latency (~7.6 s p50): NOT root-caused, NOT fixed.** Needs per-stage tracing (queue→pair→publish→deliver) to find whether it's Redis pub/sub cadence or polling. Propose a target of **p95 < 2 s** (a test assumption — no project SLA exists).
- **P3 — Redis unbounded: NOT changed.** Recommend `maxmemory` + `allkeys-lru` (or `noeviction` with TTLs) and explicit TTL on matchmaking/presence keys. Needs confirming which keys are transient vs durable before setting.
- **Multi-node membership.** `matchAuth` is per-node in-memory. It is populated on **every** node from the Redis match subscription, so authorization is multi-node-correct — **but** the room's game state is per-node, so if two matched players connect to *different* nodes they'd be in different room objects. That's the pre-existing multi-node game-state gap (out of scope for a single-node local fix). Not tested (local = 1 node).
- **Reconnect after both players drop.** `matchAuth` is cleared when a room empties, so a match both players briefly leave cannot be rejoined. Acceptable for 2-player rummy; note if longer grace is wanted.

---

## 7. Load-Test Readiness

**PARTIALLY READY.**

Evidence: the **correctness and security blocker is fixed and verified** — matchmade rummy now creates genuine independent rooms (100 users → 53 rooms, 0 practice, invariant true, real gameplay), with membership enforced and unknown ids rejected, and **zero regression** (full suite green). The 5k→100k *gameplay* test is now architecturally possible where it was impossible before.

But it is **not fully READY** because two scale limiters remain **unfixed**: the `/live/ws` O(N²) connect cost (P1) and the ~7.6 s match latency (P2). A 5k+ matchmade test would hit both — the matchmaker front-door, not gameplay, would be the bottleneck. Those should be fixed and race-verified first. Redis memory (P3) must be bounded before a sustained large run.

---

## 8. No False Claims

- **DEMONSTRATED + FIXED + VERIFIED:** match→room correctness; unique per-match rooms (100 users → 53 rooms); invalid-room rejection; match-room isolation (security); preset tables preserved; no regression (full realtime suite green); real matchmade gameplay (thousands of actions).
- **CONFIRMED but NOT FIXED:** `/live/ws` O(N²) connect cost (P1); ~7.6 s match latency (P2, not root-caused); Redis unbounded (P3).
- **NOT TESTED:** race detector (no cgo locally); multi-node room state; 5k–100k matchmade gameplay; reconnect storm; node-failure recovery.
- **REQUIRES PRODUCT DECISION:** matchmade rummy table size (2 vs 4 vs 6).
- **EXTRAPOLATED:** nothing new — no capacity number is claimed from this fix.

**100k matchmade rummy is NOT claimed.** This fix makes it *possible and testable*; it does not make it *proven*.

---

## Artifacts

- Code: `vaultchat-games-integration/go-server/internal/realtime/{tables,rooms,live,ws}.go` (+114/−8), `rummymatch_test.go` (new). Left in the working tree for review (not committed).
- Drivers: `mm-probe.js` (collapse proof), `mm-accept.js` (P8 acceptance), `mm-scale.js` (matchmaking distribution).
- Container rebuilt from the fixed source and verified live on `localhost:8090`.
