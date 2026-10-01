# Second go-api replica — readiness assessment

> **TRANSPORT CITATION IS STALE (noted 2026-10-01).** Parts of this document reason
> from `lib/socket.ts` constructing `ioClient(SERVER_URL, { transports: ['websocket'] })`.
> That code no longer exists: `socket.io-client` is not a dependency, three selftests
> enforce its absence (`lib/socket.transport.selftest.ts:14-15`,
> `lib/nativeDeviceSupport.selftest.ts:41,44,51`), and `selectTransport()` returns
> `ccwire` with no alternative (`lib/socket.ts:108-115`). Any conclusion resting on the
> old citation must be re-derived against CC-Wire before it is relied on.


Investigated 2026-09-13 against the live box (`root@65.21.229.167`), read-only.
Closes the evidence gap behind architecture-review finding **P1-04** ("one of
everything") and step 3 of `vaultchat-backend-go/SCALEOUT.md`.

This document does not make the change. It establishes what would break, so the
change is ten minutes of configuration later instead of a live debugging session.

---

## Verdict: **READY WITH TWO CHANGES**

Nothing found is a blocker. The realtime layer is genuinely cluster-correct and
`REDIS_ADAPTER=1` is already on in production, so the hard part is done. Two
things must change before the second replica is started:

| # | Change | Why |
|---|---|---|
| **C1** | Caddyfile: `reverse_proxy go-api:4000` → a `dynamic a` upstream block | A static upstream is **one** upstream to Caddy. With two container IPs behind the name, Caddy's load balancing, passive health checks and retries are all inert — a dead replica is not routed around. |
| **C2** | Put a single-runner lock around the ShopBook hourly job | `sbSendDailySummaries` / `sbSendWeeklyReminders` dedupe with SELECT-NOT-EXISTS-then-INSERT and no lock. Two replicas started by the same `up -d` tick within milliseconds of each other, which is exactly the race window. Users get duplicate notifications and duplicate pushes. |

And one thing that must **not** change:

| **C3** | Do **not** restore a host `ports:` mapping on `go-api` | It is the only thing that would hard-block `--scale go-api=2`, and it is currently absent. See §3 and the LiveKit-webhook footgun in §7. |

Sticky sessions — the failure the finding was most worried about — are a
**non-issue**. Both ends are pinned to websocket-only. Detail in §1.

---

## 1. Sticky sessions — NOT REQUIRED

**Client** — `lib/socket.ts`, inside `connect()`:

```ts
const s = ioClient(SERVER_URL, {
  // Task 2: websocket-only (no polling fallback — intentional launch
  // decision), aggressive-but-jittered reconnect for fast network recovery.
  transports: ['websocket'],
```

It is the only `ioClient(...)` construction in the app, and there is no
`upgrade` / `transports` override anywhere else.

**Server** — `vaultchat-backend-go/internal/realtime/server.go`, `New()`:

```go
opts := socket.DefaultServerOptions()
// The client is websocket-only (server.js relies on the default upgrade but
// the RN client never long-polls); pin the transport to skip HTTP polling.
opts.SetTransports(types.NewSet("websocket"))
```

So polling is refused on both ends. There is no multi-request handshake to keep
on one node: the connection is a single HTTP GET that upgrades in place and then
lives on one TCP socket for its lifetime. A round-robin proxy cannot split it.

**Conclusion: no `ip_hash`, no `lb_policy cookie`, no sticky sessions.** Plain
`least_conn` is correct and is what §7 configures.

> Honest caveat: this holds only while the client stays websocket-only. If a
> future build ever removes `transports: ['websocket']` to get a polling
> fallback through a hostile network, sticky sessions become mandatory *at the
> same moment*, and the symptom will be "the app randomly fails to connect" with
> nothing in the app itself changed. That coupling is worth a comment at both
> sites.

---

## 2. Caddy — the one real configuration change

Current terminal block in `/home/srihari/vaultchat/caddy/Caddyfile`:

```
	# ── everything else → Go ─────────────────────────────────────────
	handle {
		reverse_proxy go-api:4000
	}
```

Chain in front of it, verified on the box:

```
nginx :443 (api.corefinite.com)  →  127.0.0.1:8095  →  caddy :80  →  go-api:4000
```

`vaultchat-caddy-1` is `caddy:2-alpine`, **v2.11.4**. Its resolver is Docker's
embedded DNS (`nameserver 127.0.0.11` in the container's `/etc/resolv.conf`),
and `go-api` today resolves to the single container IP `172.20.0.6`.

### What actually happens if you scale without touching this

Not a hard failure — which is worse, because it looks like it works.

`reverse_proxy go-api:4000` registers **one** upstream whose address is a
hostname. Caddy does not expand it. The name is resolved by Go's dialer at
connection time, so with two A records Docker's embedded DNS (which rotates
record order per query) will in practice spread new connections across both
containers. What you do **not** get:

- **No health awareness.** Caddy's upstream pool has one entry, so passive
  health checks, `fail_duration`, `max_fails`, `lb_retries` and every
  `lb_policy` have nothing to choose between and are effectively disabled. Kill
  one replica and roughly half of new connections go to it until Docker DNS
  drops the record. This is precisely the redundancy the finding is asking for,
  and it is the part a static upstream silently does not give you.
- **No control over distribution.** You get whatever the resolver's ordering
  plus Go's Happy-Eyeballs fallback produces, not a policy you chose.

### The correct block

`caddy list-modules` on the running container confirms
`http.reverse_proxy.upstreams.a` is present, so `dynamic a` is available in this
build.

```
	# ── everything else → Go ─────────────────────────────────────────
	handle {
		reverse_proxy {
			# Docker DNS returns one A record per running go-api container, so
			# `docker compose up -d --scale go-api=N` is the entire scaling
			# control surface — no Caddyfile edit per replica.
			#
			# `resolvers 127.0.0.11` is Docker's embedded DNS, stated explicitly
			# rather than inherited: the container's resolv.conf already points
			# there, but a dynamic upstream that silently falls back to the host
			# resolver returns NXDOMAIN for a service name and 502s everything.
			dynamic a {
				name      go-api
				port      4000
				refresh   10s
				resolvers 127.0.0.11
			}

			# PASSIVE health checks only. Caddy's docs are explicit that
			# "active health checks do not run for dynamic upstreams" — a
			# health_uri block here would be accepted and never execute, which
			# is the kind of config that reads as safe and is not. fail_duration
			# is what actually takes a dead replica out of rotation.
			lb_policy        least_conn
			lb_retries       2
			fail_duration    10s
			max_fails        3
			unhealthy_status 5xx

			transport http {
				dial_timeout 5s
			}
		}
	}
```

`least_conn` rather than `round_robin` because these are long-lived websockets,
not requests: after a replica restart, round-robin hands the two nodes equal
*new* connections while one already holds every old one, and the imbalance never
heals. `least_conn` drains toward even.

`refresh 10s` rather than the 1m default so a scale-up or a replaced container
enters rotation within one Socket.IO reconnect backoff rather than a minute.

No read/write timeout is set: Socket.IO pings every 10s
(`server.go: SetPingInterval(10 * time.Second)`), so a live websocket is never
actually idle and Caddy's defaults do not cut it off.

> Honest caveat: `refresh`, `least_conn` and `fail_duration` are judgement, not
> measurement. I could not test the DNS behaviour with two records live because
> starting a second replica is exactly the change this document exists to
> prepare. The `dynamic a` syntax, the module's presence in v2.11.4, and the
> active-health-check restriction are verified; the tuning numbers are starting
> points.

---

## 3. Compose — nothing blocks `--scale`

The running stack is composed from three files (read off the container's own
`com.docker.compose.project.config_files` label, not assumed):

```
/home/srihari/vaultchat/docker-compose.yml
/home/srihari/vaultchat/docker-compose.prod.yml
/home/srihari/vaultchat/docker-compose.box.yml
```

The two things that break `--scale`:

| Blocker | Present? | Evidence |
|---|---|---|
| `container_name:` on `go-api` | **No** | Not in any of the three files. The running container is `vaultchat-go-api-1` — compose's own `<project>-<service>-<n>` naming, which is what a scalable service looks like. |
| Host `ports:` mapping on `go-api` | **No** | `docker-compose.yml` publishes `14000:4000`; `docker-compose.prod.yml` narrows it to `127.0.0.1:14000:4000`; **`docker-compose.box.yml` applies last and sets `ports: !override []`**. Confirmed on the live container: `docker inspect` reports `HostConfig.PortBindings == {}`, and `ss -ltnp` shows nothing listening on `:14000`. |

`go-api` is on the `vaultchat_default` network with the network alias `go-api`,
which is what makes the `dynamic a` lookup in §2 work.

Everything else the replica needs is shared, not per-node: `DB_HOST=pgbouncer`,
`DB_PORT=6432`, `REDIS_HOST=redis`, and the three `secrets/` bind mounts are
read-only files, safe to mount into N containers.

**So `--scale go-api=2` works as-is.** See §7 for the exact command.

---

## 4. Cluster correctness

### `REDIS_ADAPTER` is on in production — confirmed

```
$ docker inspect vaultchat-go-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i redis
REDIS_PORT=6379
REDIS_ADAPTER=1
REDIS_PASS=
REDIS_HOST=redis
```

And `curl 127.0.0.1:8095/health` returns `{"db":true,"redis":true,"status":"ok"}`,
so `redisx.Client != nil` — which is the other half of `ClusterEnabled()`.
Step 2 of the SCALEOUT canary is therefore genuinely complete and soaked (the
container has 12h uptime, the Redis 4 weeks), not merely configured.

### What is correctly shared

Read in full: `internal/realtime/cluster.go`, `presence.go`, `server.go`,
`delivery.go`.

- **Room fan-out** — `redisadapter.RedisAdapterBuilder` is installed in `New()`
  whenever `ClusterEnabled()`. Room emits cross nodes.
- **Presence** — `trackSocket` / `untrackSocket` call `clusterTrackFirst` /
  `clusterUntrackLast`, which claim/withdraw a per-node field in
  `vc:pres:<uid>` and only fire the online/offline transition when the user was
  globally offline / is now globally offline. A node's claim is only trusted
  while `vc:node:hb:<node>` exists (15s TTL, 5s beat), so a crashed replica's
  users go offline within ~15s even before the janitor runs.
- **`hasLiveSocket`** — local fast path, then `clusterHasLive`. This gates the
  call wake push, so cluster correctness here is what stops a callee on replica
  B from getting a redundant push when ringing via replica A. Correct.
- **`OnlineCount`** — `SCARD vc:pres:online`, fleet-wide.
- **Call rosters** — `vc:call:<chatId>`, with `clusterCallLeave` also fired from
  the `disconnecting` handler so a drop does not leave a ghost in the roster.
- **Chat membership cache** — `vc:members:<chatId>` in Redis;
  `InvalidateChatMembers` does a `DEL` on the shared key. Cross-node correct.
- **Chat-viewer state** — `cv:h:<chatId>` / `cv:exp` in Redis.
- **Rate limits** — `redisx.Consume` (`rl:{key}` buckets), shared. A second
  replica does **not** double anyone's effective rate limit.

### Remaining process-local state — one item, bounded

**`permGen` in `server.go`** — the per-chat permission generation counter that
invalidates every live socket's cached "is this user a member of this chat"
decision. It is a package-level `map[string]uint64` guarded by a process mutex,
and the code says so itself:

```go
// ponytail: the counter is per-process. A second replica would not see the
// bump, which is what permTTL is for — a bounded worst case instead of an
// unbounded one. Scale-out needs this published over the same Redis channel
// the adapter already uses.
const permTTL = 30 * time.Second
```

**What two replicas would disagree about:** remove a member from a group via
replica A, and a socket held on replica B keeps its cached "yes, a member"
decision. `InvalidateChatMembers` still deletes the shared Redis roster, so
fan-out stops *reaching* them immediately — the residue is only that their live
socket may still *publish* into the chat (live-location updates, call
signalling) for up to `permTTL`.

**Assessment: acceptable, not a blocker.** 30 seconds is a bounded worst case,
and closing it is a small follow-up (publish the bump on a Redis pub/sub
channel; the adapter's connection is already there). If it matters more than
that today, drop `permTTL` to 5s as a one-character mitigation — the cost is
more membership queries, nothing else.

Other package-level mutable state checked and cleared:

- `runDelayCheckedAt sync.Map` (`routes/spaces_runs.go`) — a per-run query-cost
  throttle only. The actual dedupe is an `ON CONFLICT` insert into
  `run_events(kind='run_delayed', ref_id=stop)`, so a second replica means
  slightly less throttling, never a duplicate notification. The code documents
  this explicitly and it checks out against the SQL.
- Every other package-level map in `internal/realtime` and `internal/routes` is
  an immutable allowlist (`ghostCols`, `callRoles`, `sbPaymentMethods`, …).

---

## 5. Singleton jobs

Every ticker in the backend, and what guards it.

### Already lock-guarded

| Job | Guard |
|---|---|
| realtime dead-node janitor (`cluster.go`, 60s) | `SETNX vc:janitor:lock` |
| chat-viewer sweep (`delivery.go`, 10s) | `SETNX vc:cvsweep:lock`, under `ClusterEnabled()` |
| partition maintainer — create (`jobs/partitions.go`) | `pg_try_advisory_xact_lock` |
| partition maintainer — drop (`jobs/partitions.go`) | `pg_try_advisory_xact_lock` |
| scheduled-messages worker (`jobs.go`, 30s) | `FOR UPDATE SKIP LOCKED` inside a tx |

The advisory locks are the **transaction-scoped** variant, which is the correct
choice here and is not accidental: go-api reaches Postgres through PgBouncer in
transaction-pooling mode, where a session-level `pg_advisory_lock` would be left
held on a server connection already handed to someone else. The code comments
call this out.

### Safe without a lock (idempotent, or claimed by the write itself)

- `sweep-expired-messages`, `sweep-expired-chats`, `sweep-expired-stories`,
  `sweep-games-notify-seen`, `sweep-games-live-tables`, `expire-bodies` —
  plain `DELETE … WHERE <expired>`. Running twice deletes nothing the second
  time.
- `media-retention` (`sweepDeliveredAttachments`), `broadcast-retention`
  (`sweepEndedBroadcasts`) — object-store deletes are idempotent; a duplicate
  delete is a 404 no-op.
- `broadcast-reaper`, `golive host sweep` — `UPDATE … WHERE status IN
  ('starting','live') … RETURNING`. Under READ COMMITTED the second replica's
  identical UPDATE blocks, re-evaluates the predicate against the committed row,
  finds it no longer matches, and returns zero rows. The `RETURNING` **is** the
  claim; the follow-up work (ending egress, notifying) runs exactly once.
- `shopbook uncollected-orders sweep` — same `UPDATE … RETURNING` claim
  pattern, so the stock release and the notification fire once.
- `vaultbeam relay sweep` (`main.go`, hourly) — expiry delete, idempotent.
- `delete-on-delivery` / `delete-on-delivery-bodies` — delete-only, and in any
  case **not running**: `DELETE_ON_DELIVERY` is absent from the container env.

### ⚠️ NOT SAFE — `StartShopBookJobs` (`internal/routes/shopbook_jobs.go`)

**This is the one real finding.** Hourly ticker, gated on
`time.Now().UTC().Hour() != sbSummaryHourUTC()` (default 15:00 UTC), and
`SHOPBOOK_JOBS` is **not set** in the production container — so it is running.

Two of its three calls dedupe with a check-then-act that has no lock and no
unique index behind it:

`sbSendDailySummaries` — the dedupe is a `NOT EXISTS` in the *query*:

```sql
 WHERE s.approved
   AND NOT EXISTS (
	SELECT 1 FROM shopbook_notification n
	 WHERE n.user_id=s.owner_user_id AND n.event='daily_summary'
	   AND n.created_at::date = NOW()::date)
```

…and the row that satisfies it is written later, per shop, by `sbNotify`'s
plain `INSERT INTO shopbook_notification`. Between the SELECT and the INSERT
there is nothing.

`sbSendWeeklyReminders` — same shape: a separate `SELECT EXISTS(…)` cooldown
check per customer, followed by an unguarded insert.

**Why this is not theoretical.** The file's own comment says "Each firing is
idempotent — 'already sent' is derived from the notification inbox itself, so
restarts and multi-hour downtime never double-send." That reasoning is sound for
*one* process restarting. It fails for two processes, and it fails hardest in
exactly the way you will deploy them: `docker compose up -d --scale go-api=2`
starts both containers within the same second, so both hourly tickers fire
within milliseconds of each other, every hour, forever. The race window is not a
rare interleaving — it is the steady state.

**Blast radius.** `sbNotify` does three things per recipient: emits
`shopbook:event` over the socket, inserts an inbox row, and sends an Expo push.
So a lost race is a duplicated push notification and a duplicated inbox row for
every shop owner and every customer with a pending balance. Not data corruption
— but it is user-visible, it happens daily, and it is the kind of thing that
gets reported as "the app is spamming me" a week after a deploy nobody connects
it to.

**Fix (C2) — one guard, matching the pattern already used twice in this
codebase:**

```go
func sbJobsTick(ctx context.Context) {
	if time.Now().UTC().Hour() != sbSummaryHourUTC() {
		return
	}
	// Cluster: one replica per tick. Same SETNX single-runner lock as the
	// realtime janitor and the chat-viewer sweep (realtime/cluster.go,
	// realtime/delivery.go) — the daily-summary and weekly-reminder dedupes
	// are check-then-insert, so concurrent replicas double-send.
	if c := redisx.Client; c != nil {
		if ok, err := c.SetNX(ctx, "vc:sbjobs:lock", "1", 55*time.Minute).Result(); err != nil || !ok {
			return
		}
	}
	sbSendDailySummaries(ctx)
	sbSendWeeklyReminders(ctx)
	sbSweepUncollectedOrders(ctx)
}
```

A 55-minute TTL (not 5s) because the guarded work is "once per day at hour H",
so the lock must outlive the whole hour in which the two replicas can fire,
while still expiring before the next day's window. `redisx.Client == nil` falls
through to running it, which preserves single-node behaviour when Redis is down
— the same fail-open convention as the rest of the cluster code.

Alternative if you would rather not touch code before the replica: set
`SHOPBOOK_JOBS=off` on the second replica only. That works but is fragile — it
silently depends on which container is "second", and compose will not preserve
that across a recreate. Prefer the lock.

---

## 6. Capacity — not close to a constraint

Measured on the box:

```
$ free -g
               total        used        free      shared  buff/cache   available
Mem:              62           7           1           0          54          55
$ nproc → 12
$ uptime → load average: 0.14, 0.19, 0.29
```

Load average **0.14 on 12 cores** — roughly 1% utilised. 55 GB available.

`go-api` itself:

```
vaultchat-go-api-1   CPU 0.00%   MEM 8.684MiB / 62.7GiB
```

**8.7 MB.** A second replica is a rounding error against 55 GB available. The
finding's framing is right: capacity is not the constraint, redundancy is.

Disk: 300 GB free of 436 GB (28% used). The second replica shares the same
image, so it adds a container layer, not a copy.

### Database connections — this is the number that actually matters

| Layer | Value | Source |
|---|---|---|
| Postgres `max_connections` | **100** | `SHOW max_connections` |
| Postgres current backends | **10** | `SELECT count(*) FROM pg_stat_activity` |
| PgBouncer `POOL_MODE` | `transaction` | `docker-compose.yml` |
| PgBouncer `DEFAULT_POOL_SIZE` | **40** server conns per (db, user) | `docker-compose.yml` |
| PgBouncer `MAX_CLIENT_CONN` | **2000** client conns | `docker-compose.yml` |
| go-api per-pool max | `DB_POOL_MAX` default **30** | `internal/db/db.go` |
| go-api pools per process | 2 (`Pool` + `SysPool`) | `internal/db/db.go` |

So: one replica can open at most **60** connections *to PgBouncer*. Two replicas
→ 120, against a `MAX_CLIENT_CONN` of 2000. Comfortable.

The number that does *not* double is the one that matters: both replicas use the
same `vaultchat` user against the same `vaultchat` database, so they land in the
**same** PgBouncer pool and share its ceiling of **40** real Postgres server
connections — against `max_connections` 100, currently using 10.

**This is exactly what PgBouncer was put here for, and it means replica count is
decoupled from Postgres connection pressure.** It is safe to scale to 2, and it
would still be safe at 4 or 8. Postgres only notices if `DEFAULT_POOL_SIZE` is
raised.

One consequence worth stating: with two replicas sharing 40 server connections,
a slow query now contends across both. If `pg_stat_activity` starts showing
sustained waiting on the PgBouncer pool after the change, the lever is
`DEFAULT_POOL_SIZE` (there are 90 spare Postgres connections to give it), not
`DB_POOL_MAX`.

---

## 7. The change — exact commands

All on the box, in order. Nothing here is destructive; every step is reversible
in seconds.

### Step 0 — record the baseline

```bash
ssh root@65.21.229.167
cd /home/srihari/vaultchat
cp caddy/Caddyfile caddy/Caddyfile.bak-prereplica
docker ps --filter name=vaultchat-go-api --format '{{.Names}}'
curl -s http://127.0.0.1:8095/health
```

### Step 1 — land C2 (the ShopBook lock)

Build and deploy the go-api image containing the `vc:sbjobs:lock` fix from §5
through the normal deploy path. **Do this first**, in a single-replica
deployment, so the lock is already in the image the second replica runs.

### Step 2 — Caddyfile (C1)

Replace the final `handle { reverse_proxy go-api:4000 }` block with the
`dynamic a` block given in §2. Then reload **without restarting the container** —
Caddy's admin API is up on `127.0.0.1:2019` inside the container:

```bash
docker exec vaultchat-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker exec vaultchat-caddy-1 caddy reload  --config /etc/caddy/Caddyfile
curl -s http://127.0.0.1:8095/health     # must still be {"status":"ok",...}
```

Do this while still at **one** replica. If `/health` still answers, the dynamic
upstream resolves correctly — that is the whole risk of this step, tested before
any replica exists.

> Do not `docker compose up -d caddy`. `docker-compose.prod.yml` carries a
> prominent warning about exactly that: a recreate binds from the file, and a
> stale `80:80` there once took the site down against the host nginx.
> `caddy reload` touches nothing but the config.

### Step 3 — the second replica

```bash
cd /home/srihari/vaultchat
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.box.yml \
  up -d --no-recreate --scale go-api=2 go-api
```

`--no-recreate` is load-bearing: without it compose recreates
`vaultchat-go-api-1` as well, which drops every live websocket for no reason.
With it, `vaultchat-go-api-1` is untouched and `vaultchat-go-api-2` is added.

Verify:

```bash
docker ps --filter name=vaultchat-go-api --format '{{.Names}}\t{{.Status}}'
docker exec vaultchat-caddy-1 nslookup go-api    # must now return TWO A records
docker logs --tail 20 vaultchat-go-api-2 | grep cluster
# expect: [cluster] redis adapter on — node <hostname>-<hex>
docker exec vaultchat-redis-1 redis-cli smembers vc:nodes    # two node ids
```

### Rollback (any step, ~10 seconds)

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml \
  up -d --no-recreate --scale go-api=1 go-api
cp caddy/Caddyfile.bak-prereplica caddy/Caddyfile
docker exec vaultchat-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

The `dynamic a` block also tolerates one replica, so rolling back the scale
without rolling back the Caddyfile is fine — do them in whichever order the
situation allows.

### ⚠️ The footgun to write down before you forget it (C3)

`livekit/livekit.yaml` and `livekit/golive.yaml` both post webhooks to
`http://127.0.0.1:14000/internal/...`. That host port **does not exist**:
`docker-compose.box.yml` sets `go-api: ports: !override []`, and `ss -ltnp`
confirms nothing is listening on `:14000`.

**Two separate facts follow, and they must not be conflated:**

1. LiveKit and Go Live webhooks are **already failing in production**, today,
   before any of this. That is a pre-existing bug, unrelated to replicas, and it
   is why `broadcast_reaper.go` and `golive_reaper.go` exist to clean up after
   sessions that never got a terminal webhook. Worth its own ticket. Out of
   scope here.
2. Whoever fixes it will reach for `ports: - "127.0.0.1:14000:4000"`, because
   `docker-compose.prod.yml` still has that line with a comment explaining why
   it is needed. **That single line makes `--scale go-api=2` fail instantly**
   with a port-already-allocated error, and if it is added *after* the replica
   exists, the next `up -d` fails and can leave the stack half-recreated.

The correct fix for the webhooks under a multi-replica deployment is a Caddy
route, not a host port — LiveKit is `network_mode: host`, so point it at the
host-side Caddy (`127.0.0.1:8095`) with a path the Caddyfile forwards to
`go-api`, and let the same `dynamic a` upstream distribute it. Either replica
can process a webhook; nothing in the webhook handlers is node-affine.

---

## 8. Two-device verification — and what failure looks like

The SCALEOUT step-3 checks, plus what each one tells you when it fails. This is
the part that needs two real devices and cannot be done from the box.

**Setup.** User A and user B on separate physical devices, signed in as
different accounts sharing at least one 1:1 chat and one group. Pin each to a
known replica and confirm the split before testing anything — otherwise a green
run proves nothing, because both users may be on the same node:

```bash
docker exec vaultchat-redis-1 redis-cli hgetall vc:pres:<uidA>
docker exec vaultchat-redis-1 redis-cli hgetall vc:pres:<uidB>
# the node field in each hash must differ
```

If both land on the same node, force a split: kill one app, wait, reopen it, and
re-check. `least_conn` makes this quick.

### 1. Presence, both ways

A opens the app; B (already open) sees A go online. A backgrounds/force-quits; B
sees A go offline within ~15s.

- **A never appears online to B** → `clusterTrackFirst` returned `false` when it
  should have returned `true`, i.e. a stale field in `vc:pres:<uidA>` from a node
  whose heartbeat still exists. Check `redis-cli smembers vc:nodes` for more
  entries than running containers.
- **A appears online but never goes offline** → the janitor lock is stuck or
  `clusterUntrackLast` is not firing. Check `redis-cli ttl vc:janitor:lock`
  (should be ≤55s and moving) and `redis-cli hgetall vc:pres:<uidA>` (should be
  empty after A quits).
- **Presence flaps on and off repeatedly** → both replicas are claiming and
  withdrawing; the node heartbeat is failing to refresh. Check Redis latency and
  `vc:node:hb:*` TTLs.

### 2. 1:1 call rings across nodes

A calls B. B's device rings — foreground *and* with the app force-quit (the
full-screen Notifee ring).

- **Silence with the app open** → `call_incoming` did not cross the adapter.
  This is the headline symptom of the Redis adapter not actually being installed
  on one replica. Verify `REDIS_ADAPTER=1` in *both* containers' env
  (`docker inspect vaultchat-go-api-2 | grep REDIS_ADAPTER`) and that both
  logged `[cluster] redis adapter on`.
- **Rings, but B also gets a redundant push while the app is open** →
  `hasLiveSocket` returned false for a user who is online on the other node;
  `clusterHasLive` is not seeing B's field. Same root cause as check 1.
- **Rings only when both users happen to share a node** → conclusive proof the
  adapter is not carrying emits. Stop and roll back.

### 3. Group-call roster fills

A and B join the same group call from different replicas; each sees the other in
the participant list.

- **Each sees only themselves** → `clusterCallRoster` is reading
  `vc:call:<chatId>` but the joins are not landing there. Check
  `redis-cli smembers vc:call:<chatId>` during the call: if it holds only one
  uid, `clusterCallJoin` is not being called on one replica (`ClusterEnabled()`
  false there).
- **Roster fills but media never connects** → that is the SFU or ICE, *not* the
  replica change. Verify against a single-replica baseline before blaming the
  scale-out.
- **A ghost participant remains after someone leaves** → the `disconnecting`
  handler's `clusterCallLeave` did not fire. The entry expires on the 6h TTL,
  which is far too slow to be acceptable.

### 4. Message fan-out

A sends to a 1:1 chat and to the group; B receives instantly without pulling to
refresh. Then B replies; A receives.

- **Message only arrives when B reopens the chat** → the socket emit was lost
  and B is seeing the REST fetch instead. Adapter again.
- **Arrives to some group members and not others** → the `vc:members:<chatId>`
  cache is stale on one replica. It has a 30s TTL, so if the gap closes within
  30s the cache is the cause, and `InvalidateChatMembers` is not deleting the
  shared key on some mutation path.

### 5. Typing indicators cross

A types in a shared chat; B sees the indicator, and it clears when A stops.

- **Never appears** → adapter.
- **Appears and never clears** → the clear event is being dropped, not the set
  event, which points at ghost-mode filtering or a lost `typing_stop` rather than
  the cluster.

### 6. Membership revocation (the `permGen` gap from §4)

From device A, remove B from a group. Then, from B's still-open app, attempt to
publish into that chat — share live location, or start a call.

- **B can still publish for up to 30s** → this is the *known* `permTTL`
  behaviour, not a regression. Expected.
- **B can still publish after 60s** → a real bug: the generation bump is not the
  only guard failing, the Redis roster delete must also have missed. Investigate
  before going further.

### 7. Replica failure — the point of the whole exercise

With A and B on different replicas and a chat open on both,
`docker stop vaultchat-go-api-2`.

- **Pass**: the user on the killed node reconnects to the surviving one within a
  few seconds; the *other* user's session is completely undisturbed.
- **Both users' apps show "Connecting…"** → Caddy is still sending to the dead
  upstream; the `dynamic a` refresh or `fail_duration` is not taking it out of
  rotation. Lower `refresh`.
- **The surviving user sees the moved user go offline and then online again** →
  cosmetically ugly but correct: the heartbeat expired before reconnection.
  Acceptable.
- **The moved user cannot reconnect at all until the container is restarted** →
  Docker DNS is still returning the dead container's A record. Check
  `docker exec vaultchat-caddy-1 nslookup go-api` and confirm it drops to one
  record.

### 8. ShopBook duplicate check (validates C2)

After the deploy, wait for the daily-summary hour (15:00 UTC by default):

```sql
SELECT user_id, created_at::date, count(*)
  FROM shopbook_notification
 WHERE event='daily_summary'
 GROUP BY 1,2 HAVING count(*) > 1;
```

Zero rows is a pass. Any row means the `vc:sbjobs:lock` fix from §5 is not in the
running image, or `redisx.Client` is nil on one replica. This is the only check
here that must wait a day, and it is the one most likely to be skipped and then
discovered by a user — put a reminder on it.

### Stop condition

If check 2 or 4 fails, roll back immediately (§7) rather than debugging live.
Those two are load-bearing, and a failure in either means cross-node emits are
not working at all, which makes every other result meaningless.

---

## What I could not determine from the box

Stated plainly so nobody treats this document as more certain than it is.

- **Whether Docker's embedded DNS returns both A records for the `go-api` alias
  under `--scale`.** It should — that is the documented behaviour of compose
  service aliases — but the box currently has one replica, so the lookup returns
  one record and I could not observe the two-record case without making the
  change. This is the single assumption the §2 config rests on, and Step 3's
  `nslookup go-api` check exists to verify it before you trust it.
- **The tuning numbers in the Caddy block** (`refresh 10s`, `fail_duration 10s`,
  `max_fails 3`, `least_conn`). Reasoned, not measured. Adjust after check 7.
- **Whether Prometheus scrapes go-api, and what a second replica does to those
  series.** I found no go-api scrape target in
  `/home/srihari/vaultchat/prometheus/prometheus.yml`, but
  `vaultchat-prometheus-1` and `vaultchat-grafana-1` are running, so the config
  may live elsewhere. If go-api *is* scraped by service name, a second replica
  either halves the scraped values (if the target resolves to one rotating IP)
  or needs a second target — counters like `socket_connect` would then read
  wrong. Worth five minutes before the change; it affects dashboards, not
  correctness.
- **Real behaviour under load with two replicas.** Everything above is static
  analysis plus a single-replica production box at 1% CPU. The cluster code is
  well-structured and its comments are unusually honest about its own limits,
  but no line of it has ever run with a peer.
