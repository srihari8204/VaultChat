# Scale-out (Phase 2) — running go-api on more than one node

Phase 2 removes the single-node ceiling documented in `internal/realtime/server.go`
(pre-P2: "No Redis adapter … fan-out is in-process"). It is delivered in three
independently rollback-able pieces.

## What changed

| Piece | What | Where | Flag / rollback |
|---|---|---|---|
| P2.1 | Socket.IO **Redis adapter** — room emits reach sockets on every replica (same pub/sub wire format as Node's `@socket.io/redis-adapter`) | `server.go` (`SetAdapter`) | `REDIS_ADAPTER=1`; unset → in-memory adapter, pre-P2 behavior |
| P2.1 | **Presence, OnlineCount, call rosters in Redis** (`vc:pres:*`, `vc:call:*`) with node heartbeats + a dead-node janitor | `cluster.go`, `presence.go`, `handlers.go` | same flag; Redis down ⇒ automatic fallback to local maps |
| P2.2 | **Chat-membership cache** (`vc:members:<chatId>`, 30 s TTL, invalidated on every membership mutation) — removes the per-message `vc_chat_member_ids` query | `delivery.go`, `routes/chats*.go` | cache is fail-open; Redis down ⇒ direct DB query |
| P2.2 | **Bounded worker pool** for presence flips, unread bumps, pushes (was: unbounded `go` per event) | `internal/workx`, call sites | `WORKX_WORKERS` / `WORKX_QUEUE` envs; saturation runs tasks inline (backpressure) and logs |
| P2.3 | **PgBouncer** (transaction pooling) in front of Postgres; pgx `default_query_exec_mode=exec`; `WithUser` now uses parameterized `set_config(..., true)` (no string-built SET LOCAL) | `docker-compose.yml`, `internal/db/db.go` | `DB_HOST=postgres DB_PORT=5432` for direct; `DB_QUERY_EXEC_MODE=cache_statement` restores pgx statement caching on direct connections |

## Canary procedure (per PERF_IMPROVEMENT_PLAN.md)

1. Baseline single node, flag off (current prod shape). Nothing changes.
2. Set `REDIS_ADAPTER=1` on the existing single node. Behavior must be
   identical (adapter + Redis presence active, one node). Soak.
3. Add a second `go-api` replica behind Caddy (both pointed at the same
   Redis/PgBouncer). Verify cross-node: two test users on different replicas —
   presence visible both ways, 1:1 call rings, group-call roster fills,
   message fan-out arrives, typing indicators cross.
4. Scale further as load requires. Rollback at any step = scale to 1 replica
   and/or unset the flag.

## Redis keys (all fail-open)

```
vc:node:hb:<node>   node heartbeat (EX 15, refreshed every 5 s)
vc:nodes            set of known node ids (janitor work-list)
vc:pres:<uid>       hash: node → local socket count
vc:pres:online      set of globally-online uids (OnlineCount = SCARD)
vc:roster:<node>    uids tracked by a node (crash sweep)
vc:call:<chatId>    call-room roster (EX 6 h, cleared on leave/disconnect)
vc:members:<chatId> chat membership cache (EX 30 s, DEL on mutation)
vc:janitor:lock / vc:cvsweep:lock   single-runner locks
```

A node's presence fields are only trusted while its heartbeat exists, so a
crashed replica's users stop counting as online within ~15 s; the janitor
(60 s, lock-guarded) then flips them offline in Postgres and sweeps the keys.

## Known limitation — games are node-local

The mini-games platform (`games.go`: `gamePlayers`/`gameRooms`/`gameQueue`)
still keeps state in process memory. Under >1 replica, matchmaking only pairs
users connected to the same node, and a game room is only playable on the node
that created it. Options until game state moves to Redis: (a) accept it —
games are ephemeral and best-effort; (b) route `/socket.io` with sticky
sessions so a user's devices land on one node; (c) keep 1 replica if games
matter more than scale. Messaging, presence, calls, and VaultBeam signaling
are all fully cluster-correct — this caveat is games-only.

## Operational notes

- `redisx.Connect()` must precede `realtime.New()` in `main.go` (it does).
- PgBouncer is transaction-pooling: session-level `SET`/`LISTEN` must not be
  introduced in routes. `WithUser` is safe (txn-scoped `set_config`).
- `workx.InlineRuns()` > 0 growing fast means the side-work pool is
  saturated — raise `WORKX_WORKERS`, or look for a stalled DB.
- The Kafka `EVENT_BUS` path stays off; revisit at the scale where async
  fan-out through a log (not just a worker pool) pays for its ops burden.
