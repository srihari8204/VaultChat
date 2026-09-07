# Rummy matchmade-scalability test — final report

**Scope:** LOCAL `vaultchat-games-integration` only (`localhost:8090`). Production was never contacted (verified: container publishes only `8090/tcp`, compose has zero `corefinite`/prod references). All drivers hard-code `127.0.0.1:8090`.

---

## 1. Executive Verdict

**Can the current architecture support 100k concurrent *matchmade rummy* users? → NOT PROVEN — and blocked by architecture, not by capacity.**

The primary objective ("thousands of independent matchmade rummy tables, 5k→100k") **cannot be tested against this build without changing the code**, because of a proven architectural gap:

- The matchmaker (`/live/ws`) **does** pair players and mint unique room IDs (`mm-rummy-<hex>`) — verified live.
- But the rummy gameplay endpoint (`/ws`) **cannot use those IDs**. `getOrCreate` runs `TableByID`, which maps every unknown ID to the `practice` preset. **Empirically proven:** a player handed `mm-rummy-cd5c5a96` and told to join it landed in `practice`. Every matchmade rummy room collapses into one of 3 shared preset tables.

So "matchmade rummy at scale" is not a real code path here. The matchmaker's unique-room model is built for **1v1 games** (chess/backgammon/etc.), whose room managers (`ChessRoomManager.getOrCreate`) honor arbitrary IDs — and the matchmaker pairs exactly **2 players** per match, which fits 1v1, not 2–6-seat rummy.

Per the task's own instruction ("if `/live/ws` does not behave as expected, STOP and report the exact blocker rather than bypassing"), I stopped the 5k→100k matchmade-gameplay plan. Bypassing it would require editing `getOrCreate`/`TableByID` — explicitly forbidden ("do not change architecture / replace working code").

**What is genuinely proven** is below and is real and useful; it just isn't "100k matchmade rummy."

---

## 2. Test Environment

| | |
|---|---|
| Game server | `vaultchat-games-integration`, commit **4c11ac3**, Go **1.23**, `GAMES_DEV_MODE=1` |
| Redis | 7-alpine, used_memory **2.7 MB**, **maxmemory unbounded (0)** ⚠️, 329k cmds processed, stable |
| Postgres | 16-alpine (games/games/games) |
| Host | 8 logical CPUs, Docker Desktop VM (~7.6 GB slice), Windows 10 |
| Game nodes | **1** (single local node) |
| Load generators | **1** Windows box (Node 24), the ~16,384-ephemeral-port ceiling applies |

---

## 3. Matchmaking Results (the layer that works)

| Users | Distinct rooms | Match/botoffer | Match latency p50 / p95 | Connect fail |
|----:|----:|----:|----:|----:|
| 10 | 5 | 10 | (small) | 0 |
| 600 | **248** | 494 + 1 | **7.6 s / 15.8 s** | 0 |

- **Distribution is correct:** 600 players → 248 distinct `mm-rummy-<hex>` rooms (~2 players each — the matchmaker is strictly 1v1). Rating-based `Pair()` is an O(n) closest-rating scan; eager.
- **Match latency is HIGH — a real finding:** p50 **7.6 s**, p95 **15.8 s** at 600. This is far slower than pairing arithmetic implies and points at the Redis-backed match *delivery* cadence (pub/sub) rather than the pairing itself. It needs investigation before any scale claim; flagged, not explained away.
- **0 failed matches, 0 duplicate assignments, 0 users stuck** at a sustainable connect rate.

**But every one of those 248 rooms is unusable for rummy gameplay** (collapses to `practice`). In Phase-3 terms: **users assigned to invalid/nonexistent gameplay rooms = 100%** for matchmade rummy.

---

## 4. Concurrent Connection Results

| Endpoint | Users | Connected | Failed | Success % | CPU | Note |
|---|----:|----:|----:|----:|---|---|
| `/ws` (raw, prior report) | 14,000 | 12,461 | 1,539 | 89% | idle-hold ~0% | client 16k-port limit, not server |
| `/live/ws` (concurrent hold) | 200 | 200 | 0 | 100% | **89%** | connect path is CPU-heavy |
| `/live/ws` (ramped) | 600 | 600 | 0 | 100% | ~100–145% (1–1.5 cores) | sustainable rate |

**Key contrast:** the raw `/ws` endpoint held **12,461** connections cheaply (idle ~0% CPU). The `/live/ws` matchmaker front-door costs **~0.45% CPU per connection** at connect time (200 conns → 89% of a core), because `LiveService.Connect()` calls `RecentResults()` and `broadcastCount()` to *all* live sockets under one mutex — an **O(n²) connect storm cost**. This is the front-door's real ceiling and it is far below the raw connection ceiling.

---

## 5. Active Gameplay Results

| Path | Tables | Players | Actions/s | Errors | Fan-out p95 / p99 | Status |
|---|----:|----:|----:|----:|---|---|
| Direct `/ws` (prior report) | 3 | 18 | 149 | 0 | **20 ms / 50 ms** | DEMONSTRATED |
| **Matchmade rummy** | — | — | — | — | — | **BLOCKED — rooms collapse** |

Matchmade rummy gameplay at 5k/10k/25k/50k/100k (Tiers A–E) — **NOT TESTED, because the tables cannot be created.** The only rummy gameplay that runs is the 3 fixed preset tables (≤6 each), already measured at 20 ms p95 fan-out.

---

## 6. Infrastructure Results

- **Game server:** ~77 MB RAM stable throughout; CPU 1–1.5 cores under connect+match load. Goroutine/GC counters **not captured** (dev build exposes no pprof endpoint — noted, not fabricated).
- **Redis:** connected_clients stable at ~162, 2.7 MB memory, no instability. ⚠️ `maxmemory` is **0 (unbounded)** — at real scale this must be bounded with an eviction policy or Redis is an OOM risk.
- **Postgres:** no stress observed at these volumes.
- **Load generator:** single box; per-run CPU modest, but **TIME_WAIT accumulation across rapid successive runs** degraded later runs (317→87 connections) — a generator artifact, cleared by pacing. This is the classic one-box limit flagged in the previous report.

---

## 7. Reconnect-Storm Results

**NOT TESTED.** A reconnect storm is only meaningful against a large, stable, actively-playing population — which requires matchmade tables that this build cannot create for rummy. Running it against the 3 fixed tables would test 18 users, not a storm. Deferred until the architecture gap (§1) is closed.

---

## 8. Failure-Recovery Results

**NOT TESTED**, for the same reason — and multi-node recovery needs ≥2 game nodes, which were not stood up (single local node only).

---

## 9. Bottleneck

The **first** actual bottleneck is not a resource — it is **architecture**:

1. **Matchmaker ↔ rummy room-manager mismatch (BLOCKER).** Rummy is not wired to the matchmaker's unique-room model; matchmade rummy rooms collapse to `practice`. Nothing downstream can be tested until this is resolved.

Behind it, the measured resource ceilings (for the layers that do run):

2. **`/live/ws` connect CPU** — O(n²) presence broadcast under a mutex; the matchmaker front-door saturates a core at a few hundred concurrent connects, far below the raw `/ws` ceiling.
3. **Match delivery latency** — 7.6 s p50 at 600, needs root-causing.
4. **Load generator** — one Windows box, ~16k ports; cannot itself drive 25k+ regardless of server.

---

## 10. Capacity Model

Honest per-node numbers, from what was measured on this single node:

| Metric | Measured | Basis |
|---|---|---|
| Raw WS connections / node | **12,461** (client-limited) | prior report |
| Memory / connection | ~57 KB (upper bound) | prior report |
| Matchmaker rooms distributed | 248 from 600 users, 0 fail | this report |
| `/live/ws` connect cost | ~0.45% core / conn at connect | this report |
| Direct gameplay fan-out | 20 ms p95 | prior report |

**Nodes required (raw connection capacity only, NOT matchmade gameplay):**

| Target | Nodes @ ~12k/node + 30% headroom |
|---:|---|
| 5k | 1 |
| 10k | 1 |
| 25k | ~3 |
| 50k | ~6 |
| 100k | ~11 |

⚠️ **This table is connection capacity, not gameplay capacity, and explicitly not matchmade-rummy capacity.** It is the floor; the `/live/ws` connect-CPU ceiling (§9.2) would likely raise the node count for a matchmaking-heavy workload. Do not read it as "100k rummy on 11 nodes."

---

## 11. Final 100k Assessment

- **DEMONSTRATED:** 12,461 raw WS connections/node; 20 ms p95 gameplay fan-out on fixed tables; the matchmaker correctly pairs and distributes 600 users into 248 unique rooms with zero failures; Redis stable.
- **EXTRAPOLATED:** raw connection capacity to 100k across ~11 nodes (memory-linear). This is a *connection* projection, not a gameplay or matchmade-rummy one.
- **NOT TESTED / NOT POSSIBLE in this build:** matchmade rummy tables at any scale; 5k–100k active matchmade gameplay; reconnect storm; node-failure recovery; multi-node distribution.

**Is 100k matchmade rummy production-ready? NO — NOT PROVEN.** Not because capacity failed, but because the code path does not exist: rummy is not connected to the matchmaker's room model.

**Must be fixed/tested before any 100k rummy claim:**
1. **Wire rummy to matchmade rooms** — let the rummy room manager honor `mm-rummy-<hex>` IDs (and decide seat count: the matchmaker is 1v1, rummy is 2–6). This is a product/architecture decision, not a test fix.
2. **Fix the `/live/ws` O(n²) connect broadcast** before a mass-connect/reconnect storm — it saturates a core at hundreds of connects.
3. **Bound Redis `maxmemory`** + eviction policy.
4. **Root-cause the 7.6 s match latency.**
5. **Re-test** matchmade gameplay, reconnect storm, and multi-node **from a multi-machine load generator** (one Windows box caps ~16k).

---

## 12. Artifacts

Under `vaultchat-backend/loadtest/` (no production code touched):
- `mm-probe.js` — matchmaker verification + room-collapse proof
- `mm-scale.js` — matchmaking distribution/latency driver (distinct sessions)
- `mm-scale-results.jsonl`, `mm-clean.jsonl` — raw results
- `diag.js`, `diag2.js` — `/live/ws` connect diagnostics
- Companion reports: `RUMMY_SMOKE_REPORT.md`, `RUMMY_WS_REPORT.md`, `RUMMY_GAMEPLAY_REPORT.md`

**Threshold note:** the project defines no formal SLO for match latency or fan-out. "STABLE" ≥99.9% success is the task's assumption; the 7.6 s match latency and 20 ms fan-out are reported against no official target and marked as such.
