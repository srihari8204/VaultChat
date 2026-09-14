# VaultChat — Performance Baseline (§19)

> # NO BASELINE HAS BEEN MEASURED YET.
>
> **Every results table in this document is empty, and stays empty until
> somebody runs the harness.** No figure below is a measurement of the Go
> backend. Nothing here was estimated, extrapolated, or carried over from
> another system and relabelled.
>
> The author of this document could not measure anything: Docker Desktop does
> not start on the authoring machine and there was no production access. So
> what was built is not a number — it is **one command that produces the first
> number**, with enough preconditions that it refuses to produce a wrong one.

---

## 0. What already exists, and why it is not a baseline

Two things in this repository look like performance data and are not.

**`vaultchat-backend/loadtest/REPORT.md` (2026-07-26)** is a real, careful
measurement — **of the Node backend**, on a Windows Docker Desktop VM. The Go
rewrite happened after it. Not one of its numbers describes the code that is
live today. It is enormously useful as the *incumbent* to be compared against
(§4 uses it for exactly that) and useless as a current baseline.

**`PERF_AUDIT.md`** says so about itself, in its own subtitle: *"Savings
figures are engineering estimates with stated rationale, not measurements."*
It is also partly stale — it describes the realtime server as having "no Redis
adapter", which `internal/realtime/server.go` no longer matches.

So: the Go backend, which serves 100% of live traffic, has never been measured.

---

## 1. The one command

```bash
# From the repo root, on a machine with the stack up.
JWT_SECRET="$(docker compose exec -T go-api sh -lc 'echo $JWT_SECRET')" \
  bash scripts/bench/run.sh
```

That runs every phase in §3, writes a machine-readable `result.json` and a
human `summary.txt` under `scripts/bench/results/<UTC timestamp>/`, and prints
the summary. It aborts with an explicit reason — and **no output at all** — if
any precondition in §2 is unmet.

### Bringing the stack up first

```bash
docker compose -f docker-compose.yml -f docker-compose.bench.yml up -d --build go-api caddy
cd vaultchat-backend && DB_HOST=127.0.0.1 DB_PORT=15432 node migrate.js up && cd ..
```

`docker-compose.bench.yml` is included because it is the file that exists to
pin the bench to prod shape — but read §2.1, because what it pins is no longer
the thing that serves traffic.

### Individual phases

Every phase can be run alone via `BENCH_ONLY`. Each of these still enforces the
full precondition set.

| # | Number you want | Command |
|---|---|---|
| 1 | send→delivered p50/p95/p99 | `BENCH_ONLY=latency bash scripts/bench/run.sh` |
| 2 | connect + handshake p50/p95/p99 | `BENCH_ONLY=connect bash scripts/bench/run.sh` |
| 2 | reconnect storm (deploy case) | `BENCH_ONLY=storm bash scripts/bench/run.sh` |
| 3 | fan-out cost, 50-member group | `BENCH_ONLY=latency bash scripts/bench/run.sh` (same run) |
| 4 | memory + connection ceiling | `BENCH_ONLY=ceiling bash scripts/bench/run.sh` |
| — | HTTP floor (`/health`, `/chats`) | `BENCH_ONLY=http bash scripts/bench/run.sh` |

Knobs (`BENCH_BASE`, `BENCH_RATES`, `BENCH_STAGE_SECS`, `BENCH_CEILING_STEPS`,
`BENCH_STORM_CLIENTS`, …) are documented in the header of
`scripts/bench/run.sh`. Defaults are chosen to match the Node run in
`loadtest/REPORT.md` so the two are comparable.

### Tools used

No dependency was added. The harness uses `socket.io-client`, **already** in
this repo's `package.json`, and `pg` + `jsonwebtoken`, already in
`vaultchat-backend`. No `npx`-fetched load tool and no `docker run` image are
needed; if a future phase needs one, it belongs behind `npx`/`docker run` and
not in `package.json`.

---

## 2. Preconditions — all enforced, all fatal

`scripts/bench/run.sh` checks each of these and **stops** rather than
degrading. The reasoning is uniform: a wrong performance number does not stay
in the terminal. It gets pasted into a capacity decision months later by
somebody who was not in the room.

| Check | Why a failure here would silently corrupt the result |
|---|---|
| `docker`, `docker compose` v2, `node ≥ 18`, `curl` | `fetch` is used throughout |
| repo-root `node_modules/socket.io-client` | absent ⇒ no sockets at all |
| `vaultchat-backend/node_modules` has `pg`, `jsonwebtoken` | needed to seed and mint tokens |
| `JWT_SECRET` set **and** accepted by the server | a mismatched secret rejects every handshake; without this check the run reads as "the server cannot hold sockets" |
| `GET /chats` with a freshly minted bench token returns 200 | the cheap, unambiguous version of the check above |
| stack is up; `$BASE/health` and `$DIRECT/health` answer | — |
| `$DIRECT/internal/metrics` carries `vaultchat_sockets_local` | Caddy 404s `/internal/*` on purpose, so this must be go-api's own port (compose maps `14000:4000`). Without it the ceiling has no server-side memory or socket count, and a client-side-only ceiling is not a ceiling |
| **exactly one** `go-api` container | fan-out cost and socket ceiling are per-process numbers |
| legacy `api`, `fanout-worker`, `kafka` **not** running | production runs none of them; measuring beside them measures a shape that does not exist |
| `REDIS_ADAPTER=1`, `EVENT_BUS` empty on go-api | see §2.1 |
| server holds **zero** sockets before the ceiling phase | a ceiling stacked on unknown existing load compares to nothing |
| zero send errors across the fan-out run | see §2.2 |
| server's own `sockets_local` equals the client's count at each ceiling step | disagreement means sockets are being dropped silently and every later row is fiction |
| `sockets-bench --selftest` passes | the percentile maths is checked before it is trusted |

### 2.1 The shape problem — read this before trusting any output

`docker-compose.bench.yml` exists precisely because measuring the wrong shape
produces numbers that mean nothing. Its own header says so. But it was written
in the Node era, and what it overrides is the **`api`** service
(`REDIS_ADAPTER=0`, `EVENT_BUS=""`).

Today `api` is `profiles: ["legacy"]` and serves nothing. Go owns every route
(`caddy/Caddyfile` → `go-api:4000`) and every socket. So including that
override is correct — it also sets go-api's `ADMIN_KEY` — but **it does not by
itself put go-api into prod shape.**

Production's go-api shape is:

| | production | evidence |
|---|---|---|
| `REDIS_ADAPTER` | `1` | `docs/SECOND_REPLICA_READINESS.md`: *"`REDIS_ADAPTER` is on in production — confirmed"*; `docs/ENV_INVENTORY.md` lists prod `1` |
| `EVENT_BUS` | unset | Go has no Kafka path; in-process fan-out |
| replicas | 1 | single-process |
| Kafka / fanout-worker / Node `api` | not running | `profiles: ["legacy"]` |

That is compose's default for `go-api`, so the default stack is already right —
but the harness **asserts** it and **records what it found** rather than
assuming. `BENCH_ALLOW_SHAPE_DRIFT=1` exists for deliberately measuring the
`REDIS_ADAPTER=0` rollback shape; if you use it, the number must be labelled as
such wherever it is written down.

### 2.2 The rate limiter is part of the system under test

`internal/routes/chats_helpers.go` limits sends to **60 per 10 s per user**
(and 1,200/hour). At R msg/s spread over S senders each sender does `10R/S` per
window, so `S > R/6` or the limiter engages and the run measures HTTP 429s
instead of delivery latency.

The harness therefore **derives** the sender count from the rate rather than
letting anyone pick it, and then **fails the run if any send error occurred at
all**. The limiter is not disabled: it is real production behaviour and a
baseline taken with it off would not describe production.

The hourly cap is not derived around — repeated full runs inside one hour will
eventually trip it. If that happens the run fails loudly; wait or re-seed.

### 2.3 Warmup

The fan-out phase runs a full throwaway stage first (`BENCH_WARMUP_SECS`,
default 15 s), whose output is written to `warmup-discarded.log` and excluded
from every statistic. It exists to absorb Go's first-call paths, connection
pool fill, the 30 s Redis chat-membership cache in `internal/realtime/
delivery.go`, and the Redis adapter's subscription setup.

The connect phase discards its first 20 handshakes; the storm phase discards a
whole first round. **Every reported figure carries its own sample count `n`** —
in `result.json` and in the printed summary.

> Note: `loadtest/fanout.js` has **no internal warmup discard** (its `-5000` is
> a drain correction to the rate denominator, not a sample filter). The warmup
> is supplied by the driver. If you invoke `fanout.js` by hand, you have no
> warmup.

---

## 3. Results — EMPTY, PENDING A RUN

Fill a row only from a `result.json`, and only together with its environment
block (§5). A row without one is not admissible.

### 3.1 Message send → delivered, end to end

The number users feel. Driver: `loadtest/fanout.js` via `run.sh` — REST
`POST /chats/{id}/messages`, timestamp embedded in the body, receiving sockets
stamp arrival; same machine for both ends, so no clock skew.

| send rate | deliveries/s | delivered % | p50 | p95 | p99 | max | n (deliveries) | POST p95 |
|---|---|---|---|---|---|---|---|---|
| 10 msg/s | — | — | — | — | — | — | — | — |
| 25 msg/s | — | — | — | — | — | — | — | — |
| 50 msg/s | — | — | — | — | — | — | — | — |

*A mean is deliberately absent from this table. It is recorded in `result.json`
and should not be quoted: it hides exactly the tail that makes the app feel
broken.*

### 3.2 Socket connect + handshake

Measured from the `io()` call to the `connect` event: TCP + WebSocket upgrade +
the JWT auth middleware in `internal/realtime/server.go`. Transport is
websocket-only, matching `lib/socket.ts`.

| | p50 | p95 | p99 | max | n |
|---|---|---|---|---|---|
| sequential (server not under connect pressure) | — | — | — | — | — |

#### Reconnect storm — what happens after every deploy

| clients | connected | failed | handshake p50 | p95 | p99 | wall time until all back | n |
|---|---|---|---|---|---|---|---|
| 500 | — | — | — | — | — | — | — |

> **Fidelity limit, stated so the number is read correctly.** These clients
> reconnect against a server that is already warm. A real deploy also restarts
> the process, so its first seconds additionally include Go's cold start and
> cold per-socket permission caches. Treat the measured figure as a **lower
> bound** on deploy recovery. `cmd/api/main.go` has a `SHUTDOWN_DRAIN_DELAY` +
> hub-drain path that a warm-client storm does not exercise; measuring that
> properly means restarting the container mid-run, which this harness does not
> do.

### 3.3 Fan-out cost in a large group

Same run as §3.1. Worst-case shape: every message lands in a 50-member group,
so one send is 50 socket deliveries. Real traffic is dominated by 1:1
(2 deliveries), so this is a ceiling on cost, not a typical case.

| group size | send rate | deliveries/s | delivered % | delivery p95 | p99 | server heap | n |
|---|---|---|---|---|---|---|---|
| 50 | 10 msg/s | — | — | — | — | — | — |
| 50 | 25 msg/s | — | — | — | — | — | — |
| 50 | 50 msg/s | — | — | — | — | — | — |

To find the knee rather than confirm a rate, extend upward:
`BENCH_RATES=10,25,50,75,100 bash scripts/bench/run.sh`.

### 3.4 Memory and connection ceiling

Ramps idle sockets in steps, reading the **server's own**
`/internal/metrics` at each step (`vaultchat_heap_alloc_bytes`,
`vaultchat_goroutines`, `vaultchat_sockets_local`) rather than guessing from
the client.

| sockets held | heap alloc | bytes/socket | goroutines | handshake p95 during ramp | failures |
|---|---|---|---|---|---|
| 250 | — | — | — | — | — |
| 500 | — | — | — | — | — |
| 1,000 | — | — | — | — | — |
| 2,500 | — | — | — | — | — |
| 5,000 | — | — | — | — | — |

**Stopped because:** _(pending)_

The ramp stops at the first connect failure, the first client/server socket
count disagreement, or when a step's handshake p95 exceeds
`--degrade-factor` (default 5) × the **first step's** p95. That factor is a
*stopping heuristic so the ramp does not run forever*, deliberately relative to
this host — **not** a target and not evidence of anything. The real
degradation point is whatever the table shows.

---

## 4. Target and abort thresholds

Each threshold below is either traced to evidence in this repository, or
explicitly left unset. Nothing here is a round number picked because it
sounded reasonable.

### 4.1 Justified from the repo's own stated bar

| metric | target | abort | justification |
|---|---|---|---|
| send→delivered **p99**, steady state | < 250 ms | ≥ 250 ms sustained | `loadtest/REPORT.md` sets its own revisit trigger at *"p99 delivery latency creeping past 250 ms at steady state"*. That was written as the Node gate; it is the only delivery-latency threshold this project has ever committed to |
| send error rate | 0 | > 0 in a bench run | the launch bar is `< 1%` (`loadtest/http.k6.js` via `REPORT.md`), but **in a controlled bench** any send error means the limiter or the harness is wrong, so the harness treats non-zero as fatal rather than as a result |
| `/health` p95 @ 200 VUs | < 100 ms | ≥ 100 ms | the repo's own 10K-launch acceptance target, `loadtest/http.k6.js` |
| `/chats` p95 @ 100 VUs | < 400 ms | ≥ 400 ms | same source |
| idle sockets held, one process | ≥ 7,000 | < 5,000 | the stated 10K-user-launch requirement is *"~5–7K idle WS at peak"* (`loadtest/sockets.js` header). 5,000 is the floor of that stated range |

### 4.2 Regression bars against the measured Node incumbent

These are not targets for Go in the abstract. They are the bar the rewrite has
to clear to have been worth doing. All come from `loadtest/REPORT.md`
(2026-07-26, Node, Docker Desktop VM, 50-member group). **The Go run must be
performed on the same class of host for the comparison to hold** — see §5.

| metric | Node measured | Go must be | why this is the bar |
|---|---|---|---|
| delivery p95 @ 10 msg/s into a 50-group | 60 ms | ≤ 60 ms | Go slower than the backend it replaced on the hottest path undermines the migration's own premise |
| delivery p99 @ 10 msg/s | 70 ms | ≤ 70 ms | same |
| clean capacity (sub-70 ms p99) | 2,500 deliveries/s | ≥ 2,500/s | same |
| knee (100% delivery) | ~3,000 deliveries/s | ≥ 3,000/s | same |
| heap per idle socket | ~20 KB | ≤ 20 KB | a Go process using more memory per socket than Node would be a specific, findable regression |
| 5,000 idle sockets | 0 failures, 0 drops, 5 min | 0 failures | same |

**Abort signal:** Go measurably worse than Node on *any* row of §4.2, on
comparable hardware, is a finding that must be written up before it is
explained away.

### 4.3 To be set from the first baseline

No evidence in this repository supports a number for these. Inventing one would
be worse than leaving it blank, because a blank gets filled and a guess gets
quoted.

| metric | threshold |
|---|---|
| socket connect + handshake p50 / p95 / p99 | **to be set from the first baseline** |
| reconnect-storm wall time until all clients reconnected | **to be set from the first baseline** |
| reconnect-storm handshake p99 vs the sequential p99 (the degradation factor under connect pressure) | **to be set from the first baseline** |
| goroutines per socket | **to be set from the first baseline** |
| absolute socket ceiling on prod hardware | **to be set from the first baseline** — the §4.1 row is a *launch requirement*, not a measured ceiling |
| p99 for 1:1 chats specifically (2 deliveries, the dominant real shape) | **to be set from the first baseline** — the harness currently measures the 50-member worst case only |

One storm threshold *is* justifiable now, without a measurement: **any connect
failure during a storm at a client count at or below the measured idle ceiling
is an abort**, regardless of latency. A deploy reconnects everybody at once; a
failure there means users are dark after every deploy.

---

## 5. The environment that must be recorded with every number

**A latency number without its environment is not a baseline, it is an
anecdote.** `run.sh` captures all of this automatically into
`results/<stamp>/environment.txt` and `result.json`, and the printed summary
repeats the critical lines. Reproduce them wherever a figure is quoted.

Captured automatically:

- `host` — `uname -a`
- `docker version`, `docker info` (full JSON: CPU count, total memory, storage driver, whether this is a Docker Desktop VM)
- `docker compose ps --format json` — exactly which services were running
- go-api image id/tag
- **shape**: `REDIS_ADAPTER`, `EVENT_BUS`, go-api replica count, read from the running container (not from the compose file)
- `base` — **through Caddy (`:18080`) or go-api direct (`:14000`)**. These are different measurements; the proxy's contribution is the difference between them
- `git_rev` and `git_dirty` (file count) — a number from a dirty tree names nothing
- node version
- UTC timestamp

Record by hand alongside the result, because the harness cannot see it:

- **CPU model and core count, and RAM** of the host — `docker info` gives the
  slice, not the silicon
- whether the load driver ran **on the same machine as the server**. It does by
  default, which adds client-side CPU to every number; the Node run in
  `REPORT.md` had the same property and called its results a lower bound
- **prod shape or not** — if `BENCH_ALLOW_SHAPE_DRIFT=1` was used, say so in the
  same sentence as the number
- host network conditions if the driver was remote
- seed size (`BENCH_USERS`, `BENCH_MEMBERS`) and how long the bench database had
  been accumulating rows — `messages` is one unpartitioned heap
  (`PERF_AUDIT.md` §1.8), so a database with millions of bench rows is a
  different system from a fresh one

### Reference hardware, for calibration

`loadtest/REPORT.md` records production as a **12-core / 62 GB Hetzner box**,
and its own bench as a **Windows Docker Desktop VM with an 11.6 GB slice** —
strictly weaker, so it treated every number as a lower bound. A Go run on a
laptop is comparable to the Node run in §4.2 and **not** comparable to
production. Say which you did.

---

## 6. Known gaps in this harness

Listed because an unlisted gap becomes a false claim of coverage.

- **It has never been executed.** Docker Desktop does not start on the
  authoring machine and there was no production access. The scripts are
  syntax-checked and the percentile maths is unit-checked
  (`node scripts/bench/sockets-bench.js --selftest`); the measurement paths
  have not been run against a live server even once. Expect to fix something on
  the first attempt.
- The storm phase does **not** restart the server (§3.2 fidelity limit).
- Only the 50-member group is measured. 1:1 — the dominant real shape — is not.
- Push notification delivery, media upload/download, and call/SFU paths are out
  of scope; `loadtest/sfu-load.sh` exists separately for the last of those.
- `loadtest/fanout.js` writes `vaultchat-backend/loadtest/fanout-results.json`,
  overwriting the stale Node-era artifact there. `run.sh` copies the fresh file
  into its own timestamped result directory, so a later run of that tool by
  hand cannot rewrite recorded history.
- `fanout.js`'s `apiMemory()` greps `docker stats` for a container name
  containing `api`, which now matches `go-api`. The authoritative memory figure
  is the one the ceiling phase reads from `/internal/metrics`.
- Client and server share a CPU by default. For a number that describes the
  server rather than the pair, run the driver from a second machine with
  `BENCH_BASE` pointed at the first, and record that you did.

---

## 7. Recording a run

1. Run §1. It writes `scripts/bench/results/<UTC stamp>/`.
2. Copy `summary.txt` figures into the tables in §3 — **with** the
   environment line the summary prints.
3. Commit `result.json` if the run is to be a reference point. Runs are
   comparable only when §5 matches.
4. If any §4.1 or §4.2 threshold is missed, that is the finding. Write it down
   before explaining it.
5. Fill in §4.3 from the first run, and note which run it came from.
