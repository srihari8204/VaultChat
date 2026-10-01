# VaultChat on Akamai Cloud (Linode) LKE — production topology

> **TRANSPORT CITATION IS STALE (noted 2026-10-01).** Parts of this document reason
> from `lib/socket.ts` constructing `ioClient(SERVER_URL, { transports: ['websocket'] })`.
> That code no longer exists: `socket.io-client` is not a dependency, three selftests
> enforce its absence (`lib/socket.transport.selftest.ts:14-15`,
> `lib/nativeDeviceSupport.selftest.ts:41,44,51`), and `selectTransport()` returns
> `ccwire` with no alternative (`lib/socket.ts:108-115`). Any conclusion resting on the
> old citation must be re-derived against CC-Wire before it is relied on.

> Specifically: **finding F4 ("sticky sessions are NOT required")** is derived from that
> citation and is therefore unproven as written.


Greenfield design. The existing single-box compose stack is read here as a
statement of **what must run and what it really needs**, never as a shape to
copy. Every claim about the workload is cited to a file in this repo; every
claim I could not check from the repo is marked **[ASSUMPTION]** and collected
in §12.

No plan names and no prices appear in this document. Where sizing matters it is
expressed as a *plan class* (dedicated / shared / high-memory) plus the property
being bought (cores, RAM, sustained egress, local NVMe).

---

## 0. What the repo actually says, before any design

Five findings changed the design materially. They are up front because the rest
of the document only makes sense with them.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **F1** | **LiveKit uses ONE UDP port, not a range.** Both SFUs multiplex every participant over a single port — `7882` (calls), `7892` (Go Live) — with a TCP fallback on `7881`/`7891`. | `livekit/livekit.yaml` `rtc.udp_port: 7882`; `livekit/golive.yaml` `rtc.udp_port: 7892` | The "wide UDP range" problem is **coturn's alone**. LiveKit needs 2 UDP ports total. This collapses most of §2. |
| **F2** | **coturn's range is 49152–65535** — 16,384 ports, not the 40 the compose comment claims. | `coturn/turnserver.conf` `min-port=49152` / `max-port=65535`; `docker-compose.yml` comment says `49160-49200` | These disagree. The conf file is what coturn reads, so 16k is the operative number. Rule out NodePort on this alone. **[ASSUMPTION A7]** — which is live is unverified. |
| **F3** | **go-api is already written for Kubernetes.** It has `/livez` (touch-free), `/ready` (503 while draining), `/build` (provenance), a SIGTERM drain with `SHUTDOWN_DRAIN_DELAY` sized to outlast LB deregistration, and `hub.Shutdown()` telling sockets to reconnect. Its own comments name `terminationGracePeriodSeconds` and ingress-nginx. | `vaultchat-backend-go/cmd/api/main.go:118-230, 446-506` | The chart wires up behaviour that exists. Do not invent probes. |
| **F4** | **Sticky sessions are NOT required.** Client and server are both pinned websocket-only, so there is no multi-request polling handshake to keep on one node. | `lib/socket.ts` `transports: ['websocket']`; `internal/realtime/server.go` `opts.SetTransports(types.NewSet("websocket"))`; analysis in `docs/SECOND_REPLICA_READINESS.md §1` | Plain round-robin is correct. **This holds only while the client stays websocket-only** — the day a polling fallback is added, sticky sessions become mandatory in the same commit. |
| **F5** | **`migrate.js` has no advisory lock.** Commands are `status` / `baseline` / `up`; there is no `down`. Migrations are forward-only and unguarded against a concurrent runner. | `vaultchat-backend/migrate.js` | Ordering must be solved *outside* the runner (§9), and rollback is "revert the image, never the schema". |

Two more that shape §3 and §7:

- **RLS is currently inert in production** — the app connects as a bootstrap
  superuser that owns every table, so all 33 policy-bearing tables are
  decorative (`docs/RLS_ENFORCEMENT.md`, three independent citations). The
  cutover is prepared (migration `133_rls_roles.sql`, `internal/db/rls.go`,
  `DB_RLS_ENFORCE`) but not thrown. **A greenfield cluster should be built with
  it already thrown** — it is far cheaper before there are users than after.
- **The PII envelope has a version byte but no key id** —
  `version(0x01) | salt | iv | ct | tag`, HKDF-SHA256 from a single
  `VAULTCHAT_MASTER_KEY` (`internal/vault/vault.go:31-78`). There is no
  mechanism for two keys to coexist, so master-key rotation is a full
  re-encrypt, not a roll.

---

## 1. Component → Kubernetes object map

| Component | K8s objects | Replicas | Placement | Network exposure |
|---|---|---|---|---|
| **go-api** (REST + Socket.IO, `:4000`) | `Deployment` (RollingUpdate, `maxSurge:1 maxUnavailable:0`), `Service` ClusterIP, `Ingress`, `PDB minAvailable:2`, `ServiceMonitor` (`/internal/metrics`), `ScaledObject` (KEDA), `ConfigMap`, `ExternalSecret` | 3 → 12 | `app` pool, `topologySpreadConstraints` over zones + nodes | via ingress only; `/internal/*` denied at ingress |
| **migrations** | `Job` as an **Argo CD PreSync hook**, `backoffLimit: 0`, Node image + `migrations/` | 1, once per sync | `app` pool | none |
| **PostgreSQL** | CloudNativePG `Cluster` (1 primary + 2 replicas), `ScheduledBackup`, `ObjectStore`/barman-cloud to object storage | 3 instances | `data` pool, one per zone, `requiredDuringScheduling` anti-affinity | in-cluster only |
| **PgBouncer** | CNPG `Pooler` (kind: `rw`), `poolMode: transaction` | 3 | `data` pool | in-cluster only |
| **Redis (app)** | Redis `Sentinel` or operator-managed replica set, AOF on PVC | 1 primary + 2 | `data` pool | in-cluster only |
| **Redis (calls SFU)** | `StatefulSet`, 1 replica, **no persistence** (`--save "" --appendonly no`) | 1 | `media` pool | in-cluster only |
| **Redis (Go Live SFU)** | `StatefulSet`, 1 replica, no persistence | 1 | `media` pool | in-cluster only |
| **LiveKit — calls** | `Deployment`, `hostNetwork: true`, `dnsPolicy: ClusterFirstWithHostNet`, `Service` ClusterIP (signalling, for webhooks), `PDB maxUnavailable:1` | 2+ | `media` pool, `podAntiAffinity` hard (one per node — ports collide) | TCP 7880/7881 via ingress + NodeBalancer; **UDP 7882 direct to node public IP** |
| **LiveKit — Go Live** | same shape, ports 7890/7891/7892 | 2+ | `media` pool, same node as calls is fine (ports differ) | TCP 7890/7891; **UDP 7892 direct** |
| **LiveKit egress ×2** | two `Deployment`s, `SYS_ADMIN`, `requests.cpu: 4` floor | 1-2 each | `media` pool (or its own `render` pool if CPU contention shows) | none inbound |
| **coturn** | `DaemonSet`, `hostNetwork: true`, node selector `role=media` | 1 per media node | `media` pool | **UDP 3478 + TCP 3478 + TLS 5349 + UDP 49152-65535 direct to node public IP** |
| **Valhalla** | `Deployment`, tiles **in the image**, `readOnlyRootFilesystem`, no volume | 2 | `data` pool (page-cache locality) | in-cluster only |
| **games server** | `Deployment`, 1 replica, `Recreate` strategy, image imported from `docker save` | 1 | `app` pool | its own `Ingress` for `games.corefinite.com` |
| **games Postgres** | a second `database` in the same CNPG `Cluster` with its own role | — | `data` pool | in-cluster only |
| **vaultlens worker** | `Deployment` (or KEDA `ScaledJob` on queue depth), no Service | 0-N | `batch`/`app` pool | none inbound |
| **ingress-nginx** | Helm release, `Deployment` 3×, `Service type=LoadBalancer` → NodeBalancer | 3 | `sys` pool | 80/443 public |
| **cert-manager** | Helm release + `ClusterIssuer` (DNS-01) + `Certificate` ×2 | — | `sys` pool | — |
| **External Secrets Operator** | Helm release + `ClusterSecretStore` + `ExternalSecret` per app | — | `sys` pool | — |
| **Argo CD** | Helm release, `ApplicationSet` | — | `sys` pool | private ingress / port-forward |
| **kube-prometheus-stack + Loki + Alloy** | Helm releases | — | `sys` pool | private ingress |
| **Reloader** | Helm release | — | `sys` pool | — |
| **Velero** | Helm release + `Schedule` | — | `sys` pool | — |
| Object storage | none — external, S3-compatible | — | — | outbound HTTPS |
| FCM push | none — outbound HTTPS from go-api | — | — | outbound HTTPS |

---

## 2. Node pools

**Four pools.** Not three (media cannot share with anything), not six (a
separate pool per workload buys isolation nobody asked for and pays for idle
capacity in every one).

| Pool | Class | Min nodes | What runs there | Why it is separate |
|---|---|---|---|---|
| `sys` | **shared** CPU, small | 3 (one per zone) | ingress-nginx, cert-manager, ESO, Argo CD, Prometheus/Loki/Grafana, Velero, Reloader | Control-plane-ish work that is bursty and latency-tolerant. Putting it here means an ingress-controller rollout or a Prometheus compaction cannot perturb the socket server. Shared-class CPU is acceptable *because* nothing here is latency-critical — except ingress, which is network-bound rather than CPU-bound. |
| `app` | **dedicated** CPU, balanced RAM | 3 (one per zone) | go-api, games server, vaultlens worker, migration Jobs | go-api holds tens of thousands of long-lived sockets; its tail latency is the product. Dedicated (non-burstable, non-shared) vCPU is the whole reason for this pool: a CPU-steal spike on a shared plan shows up to users as message lag, and the repo already has an 8-10s lag investigation on record. Sized for **goroutines and file descriptors, not throughput** — each socket is an idle goroutine pair plus a TCP buffer, so RAM and `nofile` limits bind before CPU does. |
| `media` | **dedicated** CPU, **highest sustained egress** in the catalogue, public node IPs | 3 | LiveKit ×2, their Redis ×2, egress ×2, coturn (DaemonSet) | Three independent reasons, any one sufficient: (a) `hostNetwork: true` means these pods own real host ports, so they cannot coexist with anything that might want the same; (b) an SFU is **bandwidth-bound, never CPU-bound** — it forwards ciphertext and cannot transcode (`livekit/livekit.yaml` header, `docs/SFU_SPIKE.md`), so what you buy here is egress allowance and NIC, and the plan choice should be driven by *sustained Mbps per node*, not cores; (c) egress (the HLS renderer) is headless Chrome + ffmpeg and is the **only** CPU-bound thing in the stack, with a hard 4-core floor below which room-composite silently refuses to produce a playlist. Capacity rule of thumb from the repo: ~600 kbps per forwarded stream, so a 10-person call is ~54 Mbps egress from one node. |
| `data` | **high-memory**, local NVMe if the catalogue offers it | 3 (one per zone) | CNPG Postgres ×3, PgBouncer ×3, app Redis ×3, Valhalla ×2 | Postgres wants page cache and predictable IOPS; Redis wants RAM; Valhalla memory-maps ~4.4 GB of tiles and is fast only when they are resident. All three are RAM-hungry and CPU-cheap, which is exactly the high-memory class. Keeping them off `app` means a Postgres checkpoint or a Redis AOF rewrite cannot stall the socket server. Local NVMe matters for Postgres WAL fsync latency; if the catalogue's high-memory class has no local disk, use network block storage and accept the higher commit latency **[ASSUMPTION A3]**. |

Deliberately **not** a fifth pool: a `batch` pool for vaultlens and migration
Jobs. Both are short-lived and rare; they fit in `app` with resource requests
that make the scheduler keep them honest. Add the pool when batch work grows
enough to evict a go-api pod — that is the trigger, and not before.

**Autoscaling:** cluster-autoscaler on `app` only. `data` and `media` are
manually sized (stateful and host-port-bound respectively — autoscaling either
is a way to lose data or drop calls without meaning to). `sys` is fixed at 3.

---

## 3. The UDP problem

### 3.1 What is actually needed

After F1 and F2, the requirement is much smaller than it first looks:

| Workload | UDP | TCP | Can it go through an L4 LB? |
|---|---|---|---|
| LiveKit calls | **1 port** (7882) | 7880 signalling, 7881 media fallback | TCP yes. UDP: only if the LB does UDP **[A1]** |
| LiveKit Go Live | **1 port** (7892) | 7890, 7891 | same |
| coturn | **16,384 ports** (49152-65535) + 3478 | 3478, 5349 (TLS) | **No.** Not by any load balancer, at any price. |

### 3.2 Why NodePort is wrong here

Three independent disqualifiers, in order of severity:

1. **Range.** The default NodePort range is 30000–32767 — 2,768 ports. coturn
   wants 16,384. You can widen `--service-node-port-range`, but that is an
   apiserver flag on a managed control plane you do not own **[A2]**.
2. **Source NAT.** `kube-proxy` rewrites the source address of NodePort traffic
   unless `externalTrafficPolicy: Local`. TURN's entire security model is
   five-tuple permissions on the relay: the peer address coturn sees must be the
   peer address the client authorised. SNAT breaks that quietly — allocations
   succeed and relayed packets are dropped.
3. **conntrack.** 16k UDP flows per node through `nf_conntrack`, at UDP's
   30-second default timeout, is a table-exhaustion incident waiting for a busy
   evening.

### 3.3 The design: split signalling from media

This is the crux, and the answer is not one mechanism but two, because
signalling and media have opposite requirements.

```
                    ┌──────────────── NodeBalancer (TCP/TLS only) ────────────────┐
  client ── 443 ────┤ api.corefinite.com  → ingress-nginx → go-api                │
         ── 443 ────┤ sfu.corefinite.com  → ingress-nginx → livekit :7880 (WSS)   │
         ── 443 ────┤ live.corefinite.com → ingress-nginx → golive  :7890 (WSS)   │
                    └────────────────────────────────────────────────────────────┘

  client ── UDP 7882 ────────► media-1.corefinite.com  (node public IP, hostNetwork)
  client ── UDP 7892 ────────► media-1.corefinite.com
  client ── UDP 3478 ────────► turn1.corefinite.com    (node public IP, hostNetwork)
  client ── UDP 49152-65535 ─► turn1.corefinite.com
  client ── TCP 5349 (TURNS) ► turn1.corefinite.com
```

**Signalling goes through the NodeBalancer.** It is ordinary TCP/WSS on 443 and
benefits from the LB's health checks and TLS. This is also what makes the SFU
reachable from networks that block everything but 443.

**Media bypasses the load balancer entirely** and goes to a node's public IP,
because ICE is *designed* for exactly this: the server does not need to be
"behind an address", it needs to *advertise* an address the client can reach.

- **LiveKit** advertises it via `rtc.node_ip`. Today that is a literal
  (`node_ip: 65.21.229.167`) and LiveKit reads its config as **plain YAML with
  no `${VAR}` expansion** — a hard-won lesson recorded twice in
  `livekit/livekit.yaml`. In K8s the substitution therefore has to happen before
  LiveKit reads the file: an `initContainer` renders the config with the node's
  public IP from the Downward API (`status.hostIP`) or from the metadata
  service, and writes it to an `emptyDir` the main container mounts.
  The alternative, `use_external_ip: true` (STUN auto-detect), works on a cloud
  VM with a public IP and removes the templating — take it if `status.hostIP`
  turns out to be the VPC-private address **[A4]**.
- **coturn** advertises it via `--external-ip`, already parameterised in the
  compose file. Same Downward API injection, no templating needed since it is a
  flag.

### 3.4 How a client discovers the right node

It does not have to, and that is the point — **discovery is server-driven in
both cases**, and both mechanisms already exist in this codebase:

- **LiveKit:** the client never picks a server. It calls
  `POST /calls/{id}/sfu-token`, and go-api returns a token *plus* `LIVEKIT_URL`
  — the public `wss://` address the client should dial (`internal/livekit/token.go`;
  the env var's comment states outright that it "is what the CLIENT dials").
  So the client dials one hostname through the LB, LiveKit's Redis-backed room
  routing puts it on the node that owns the room, and that node's ICE candidates
  carry its own public IP. **Multi-node LiveKit requires the Redis clustering
  path to be genuinely exercised — this deployment has only ever run one node
  per SFU [A5].**
- **coturn:** the client gets its ICE server list from go-api (`TURN_HOST` /
  `TURN_SECRET`, HMAC-derived ephemeral credentials). Hand it **every** media
  node — `turn1`, `turn2`, `turn3` — as separate ICE server entries. ICE gathers
  candidates from all of them in parallel and the connectivity check picks the
  one that works. A dead TURN node costs a few hundred milliseconds of
  gathering, not a failed call. This is strictly better than a load balancer
  would be, because ICE's own failover is faster than any health check.

### 3.5 Rolling a media node — what breaks, honestly

**Live calls on that node drop.** There is no session migration in LiveKit and
none in coturn. Anything else you read is wishful. What the design can do is
make it rare, brief and scheduled:

1. **Cordon, don't drain.** `kubectl cordon` the node. New rooms stop landing
   there because LiveKit's Redis room allocation only considers nodes that are
   accepting, and new TURN allocations stop because the ICE list is rebuilt per
   call — but existing sessions continue untouched.
2. **Wait for the node to empty.** Poll LiveKit's `livekit_participants_total`
   (or the room count via its API) until it reaches zero or a low-water mark.
   Empirically this is minutes, not hours: `room.empty_timeout` is 60s for
   calls and 300s for Go Live, and a call is a call.
3. **Then drain**, with `terminationGracePeriodSeconds` long enough that the
   remaining stragglers finish rather than get SIGKILLed — 900s is a reasonable
   starting number for the SFU, and coturn's `channel-lifetime=300` /
   `permission-lifetime=300` say 300s is enough for TURN.
4. **Do it in a window.** Not at the end of a deploy. Media nodes should be
   replaced on a schedule a human chose, not as a side effect of a
   `kubectl apply`.

**What this means for Argo CD:** the media pool's workloads are excluded from
automated sync-and-prune. They get `syncPolicy: manual` (or
`SyncOptions: Prune=false` plus a human-approved sync), because a GitOps
controller that can restart an SFU on its own schedule *will* restart it during
someone's call.

**The residual exposure, stated plainly:** a node hardware failure drops every
call on that node with no warning and no mitigation. The client-side answer —
ICE restart, then a fresh `sfu-token` and rejoin — is the only real recovery,
and whether the RN client does that today is unverified **[A6]**. That is the
single highest-value client-side resilience item this design surfaces.

---

## 4. PostgreSQL: managed vs in-cluster

### 4.1 The decision hinge

**It is the BYPASSRLS role, and it is very likely disqualifying.**

The two-pool design is not a style choice. `internal/db/db.go` opens `Pool`
(RLS-enforcing, connects as `vaultchat_app`) and `SysPool` (connects as
`vaultchat_sys`), and eighteen queries — retention sweeps, presence fan-out,
invite-link resolution, cross-user story reads — are on `SysPool` *by
necessity*: binding a user to them returns the wrong answer or no answer
(`docs/RLS_ENFORCEMENT.md`, "The 18 queries"). `internal/db/rls.go` refuses to
boot under `DB_RLS_ENFORCE=1` if the system role is missing, precisely because
the alternative is a backend that boots, serves, and silently returns nothing.

`vaultchat_sys` needs the **`BYPASSRLS` role attribute**. Granting `BYPASSRLS`
requires superuser. Managed Postgres offerings almost universally withhold
superuser and give you a `rds_superuser`-equivalent that can do most things but
**not** grant role attributes it does not itself hold.

**Verify before anything else — one query against a trial instance of Akamai's
managed Postgres:**

```sql
CREATE ROLE rls_probe NOLOGIN BYPASSRLS;   -- the whole decision, in one statement
DROP ROLE rls_probe;
```

Two more that must pass on the same instance, because migrations need them:

```sql
-- migration 128 creates partition DDL as SECURITY DEFINER
CREATE FUNCTION probe() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql SECURITY DEFINER;
-- migration 133 creates roles and grants DEFAULT PRIVILEGES on future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO rls_probe;
```

If `BYPASSRLS` fails: **managed Postgres is disqualified.** Not inconvenient —
disqualified. The workarounds are all worse than running your own:

- Drop RLS and rely on route-layer checks only. That is the status quo, and it
  throws away defence-in-depth on chats, messages, attachments and calls for an
  operational convenience.
- Wrap all 18 system queries in `SECURITY DEFINER` functions owned by the table
  owner. That is 18 new functions to audit, each one a bypass with a wider blast
  radius than a role attribute, and every new system query needs another.
- Give the app the owner role. Then RLS is inert again (ownership exempts you
  unless `FORCE`), which is exactly the bug `RLS_ENFORCEMENT.md` documents.

### 4.2 The pick: CloudNativePG, in-cluster

Assuming `BYPASSRLS` fails (the likely case), and honestly a good choice even if
it passes:

**Why CNPG over Zalando or Percona:**

- **It is the only one of the three with a first-class `Pooler` CRD** that
  deploys and manages PgBouncer as part of the cluster, with the auth plumbing
  (`auth_user` + auth query) already solved. The repo has already discovered
  that this plumbing is what lets *both* RLS roles authenticate without a
  hand-maintained `userlist.txt` (`docs/REBUILD_RISKS.md:203`). With Zalando you
  get a connection pooler too, but with Percona you are assembling it.
- **Backups are the operator's job, not a sidecar's.** CNPG does continuous WAL
  archiving plus base backups to S3-compatible storage natively, with PITR as a
  `Cluster.spec.bootstrap.recovery` stanza. Zalando delegates to WAL-G/WAL-E
  configured through env vars on the pod spec, which is more surface to get
  wrong.
- **Failover is a Kubernetes primitive, not a separate consensus system.** CNPG
  uses the API server for leader election. Zalando runs Patroni, which is
  excellent and battle-tested but is a second distributed system to understand
  at 3am. Fewer moving parts wins.
- **Percona's operator is strong but is oriented around Percona's distribution**
  and adds components (pmm, etc.) this deployment does not need.

**Shape:**

```yaml
instances: 3                       # 1 primary + 2 streaming replicas
primaryUpdateStrategy: supervised  # a human decides when the primary moves
postgresql:
  parameters:
    max_connections: "200"         # PgBouncer fronts this; 200 is plenty
    synchronous_commit: "on"
  synchronous:
    method: any
    number: 1                      # one sync replica, in another zone
```

`synchronous.number: 1` is the RPO decision: a committed transaction is on two
nodes in two zones before the client hears "committed". It costs one
cross-AZ round trip per commit. Take it — this is a messenger, and the thing
being committed is someone's message.

**PgBouncer placement.** CNPG's `Pooler` runs PgBouncer as its own Deployment in
front of the `-rw` service, in **transaction** mode. Three constraints the app
has already been adapted to and which must not regress:

- `default_query_exec_mode=exec` on the pgx side — no named prepared statements,
  because transaction pooling cannot track them across server connections
  (`internal/db/db.go` `Connect`).
- `WithUser` uses `set_config($1, $2, true)` — transaction-scoped, so a pooled
  server connection is never left carrying someone's `app.current_user_id`.
  This is the single most important correctness property in the whole data path:
  session-scoped `SET` here would leak one user's RLS identity to the next
  request on that connection.
- **No `LISTEN`, no session-level `SET`, ever.** Worth a lint rule, not just a
  comment.

**Two Poolers or one?** One `rw` Pooler, both roles through it. PgBouncer pools
per (database, user) pair, so `vaultchat_app` and `vaultchat_sys` get separate
server-connection pools automatically — which is exactly the isolation the
smaller `DB_SYSTEM_POOL_MAX: 8` default is reaching for. Adding a second Pooler
deployment buys nothing.

**Storage:** each instance gets its own PVC (block storage), plus a separate
`walStorage` PVC so a WAL burst cannot fill the data volume. Set
`storage.resizeInUseVolumes: true` and alert at 70%.

### 4.3 If `BYPASSRLS` passes

Then managed Postgres becomes genuinely attractive — backups, patching and
failover become someone else's pager — and the trade flips to: you lose
`pg_stat_statements`-level control and cross-cluster latency goes up by a
network hop. Take it if it passes and you are short on operators. Note that you
still run PgBouncer yourself (as a plain Deployment) unless the managed offering
provides a transaction-mode pooler, because the connection math does not work
without one: 12 go-api pods × `DB_POOL_MAX=30` = 360 connections against a
managed instance that probably caps well below that.

---

## 5. The 10 GB tile problem

### 5.1 Correcting the size first

`docs/SERVER_INVENTORY.md:50` breaks the 9.8 GB down:

| File | Size | Needed at runtime? |
|---|---|---|
| `india-latest.osm.pbf` | 1.7 GB | **No** — `use_tiles_ignore_pbf=True` is already set |
| `valhalla_tiles.tar` | 4.4 GB | Yes |
| `valhalla_tiles/` (extracted) | ~3.6 GB | No, if serving from the tar |
| `valhalla.json`, `file_hashes.txt` | small | Yes |

**The runtime set is ~4.4 GB, not 9.8 GB.** Valhalla serves directly from the
tar, and the compose file already turns off pbf re-parsing. That halves the
problem before choosing a mechanism, which is the cheapest win available.

### 5.2 The options

| Option | Image size | Cold start | Money | Verdict |
|---|---|---|---|---|
| **Bake into the image** | +4.4 GB | First pull per node: minutes. Subsequent pods on that node: seconds (containerd layer cache). | Registry storage + intra-region pull bandwidth | **Chosen** |
| ReadWriteMany volume | tiny | Seconds | NFS/CephFS: a new distributed filesystem to run, or a managed file service | **No.** Linode block storage is RWO **[A3]**; standing up NFS makes a single-writer SPOF the routing engine depends on, to solve a read-only problem. Worst option here. |
| ReadOnlyMany volume | tiny | Seconds | Block storage volume | **No.** `ROX` needs a driver that genuinely supports multi-attach read-only. Block storage generally does not. If Akamai's CSI does, this becomes competitive — verify. |
| initContainer sync from object storage | tiny | **4.4 GB download on every pod start** — minutes, every time, per pod | Egress on every pod start, forever | **No.** Turns a one-time cost into a recurring one, and makes an HPA scale-up event a four-minute wait. |
| Node-local cache (hostPath + primer DaemonSet) | tiny | Seconds after the primer finishes | Same download as initContainer, but once per node | Close second. It is exactly what the image option gives you, except you write and operate the primer yourself and lose content-addressed integrity. |

### 5.3 The choice, and its costs stated

**Bake the tiles into an OCI image**, built by a separate, rarely-run pipeline:

```
valhalla-tiles:india-2026-09-14   # tag = extract date, immutable, never :latest
```

The Valhalla Deployment runs *that* image directly — the tiles are a layer, not
a volume. `readOnlyRootFilesystem: true`, no PVC at all.

**What it costs:**

- **Image size:** ~4.5 GB. Registry storage for a handful of retained tags.
- **Cold start:** the first pod on a new node waits for the pull. Mitigated by a
  **pre-pull DaemonSet** on the `data` pool — a pod whose only job is to run
  `sleep infinity` on the tiles image, which forces containerd to have the layer
  before the real workload is scheduled. This also makes cluster-autoscaler
  scale-up survivable.
- **Rebuild cadence:** a new OSM extract is a new image tag and an Argo sync.
  Routing quality drifts with OSM, so budget quarterly. The build is hours; run
  it in CI on a beefy runner, not on a cluster node.
- **Money:** registry storage plus one intra-region pull per node per tag. Both
  small, and — crucially — *bounded*, unlike the object-storage-sync options
  whose cost scales with pod churn.

**The property that makes this correct:** the tiles are immutable and identical
for every replica. That is the definition of a container image layer. Every
other option is re-implementing layer distribution with fewer guarantees.

---

## 6. Ingress

### 6.1 ingress-nginx, and why not the alternatives

**ingress-nginx.** Not because it is the most modern, but because every
behaviour this stack needs is a documented annotation rather than a
custom-resource design exercise:

- WebSocket upgrade works with no configuration at all (`Connection`/`Upgrade`
  pass-through is default, HTTP/1.1 upstream is default).
- `/internal/*` must 404 from outside — the Caddy setup enforces this today and
  it is load-bearing, since `/internal/emit`, `/internal/chat-event`,
  `/internal/livekit/webhook` and `/internal/metrics` are all mounted on the
  same `:4000` listener as the public API. A `server-snippet` does it in three
  lines.
- The whole thing is one Helm values file that a reviewer can read.

Rejected: **Gateway API / Envoy Gateway** — the right long-term answer, but
`BackendTrafficPolicy` timeout semantics for hour-long WebSockets are a place I
would rather not be learning during an incident; revisit when the socket
behaviour is boring. **Traefik** — fine, but nothing here needs it. **Caddy** —
what the box runs today; its K8s ingress controller is a community project with
a much smaller operational corpus, and the one thing Caddy was buying (per-route
strangler switching between Node and Go) is finished work.

### 6.2 Values that matter

```yaml
controller:
  replicaCount: 3
  config:
    # Long-lived sockets. Defaults are 60s, which kills an idle chat connection
    # every minute and makes the app look broken on a quiet network.
    proxy-read-timeout: "3600"
    proxy-send-timeout: "3600"
    # THE ONE PEOPLE MISS: on every config reload nginx spawns new workers and
    # gives old ones this long to finish. Default 240s — so every ingress
    # change (a new cert, any Ingress edit anywhere in the cluster) hard-kills
    # every WebSocket older than four minutes. Cluster-wide, silently.
    worker-shutdown-timeout: "3600"
    proxy-buffering: "off"
    upstream-keepalive-connections: "320"
    use-forwarded-headers: "true"
    enable-real-ip: "true"
    http-snippet: |
      # crude L7 backstop only — real limiting is in the app, see 6.4
      limit_req_zone $binary_remote_addr zone=vcglobal:20m rate=50r/s;
  service:
    externalTrafficPolicy: Local   # preserve client IP for the app's limiter
```

`externalTrafficPolicy: Local` matters more than it looks: `redisx.ConsumeSecure`
keys on the caller, and behind SNAT every caller is the same node IP.

Per-Ingress:

```yaml
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
nginx.ingress.kubernetes.io/server-snippet: |
  location ^~ /internal/ { return 404; }
```

### 6.3 Ingress rollouts and long-lived sockets

An ingress-nginx pod rollout terminates every socket on it. With
`worker-shutdown-timeout: 3600` and a matching
`terminationGracePeriodSeconds: 3660`, a controller pod lingers until its
sockets drain naturally. This makes ingress upgrades slow — deliberately. A
fast ingress upgrade is a mass reconnect storm against go-api, and the client's
"aggressive-but-jittered reconnect" (`lib/socket.ts`) is what stands between you
and a thundering herd. Do not tune this down to make deploys feel snappier.

### 6.4 Rate limiting — keep it where it already is

The app has a Redis-backed limiter with a deliberate two-tier design:
`Consume` fails **open** (a Redis outage must not break chat) and
`ConsumeSecure` fails **closed** (`internal/redisx/*.go:92-157`) for endpoints
where "allow everything" is the wrong answer. It is per-identity, which is the
only unit that means anything for a messenger.

**Do not re-implement this at the ingress.** An nginx `limit_req` on
`$binary_remote_addr` punishes carrier NAT — a whole city behind one IPv4
address — and cannot tell an authenticated user from an anonymous probe. Keep
`limit_req` as a coarse anti-flood backstop at a rate high enough that no
legitimate user ever meets it, and leave policy in the app.

### 6.5 Certificates, including coturn's

**cert-manager with a DNS-01 `ClusterIssuer`.** DNS-01 rather than HTTP-01, for
one decisive reason: **coturn is not an HTTP workload and can never answer an
HTTP-01 challenge.** DNS-01 issues certs for names that serve no HTTP at all,
which is exactly `turn.corefinite.com`'s situation.

```
Certificate: api-tls   → Secret api-tls       (ingress-nginx consumes)
Certificate: turn-tls  → Secret turn-tls      (coturn mounts as files)
```

**The certbot-deploy-hook problem, solved.** On the box, certbot renews and a
deploy hook copies `cert.pem`/`pkey.pem` into `coturn/certs/` and restarts the
container. In Kubernetes:

1. cert-manager renews and **rewrites the `turn-tls` Secret**. That is the
   renewal event.
2. The kubelet propagates the new Secret into the mounted volume within about a
   minute — but **coturn read its cert at startup and will not notice**. coturn
   has no reliable certificate hot-reload; treating `SIGHUP` as one is
   optimistic, and a TURN server serving an expired cert fails *only* for TURNS
   clients, which is the quietest possible failure.
3. So: **[stakater/Reloader](https://github.com/stakater/Reloader)** annotation
   on the coturn DaemonSet —
   `secret.reloader.stakater.com/reload: "turn-tls"` — which watches the Secret
   and triggers a rolling restart when its contents change. **That is the
   deploy hook.** Same trigger, same action, declared instead of scripted.

**The cost, stated honestly:** a coturn restart drops every active relay
allocation on that node. cert-manager renews at ⅔ of lifetime, so with a 90-day
cert this is roughly **once every 60 days per node**, and the DaemonSet's
`maxUnavailable: 1` staggers it so only one node's relays drop at a time. ICE
restart recovers a call whose relay died; a call that was *only* reachable via
that relay and does not ICE-restart, drops. Accept it, alert on it, and schedule
renewals away from peak by setting `renewBefore` to land the restart in a quiet
window.

A cleaner variant worth knowing: put **eBPF/`sslh`-free TLS termination in front
of coturn** — i.e. don't. TURNS terminates TLS inside coturn by design, and
proxying it costs you the client IP the permission model depends on. The restart
is the correct trade.

---

## 7. Placement, disruption, scaling, probes

### 7.1 Stateless vs stateful

| | Workloads | Controller | Why |
|---|---|---|---|
| Stateless | go-api, Valhalla, egress, vaultlens, ingress | `Deployment` | No identity, no ordering, no persistent volume. go-api's only local state is the socket map, and that is Redis-backed under `ClusterEnabled()` (`internal/realtime/cluster.go`). |
| Stateful | Postgres, app Redis | Operator-managed `StatefulSet` | Stable identity + PVC + ordered start. |
| Stateful-but-disposable | SFU Redis ×2 | `StatefulSet`, no PVC | Pure rendezvous state, worthless after a restart. The compose file already says so, and the reasoning holds: an appendonly file here is "only a thing to corrupt". |
| Host-bound | LiveKit ×2, coturn | `Deployment` with hard anti-affinity / `DaemonSet` | `hostNetwork` makes the node the unit. |
| Singleton | games server | `Deployment`, `strategy: Recreate`, `replicas: 1` | See §11.2. |

### 7.2 PodDisruptionBudgets

| Workload | PDB | Reasoning |
|---|---|---|
| go-api | `minAvailable: 2` | Below two there is no redundancy during a node upgrade. Not a percentage — a percentage of 3 rounds in ways you will regret at 3 replicas. |
| ingress-nginx | `minAvailable: 2` | Same. |
| Postgres | CNPG manages its own | Do not add one; it will fight the operator. |
| app Redis | `maxUnavailable: 1` | Sentinel needs quorum. |
| LiveKit ×2 | `maxUnavailable: 1` | One media node at a time, ever. |
| coturn | `maxUnavailable: 1` | DaemonSet — this is what staggers cert-renewal restarts. |
| games | **none** | One replica; a PDB on a singleton just blocks node drains forever. Accept the downtime window. |
| Valhalla | `minAvailable: 1` | Navigation degrades to "no route" without it. |

### 7.3 Anti-affinity and topology spread

```yaml
# go-api — spread over zones first, then nodes; soft, so 12 replicas on 3 nodes
# is still schedulable.
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
```

`ScheduleAnyway`, not `DoNotSchedule`: a hard constraint on the socket server
means an HPA scale-up during a zone incident fails to schedule at exactly the
moment you need capacity.

```yaml
# LiveKit — HARD anti-affinity. hostNetwork means two pods on one node
# collide on port 7880 and the second CrashLoops.
podAntiAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
    - topologyKey: kubernetes.io/hostname
      labelSelector: {matchLabels: {app: livekit-calls}}
```

Postgres: `requiredDuringScheduling` anti-affinity across zones — three
instances in one zone is not a cluster, it is three copies of one failure.

### 7.4 HPA: the metric is not CPU

**It is `sockets_local`.** The gauge already exists —
`internal/realtime/server.go:181` registers `sockets_local` (this pod's socket
count) and `users_local`, alongside `sockets_online` (the cluster-wide count
from Redis).

CPU is the wrong metric for three reasons: an idle socket costs a goroutine pair
and a TCP buffer, not cycles, so 20k idle connections show ~0% CPU right up to
the memory or fd wall; a burst of fan-out spikes CPU for seconds without meaning
you need a pod; and CPU recovers before a scale-up finishes, producing flapping.

**Use KEDA with a Prometheus scaler** rather than HPA + prometheus-adapter —
one component instead of two, and KEDA's `ScaledObject` carries the
stabilization policy in the same object:

```yaml
triggers:
  - type: prometheus
    metadata:
      query: sum(sockets_local{job="go-api"}) / count(sockets_local{job="go-api"})
      threshold: "4000"          # connections per pod — calibrate on real memory
advanced:
  horizontalPodAutoscalerConfig:
    behavior:
      scaleUp:
        stabilizationWindowSeconds: 60
      scaleDown:
        stabilizationWindowSeconds: 900     # 15 minutes
        policies: [{type: Pods, value: 1, periodSeconds: 300}]
```

**The asymmetry is the whole design.** Scaling *up* is nearly free. Scaling
*down* terminates a pod, and every socket on it reconnects — so aggressive
scale-down manufactures the reconnect storm you were scaling to avoid. One pod
per five minutes, with a fifteen-minute window.

**The honest limitation:** new pods only receive *new* connections. Existing
pods stay loaded until their clients happen to reconnect, so scaling up does not
relieve a currently-hot pod — it only absorbs growth. Two consequences: run with
real headroom rather than scaling reactively, and if a pod genuinely needs
shedding, the mechanism is a deliberate disconnect (`hub.Shutdown` already tells
clients to reconnect rather than letting them discover it by ping timeout), not
an autoscaler.

Secondary trigger worth adding: `workx` queue saturation.
`workx.InlineRuns()` growing means the side-work pool is saturated
(`SCALEOUT.md`, operational notes) — a genuine "this pod is overloaded" signal
that CPU misses.

### 7.5 Requests and limits

| Workload | requests | limits | Rationale |
|---|---|---|---|
| go-api | `cpu: 500m`, `mem: 1Gi` | `cpu: <none>`, `mem: 2Gi` | **No CPU limit.** CFS throttling on a latency-sensitive Go server adds p99 spikes for no benefit; the request already guarantees a share and the dedicated pool bounds the neighbours. Memory *is* limited, because a socket leak should kill one pod, not a node. Start at 4000 conns/pod and revise from real `container_memory_working_set_bytes`. |
| Valhalla | `cpu: 1`, `mem: 4Gi` | `mem: 6Gi` | Memory-mapped tiles want page cache; the request keeps it resident. `server_threads: 4`. |
| egress | `cpu: 4`, `mem: 2Gi` | `cpu: 6`, `mem: 4Gi` | **4 is a floor, not a preference** — room-composite refuses below it and then *reports ready anyway*, so every broadcast dies in `starting` with nothing in any log. Measured, in the compose file. A CPU limit here is correct, unlike go-api: this is the one workload that can genuinely run away. |
| LiveKit | `cpu: 2`, `mem: 2Gi` | `mem: 4Gi` | Bandwidth-bound; CPU request is for packet handling and the kernel. |
| coturn | `cpu: 500m`, `mem: 512Mi` | `mem: 1Gi` | Relay only. |
| PgBouncer | `cpu: 500m`, `mem: 256Mi` | `mem: 512Mi` | Single-threaded per process. |
| Postgres | `cpu: 2`, `mem: 8Gi` | `mem: 8Gi` (requests == limits, Guaranteed QoS) | A database that gets evicted under memory pressure is not a database. |

### 7.6 Probes

Built on what `main.go` actually implements — these endpoints exist and their
semantics are already argued in the source.

```yaml
# go-api
startupProbe:                     # boot does db.Connect + optional RLS assertions
  httpGet: {path: /livez, port: 4000}
  periodSeconds: 2
  failureThreshold: 30            # 60s to start; then liveness takes over
livenessProbe:
  httpGet: {path: /livez, port: 4000}
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3
readinessProbe:
  httpGet: {path: /ready, port: 4000}
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 2
terminationGracePeriodSeconds: 75
```

**Liveness is `/livez`, never `/health`.** `/health` pings Postgres and Redis on
every call with a 2s bound. A kubelet probe at the default `timeoutSeconds: 1`
against a *slow* database times out and restarts the pod — turning a database
slowdown into a cluster-wide restart storm. `/livez` touches nothing: if the
scheduler can run the handler, the process is alive, which is the entire
question liveness asks. The source says this at length and it is correct.

**Readiness is `/ready`**, which returns 503 on `!dbOK` **and** immediately on
SIGTERM via the `draining` flag — so endpoint removal starts on the signal, not
on the next probe tick. Note Redis being down does *not* make the pod unready,
deliberately: the limiter falls back in-process and the socket layer falls back
to local maps, so a Redis outage is degradation, not outage. Alert on the body,
do not pull the pod.

**The grace-period arithmetic must be respected:**
`SHUTDOWN_DRAIN_DELAY` (10s, must exceed `readinessProbe.periodSeconds ×
failureThreshold` = 10s, so make it 15s) `+ SHUTDOWN_TIMEOUT` (45s) `+` margin
`=` `terminationGracePeriodSeconds: 75`. If tGPS is shorter, the kubelet
SIGKILLs mid-drain and none of the careful shutdown ran.

| Workload | liveness | readiness | note |
|---|---|---|---|
| LiveKit | TCP 7880 | `GET /` on 7880 | tGPS 900 (§3.5) |
| coturn | `exec: turnutils_uclient -y ...`, or TCP 3478 | none (DaemonSet, hostNetwork) | a TCP check on 3478 proves the listener, not the relay — accept it |
| Valhalla | TCP 8002 | `GET /status` | startupProbe `failureThreshold: 60` — mapping 4.4 GB of tiles is not instant |
| egress | process liveness only | **none** | it has no inbound traffic; a readiness probe on a queue consumer means nothing |
| PgBouncer / Postgres | operator-managed | operator-managed | do not override |
| games | TCP on its port | HTTP if the binary has a health path — **unknown** | §11.2 |

---

## 8. Secrets

### 8.1 The two that matter

```
VAULTCHAT_MASTER_KEY     32 bytes, hex or base64
VAULTCHAT_LOOKUP_PEPPER  64 chars
```

`docs/ENV_INVENTORY.md §1` is titled "LOSE THESE AND THE DATA IS GONE" and is
not exaggerating. The master key is the HKDF root for the AES-GCM encryption of
**every PII column** — email, phone, first/last name, DOB, status, photo key.
The pepper produces `users.email_lookup` / `users.phone_lookup`, the only way
login finds an account at all.

### 8.2 The disaster case, plainly

**Lose `VAULTCHAT_MASTER_KEY` and every health check stays green.**

`/livez` returns 200 — the process is fine. `/ready` returns 200 — Postgres is
reachable. Prometheus shows normal request rates and *better* latency, because
decryption is no longer happening. Postgres is up, replicating, and backed up;
its backups are perfect copies of ciphertext nobody can read. Every existing
user's name, phone and email is an AES-GCM blob with no key, and no migration,
no reset and no support process recovers it. New signups work, which makes it
look like a partial outage rather than a permanent one.

Lose the **pepper** and login stops finding accounts — recoverable *only* by
decrypting every row with the master key and re-deriving. Lose **both** and
there is nothing to re-derive from.

There is no key id in the envelope (`version(0x01) | salt | iv | ct | tag`), so
a second master key cannot coexist with the first. **Rotation is a full
re-encrypt of every PII column, not a roll**, and it needs a schema change to
carry a key version before it is even possible.

### 8.3 Design

**External Secrets Operator, with the source of truth outside the cluster.**

```
HashiCorp Vault (or equivalent managed KMS/secret store)
        │  ClusterSecretStore (auth: Kubernetes ServiceAccount / JWT)
        ▼
ExternalSecret  ──►  Secret (namespaced, RBAC-restricted)
        │
        ▼
go-api pods: env from Secret; file-type secrets via `secret` volume
```

Why ESO over Sealed Secrets: **Sealed Secrets puts the ciphertext in git and the
decryption key in the cluster.** For a value whose loss is permanent, that means
your recovery story is "restore the controller's private key", and the git
history now contains encrypted copies of the one secret you must never have a
stale copy of. ESO keeps the cluster a *consumer*: rotating in the vault
propagates, and a cluster rebuild re-fetches rather than re-decrypts. Sealed
Secrets remains fine for low-stakes config; do not mix mechanisms — one is
easier to audit.

**Carry over the file-not-env pattern.** `docker-compose.prod.yml` mounts the
FCM service account and the games signing key as *files*, so the credential
never appears in `docker inspect`, the process environment or a crash dump — the
Go code reads `*_FILE` env vars pointing at paths. Kubernetes has the same
split: `envFrom` puts values in the environment (visible in `kubectl describe
pod`-adjacent places and in any core dump), a `secret` volume puts them on a
tmpfs path. **Keep the `_FILE` pattern for FCM and the games key.** The master
key and pepper are read from the environment by `internal/vault/vault.go` and
changing that is a code change — note it as a hardening item, not a blocker.

**Non-negotiables:**
- Namespace-scoped `Secret` with RBAC limiting `get` to the go-api ServiceAccount.
- **etcd encryption at rest enabled on the cluster** — verify LKE does this by
  default **[A8]**; if it does not, that alone argues for keeping the master key
  as a file from a CSI secret driver rather than a `Secret` object.
- Audit-log every read of the vault path holding these two values, and alert on
  any read that is not the operator's ServiceAccount.

### 8.4 Backup — the part that actually saves you

**The cluster is not a backup. The vault is not a backup either** — a vault you
can delete by accident is a single point of failure with good marketing.

1. **Offline, geographically separated, at least two copies.** Printed or
   engraved, in sealed envelopes, in two locations. This is a 32-byte value; it
   fits on a card.
2. **Shamir split.** The repo already implements Shamir secret sharing for
   feature #207 (`memory: honesty_fixes_2026-06-16`). Use it: 3-of-5 shares to
   five holders means no single person can exfiltrate it and no single loss
   destroys it.
3. **Verify restorability quarterly.** Take a production PITR restore into an
   isolated namespace, point a throwaway go-api at it with the key *from the
   offline copy*, and confirm a PII column decrypts. A backup you have never
   restored is a belief, not a backup. Put it on the calendar next to the
   database restore drill (§10.4) — same drill, one extra assertion.
4. **Never in CI logs, never in an Argo manifest, never in a Slack message.**
   ESO means it never has to be.

### 8.5 Rotation policy, per secret

| Secret | Rotatable? | Cost |
|---|---|---|
| `VAULTCHAT_MASTER_KEY` | **Effectively no** — needs a key-version column, a dual-key decrypt path, and a full re-encrypt of every PII column | A project. Design the key-version field *now* while there are few users. |
| `VAULTCHAT_LOOKUP_PEPPER` | Only with the master key intact: decrypt-and-re-hash `users.phone_lookup`/`email_lookup`, **plus** a deliberate phone-OTP lockout window — `otp_codes.phone_hash` rows are ephemeral and cannot be backfilled (`SECRETS.md`). **Tooling half-exists**: `scripts/pepper-phone-hash-backfill.js` already does the `users.phone_hash` re-key and is the template for a rotation, though it is written as a one-off (sentinel-gated, irreversible) rather than a repeatable roll. Runs as a §10.3b data-migration Job | Hours, with a user-visible window |
| `JWT_SECRET` | Yes | Every session re-logins. **And** every outstanding group-invite link is voided, because `INVITE_SECRET` is unset and falls back to it (`chats_invitations.go:44`). Set `INVITE_SECRET` explicitly to decouple them. |
| `TURN_SECRET` | Yes, if coturn and go-api restart together | Both read the same value; stagger and TURN auth fails |
| LiveKit keys ×2 | Yes, per SFU | Must never be equal across the two — `golive.Usable()` refuses an overlap on purpose |
| Games ed25519 pairs | Yes, but both halves together | §11.2 |
| S3/R2 credentials | Yes, freely | Objects are not at risk, only access |
| FCM service account | Yes, re-download from Firebase | None |

---

## 9. Images, registry, provenance

### 9.1 Registry

Use the registry your CI already authenticates to (GHCR is fine), **with an
in-region pull-through cache or mirror if the catalogue offers one** — this
matters specifically because of the 4.5 GB tiles image and the media pool's
cold-start behaviour. Private repos, immutable tags enabled at the registry
level so a tag cannot be moved after push.

### 9.2 Tagging

**Never `:latest`.** The repo has already been bitten: `docs/REBUILD_RISKS.md:323`
records Valhalla pinned to `:latest` as a "floating" risk, and the compose file
records a production incident where the repo's pinned LiveKit versions
(v1.8/v1.8.4) disagreed with what the box actually ran (v1.13.5/v1.14.0), so a
rebuild from git deployed a Go Live that did not work.

```
ghcr.io/<org>/vaultchat-go-api:<git-sha>-<source-fingerprint>
ghcr.io/<org>/valhalla-tiles:india-2026-09-14
ghcr.io/<org>/vaultchat-games:imported-2026-09-14   # §11.2
```

**Deploy by digest, not tag.** Argo manifests carry
`image: ghcr.io/...@sha256:...`. The tag is for humans; the digest is what runs.
An image updater (Argo CD Image Updater, or a CI commit) resolves tag → digest
and commits it, so git always records exactly what is deployed.

### 9.3 Scanning

- **Build time:** Trivy (or Grype) on the image; fail the build on
  `CRITICAL` with a fixed version available. Do not fail on unfixed CVEs — that
  just teaches people to add `--ignore`.
- **Continuously:** re-scan deployed digests nightly; a CVE published today
  affects an image built last month, and only a recurring scan finds it.
- **Base images:** `alpine:3.20` for go-api (already), distroless where the
  binary is static. Pin base images by digest too.
- **Supply chain:** `cosign sign` every image; an admission policy (Kyverno or
  Sigstore policy-controller) that refuses unsigned images in the app namespace.
  Generate an SBOM and attach it as an attestation.

### 9.4 Carrying the source fingerprint into Kubernetes

The Dockerfile already computes a sha256 over every non-test `.go` file plus
`go.mod`/`go.sum` — CR-stripped, `LC_ALL=C` sorted, filename hashed alongside
content — and injects it via `-ldflags -X main.buildSource`, reported at
`GET /build`. The reasoning is worth preserving verbatim: the box builds from a
working tree hundreds of commits behind its own HEAD, so a git SHA "would be a
confident lie". The fingerprint answers "is prod running *this code*" with a
string comparison.

**Carry it four ways:**

**(a) Into image metadata at build time.**

```dockerfile
LABEL com.vaultchat.source-fingerprint="$SRC_HASH"
LABEL org.opencontainers.image.revision="$GIT_SHA"
LABEL org.opencontainers.image.source="https://github.com/<org>/<repo>"
```

Now `crane config <digest>` answers the question without a running pod.

**(b) Into the tag.** `<git-sha>-<fingerprint>` makes drift visible in
`kubectl get pods -o wide` — two pods with the same git sha and different
fingerprints is a working-tree build that escaped, and you can see it.

**(c) As a cosign attestation.** Sign a statement binding
`digest → {git sha, fingerprint, builder identity}`. Admission then enforces
that only CI-built images run, which is the property `scripts/fingerprint-go.sh`
was reaching for manually.

**(d) As a post-deploy CI gate — the one that actually catches things.**

```bash
# after Argo reports Synced+Healthy
want=$(crane config "$DIGEST" | jq -r '.config.Labels["com.vaultchat.source-fingerprint"]')
got=$(curl -fsS https://api.corefinite.com/build | jq -r .source)
[ "$want" = "$got" ] || { echo "FINGERPRINT MISMATCH: want=$want got=$got"; exit 1; }
```

This closes the loop end-to-end: the fingerprint in git, in the image label, in
the attestation, and in the process answering on the public hostname must all be
the same string. It also catches the class of failure nothing else does — a
rollback that only half-applied, or a pod that survived a deploy.

`/build` is unauthenticated on purpose ("the first thing you need during an
incident, when you may not have a token") and discloses only a non-invertible
hash and a timestamp. Keep it public; it costs nothing and is load-bearing
during an incident.

---

## 10. GitOps, CI/CD, migrations, observability, backups

### 10.1 Argo CD

**Argo CD over Flux**, for two reasons specific to this system:

1. **Sync waves and hooks solve the migration-ordering problem declaratively.**
   A `PreSync` hook Job runs to completion *before* the new ReplicaSet exists.
   Flux can express ordering with `dependsOn` between Kustomizations, but
   expressing "run this Job, once, before this Deployment updates, in the same
   reconciliation" is native in Argo and assembled in Flux.
2. **The UI is the argument during an incident.** Per-resource diff, sync
   status, and one-click rollback to a previous revision, readable by someone
   who is not the person who wrote the manifests. Given this project's history
   of "the file said 80:80 while the running container had 8095", a tool whose
   headline feature is *showing you live drift* is the right tool.

Flux is the better answer if you want pure-git, no-server, multi-tenant
reconciliation and the team lives in the CLI. This system is one team, one
cluster, and has an incident history that rewards visibility.

**Repo layout:** a separate `vaultchat-deploy` repo (manifests + Helm values),
not this one. App code and cluster state on different review cadences, and CI
commits digests there without touching application history.

**App-of-apps:** one `ApplicationSet` generating an `Application` per component,
so `media/*` can carry `syncPolicy: manual` (§3.5) while `app/*` is fully
automated with `prune: true` and `selfHeal: true`.

### 10.2 Pipeline

```
push → test (go test ./..., tsc) 
     → build (Dockerfile, computes SRC_HASH)
     → scan (trivy, fail on fixable CRITICAL)
     → sign + attest (cosign)
     → push to registry
     → commit digest to vaultchat-deploy/staging
     → Argo syncs staging → smoke test (incl. the /build gate)
     → promote: PR moving the SAME digest to vaultchat-deploy/prod
```

**Promotion moves a digest, never rebuilds.** The artifact tested in staging is
byte-identical to the one that reaches production. A rebuild between
environments makes staging a rehearsal for a different play.

### 10.3 Migrations — the ordering problem

**Mechanism:** an Argo CD `PreSync` hook Job.

```yaml
metadata:
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  backoffLimit: 0        # a failed migration must not retry blindly
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/<org>/vaultchat-migrate@sha256:...
          command: ["node", "migrate.js", "up"]
```

**Why a PreSync hook and not an initContainer.** An initContainer runs **once
per pod**, so a 3-replica rollout starts three concurrent `migrate.js up`
processes. `migrate.js` is transactional per file and ledgered — which stops
double-*application* — but it takes **no advisory lock** (F5), so concurrent
runners race on the ledger read and can deadlock or fail a deploy for no reason.
A PreSync hook is one Job, so it cannot race itself by construction.

**Also fix the root cause, because a human can still run it by hand.** One line
at the top of `migrate.js`:

```js
await client.query("SELECT pg_advisory_lock(hashtext('vaultchat_migrations'))");
```

A session-level advisory lock, released when the connection closes. Three lines
including the unlock, and it makes concurrency safe everywhere rather than just
in the happy path Argo controls. *(Note: this needs a direct Postgres
connection, not PgBouncer in transaction mode — session-level locks do not
survive transaction pooling. Point the migration Job at the CNPG `-rw` service
directly, bypassing the Pooler.)*

**Migrations must be backward-compatible.** A rolling update runs old and new
binaries against one schema simultaneously. Expand/contract, always:

```
release N:   add nullable column / add table / add index CONCURRENTLY
release N+1: backfill + start writing it
release N+2: make it NOT NULL / drop the old column
```

Never rename or drop in the same release that stops using something.

**And there is an existing hole here worth closing.** `CREATE INDEX
CONCURRENTLY` cannot run inside a transaction, and `migrate.js` wraps every file
in `BEGIN/COMMIT`. `134_fk_indexes.sql:45-49` knows this, says so in a comment,
builds its indexes **non-concurrently** (taking a write lock on `messages` for
the duration of the build), and tells the operator to create
`idx_messages_sender_id` by hand with CONCURRENTLY before deploying.
`055_message_client_id.sql:18` does the same. **A manual pre-step in a comment
is not a deploy procedure** — under Argo it will be skipped, and the PreSync Job
will instead take a write lock on the messages table mid-deploy.

The fix is small: a naming convention (`NNN_*.concurrent.sql`) that `migrate.js`
runs **outside** a transaction, ledgered as usual. Ten lines in the runner, and
it turns a comment nobody reads into something the pipeline enforces. Until that
exists, every migration adding an index to a large table is a lock incident
waiting for a busy evening.

### 10.3b Data migrations are a different object from schema migrations

`migrate.js` only executes `.sql` and **cannot bind a secret** — hardcoding the
pepper into a committed `.sql` would leak it into git. So this repo already has a
second class of migration that the runner structurally cannot run:
`scripts/pepper-phone-hash-backfill.js` re-keys every `users.phone_hash` and
encrypts legacy plaintext `users.phone` into `phone_cipher`. It needs **both**
`VAULTCHAT_MASTER_KEY` and `VAULTCHAT_LOOKUP_PEPPER`, is **irreversible if run
twice** (peppered and unpeppered values are both 64-hex and indistinguishable),
self-gates with its own sentinel table, and must land in the same release window
as the code that reads the new format.

None of that fits a PreSync hook, and forcing it to would be actively dangerous:

| Property | Why PreSync is wrong for it |
|---|---|
| Long-running (row-by-row over the whole `users` table) | Blocks the sync; Argo's timeout kills it mid-backfill |
| Needs the master key and pepper | The schema-migration Job should **not** mount either — keep that blast radius small |
| Irreversible, sentinel-gated | Must be run deliberately by a human, never swept up by an automated sync |

**So: a separate `Job`, not a hook.** Committed to the deploy repo with
`syncPolicy: manual` and `ttlSecondsAfterFinished`, mounting the vault secrets
that the schema Job deliberately does not, with `backoffLimit: 0` and
`activeDeadlineSeconds` sized generously. A human triggers it in the release
window; the sentinel table makes a double-trigger safe. This is the same
reasoning that keeps `scripts/enable-rls-force.sql` out of the migration
sequence (§11.4) — **operational switches and data rewrites are not schema
changes**, and the runner should stay unable to perform them.

The general rule this establishes, worth writing into the deploy repo's README:
*schema migrations are automatic and secretless; data migrations are manual and
secret-bearing.* Two Job templates, never one.

### 10.4 Zero-downtime rollout and rollback

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate: {maxSurge: 1, maxUnavailable: 0}
minReadySeconds: 15
```

`maxUnavailable: 0` — never reduce socket capacity below steady state during a
deploy. `minReadySeconds: 15` stops a crash-looping-after-30s build from
replacing the whole fleet before anyone notices.

**What a user experiences:** each terminating pod flips `/ready` to 503 on
SIGTERM, keeps serving for `SHUTDOWN_DRAIN_DELAY` while the endpoint is removed,
then `hub.Shutdown(10s)` tells its sockets to reconnect. The client's jittered
reconnect lands them on a surviving pod. **This is a brief reconnect, not zero
disruption** — with 12 pods, a rolling deploy reconnects roughly 1/12 of users
at a time. Honest framing: zero *downtime*, not zero *disruption*.

**Rollback:**
- **Application:** Argo rollback to the previous revision → previous digest.
  Seconds. Verify with the `/build` gate, not by looking at the tag.
- **Schema: there is no rollback.** `migrate.js` has no `down`. This is the
  constraint that makes expand/contract mandatory rather than advisable: **every
  migration must be safe against the binary that preceded it**, because that is
  the binary you will roll back to.
- **Data:** PITR to a timestamp before the bad migration. That is a restore, not
  a rollback — minutes to an hour, and it loses everything committed since.
  Treat it as the last resort it is.

### 10.5 Observability

**Metrics.** go-api exposes Prometheus text format at `GET /internal/metrics` —
hand-rolled (`internal/metrics/metrics.go`), not client_golang, with cumulative
histograms, route-pattern labels and scrape-time gauge readers. A
`ServiceMonitor` with `path: /internal/metrics` scrapes it in-cluster; the
ingress 404s that prefix from outside, which is the correct arrangement.
kube-prometheus-stack for everything else; LiveKit and coturn both export
Prometheus natively.

**Logs.** Loki + Alloy. LiveKit already logs JSON (`logging.json: true`, chosen
"so Loki/Promtail can parse it"). Set go-api to structured output too.
**Retention: short.** This is a privacy messenger — logs that accumulate user
identifiers are a liability that grows. 14 days hot, nothing archived, and an
explicit rule that user content never reaches a log line.

**Traces.** **Skip for now.** There is no OpenTelemetry instrumentation in the
repo, and adding it across ~17 route modules is a project, not a config. The
existing per-route histograms answer "which endpoint is slow"; traces answer
"why", and you do not need that until the metrics stop being enough. **Trigger
to revisit:** the first incident where a p99 spike cannot be attributed from
metrics alone.

**Alerts that matter for *this* system** (not generic CPU/memory):

| Alert | Condition | Why |
|---|---|---|
| Retention guarantee broken | `message_bodies_overdue > 0` for 30m | The three-hour delete-on-delivery promise is silently not being met. This is a *product* guarantee with a metric already wired (`chats_bodies.go:403`). |
| Socket cliff | `sockets_online` drops >30% in 5m without a deploy | The only signal that realtime is broken for everyone; HTTP checks stay green through it. |
| RLS returning nothing | 2xx rate normal **and** a business counter (messages sent, chats listed) near zero | The RLS failure mode: "empty is the symptom. Not errors — empty." Nothing else catches it. |
| Backpressure | `workx` inline runs rising | Side-work pool saturated — the pre-lag signal. |
| PITR staleness | last successful WAL archive > 10m | Silently broken backups are the classic. |
| Replication lag | > 30s | RPO is a lie above this. |
| Cert expiry | < 14 days | Especially `turn-tls`, which fails invisibly for TURNS-only clients. |
| Pods not ready | go-api ready < 2 for 5m | PDB floor breached. |
| Fingerprint drift | the §9.4 gate failing | Something is running that CI did not build. |

### 10.6 Backups and RPO/RTO

| What | Mechanism | RPO | RTO |
|---|---|---|---|
| **Postgres (vaultchat)** | CNPG continuous WAL archiving + daily base backup to object storage, in a **different region than the cluster** | **≤ 5 min** (WAL archive timeout 300s); ≈0 for a same-region failover thanks to the sync replica | **≤ 30 min** for a full PITR restore of this schema size; **< 60s** for an automatic primary failover |
| **Postgres (vaultgames)** | same cluster, same backup — which is already a strict improvement: its only current backup is local-only and never copied off-box (`REBUILD_RISKS.md §7`) | ≤ 5 min | ≤ 30 min |
| **Object storage (media, HLS)** | provider durability + bucket versioning + lifecycle rules for orphaned multipart uploads | ~0 | ~0 |
| **Cluster state** | Argo CD — git *is* the backup. Velero adds PVC snapshots and the handful of things git cannot hold | 24h (Velero schedule) | ≤ 2h to rebuild a cluster from git |
| **Valhalla tiles** | the image | 0 | minutes (image pull) |
| **Master key + pepper** | vault + offline Shamir shares (§8.4) | — | **hours** (physical retrieval), and **∞ if the offline copies were never made** |
| **Games binary + data** | `docker save` of the imported image in the registry; its database in CNPG | ≤ 5 min | ≤ 1h |

**Stated targets:** **RPO 5 minutes, RTO 1 hour** for a full loss of the
cluster within one region. Both are meaningless until the restore drill in §8.4
has been run once and timed — a target you have never measured is a hope.

**Velero specifically:** back up namespaces + PVs on a daily schedule to object
storage, but understand what it is *for* here. With Argo, the cluster is
reproducible from git; Velero's real value is (a) PVC data for anything not
covered by CNPG, (b) a fast path to un-delete a namespace someone removed, and
(c) CRD/resource state that drifted. Do not treat it as the database backup —
CNPG is.

---

## 11. Hard problems and how we solve them

### 11.1 UDP media

Covered in §3. Summary: **LiveKit needs one UDP port per SFU, not a range** —
that is the finding that makes this tractable. Signalling (TCP/WSS) goes through
the NodeBalancer; media (UDP) goes direct to a media node's public IP via
`hostNetwork`, advertised in ICE candidates by `rtc.node_ip` / `--external-ip`
injected from the Downward API. **coturn's 16,384-port range rules out every
load balancer and every NodePort scheme** — a `hostNetwork` DaemonSet on the
media pool is the only honest answer, and clients get all TURN nodes in their
ICE server list so ICE does the failover. Node replacement drops live calls on
that node; the mitigation is cordon → wait for empty → drain in a chosen window,
never as a side effect of a deploy.

### 11.2 The opaque games binary

**What it is.** `/opt/vaultgames/go-server` — an external binary with no source
anywhere in this repo, started by `/opt/vaultgames/run.sh` with `docker run`,
carrying **no compose labels at all**. Its entire configuration exists in one
place: the running container. That configuration includes
`GAMES_NOTIFY_SIGNING_KEY_PEM` — a **multi-line ed25519 private key inlined as
an environment variable**, which `ENV_INVENTORY.md §2a` flags as the one value a
careless `sed`-style redaction will leak. It owns a separate `vaultgames`
Postgres database holding every player balance, rating and friend list, with
DSNs **pinned to compose-generated container names**
(`postgres://vaultgames:…@vaultchat-postgres-1:5432/vaultgames`), which hold only
as long as the compose project directory keeps its basename.

**This is a constraint, not a component to redesign. The migration is
archaeology, in this order:**

1. **Capture before anything else.**
   `docker inspect vaultchat-games > games-inspect.json` and
   `docker save vaultchat-games:latest | gzip > games-image.tgz`, both off-box,
   both today. Everything below depends on these two files existing. Also
   `pg_dump -d vaultgames` off-box — its current backup is local-only.
2. **Re-tag and push the saved image** as
   `ghcr.io/<org>/vaultchat-games:imported-2026-09-14`. It is now a normal,
   digest-addressed, scannable artifact. **It cannot be rebuilt or patched** —
   accept that and write it on the tag.
3. **Lift every env var from `games-inspect.json` into the vault**, then into an
   `ExternalSecret`. The multi-line PEM works fine as a Secret value.
   **Regenerate the ed25519 pair during the migration** rather than carrying a
   key that has spent its life in `docker inspect` output — the public half goes
   to go-api as `GAMES_NOTIFY_PUBLIC_KEY_FILE`, and both halves must rotate
   together or verification fails one-way and silently.
4. **Break the container-name DSN dependency.** This is the one change that is
   forced: `vaultchat-postgres-1` does not exist in Kubernetes. Override
   `GAMES_DB_URL` and `GAMES_REDIS_URL` to Kubernetes service DNS
   (`vaultchat-pg-rw.data.svc.cluster.local`, the app Redis service). Both are
   env vars, so **no binary change is needed** — which is the whole reason this
   is survivable.
5. **Deploy it as a `Deployment`, `replicas: 1`, `strategy: Recreate`.** Not 2.
   Not RollingUpdate. There is no source, so there is no way to know whether it
   holds process-local state, whether two instances would corrupt the
   `GAMES_DATA_FILE`, or whether it tolerates a second writer. `Recreate` +
   `replicas: 1` means at most one process, ever — brief downtime on every
   restart, which is the correct price for not knowing. No PDB (a PDB on a
   singleton blocks node drains forever).
6. **Give it its own namespace and a restrictive `NetworkPolicy`:** egress only
   to Postgres, Redis and go-api; no general internet. It is the least-known
   thing in the cluster and should have the smallest reach.
7. **Its database joins the CNPG cluster** as a second database with its own
   role — which upgrades its backup from "local only, never copied off-box" to
   the same PITR everything else gets. Strictly better than today.
8. **Delete `/opt/vaultgames/keys/ed25519.key`** on the old host.
   `docs/GAMES_INTEGRATION.md §2` has already proven all four preconditions —
   the games server does not read it, it is a duplicate of the VaultChat-side
   key, and the container cannot even see the directory. One `shred -u`.

**What is still unfixable:** if that binary is lost, the games feature cannot be
rebuilt at all. The registry copy is now the only artifact. Back up the registry.

### 11.3 The tile volume

Covered in §5. Summary: the *runtime* set is **4.4 GB, not 9.8 GB**, because
`use_tiles_ignore_pbf=True` means the 1.7 GB OSM extract is build input, not
runtime data — so ship `valhalla_tiles.tar` and `valhalla.json` only. Bake them
into a versioned OCI image and run Valhalla *from* that image with no volume at
all: immutable, content-addressed, cached per node by containerd, and identical
for every replica, which is exactly what an image layer is for. Costs ~4.5 GB of
image and a multi-minute first pull per node, mitigated by a pre-pull DaemonSet.
Rejected RWX (a new distributed filesystem and a new SPOF for a read-only
problem), ROX (block storage does not multi-attach), and init-container sync
(turns a one-time cost into a per-pod-start cost, forever).

### 11.4 The RLS roles

**The hinge is whether the platform lets you create a `BYPASSRLS` role.** If
Akamai's managed Postgres does not — the likely case, since that requires
superuser — then **managed Postgres is disqualified** and CloudNativePG is the
answer (§4). Verify with one `CREATE ROLE rls_probe NOLOGIN BYPASSRLS;` before
any other decision, because everything downstream depends on it.

**Build the cluster with RLS already enforced.** Today it is inert — the app
connects as a bootstrap superuser that owns every table, so all 33 policy-bearing
tables are decorative. Greenfield is the cheapest possible moment to fix that:
no existing sessions, no users to break, no rollback window to negotiate.

The order is fixed and each step is already prepared in this repo:

1. Bootstrap the CNPG cluster with a superuser that is **not** the application
   role, and have migrations run as an owner role that is also not the
   application role.
2. Apply migrations through `135`, including `133_rls_roles.sql` — creates
   `vaultchat_app` and `vaultchat_sys` `NOLOGIN`/passwordless, grants data
   privileges on current *and future* objects, owns nothing, and aborts if
   either role comes out privileged or owning a table.
3. `ALTER ROLE ... LOGIN PASSWORD` from the vault; ESO delivers both to go-api as
   `DB_USER`/`DB_PASS` and `DB_SYSTEM_USER`/`DB_SYSTEM_PASS`.
4. Set **`DB_RLS_ENFORCE=1`**. `internal/db/rls.go` then asserts at boot that
   both roles are what the cutover requires and **refuses to start otherwise** —
   which is exactly the property you want in a Deployment, because a
   misconfigured pod CrashLoops visibly instead of serving empty results.
5. Run `scripts/enable-rls-force.sql` as a one-off Job (**not a migration** — the
   repo is emphatic and right: a routine `migrate.js up` must never enforce RLS
   behind an operator's back).

**The failure mode to design the alerting around:** *a policy that is subtly
wrong returns zero rows. It does not error.* The API boots, `/ready` returns
200, logs are clean, metrics show queries completing *faster* — and every chat
list, message thread and call is empty. This is why §10.5 alerts on a business
counter near zero while the 2xx rate is normal. Nothing else detects it.

**The residual gap, stated:** RLS covers 6 tables with policies; 33 have it
enabled; stories, channels, communities, shopbook, vaultbeam, devices and users
have never had it and are protected by route-layer checks alone. This is
defence-in-depth for chats/messages/attachments/calls, **not** a blanket
guarantee. Extending it is separate work with a much larger surface.

**One PgBouncer detail that is load-bearing:** `WithUser` must stay
transaction-scoped (`set_config($1,$2,true)`). A session-scoped `SET` under
transaction pooling leaks one user's RLS identity onto the next request that
gets that server connection. That is a cross-user data leak with no error and no
log line. Worth a CI lint rule forbidding `SET ` outside `set_config(..., true)`
in `internal/`.

### 11.5 The master key

Covered in §8. Summary: **losing `VAULTCHAT_MASTER_KEY` is unrecoverable and
every health check stays green while it happens.** The key is the HKDF root for
AES-GCM over every PII column; the envelope carries a version byte but **no key
id**, so two keys cannot coexist and rotation is a full re-encrypt requiring a
schema change that does not yet exist. Store it in an external vault consumed
via ESO (not Sealed Secrets — the cluster must be a consumer, not the owner),
back it up offline as 3-of-5 Shamir shares in two geographic locations using the
sharing code this repo already has, and prove it quarterly by restoring a PITR
snapshot into an isolated namespace and decrypting one PII column with the
*offline* copy. Add a key-version field to the envelope now, while the user
count is small enough that a re-encrypt is an afternoon.

---

## 12. Multi-AZ / HA reality check

### 12.1 What is achievable

| Layer | Zone-fault behaviour | Honest verdict |
|---|---|---|
| go-api | Spread across 3 zones; losing one drops ~⅓ of sockets, which reconnect to the survivors within seconds | **Genuinely HA.** The client's jittered reconnect makes this a blip. |
| Postgres | Sync replica in a second zone; CNPG promotes in < 60s | **Genuinely HA**, at the cost of one cross-AZ round trip per commit. Requires ≥3 zones in the region **[A9]**. |
| Redis (app) | Sentinel across 3 zones | HA, with a few seconds of failover during which the limiter and presence fall back in-process — which the code already handles by design. |
| Ingress | 3 controllers, NodeBalancer health-checks them out | HA. |
| Valhalla | 2 replicas, stateless, tiles in the image | HA. |
| Object storage | Provider-managed | Outside the cluster's failure domain entirely. |

### 12.2 What is not

**Live media is zone-pinned and cannot be made HA.** A call lives on exactly one
SFU node. Losing that node — or its zone — drops every call on it, immediately,
with no failover path. LiveKit has no session migration and neither does coturn.
The *only* recovery is client-side: ICE restart, then a fresh `sfu-token` and
rejoin. What the design buys you is that **new** calls land elsewhere within
seconds, and that the blast radius is one node's worth of calls rather than all
of them.

**The games server is a single point of failure by construction.** One replica,
`Recreate`, no source. A node failure takes games down until it reschedules —
tens of seconds to a couple of minutes. Two replicas is not available as an
option, because nothing can establish that the binary tolerates it.

**Egress renders are lost on interruption.** A broadcast whose egress pod dies
mid-render does not resume; the reaper
(`routes/broadcast_reaper.go`, `StartGoLiveHostSweep`) releases the host so they
can go live again, which is the correct recovery, but the stream ends.

**PgBouncer transaction pooling means in-flight transactions die on failover.**
Expected and correct; the client retries.

### 12.3 Where a single region leaves you exposed

**A region-wide outage is a full outage. There is no hot standby in this design,
and adding one would roughly double the bill for a failure mode that is rare and
usually short.**

What exists instead:

- **Off-region PITR backups.** CNPG archives WAL and base backups to object
  storage **in a different region than the cluster** — non-negotiable, since a
  backup that shares a failure domain with the primary is not a backup. This is
  the difference between "down for a few hours" and "the company is over".
- **A cluster reproducible from git.** Argo CD means a new LKE cluster in
  another region is a `ClusterSecretStore` re-point and a sync. The long poles
  are DNS propagation, the Postgres restore, and the 4.5 GB tiles pull — not
  manifest authoring.
- **A documented, rehearsed restore.** Untested, the RTO above is fiction.

**Honest region-loss numbers:** **RPO 5 minutes** (last archived WAL),
**RTO 2-4 hours** (provision cluster, restore Postgres, re-point DNS, pull
images, verify) — and **only if the restore drill has actually been run.**

Two more region-level exposures worth naming:

- **Media latency is geographic and a single region cannot fix it.** Users far
  from the region get worse calls, full stop. The answer is additional media
  nodes closer to users — LiveKit supports multi-region SFU, coturn is already
  per-node — which this design accommodates (add a `media` pool in another
  region, hand its TURN URIs to clients in that geography) but does not
  implement. Do it when the call-quality metrics say to, not before.
- **Object storage is cross-region already.** R2 (or whichever S3-compatible
  store) survives a compute-region outage independently, so media and HLS
  segments are not part of the regional blast radius. Worth keeping that way —
  it is the largest data set and the one you most want outside the failure
  domain. Weigh egress cost between the storage provider and Akamai when
  choosing whether to move it.

---

## 13. Assumptions I could not verify from the repo

Everything here needs one check against Akamai's docs, a trial cluster, or the
live box. They are ordered by how much of the design moves if the answer is
"no".

| # | Assumption | Why it matters | How to verify |
|---|---|---|---|
| **A1** | Akamai NodeBalancer does not forward arbitrary UDP | The whole of §3 assumes media bypasses the LB. If UDP forwarding exists, LiveKit's *two* UDP ports could go through it (coturn's 16k still could not) | Akamai NodeBalancer protocol docs; try a UDP-protocol Service |
| **A2** | LKE does not permit widening `--service-node-port-range` | Rules out the NodePort variant for coturn — though SNAT and conntrack rule it out anyway | LKE control-plane customisation docs |
| **A3** | Linode Block Storage is RWO only; no managed RWX/NFS in-region; high-memory plans may lack local NVMe | Decides §5 (tiles) and Postgres WAL latency | LKE CSI driver docs; `kubectl get storageclass` on a trial cluster |
| **A4** | Downward API `status.hostIP` on LKE is the node's **public** IP, not a VPC-private address | If private, LiveKit must use `use_external_ip: true` (STUN) and coturn needs the metadata service instead | `kubectl get nodes -o wide` on a trial cluster; compare to the assigned public IP |
| **A5** | LiveKit multi-node clustering via Redis works as documented | This deployment has only ever run **one** node per SFU; §3 assumes N | Stand up 2 nodes, join from two clients, confirm cross-node room routing |
| **A6** | The RN client performs ICE restart + `sfu-token` re-fetch when a media node disappears | Determines whether §12.2's "only recovery" actually exists | Read `app/group-call-active.tsx` and the WebRTC layer; kill an SFU mid-call on the bench |
| **A7** | coturn's live port range is `49152-65535` (the conf) and not `49160-49200` (the compose comment) | 40 ports would make NodePort *arguable*; 16k does not. The conf is what coturn reads, so the conf wins — but the disagreement is unexplained | `docker exec vaultchat-coturn-1 cat /etc/coturn/turnserver.conf` on the box |
| **A8** | LKE enables etcd encryption at rest by default | If not, the master key should come from a CSI secret driver rather than a `Secret` object | LKE security docs; ask support |
| **A9** | The target LKE region offers ≥3 availability zones with zone-aware node pools | Every anti-affinity and sync-replica claim in §12 depends on it | Akamai region capability matrix |
| **A10** | `vaultlens` is **deleted**, not merely stopped | `docker-compose.yml` records its removal as "the LAST running Node process"; the task brief lists it as a live component. Designed here as optional and scale-to-zero | `git log -- vaultlens/`; ask |
| **A11** | The games server is **live**, despite `SCALEOUT.md` saying "the games platform was deleted on 2026-08-02" while `GAMES_INTEGRATION.md` says "deployed to production 2026-08-22" | Determines whether §11.2 is work or archaeology-for-nothing | `docker ps` on the box; `curl games.corefinite.com` |
| **A12** | LiveKit **egress** ×2 is required in production | Not in the task's component list, but Go Live is dead without it (it writes the HLS playlist) — and it is the only 4-core-floor workload, which shapes the media pool | Confirm Go Live is a shipping feature |
| ~~A13~~ | **Resolved — verified.** `134_fk_indexes.sql:45-49` and `055_message_client_id.sql:18` both build indexes non-concurrently and defer CONCURRENTLY to a manual pre-step in a comment. See §10.3 | A manual step in a comment is skipped by any pipeline | — |
| **A14** | Object storage stays on Cloudflare R2 rather than moving to Akamai's | R2's zero-egress is a real cost input; a move changes §10.6 and the broadcast-segment path | Commercial decision |
| **A15** | `node_ip` vs `use_external_ip` — the repo has flip-flopped on this twice with production consequences both times | Getting it wrong produces "signalling connects, media never arrives", the failure that looks exactly like "the SFU is broken" | Test on the trial cluster before writing the chart |

---

## Appendix: what NOT to build

Deliberate omissions, each with the trigger that would change the answer.

| Not building | Why | Build it when |
|---|---|---|
| Service mesh (Istio/Linkerd) | mTLS between 6 services is not worth a mesh's failure modes, and a mesh sidecar in front of long-lived WebSockets is a new class of timeout bug | Multi-tenancy, or a compliance requirement for in-cluster mTLS |
| Kafka | Removed from the prod shape already; in-process fan-out + Redis adapter is measured as sufficient | Fan-out needs a durable replayable log, not just a worker pool (`SCALEOUT.md`) |
| Distributed tracing | No instrumentation exists; the per-route histograms answer the current questions | The first incident where metrics alone cannot attribute a p99 spike |
| Multi-region active-active | Doubles cost; media is zone-pinned anyway so the hardest part does not get easier | Users on another continent, or a contractual regional SLA |
| A separate `batch` node pool | vaultlens and migration Jobs are rare and short | Batch work starts evicting go-api pods |
| ingress-level auth/WAF | The app owns auth; a WAF in front of an E2EE messenger inspects ciphertext and finds nothing | Credential-stuffing at the login endpoints outpaces `ConsumeSecure` |
| Sealed Secrets alongside ESO | Two secret mechanisms is one too many to audit | Never; pick one |
| A second `Pooler` for the system role | PgBouncer already pools per (database, user) | Never |

---

*Written 2026-09-14 against commit `d0ddada` on `hetzner-deploy`. Every
repo-grounded claim cites a file; every unverified claim is in §13. Nothing in
this document has been applied, and no prices or plan names appear in it.*
