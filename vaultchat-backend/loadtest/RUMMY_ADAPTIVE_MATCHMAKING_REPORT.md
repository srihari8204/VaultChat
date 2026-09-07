# Adaptive rank-based Rummy matchmaking — engineering report

**Scope:** LOCAL only (`vaultchat-games-integration`). Smallest safe change; no architecture rewrite. Production never touched.

## Changed

Adaptive change (3 files):
- `internal/realtime/matchmaker.go` — `Matchmaker.Pair` gains a `maxDiff` tolerance param; `localMatchmaker.Pair` gates the nearest waiter by it and removes **both** players atomically on success.
- `internal/realtime/redismatchmaker.go` — `redisMatchmaker.Pair` passes `maxDiff` to the Lua script; the script gates the match by tolerance and `ZREM`s both players (a 3-line Lua change — same ZSET, same nearest-rating selection).
- `internal/realtime/live.go` — `LiveService.Queue` now runs a **widening schedule** (`mmWiden`) via the *existing* bot-fallback timer; new helpers `tryMatch` / `scheduleWidenLocked`.

(The `rooms.go`/`tables.go`/`ws.go`/`live.go OnMatchRoom` in the same working tree are the **prior P0 room-identity fix**, unchanged and preserved.)

Tests added: `adaptivematch_test.go` (Tests A–G). `rummymatch_test.go` (P0) retained.

## Matchmaking behavior

`Pair` still selects the **nearest-rating** waiter — but only accepts it if within the caller's current tolerance `maxDiff` (`maxDiff <= 0` = accept anyone). A fresh player is matched only to a **close** rank; there is no exact-rank requirement (close ranks match immediately), and the closest eligible candidate is always preferred over a farther one. Removing both players atomically in `Pair` is what makes two synchronized widening retries safe — the first takes both out, the second finds nothing, so a pair can never form twice.

## Wait-time behavior

Rank tolerance widens over time using the **existing** wait mechanism (the bot-fallback timer — extended, not duplicated). Schedule (ELO points; `BaseRating = 1200`):

| Elapsed | Accepted rank gap |
|---|---|
| 0 s (on queue) | ≤ 40 |
| ~1.5 s | ≤ 120 |
| ~3.0 s | ≤ 300 |
| ~4.5 s | ≤ 700 |
| ~6.0 s | **any** waiting opponent |
| ~9.0 s | bot fallback (original timing preserved) |

So a player prefers a near rank first and progressively accepts wider gaps the longer they wait, avoiding an indefinite wait for an exact rank.

## Player count

**Unchanged — no new product rule invented.** The matchmaker still pairs exactly **2 players** (`MatchEvent{A,B}`), which is what the existing code supports; a matchmade room's capacity is exactly the seated count. Only the *rank selection* became adaptive. Whether matchmade rummy should be 4/6-player remains the previously-flagged product decision — **not touched here**.

## Security

Preserved intact — the adaptive change touches only rank tolerance and timing, never authorization:
- Matchmaker `roomId == actual Rummy roomId` (Test F, and 10/100-user runtime: 0 practice, 0 wrong-room).
- Match A never resolves to Match B (Test G).
- Unknown room IDs still rejected; `matchAuth` membership still enforced (P0 tests pass).
- Rank never became a security boundary — it only affects *who is offered* a match, not *who may join a room*.

## Tests

Unit (local matchmaker) — `go test ./internal/realtime/ -run Adaptive`: **all 7 PASS**
- A exact rank (1200/1200) → match · B close rank (1200/1205) → immediate match · C widening (diff 100) → matches at 1.54 s after widening · D prefers closer (B diff 1 over C diff 60) · E wait-time widening (diff 90 matches only after ≥1 s, proving the window deferred it) · F room identity (requested == actual, ≠ practice) · G isolation (two matches → two distinct rooms).

Runtime (live **redis-backed** server) — `mm-accept.js`:
- 10 users → 10 matched, 5 rooms, joinedOwnRoom 10, landedPractice 0, wrong-room 0, **invariant true**, 2,595 gameplay actions.
- 100 users → 100 matched, 51 rooms, joinedOwnRoom 100, landedPractice 0, wrong-room 0, **invariant true**, 4,872 gameplay actions.

## Regression

- Full `internal/realtime` suite: **ok** (35.9 s) — all pre-existing tests + P0 room-identity tests pass.
- Whole module `go test ./...`: **0 failures**.
- Race detector: **not run** — this Windows box has no C compiler (`go -race` needs cgo). Locking discipline preserved (`Pair` removes both players under one lock; timers use the existing `l.botTimers` slot and the existing lock-then-unlock-before-publish pattern).

## Not changed (intentionally left untouched, per instruction §12)

- `/live/ws` O(N²) connection cost — documented earlier, **not** touched.
- Global live-matchmaking mutex architecture — reused as-is; no new locks.
- Redis `maxmemory = 0` — **not** touched.
- Multi-node matchmaking / cross-node room state — **not** touched.
- Matchmaking latency root-cause / 5k–100k scale — **not** touched.
- Rummy engine, WebSocket protocol, auth, table presets, frontend — **not** touched.

## Runtime note (honest)

Adaptive *widening* is proven by the unit tests on the local matchmaker. The **redis** matchmaker uses the identical tolerance gate (verified matching live at 10/100 users) and the identical shared widening driver in `LiveService.Queue`, so it inherits the behavior — but multi-rating widening *timing* was not separately measured on the redis path, because dev launch-token players all start at `BaseRating` (no runtime rating setter). Documented, not faked.

## Final status

**READY** — for adaptive rank matchmaking specifically: exact rank no longer required, closest preferred, tolerance widens with wait time, and the P0 room-identity/security guarantees are intact (unit + 10/100-user runtime verified, zero regression).

This is **not** a claim of 5k–100k scale readiness — those scalability items were intentionally left untouched and remain open.

## Artifacts
Code in `vaultchat-games-integration/go-server/internal/realtime/` (working tree, uncommitted for review). Drivers: `mm-accept.js`, `mm-probe.js`. Container rebuilt from source and verified live.
