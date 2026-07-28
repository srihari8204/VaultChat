# Phase 2 Step 0 — Node backend load report (gate decision)

Date: 2026-07-26. Bench: docker-compose stack (postgres 16, redis 7, api
container in **prod shape** — in-process fan-out, no Kafka, no Redis adapter,
Sentry off; see `docker-compose.bench.yml`) on a Windows Docker Desktop VM
(11.6 GB RAM slice). Client drivers on the same machine (adds client-side CPU
to every number — real servers measure BETTER than this).

Prod reference hardware is a 12-core / 62 GB Hetzner box; this bench is a
strictly weaker environment, so treat every number below as a LOWER bound.

## Acceptance targets (the repo's own 10K-user launch bar)

From `loadtest/http.k6.js` + `loadtest/sockets.js` headers:

| target | requirement |
|---|---|
| `/health` | p95 < 100 ms @ 200 VUs |
| `/chats` (authed) | p95 < 400 ms @ 100 VUs |
| error rate | < 1% |
| concurrent idle sockets | 5,000–7,000 held |

## Results

### HTTP (`node loadtest/http.js`)

| test | result | target | verdict |
|---|---|---|---|
| `/health` @ 200 VUs × 60 s | 12,000 req, 0 errors, p50 10 ms / p95 33 ms / p99 42 ms | p95 < 100 ms | **PASS (3× headroom)** |
| `/chats` @ 100 VUs × 60 s | 6,000 req, 0 errors, p50 11 ms / p95 33 ms / p99 52 ms | p95 < 400 ms | **PASS (12× headroom)** |

### Message fan-out (`node loadtest/fanout.js`, 50-member group, REST send path)

Worst-case shape: EVERY message lands in a 50-member group (50 socket
deliveries per message). Real traffic is dominated by 1:1 (2 deliveries).

| send rate | deliveries/s | delivery p50/p95/p99 | POST p95 | errors | api CPU/mem |
|---|---|---|---|---|---|
| 10 msg/s | 501/s | 23 / 60 / 70 ms | 42 ms | 0 | 0% · 81 MiB |
| 25 msg/s | 1,251/s | 17 / 55 / 62 ms | 41 ms | 0 | 0% · 97 MiB |
| 50 msg/s | 2,501/s | 21 / 54 / 64 ms | 46 ms | 0 | 6% · 101 MiB |
| 60 msg/s | 3,001/s (100.0%) | 25 / 129 / 615 ms | 115 ms p95 | 0 | ~112 MiB |
| 75 msg/s | ~2,950/s (82% in window) | 3.4 s / 10.5 s / 11.2 s | 6.0 s p95 | 0 | 49% · 129 MiB |
| 85–100 msg/s | collapse (queueing) | 8–15 s p50 | 9–10 s | 12–64% send errors | recovers after |

**Knee:** the single Node process sustains **~3,000 socket deliveries/s**
(100% delivery, p95 129 ms at 3,001/s); clean sub-70 ms p99 up to 2,500/s.
Past the knee, degradation is queueing (latency grows, sends time out) — not
crashes; the process recovered after every overload stage.

### Idle socket capacity (`node loadtest/sockets.js --count 5000`)

- **5,000/5,000 connected, 0 failures, 0 drops**, held 5 minutes, clean drain.
- api container: ~202 MiB total with 5,000 sockets vs ~85–100 MiB baseline →
  **~20 KB per idle socket**; steady-state CPU 0.09–0.14 core (heartbeats).
- Extrapolation: the 7,000-socket upper target ≈ 240 MiB; even 50,000 idle
  sockets ≈ 1.1 GB — noise on a 62 GB box. Target **PASS**.

## Capacity vs the 10K-user launch

- Realistic peak for 10K users: a few percent concurrently active, mostly 1:1
  messages → **low hundreds of deliveries/s**. Measured clean capacity is
  **2,500+/s on worst-case group traffic** → ≥ 10× headroom on this weak bench
  alone, more on the prod box.
- Both HTTP targets pass with 3–12× latency headroom and zero errors.
- Already-built scale levers, unused in this bench: `REDIS_ADAPTER=1` +
  `EVENT_BUS=kafka` + the fan-out worker let delivery fan-out scale
  horizontally across processes with ZERO rewrite (the compose staging stack
  already runs this shape).

## Gate decision

Per the Phase 2 task's own rule — "If Node clears the target with headroom,
STOP and recommend deferring Phase 2 to Phase 3":

**Node clears every target with substantial headroom. RECOMMENDATION: defer
the Go migration.** The measured bottleneck (single-process fan-out knee at
~3,000 deliveries/s) sits ~10× above realistic 10K-user launch load, and the
existing Redis-adapter + Kafka fan-out path multiplies it horizontally without
any rewrite. A 10.7k-LOC / 176-endpoint / 75-socket-event rewrite is not
justified by these numbers.

Revisit the gate when ANY of these trips:
- sustained deliveries/s approaching ~1,500 (half the single-process knee)
  on prod metrics, with the Kafka fan-out path already enabled;
- idle sockets approaching the measured ceiling on the prod box;
- p99 delivery latency creeping past 250 ms at steady state.

## What Step 0 delivered (kept, regardless of the decision)

- `contract/inventory.js` + frozen `endpoints.json` (176 endpoints) +
  `socket-events.json` (38 client→server, 37 server→client) — source-drift
  guard; the checklist for any future migration.
- `contract/run.js` — 46 behavioral checks (deep messaging-core + realtime +
  auth fixtures, per-module smokes) runnable against ANY backend via
  `BASE_URL` swap. Green against Node.
- `loadtest/seed.js` (bench dataset + JWT minting), `loadtest/http.js`,
  `loadtest/fanout.js` (delivery-latency measurement), extended
  `loadtest/sockets.js` usage, `docker-compose.bench.yml` (prod-shaped api).
- npm scripts: `test:contract`, `bench:seed`, `bench:http`, `bench:fanout`,
  `bench:sockets`.

Repro: `docker compose -f docker-compose.yml -f docker-compose.bench.yml up
-d --build api` → `node migrate.js up` + `npm run bench:seed` (env: DB on
127.0.0.1:15432) → `npm run test:contract` / `bench:http` / `bench:fanout` /
`bench:sockets`.
