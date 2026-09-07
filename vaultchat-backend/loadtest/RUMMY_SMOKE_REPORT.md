# Rummy load-test — smoke report

**Date:** 2026-09-07 · **Bench:** local Docker Desktop (Windows laptop, ~7.6 GB VM slice), load generator + server on the **same box** · **Requested tiers:** 5k / 10k / 30k / 50k / 100k users.

---

## Read this first — what was and was NOT tested

| | |
|---|---|
| ✅ **Tested** | VaultChat's **own backend** (`go-api`) on the local bench, endpoint `/health`, which does a **real Postgres `Ping` + Redis `Ping` per request** (`cmd/api/main.go:58–59`). So this exercises the full path: network → HTTP router → Postgres → Redis. Not a static string. |
| ❌ **NOT tested — the rummy game engine** | The authoritative rummy server is a **separate Go service** (`/ws` handler in `vaultchat-games-integration/go-server`). A local copy exists on this machine but was found in a **crash loop** — its own Postgres container was down (`lookup postgres … no such host`), so it served nothing. I did **not** repair it (it looks like another in-progress workstream). |
| ❌ **NOT tested — the front end** | The front end is a React Native mobile app. "100k users on the front end" isn't a runnable operation — you scale the *server*, and per-device app performance is a separate device-testing question. |
| ❌ **NOT tested — production** | Nothing was fired at `games.corefinite.com`. Hammering it would be a DoS on live users. |

**Every number below is a LOWER BOUND.** One laptop hosts both the load generator and the server, and Docker Desktop caps the VM. Prod is a 12-core / 62 GB Hetzner box and will measure materially better.

---

## Method

Closed-loop ramp: hold *N* requests continuously in flight for 15 s per tier, measure achieved throughput and latency. `docker stats` sampled across the run. Driver: `loadtest/rummy-smoke.js` (committed alongside this report). HTTP keep-alive on, so Windows ephemeral-port exhaustion is not the limiter — the *server* is.

---

## Results — `go-api /health`, single bench instance

| Concurrency | Throughput (req/s) | p50 | p95 | p99 | Errors |
|---:|---:|---:|---:|---:|---:|
| 50 | **1,800** | 23 ms | 59 ms | 96 ms | 0 % |
| 200 | 1,840 | 100 ms | 181 ms | 283 ms | 0 % |
| 500 | 1,777 | 269 ms | 423 ms | 653 ms | 0 % |
| 1,000 | 1,605 | 576 ms | 1,037 ms | 1,178 ms | 0 % |
| 2,000 | 1,470 | 1,143 ms | 2,034 ms | 3,379 ms | 0.69 % |
| 4,000 | 1,287 | 2,300 ms | 7,379 ms | 7,832 ms | 1.61 % |

**Peak container CPU under load:** go-api **332 %** (~3.3 cores — the first bottleneck), Postgres **140 %**, Redis ~49 %, pgbouncer ~84 %. **Memory stayed tiny throughout** (go-api ~100 MiB, Postgres ~126 MiB) — this workload is **CPU-bound, not memory-bound**.

### What the curve says

- **Throughput ceiling ≈ 1,800 req/s** on this bench. It's reached by concurrency 50 and then *flat, then declining* — adding concurrency past the knee only adds queue latency, and past 2,000 it tips into **congestion collapse** (RPS falls 1,800 → 1,287, errors appear).
- **Healthy operating point: concurrency ≈ 50** — p95 under 60 ms, zero errors. That's the edge you'd want to run at.
- **No crashes, no memory growth, no error cliff** until concurrency 2,000+, and even there it degrades gracefully (0.7 % → 1.6 % timeouts), not a fall-over.

---

## Mapping to your 5k / 10k / 30k / 50k / 100k tiers

"Users" ≠ concurrent in-flight requests. A rummy player is turn-based and mostly *listening* on a WebSocket, not polling. So the ceiling (~1,800 req/s on the bench) translates very differently depending on how often each user actually hits HTTP:

| Per-user HTTP rate | Users this **bench** holds at the ceiling | Users a **12-core prod box** likely holds¹ |
|---|---:|---:|
| 1 req/s (aggressive polling) | ~1,800 | ~6,500 |
| 0.1 req/s (a call every 10 s) | ~18,000 | ~65,000 |
| 0.033 req/s (every 30 s — realistic rummy cadence) | ~54,000 | ~195,000 |

¹ Scaled by CPU headroom (12 cores vs the ~3.3 the bench gave go-api) and treated as a single instance; the memory note that "prod measures better than this bench" makes these conservative. Horizontal scaling multiplies further.

**Against these numbers, your tiers land like this on the *HTTP control-plane*:**

- **5k, 10k, 30k, 50k** users — comfortably within reach on prod at any realistic rummy request cadence (≤0.1 req/s), single instance.
- **100k** users — reachable on prod at realistic cadence (~0.033 req/s ≈ 195k headroom), but the honest answer is **it needs the real WebSocket test below**, not this one, because at 100k the binding constraint is *persistent connections and per-table fan-out*, which `/health` does not exercise at all.

---

## The gap this report can't close

Rummy's real load is **WebSocket**, not request/response: ~100k *persistent* connections, low message rate, memory-per-connection, and server→client fan-out to every seat at a table. That's a different capacity question (connection count and fan-out, not req/s) and the HTTP ceiling above tells you nothing about it.

**The good news:** the engine to test it is already on this machine. It's one healthy `docker compose up` away — its only problem right now is a missing Postgres in its own stack. Once it's up, the real test is: mint dev launch tokens (`/dev/launch-token` exists in dev mode) → open *N* `/ws` connections → seat them at rummy tables → measure connection ceiling, join latency, and per-table broadcast latency at 5k → 100k.

**Say the word and I'll bring that stack up and run the true rummy-engine WS test** — that's the one that actually answers your question. I held off only because the stack looks like another in-progress workstream and I won't restart someone else's containers without a nod.

---

## Artifacts

- `loadtest/rummy-smoke.js` — the driver
- `loadtest/rummy-smoke-results.json` — raw per-tier numbers
- `loadtest/stats-samples.txt` — `docker stats` timeline
