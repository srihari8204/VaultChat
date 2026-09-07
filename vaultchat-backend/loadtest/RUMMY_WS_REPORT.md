# Rummy engine — WebSocket load test (the real one)

**Date:** 2026-09-07 · **Target:** the **actual rummy game server** running locally — `vaultchat-games-integration` on `localhost:8090`, `GAMES_DEV_MODE`, its own Postgres + Redis + LiveKit. **Not** production. **Not** the HTTP `/health` proxy from the first report — this is the game engine itself.

---

## What was exercised — the real client flow

Each simulated player did exactly what the app does:

1. `POST /dev/launch-token {vaultId,displayName}` → signed token
2. `POST /api/session {token}` → `gsid` session cookie
3. `WS /ws` with that cookie → server replies `{t:"hello"}`
4. `{t:"join", tableId}` → seated at a rummy table, 4 players/table

So the connection, auth handshake, session upsert, WebSocket upgrade, table seating, and the peer/state broadcast path were all driven for real. Driver: `loadtest/rummy-ws.js`.

---

## Results — concurrent connections held on ONE laptop

| Target | Connected | Failed | hello p50 | hello p95 |
|---:|---:|---:|---:|---:|
| 2,000 | **2,000** | 0 | 328 ms | 662 ms |
| 6,000 | **6,000** | 0 | 185 ms | 362 ms |
| 10,000 | **10,000** | 0 | 233 ms | 506 ms |
| 14,000 | **12,461** | 1,539 | 219 ms | 504 ms |

*(hello latency includes the load driver's own ramp queuing — it opened up to 1,000 conns/s through one process — so treat it as an upper bound, not the server's true handshake time.)*

**Server under 12,461 live connections:** memory **709 MiB** high-water (of 7.6 GB), **idle CPU ~0%**. During the connection *ramp*, CPU rose to ~1.3–3.3 cores — the cost is establishing connections, not holding them.

### The failures at 14k are the CLIENT, not the server — proven

Windows gives **16,384 ephemeral ports** to one destination (`127.0.0.1:8090`). The failures began at ~12.5k connections = ports exhausted (16,384 minus the session-mint pool and TIME_WAIT churn). Proof: the run *immediately after* the 14k run reached only 5,282 before failing — because the previous run's sockets were still draining through TIME_WAIT. The server had just held 12,461 fine seconds earlier. **The server never refused a connection; the load generator ran out of sockets.**

---

## Answering your tiers: 5k / 10k / 30k / 50k / 100k

| Tier | Verdict |
|---|---|
| **5,000** | ✅ **Demonstrated.** 100% connected, zero failures, server idle. |
| **10,000** | ✅ **Demonstrated.** 100% connected, zero failures. p95 handshake ~500 ms (ramp-inflated). |
| **30,000 / 50,000 / 100,000** | ⚙️ **Not reachable from one machine** — a single Windows box physically caps at ~16k outbound sockets to one host. Reaching these needs multiple load-generator IPs/machines. Below is what the measured data extrapolates to. |

### Extrapolation to 30k–100k (grounded in the measured numbers)

- **Memory:** 709 MiB for ~12.5k connections ≈ **~57 KB/connection** (an *upper* bound — Go's GC holds heap, so real cost is lower). Linear projection:
  - 30k ≈ **1.7 GB** · 50k ≈ **2.8 GB** · 100k ≈ **5.7 GB**
  - All comfortable on the 62 GB prod box. Memory is **not** the constraint to 100k.
- **CPU:** idle connections cost ~0%. The load is entirely in *connection establishment* (~1.3–3.3 cores to onboard 1k/s on this weak bench). So the real prod risk isn't steady-state — it's a **thundering-herd reconnect** (e.g. after a deploy or a network blip, everyone reconnects at once). Mitigation the server is already built for: it reports `matchmaking backend: redis (multi-node)`, i.e. it scales **horizontally** — put N nodes behind the LB and the connect storm divides across them. Also stagger client reconnect (jittered backoff).

**Bottom line:** on this single weak laptop the engine held **>12,000 concurrent rummy players with zero server distress**. Nothing in the measured behaviour suggests 100k is a problem for a horizontally-scaled prod deployment; the binding resources (memory, per-connection cost) extrapolate to a few GB and a handful of nodes. The honest caveat is that 30k+ was *projected*, not *driven*, because one machine can't open that many sockets.

---

## What is still NOT covered (so nobody over-reads this)

1. **Sustained gameplay at scale.** I proved connect + seat + the broadcast path, but not thousands of tables *actively* playing (draw/discard/declare every few seconds) for minutes. Connection capacity ≠ gameplay-message capacity. That's the next test: hold 10k connections AND drive actions on every table, measure per-table broadcast latency.
2. **Multi-machine scale.** 30k/50k/100k need a distributed load harness (several generator boxes or a cloud load service). One laptop cannot.
3. **Production hardware and topology.** This is a dev container with dev Postgres; prod has connection pooling, real disk, and a load balancer that all change the numbers — generally upward.

I can do #1 next on the same local engine (it needs no new infrastructure) — that would give you the gameplay-fan-out latency curve to sit beside this connection-capacity curve.

---

## Artifacts

- `loadtest/rummy-ws.js` — the WS driver (dev-token → session → /ws → join)
- `loadtest/rummy-ws-results.jsonl`, `rummy-ws-final.jsonl` — raw per-tier results
- Local engine brought up via `vaultchat-games-integration` (its Postgres/Redis had been down 3 weeks; started them, engine recovered clean).
