# VaultChat Backend Scalability Architecture
## Supporting 100M–1B Users

**Status:** Phase 2–3 scaling roadmap (post-strangler, multi-node, microservices preparation)  
**Current capacity:** 3,000 socket deliveries/s (single Go process), 5,000+ idle sockets  
**Target:** 100M–1B registered users, 10M–100M concurrent  
**Timeline:** 18–24 months to production-ready global scale

---

## Current State (Phase 2: Strangler Complete)

```
┌─────────────────────────────────────────────────────────────────┐
│ Client (Expo/React Native) ─────────────────────────────────────│
│                    REST + Socket.IO + WebRTC                    │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│ Caddy (reverse proxy + per-route rollback)                      │
└──────────────────────┬──────────────────────────────────────────┘
                       │
        ┌──────────────▼──────────────────┐
        │   go-api (single instance)      │ ← Limit: ~20K connections
        │   · 17 REST modules             │          ~3K msg/s throughput
        │   · Socket.IO hub               │
        │   · Kafka producer              │
        └──────────────┬───────────────────┘
                       │
        ┌──────────────┼──────────────────────┐
        │              │                      │
   ┌────▼──┐     ┌─────▼──┐          ┌──────▼──┐
   │ PgSQL │     │ Redis  │          │ MinIO   │
   │ (1 DB)│     │ (cache)│          │ (media) │
   └───────┘     └────────┘          └─────────┘

Legend: Single-node, in-process fan-out, 10K-user launch capacity
```

**Measured limits (docker-compose.bench.yml):**
- HTTP p95 latency: 33–46 ms at 100–200 VUs
- Socket delivery: 3,000/s (p95 129 ms at peak); clean p99 <70 ms up to 2,500/s
- Idle sockets: 5,000+ stable, ~20 KB per socket (0.1 core overhead)
- Memory per socket: 20 KB baseline + message buffers

**Already built (not yet enabled in production):**
- Redis Socket.IO adapter (P2.1) — scales fan-out across replicas
- Redis presence cache (`vc:pres:*`, `vc:members:*`)
- Kafka event bus (KRaft, 3 brokers in compose)
- PgBouncer connection pooling (transaction mode)
- Per-route Caddy rollback (2-line flip per route)

---

## Architecture for 100M–1B Users

### Phase 3 (Months 1–3): Horizontal Scale-Out

**Goal:** Move from single instance to 10+ replicas, handling 100K–1M concurrent.

```
┌────────────────────────────────────────────────────────────────────┐
│ Clients (mobile + web)                                             │
└──────────────────────┬─────────────────────────────────────────────┘
                       │
┌──────────────────────▼─────────────────────────────────────────────┐
│ Global Load Balancer (GSLB)                                        │
│ · GeoIP routing (US, EU, APAC)                                    │
│ · Health checks (TCP + HTTP /health)                              │
│ · Circuit breaker on cascading failures                           │
└──────────────────────┬─────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│ Caddy Layer 1 (HTTP reverse proxy + rate limiting)          │
│ · Per-IP rate buckets: 100 req/s default                   │
│ · Per-API rate buckets: /auth 10/s, /chats 500/s          │
│ · gRPC → gRPC bridge (for future service mesh)             │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────┬───────────┼───────────┬──────────────────────────┐
│           │           │           │                          │
▼           ▼           ▼           ▼                          ▼
go-api-1  go-api-2  go-api-3  ... go-api-N (10–50 instances)
│           │           │           │                          │
├─ Auth     ├─ Chats    ├─ Upload   ├─ Call                   │
├─ User     ├─ Stories  ├─ VaultBeam├─ Presence               │
├─ Contact  ├─ Channels ├─ VaultLens└─ Search                 │
└───────────┴───────────┴───────────┴──────────────────────────┘
            (all instances share: cache, DB, queue, storage)

         ┌──────────────┬──────────┬──────────┐
         │              │          │          │
    ┌────▼────┐  ┌─────▼──┐  ┌───▼────┐  ┌─▼────────┐
    │PgBouncer│  │ Redis  │  │ Kafka  │  │ MinIO/R2 │
    │ cluster │  │ cluster│  │(KRaft) │  │  (S3)    │
    │ (40 TPS)│  │(Redis  │  │ (20    │  │          │
    └─────────┘  │Sentinel)  │ brokers)  └──────────┘
                 └────────┘  └────────┘

Capacity: 100K–1M concurrent, 10K–100K messages/s
```

**Key changes for P3:**
1. **Redis Adapter enabled** (`REDIS_ADAPTER=1`)
   - Socket.IO pub/sub across instances
   - Presence tracking in Redis (`vc:pres:*`)
   - Chat membership cache (`vc:members:*`, 30 s TTL)

2. **PgBouncer in transaction-pooling mode**
   - Max client connections: 2,000–5,000 (grow with replicas)
   - Default pool size: 40 per DB/user
   - Direct Postgres connections: 8 cores × 50 = 400 max

3. **Kafka enabled (EVENT_BUS=kafka)**
   - 3–10 brokers in KRaft mode (no Zookeeper)
   - Topics:
     - `messages.created`: 50K msg/s @ 100M users
     - `presence.changed`: 100K events/s @ 100M users
     - `call.signaling`: 10K events/s peak
     - `notification.queued`: 100K events/day

4. **Stateless go-api instances**
   - No process-local state (all in Redis)
   - Auto-scaling: spinup in 10 s, spindown in 60 s
   - Crash recovery: 15 s (Redis heartbeat TTL)

**Operational checklist for P3:**
- [ ] Enable `REDIS_ADAPTER=1` on single node (baseline)
- [ ] Deploy Redis Sentinel (3 masters + 6 replicas for failover)
- [ ] Spin second node, verify cross-node chat/calls/presence
- [ ] Add third node, load test to 100K concurrent
- [ ] Enable `EVENT_BUS=kafka` (asynchronous fan-out worker path)
- [ ] Test Kafka consumer failover (broker death, network partition)
- [ ] Scale gradually to N instances based on load metrics

---

### Phase 4 (Months 4–6): Microservices Decomposition

**Goal:** Break monolith into independent services for targeted scaling and fault isolation.

```
        ┌─────────────────────────────────────────┐
        │ API Gateway / Reverse Proxy             │
        │ (Caddy + rate limiting + auth validation)
        └────────────┬────────────────────────────┘
                     │
    ┌────────────────┼────────────────┬──────────────────┐
    │                │                │                  │
    ▼                ▼                ▼                  ▼
┌─────────┐    ┌─────────┐      ┌──────────┐      ┌─────────┐
│  AUTH   │    │  CHAT   │      │ PRESENCE │      │ UPLOAD  │
│ Service │    │ Service │      │ Service  │      │ Service │
│         │    │         │      │          │      │         │
│• Login  │    │• Send   │      │• Online  │      │• S3 pre │
│• JWT    │    │• Receive│      │• Activity│      │ sign    │
│• OTP    │    │• React  │      │• Status  │      │• Resume │
│• MFA    │    │• Read   │      │• Sync    │      │• Revoke │
│         │    │• Edit   │      │          │      │         │
│ 10 inst │    │ 100 ins │      │ 20 inst  │      │5 inst   │
└─────────┘    └─────────┘      └──────────┘      └─────────┘

    ▼                ▼                ▼                  ▼
┌─────────┐    ┌─────────┐      ┌──────────┐      ┌─────────┐
│  CALL   │    │VAULTLENS│      │  SEARCH  │      │ NOTIF   │
│ Service │    │ Service │      │ Service  │      │ Service │
│         │    │         │      │          │      │         │
│• Signal │    │• Queue  │      │• Index   │      │• FCM    │
│• TURN   │    │• Generate       │• Full-text      │• Email  │
│• SFU    │    │• MediaML API    │• Filters        │• SMS    │
│         │    │         │      │          │      │         │
│ 50 inst │    │ 20 inst │      │ 10 inst  │      │ 5 inst  │
└─────────┘    └─────────┘      └──────────┘      └─────────┘

All services connected by:
  · gRPC (internal, low-latency)
  · Kafka (async events)
  · Redis (cache, presence)
  · PostgreSQL (shared, sharded)

Capacity scaling per service:
  · Chat: 100–200 instances (highest volume)
  · Call: 50 instances (media-heavy)
  · Presence: 20 instances (high read-load)
  · Auth: 10 instances (stateless, quick responses)
  · Others: 5–20 based on demand
```

**Service definitions (derived from current routes):**

| Service | Current routes | Instances | Scaling driver | Notes |
|---------|---|---|---|---|
| **Auth** | `/auth`, `/user` (auth path) | 10 | User login rate | Stateless; strong cache |
| **Chat** | `/chats`, `/messages` (core) | 100–200 | Message throughput | Highest volume; read-heavy |
| **Presence** | WebSocket presence events | 20 | Concurrent users | Frequent updates; Redis-backed |
| **Call** | `/call`, `/call/sfu-token` | 50 | Concurrent calls | WebRTC signaling; media relay |
| **Upload** | `/uploads/presign`, `/uploads/{id}` | 5 | File throughput | I/O-bound; S3 presigning |
| **Download** | `/uploads/{id}` (streaming) | 10 | Bandwidth | I/O-bound; range requests |
| **VaultLens** | `/vaultlens`, queue consumer | 20 | AI queue depth | Batchable; external API calls |
| **Search** | `/search`, indexing consumer | 10 | Query volume | Elasticsearch-backed |
| **Notifications** | FCM/Email/SMS producer | 5 | Event rate | Async; external SaaS |
| **Stories** | `/stories`, story keys | 10 | Story creation rate | Lower volume; time-decay |
| **Community** | `/communities`, chat creation | 5 | Community creation | Time-decay; batch updates |

**Decomposition strategy (strangler pattern):**

1. Extract **Auth Service** (first, stateless, no cross-service calls)
   - Move `/auth` and user-auth endpoints
   - All other services still call in-process auth logic
   - Caddy routes `/auth` to Auth Service, others still to monolith
   - Timeline: Week 1–2, rollback: 2-line Caddyfile change

2. Extract **Chat Service** (core messaging, heaviest volume)
   - Move `/chats`, `/messages`, message delivery logic
   - Call monolith via gRPC for presence/auth checks
   - Caddy routes `/chats` to Chat Service
   - Timeline: Week 3–4, complex due to fan-out dependencies

3. Extract **Presence Service** (orthogonal, isolation win)
   - Move presence tracking and sync
   - Other services call via gRPC for online checks
   - Gains: independent scaling, no message throughput impact
   - Timeline: Week 5–6

4. Extract **Upload/Download Services** (I/O isolation)
   - Move file operations
   - Gains: don't compete with messaging for CPU
   - Timeline: Week 7–8

5. Extract **Call Service** (media-heavy, independent SFU)
   - Move WebRTC signaling, SFU token generation
   - Gains: can scale independently, easier SFU integration
   - Timeline: Week 9–10

6. Extract remaining services (lower volume, parallelizable)
   - VaultLens, Search, Notifications, etc.

**Communication patterns (RPC + async):**
```
Chat Service                 Presence Service
      │                             │
      │────(gRPC)─────────────────►│  check_online(user_ids)
      │◄────(response)──────────────│
      │
Chat Service                Auth Service
      │────(cache)──────────────────►
      │◄────────────────────────────│ validate_jwt (cached)
      │
Chat Service                Kafka Broker
      │────(async)──────────────────►
      │  message.created event
      │     (fanout-worker consumes)
      │
All Services              Redis Cache
      │────────────────────────────►
      │  r/w: presence, sessions, rates
```

---

### Phase 5 (Months 7–9): Database Sharding

**Problem:** Single PostgreSQL instance can't hold billions of messages.
- 100M users × 50 messages/day = 5B messages/day
- 1 year = 1.8 trillion messages
- At 1 KB per message (compressed) = 1.8 PB/year
- Sequential write throughput: ~30K msg/s per Postgres instance (with 16 cores)

**Solution: Time + entity-based partitioning + sharding**

```
                    Write Router
                    (hash(chat_id))
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
    ┌──────┐          ┌──────┐          ┌──────┐
    │Shard0│          │Shard1│    ...   │Shard7│  (8 shards)
    │      │          │      │          │      │
    │Primary          │Primary          │Primary
    │+ 3 replicas     │+ 3 replicas     │+ 3 replicas
    └──────┘          └──────┘          └──────┘

Shard assignment:
  shard_id = chat_id % 8

Each shard stores:
  ├─ messages_202601 (Jan 2026, chat_id % 8 == shard_id)
  ├─ messages_202602
  ├─ messages_202603
  └─ ... (time-partitioned, auto-created monthly)

Capacity per shard:
  · 32 cores (2× Chat Service instances could saturate)
  · 256 GB RAM (hot message buffer)
  · Write throughput: 30K msg/s
  · Read throughput: 200K msg/s (3 replicas)
  · Total: 8 shards × 30K write = 240K msg/s sustainable
```

**Implementation steps:**

1. **Hash(chat_id) to shard at application layer**
   ```go
   shard_id = uint64(chat_id) % shard_count  // 8 shards
   shard_db = shards[shard_id]               // connection pool
   
   // Write (always to primary)
   shard_db.primary.ExecContext(ctx, "INSERT INTO messages_202601 ...")
   
   // Read (round-robin across replicas)
   shard_db.replicas[round_robin()].QueryContext(ctx, "SELECT ...")
   ```

2. **Scatter-gather for cross-shard queries**
   ```go
   // Query: "Get all messages from user's 10 chats"
   results := make([][]Message, shard_count)
   for shard_id in 0..shard_count {
       results[shard_id] = shards[shard_id].Query(...)  // parallel
   }
   return merge_and_sort(results)
   ```
   - **Latency cost:** +200–500 ms (query all shards in parallel)
   - **Mitigation:** Cache popular queries (user's thread list, top chats)

3. **Hot shard detection & split**
   ```go
   // Monitor: if shard's write latency > 100 ms
   // AND daily volume > 1B messages
   // → trigger split
   
   // New shards = 16 (chat_id % 16)
   // Gradual migration: shadow writes to new shard
   // Cutover: flip routing, backfill reads
   ```

4. **Archival to cold storage**
   ```
   After 3 months in hot DB:
   messages_202601 → S3 Glacier
   (restored on demand for old-message searches)
   
   Storage cost/year: 1.8 PB × $4/TB = $7.2M
   vs. hot DB: 1.8 PB × $250/TB = $450M
   (savings: 98%)
   ```

**Sharding trade-offs:**

| Aspect | Impact | Mitigation |
|--------|--------|-----------|
| Cross-shard queries | +200–500 ms latency | Cache hot queries; use denormalization |
| Distributed transactions | Eventual consistency | Version numbers; CRDTs for conflicts |
| Hotkey reshaping (celebrity) | One shard overloaded | Adaptive splitting; burst cache |
| Schema migrations | Coordination overhead | Shadow schema on new shard; gradual cutover |

---

### Phase 6 (Months 10–12): Message Queue & Async Workers

**Goal:** Decouple sender feedback from delivery, enable geographic distribution.

```
          Chat Service
               │
               │ POST /chats/{id}/messages
               │ [E2EE ciphertext]
               │
               ▼
          ┌─────────────┐
          │ Postgres    │
          │ (message row)  ← Returns 201 immediately
          └─────────────┘
               │
               │ (async)
               ▼
          ┌─────────────┐
          │   Kafka     │
          │  message.   │
          │  created    │ Topic: messages (50K msg/s @ 100M users)
          └─────────────┘
               │
    ┌──────────┼──────────┐
    │          │          │
    ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│ Fanout │ │ Search │ │ Notif  │
│ Worker │ │ Worker │ │ Worker │
│ (Node) │ │ (Go)   │ │ (Node) │
└────────┘ └────────┘ └────────┘
    │          │          │
    ├──►Socket │          │
    │          ├──►Index  │
    │          │          ├──►FCM
    │          │          │
    │          │          ├──►Email
    │          │          │
    │          │          └──►SMS
    │          │
    ▼          ▼

Receiver app gets message:
1. Instantly via Socket.IO (P2P connection alive) → 10–50 ms
2. Via delivery receipt (fallback) → 100–500 ms
3. Push notification (offline) → seconds to minutes
```

**Kafka topology for 100M users:**

| Topic | Partitions | Replication | Throughput | Retention |
|-------|---|---|---|---|
| `messages.created` | 200 | 3 | 50K msg/s | 7 days |
| `presence.updated` | 100 | 2 | 100K evt/s | 1 day |
| `call.signaling` | 20 | 2 | 10K evt/s | 1 hour |
| `notification.queued` | 50 | 3 | 100K evt/day | 30 days |
| `audit.events` | 10 | 2 | 10K evt/s | 90 days |

**Kafka infrastructure:**
- **Brokers:** 20–50 brokers across 3+ availability zones (KRaft, no Zookeeper)
- **Storage:** 50–100 TB per broker (7 days × 50K msg/s × 1 KB = ~30 TB)
- **Network:** 1 Gbps inter-broker, 10 Gbps edge uplink
- **Cost:** ~$100K/month for 50-broker cluster @ $2K/node/month

**Worker patterns:**

```go
// fanout-worker (Node.js, 1–10 instances)
// Consume: messages.created
// Produce: Socket.IO emission
kafka.subscribe('messages.created', function(message) {
  // Decode E2EE ciphertext (kept opaque to worker)
  const delivery = {
    chat_id: message.chat_id,
    message_id: message.message_id,
    sender_id: message.sender_id,
    ciphertext: message.ciphertext,  // unchanged
    created_at: message.created_at
  }
  
  // Fan-out to chat room
  io.to(`chat:${message.chat_id}`).emit('new_message', delivery)
  
  // Fan-out to sender (for read receipts)
  io.to(`user:${message.sender_id}`).emit('message_sent', {
    message_id: message.message_id,
    status: 'delivered'
  })
})

// search-worker (Go, 1–5 instances)
// Consume: messages.created
// Produce: Elasticsearch index + notification
kafka.subscribe('messages.created', func(message) {
  // Async index into Elasticsearch (eventual)
  es.Index(ctx, "messages", message)
  
  // Skip if sender is in mute list
  // Otherwise, enqueue notification
  if !muted[message.chat_id] {
    kafka.Produce('notification.queued', {
      recipient_id: message.recipient_id,
      type: 'new_message',
      title: message.sender_name,
      body: message.preview,
      deep_link: fmt.Sprintf("vaultchat://chat/%d", message.chat_id)
    })
  }
})

// notification-worker (Node.js, 1–10 instances)
// Consume: notification.queued
// Produce: External APIs (FCM, Resend, Twilio)
kafka.subscribe('notification.queued', async (notif) => {
  const user = await db.query('SELECT fcm_token FROM users WHERE id = ?', notif.recipient_id)
  
  if (!user.fcm_token) return  // offline, try next time
  
  try {
    await fcm.send({
      token: user.fcm_token,
      notification: {
        title: notif.title,
        body: notif.body,
      },
      data: {
        deepLink: notif.deep_link
      }
    })
  } catch (err) {
    // Requeue with backoff
    kafka.Produce('notification.queued', {
      ...notif,
      retry_count: (notif.retry_count || 0) + 1,
      scheduled_for: Date.now() + (1000 * Math.pow(2, notif.retry_count))
    })
  }
})
```

**Failure scenarios & recovery:**

| Scenario | Effect | Recovery time |
|----------|--------|---|
| 1 broker down (3× replication) | Client notices: ~none (2 replicas still live) | 30 s (replica promotion) |
| 1 worker dies | Lag on topic grows; caught up after restart | 1–5 min (new consumer assigned partition) |
| Kafka fully offline (rare) | New messages post OK (in-memory backlog); delivery stalls | 1–5 min (producer buffer + recovery) |
| Search index falls behind 1 hour | Old-message search returns partial results | Auto-catch-up when capacity returns |

---

### Phase 7 (Months 13–15): Search & Analytics

**Goal:** Enable full-text message search, analytics queries, and trending.

```
       Chat Service              Kafka
              │ POST /chats/{id}/messages
              │                   │
              ├──────────────────►│
              │                   │
              │              ┌────▼──────────┐
              │              │ Search Worker │
              │              │ (async index) │
              │              └────┬──────────┘
              │                   │
              │              ┌────▼──────────────┐
              │              │ Elasticsearch    │
              │              │ (sharded, global) │
              │              └─────────────────┘
              │
         Chat Service (search)
              │ GET /search?q=hello&chat_id=123
              │
              ▼
         ┌──────────────────────┐
         │ Search Service       │
         │ (read-only)          │
         │ · Query ES           │
         │ · Auth check         │
         │ · Paginate results   │
         └──────────────────────┘
              │
              ▼
         Client app
         (displays results)
```

**Elasticsearch deployment for 100M users:**

- **Nodes:** 20–50 across 3 data centers
- **Shards:** 200 (per-day), 3 replicas
- **Storage:** 1 index per day (auto-created)
  - 5B messages/day × 2 KB per doc (compressed) = 10 TB/day
  - 365 days × 10 TB = 3.65 PB/year
  - Retention: 1 year hot, older → archive
- **Query volume:** 1K–10K search/s peak (user-initiated, not spam)
- **Latency SLA:** p95 < 500 ms

**ES configuration:**
```yaml
# Cluster config
cluster.name: vaultchat-search
discovery.seed_hosts: [es-1, es-2, ..., es-50]

# ILM (Index Lifecycle Management)
index.lifecycle.name: vaultchat-messages
index.lifecycle.rollover_alias: messages

# Policy:
# Phase 1 (0–30 days): hot (full replicas, searchable)
# Phase 2 (30–90 days): warm (reduced replicas, read-only)
# Phase 3 (90–365 days): cold (archive to S3, restore on demand)
# Phase 4 (>365 days): delete

# Mapping
{
  "messages": {
    "properties": {
      "chat_id": { "type": "keyword" },
      "sender_id": { "type": "keyword" },
      "content": { "type": "text", "analyzer": "standard" },
      "created_at": { "type": "date" },
      "file_attached": { "type": "boolean" }
    }
  }
}
```

**Analytics (separate from search):**

```
       Kafka (events)
            │
    ┌───────┼───────┐
    │       │       │
    ▼       ▼       ▼
Message  Presence Call
Events   Events    Events
    │       │       │
    └───────┴───────┘
          │
          ▼
    ┌─────────────────┐
    │ Analytics Worker│
    │ (batch processor)
    └────────┬────────┘
             │
         ┌───┴────┐
         │        │
         ▼        ▼
      S3 Lake   ClickHouse
      (parquet) (analytics DB)
             │
             ▼
      Grafana Dashboards
      · Active users
      · Chats/day
      · Avg latency
      · Error rates
```

**Metrics to track (Prometheus + Grafana):**
- P95 message delivery latency
- Search index lag (age of oldest unindexed message)
- Chat membership cache hit rate
- Kafka consumer lag per topic
- Database CPU & query latency by shard
- Redis memory usage & eviction rate

---

### Phase 8 (Months 16–18): Distributed Presence & Geographic Scale-Out

**Goal:** Support 100M concurrent across multiple continents.

```
┌───────────────────────────────────────────────────────────────┐
│ Global Controller (location: primary region, read-only backup) │
│ · Tracks global state (total users online)                   │
│ · Health checks all regions                                  │
│ · Routes new connections                                     │
└────────────────────┬──────────────────────────────────────────┘
                     │
       ┌─────────────┼─────────────┐
       │             │             │
       ▼             ▼             ▼
    ┌──────┐     ┌──────┐      ┌──────┐
    │ US   │     │ EU   │      │ APAC │
    │ DC   │     │ DC   │      │ DC   │
    └──────┘     └──────┘      └──────┘

Each region:
  ├─ 10–20 go-api instances (Chat + Presence)
  ├─ 50 Chat Service instances (sharded by chat_id)
  ├─ PostgreSQL shard (replica of global primary)
  ├─ Redis (local, for presence + cache)
  ├─ Kafka (regional, replicating to central hub)
  ├─ MinIO (S3-compatible, multi-region sync)
  └─ Elasticsearch (regional shard)

Replication:
  ┌─ US DC (Primary Shard 0–3)
  │        │
  │        ├─► EU DC (Read Replica)
  │        │
  │        └─► APAC DC (Read Replica)
  │
  └─ EU DC (Primary Shard 4–7)
             │
             ├─► US DC (Read Replica)
             │
             └─► APAC DC (Read Replica)
```

**Key challenges at distributed scale:**

1. **Cross-region message delivery**
   - Problem: Sender in US, recipient in EU, message posted to US shard
   - Solution: 
     - Use chat_id hash to route to "home" region (always same region)
     - Replicate to recipient's region via Kafka (eventual)
     - Recipient receives from local replica (~50 ms)
   - Trade-off: eventual consistency (consistency window: 1–5 seconds)

2. **Presence sync**
   - Problem: User A online in US, User B in EU; need to see each other
   - Solution:
     - Each region maintains local presence (Redis)
     - Global presence aggregator (Kafka → analytics DB, not realtime)
     - "Online" = either local or heartbeat visible in leader region
   - Cost: +200 ms latency for cross-region presence checks (use cache)

3. **Media serving**
   - Problem: Video from US user viewed 1M times from EU
   - Solution:
     - S3 multi-region replication (auto-sync)
     - CloudFront / Cloudflare CDN cache at edge
     - R2 "cache everything" rule for media files
   - Cost: +$50K/month CDN bandwidth @ 100M users

4. **Consensus for distributed transactions**
   - Problem: Double-spend in virtual economies, duplicate messages
   - Solution:
     - Optimistic writes with version numbers
     - Conflict resolution via CRDTs (Last-Write-Wins)
     - Audit log in primary region (source of truth)
   - Example:
     ```
     User A edits message in US (v=1 → v=2)
     User B edits same message in EU (v=1 → v=2, different content)
     Conflict detected on merge:
       - Resolve: keep whichever edit has later timestamp
       - Log both versions to audit trail
       - Client shows: "This message was edited by B"
     ```

---

### Phase 9 (Months 19–21): SFU & Media Services

**Goal:** Move from full-mesh to SFU (Selective Forwarding Unit) for group calls.

**Current state (Phase 6):** Mesh capped at 5 participants (CPU/battery limit)

**Target:** 50+ participants per group call

```
   5 participants (mesh, P2P)        50 participants (SFU)
   
   ┌─────────────┐                  ┌─────────────┐
   │             │                  │   SFU Box   │
   │ P1 ◄───────►P2                 │             │
   │  ▲    ▲    ▲                   │ (handles    │
   │  │    │    │                   │  encoding   │
   │  └────┼────┘                   │  selection) │
   │       │  (each sends 4 streams)└──────┬──────┘
   │       │    (800 KB/s per phone)        │
   │  P3 ◄─┴─► P4                   Clients: P1..P50
   │  ▲    ▲                        Each sends 1 stream
   │  └────┘    P5                  (100 KB/s per phone)
   │ ◄─────────►│
   │
   Cost per phone: 4 Mbps up/dn     Cost: 1 Mbps up/dn
```

**SFU deployment (LiveKit or mediasoup):**

```
┌─────────────────────────────────────┐
│ Call Service (Go)                   │
│ · /call routes                      │
│ · SFU token generation (JWT)        │
│ · Call state machine                │
└──────────────┬──────────────────────┘
               │
        ┌──────▼──────┐
        │  SFU Pool   │ (LiveKit or mediasoup)
        │             │
        │  5–20 rooms │ (each room = 50 max)
        │  per SFU    │
        │  instance   │
        └──────┬──────┘
               │
    ┌──────────┴──────────┐
    │                     │
    ▼                     ▼
  RTP/RTCP           Media relay
  (media)            (transcoding on demand)
```

**SFU infrastructure:**
- **Instances:** 20–100 SFU boxes (1 per room, or multi-room)
- **Cost per box:** 
  - 24 cores, 128 GB RAM: $2K/month
  - 100 boxes = $200K/month
  - Savings over mesh: customers use 50× less bandwidth
- **Scaling:** Auto-spinup when room count exceeds capacity per box

**SFU operational checklist:**
- [ ] Deploy LiveKit SFU on edge servers (3+ geographies)
- [ ] Call Service: issue JWT tokens (`/call/{id}/sfu-token`)
- [ ] Client: connect to SFU instead of P2P peers
- [ ] Monitor: media quality (bitrate, FPS, RTT)
- [ ] Fallback: if SFU unavailable, offer mesh for small calls

---

### Phase 10 (Months 22–24): CDN & Global Edge Caching

**Goal:** Reduce media delivery cost by 80%, latency by 50%.

```
                  Client (mobile)
                        │
                        │ HTTP GET /media/{id}
                        │
                    ┌───▼─────┐
                    │ Cloudflare│ ← Edge cache (POP)
                    │ CDN       │   500+ locations globally
                    └───┬──────┘
                        │
              ┌─────────┴──────────┐
              │                    │
         Cache HIT             Cache MISS
         (50 ms, global)       (100–300 ms, origin)
              │                    │
              ▼                    ▼
           Return               Origin: S3 / MinIO
           to client             (authorize, stream)
                                     │
                                     ▼
                                 Re-cache at edge
                                 (1 week TTL)
```

**CDN contract & authorization:**

```go
// Before: Every GET /media/{id} requires auth
// Problem: CDN can't cache (per-user auth)
// Solution: Signed URLs (time-limited, bearer tokens)

// Endpoint: POST /media/{id}/download-token
// Returns: signed URL + expiry (1 hour)
// Authorization: checked once, embedded in URL

type DownloadToken struct {
  URL    string    // https://media.cdn/media/abc123?sig=xyz&exp=1630000000
  Expiry time.Time
}

// Client uses URL directly:
// GET https://media.cdn/media/abc123?sig=xyz&exp=1630000000
//
// CDN caches:
// - Cache key: /media/abc123 (sig+exp are query params)
// - TTL: min(URL_EXPIRY - now, 1_week)
// - Purge: on media revocation (API call to CDN)

// After expiry, URL is worthless (sig invalid)
```

**Bandwidth costs (100M users):**

| Scenario | Daily data | Cost without CDN | Cost with CDN | Savings |
|----------|---|---|---|---|
| 100M users, 5 MB avg media | 500 PB/day | $4M/day | $200K/day | 95% |
| 1M concurrent, 1 MB/s | ~86 PB/day | $3.4M/day | $170K/day | 95% |

**CDN provider comparison:**
- **Cloudflare:** $20/TB + cache purge free; best for privacy
- **AWS CloudFront:** $0.085/GB; best for AWS regions
- **Akamai:** $0.04/GB negotiated; best for scale

**Implementation:**
- [ ] Generate signed S3 URLs from `/media/{id}/download-token`
- [ ] CDN policy: cache all, respect Expires header
- [ ] Purge on demand: `/media/{id}/revoke` → POST to CDN API
- [ ] Monitor: cache hit rate (target: 70–80%), origin load

---

## Operational Architecture

### Infrastructure Layout (100M concurrent)

```
┌─────────────────────────────────────────────────────────────────┐
│                  Global Control Plane                           │
│  · Kubernetes API (etcd cluster, 5 nodes)                      │
│  · Prometheus + Alertmanager (metrics, alarms)                 │
│  · ELK Stack (logs, traces, dashboards)                        │
│  · PagerDuty (on-call routing)                                 │
└─────────────────────────────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
   ┌─────────┐          ┌─────────┐          ┌─────────┐
   │ US-EAST │          │ EU-WEST │          │ APAC    │
   │ (Primary)          │(Standby) │          │(Standby)│
   └────┬────┘          └────┬────┘          └────┬────┘
        │                    │                    │
        ├─ Kubernetes        │                    │
        │  (50–100 nodes)    │                    │
        │                    │                    │
        ├─ PostgreSQL        │                    │
        │  (8 shards × 4     │                    │
        │   replicas)        │                    │
        │                    │                    │
        ├─ Redis Cluster     │                    │
        │  (20 nodes)        │                    │
        │                    │                    │
        ├─ Kafka KRaft       │                    │
        │  (30 brokers)      │                    │
        │                    │                    │
        ├─ Elasticsearch     │                    │
        │  (50 nodes)        │                    │
        │                    │                    │
        ├─ S3 (R2)           ├─► Replica S3      ├─► Replica S3
        │  (100 TB/day)      │   (sync via       │   (sync via
        │                    │    replication)   │    replication)
        │                    │                    │
        ├─ SFU Boxes         ├─ SFU Boxes        ├─ SFU Boxes
        │  (50 instances)    │ (50 instances)    │ (50 instances)
        │                    │                   │
        ├─ Load Balancer     ├─ Load Balancer   ├─ Load Balancer
        │  (GSLB)            │ (GSLB)            │ (GSLB)
        │                    │                   │
        └─ coturn relays     └─ coturn relays   └─ coturn relays
           (10 instances)       (10 instances)    (10 instances)

Inter-DC replication:
  · Database: Primary (US) → Standby (EU, APAC) [5 s lag]
  · Kafka: US cluster ←→ EU cluster ←→ APAC cluster [mirror-maker]
  · S3: US bucket ←→ EU bucket ←→ APAC bucket [cross-region sync]
  · Cache: Redis cluster replication (eventual)
```

### Kubernetes Deployment (Phase 10+)

```yaml
# vaultchat-deployment.yaml

apiVersion: v1
kind: Namespace
metadata:
  name: vaultchat

---

# Chat Service (stateless, high-volume)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chat-service
  namespace: vaultchat
spec:
  replicas: 150  # Auto-scales 50–200 based on CPU/memory
  selector:
    matchLabels:
      app: chat-service
  template:
    metadata:
      labels:
        app: chat-service
    spec:
      containers:
      - name: chat
        image: vaultchat/go-api:chat-latest
        resources:
          requests:
            cpu: 2
            memory: 4Gi
          limits:
            cpu: 4
            memory: 8Gi
        env:
        - name: DB_HOST
          value: postgres-primary
        - name: DB_SHARD_COUNT
          value: "8"
        - name: REDIS_ADAPTER
          value: "1"
        - name: KAFKA_BROKERS
          value: kafka-1:9092,kafka-2:9092,...
        ports:
        - containerPort: 4000
      affinity:
        # Spread across nodes to avoid single-node failures
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - chat-service
              topologyKey: kubernetes.io/hostname

---

# Autoscaling: target 60% CPU utilization
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: chat-service-hpa
  namespace: vaultchat
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: chat-service
  minReplicas: 50
  maxReplicas: 200
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 70

---

# Presence Service (medium-volume, frequent updates)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: presence-service
  namespace: vaultchat
spec:
  replicas: 30
  # ... (similar structure, but different resource requests)
  template:
    spec:
      containers:
      - name: presence
        resources:
          requests:
            cpu: 1
            memory: 2Gi

---

# Auth Service (low-volume, high-read)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: auth-service
  namespace: vaultchat
spec:
  replicas: 10
  # ...
  template:
    spec:
      containers:
      - name: auth
        resources:
          requests:
            cpu: 0.5
            memory: 1Gi

---

# Service exposure
apiVersion: v1
kind: Service
metadata:
  name: chat-service
  namespace: vaultchat
spec:
  selector:
    app: chat-service
  type: ClusterIP
  ports:
  - port: 4000
    targetPort: 4000

---

# Ingress (external traffic)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vaultchat-ingress
  namespace: vaultchat
spec:
  ingressClassName: nginx
  rules:
  - host: api.vaultchat.com
    http:
      paths:
      - path: /chats
        pathType: Prefix
        backend:
          service:
            name: chat-service
            port:
              number: 4000
      - path: /auth
        pathType: Prefix
        backend:
          service:
            name: auth-service
            port:
              number: 4000
      # ... other routes
```

### Monitoring & Alerting

**Metrics collection (Prometheus):**

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
- job_name: 'go-api'
  static_configs:
  - targets: ['chat-service:9090']
- job_name: 'postgres'
  static_configs:
  - targets: ['postgres-exporter:9187']
- job_name: 'redis'
  static_configs:
  - targets: ['redis-exporter:9121']
- job_name: 'kafka'
  static_configs:
  - targets: ['kafka-exporter:9308']
```

**Critical alerts:**

| Alert | Threshold | Action |
|-------|---|---|
| Chat message latency p95 | > 500 ms | Page on-call |
| Database query latency p99 | > 1000 ms | Check slow-query log, scale |
| Kafka consumer lag (delivery) | > 1 min | Restart consumer, add workers |
| Redis memory usage | > 80% of capacity | Increase node size, or evict old cache |
| Elasticsearch index lag | > 1 hour | Check indexing worker status |
| SFU box load (CPU) | > 80% | Spawn new SFU instance |
| Cross-region replication lag | > 10 s | Check network, DB throughput |

**Dashboards (Grafana):**

1. **System Health**
   - Cluster uptime by region (target: 99.99%)
   - Error rates (p95: < 0.1%)
   - Active connections (target: 100M)

2. **Message Metrics**
   - Messages/sec by service
   - Delivery latency (p50, p95, p99)
   - Fanout delivery success rate

3. **Resource Utilization**
   - CPU/memory per service
   - Database connections by shard
   - Redis memory + eviction rate
   - Kafka lag per consumer group

---

## Cost Estimation (100M–1B Concurrent Users)

### Compute Costs

| Component | Instances | vCPU/GB | Cost/month |
|---|---|---|---|
| Chat Service | 150 | 2 vCPU, 4 GB | $90K |
| Presence Service | 30 | 1 vCPU, 2 GB | $18K |
| Auth Service | 10 | 0.5 vCPU, 1 GB | $6K |
| Call Service | 50 | 2 vCPU, 4 GB | $30K |
| Upload Service | 5 | 1 vCPU, 2 GB | $3K |
| Search Worker | 10 | 2 vCPU, 4 GB | $6K |
| VaultLens Worker | 20 | 4 vCPU, 8 GB | $24K |
| **Subtotal** | | | **$177K** |

### Database Costs

| Component | Instances | Type | Cost/month |
|---|---|---|---|
| PostgreSQL Shards | 32 | 8-core, 256 GB | $256K |
| PostgreSQL Replicas | 32 | 8-core, 256 GB | $256K |
| PgBouncer Pool | 4 | 4-core, 8 GB | $8K |
| **Subtotal** | | | **$520K** |

### Cache & Message Queue

| Component | Nodes | Config | Cost/month |
|---|---|---|---|
| Redis Cluster | 20 | 8-core, 64 GB | $60K |
| Kafka KRaft | 30 | 4-core, 32 GB | $36K |
| **Subtotal** | | | **$96K** |

### Storage

| Type | Volume | Cost/month |
|---|---|---|
| S3 (hot media) | 10 TB/day = 3.65 PB/year | $146K |
| S3 Glacier (archive) | 3.65 PB/year | $14.6K |
| Elasticsearch | 10 TB/day, 1-year retention | $120K |
| Database backups | 5× daily snapshots | $30K |
| **Subtotal** | | **$310.6K** |

### Network

| Type | Cost/month |
|---|---|
| Inter-DC replication (3×50 Mbps) | $15K |
| CDN bandwidth (1 PB/month) | $50K |
| Data egress (S3, download) | $80K |
| **Subtotal** | **$145K** |

### Infrastructure & Operations

| Item | Cost/month |
|---|---|
| SFU boxes (50) | $100K |
| TURN/STUN relays (30) | $36K |
| Load balancers & firewalls | $20K |
| Kubernetes cluster management | $10K |
| Monitoring (Prometheus + Grafana) | $5K |
| Logging (ELK stack) | $20K |
| Incident response tools (PagerDuty) | $5K |
| **Subtotal** | **$196K** |

### **Grand Total: ~$1.4M/month** ($16.8M/year)

**Comparison to WhatsApp / Telegram:**
- WhatsApp (500M+ users): estimated $3–5M/month
- Telegram (500M+ users): estimated $2–3M/month
- **VaultChat (100M users): $1.4M/month** ← Reasonable ratio (scales with user count)

**Cost per user per month:**
- 100M users: $1.4M ÷ 100M = **$0.014/user/month** ($0.17/user/year)
- 1B users: $8–12M ÷ 1B = **$0.008–0.012/user/month** (economies of scale)

---

## Rollout Timeline (18–24 Months)

| Phase | Duration | Milestones | Key deliverables |
|-------|----------|---|---|
| **P3: Scale-Out** | 3 months | 1M→10M concurrent | Redis adapter, PgBouncer, 10+ instances, load tests |
| **P4: Microservices** | 3 months | 10M→50M concurrent | 8–10 services extracted, strangler pattern, per-service scaling |
| **P5: Sharding** | 3 months | 50M→100M concurrent | 8 DB shards, hash-based routing, scatter-gather queries, hot-shard detection |
| **P6: Async Workers** | 3 months | 100M→200M concurrent | Kafka topic topology, 5+ worker types, event-driven architecture |
| **P7: Search** | 2 months | 200M→500M concurrent | Elasticsearch cluster, full-text indexing, analytics pipeline |
| **P8: Geo-distribution** | 2 months | 500M→1B concurrent | Multi-region replication, GSLB, regional failover |
| **P9: SFU** | 2 months | Enhanced calls | LiveKit deployment, 50+ participant calls, transcoding |
| **P10: CDN** | 1 month | Reduced cost | Signed URLs, edge caching, 95% cache hit rate |

**Gate conditions for advancement:**

| Gate | Condition |
|---|---|
| P3 → P4 | Sustain 1M concurrent, p95 < 300 ms, <0.1% error rate |
| P4 → P5 | Single shard handling 30K msg/s; sharding improves latency |
| P5 → P6 | Cross-shard queries working; Kafka topology validated |
| P6 → P7 | Async workers catching up; no delivery lag spike |
| P7 → P8 | Search latency stable; ready for geo complexity |
| P8 → P9 | Multi-region replication synced; group call demand rising |
| P9 → P10 | CDN value justified by bandwidth costs |

---

## Operational Challenges & Mitigations

### Challenge 1: Database Consistency at Scale

**Problem:** Sharded DB + Kafka eventual consistency = conflicts.

**Example:**
- User A sends message to chat in US shard
- User B reads same chat from EU shard
- Message appears in EU shard with 2–5 second delay
- User B can't see message until replication lag clears

**Mitigation:**
```go
// Message versioning
type Message struct {
  ID          string    // unique per message
  VersionID   int64     // incremented on every edit
  SourceShard int       // which shard was authoritative
  Timestamp   time.Time // monotonic (vector clock for dist. systems)
}

// Conflict resolution rule (Last-Write-Wins)
func resolveConflict(old, new *Message) *Message {
  if new.Timestamp.After(old.Timestamp) {
    return new
  }
  return old
}

// Client-side: accept pessimistic writes, optimistic updates
// POST /chats/{id}/messages returns 201 + server timestamp
// UI shows message immediately with local timestamp
// On arrival of server timestamp, if differs, show "(edited)"
```

### Challenge 2: Cascading Failures

**Problem:** One service down → affects others (cache miss → DB spike → entire cluster down).

**Scenario:**
1. Search service crashes
2. Message delivery workers restart (retry Elasticsearch writes)
3. Kafka consumer lag grows (more retries, exhausting worker pool)
4. Notification workers stall (competing for same pool)
5. Chat becomes unusable (no messages delivered to offline users)

**Mitigation:**
```go
// Circuit breaker pattern
type CircuitBreaker struct {
  MaxFailures int           // 5 failures
  Timeout     time.Duration // 30 seconds
  State       string        // "closed" (working) / "open" (broken) / "half-open" (testing)
}

// Usage
func sendToElasticsearch(msg *Message) error {
  if cb.State == "open" {
    // Fail fast, don't retry
    return ErrServiceBroken
  }
  err := es.Index(msg)
  if err != nil {
    cb.RecordFailure()
    if cb.MaxFailures reached {
      cb.State = "open"
      go cb.TestRecovery()  // retry in 30s
    }
  } else {
    cb.Reset()
  }
  return err
}

// In Kafka worker:
// If circuit is open, skip indexing (not critical) and move to next message
// Message loss is acceptable (eventual indexing on recovery)
// Chat delivery MUST NOT fail (wrap in separate circuit)
```

### Challenge 3: Cost Runaway

**Problem:** Kafka + multiple consumer groups + retry logic → unbounded compute.

**Scenario:**
- 50K msg/s, 10 consumers per msg (fanout, search, notification, etc.)
- If 1 consumer fails (circuit open), other 9 retry the same message
- 50K × 9 = 450K retries/s burning compute

**Mitigation:**
```
Isolate failure domains:
  ┌─ Critical path (chat delivery): FailFast if Kafka is slow
  │  └─ Never retry, let consumer lag grow
  │
  └─ Non-critical (search indexing): Exponential backoff + DLQ
     └─ Retry up to 3 times, then dead-letter queue
        └─ Background job processes DLQ 1× per hour

Set resource quotas per consumer group (Kubernetes):
  fanout-worker:   CPU 4, Memory 8Gi (critical) → kill if exceeds
  search-worker:   CPU 2, Memory 4Gi (background) → backpressure if exceeds
```

### Challenge 4: Cross-Region Conflicts

**Problem:** Simultaneous user actions in different regions → conflicts.

**Scenario:**
- User deletes message in US region (DB update)
- Message is still cached in EU region (TTL not expired)
- EU-based recipient sees deleted message for 30 seconds

**Mitigation:**
```go
// Invalidation broadcast (Kafka)
// When message is deleted:
// 1. Delete from US DB
// 2. Publish to Kafka: "message.deleted" → {message_id, timestamp}
// 3. EU region consumes event
// 4. EU updates: message cache entry → {deleted: true, deleted_at: timestamp}
// 5. Recipient's next read/sync returns {deleted: true}
// 6. UI: "This message was deleted"

type MessageDeleted struct {
  MessageID int64
  DeletedAt time.Time
  Region    string  // for audit
}

// EU cache invalidation (faster than eventual consistency)
kafka.Subscribe("message.deleted", func(evt MessageDeleted) {
  cache.Invalidate(fmt.Sprintf("msg:%d", evt.MessageID))
})
```

### Challenge 5: Operability & On-Call Burden

**Problem:** 100+ microservices + distributed tracing + on-call rotations = burnout.

**Mitigation:**
- **Automate the common case:** 
  - SLO-based auto-scaling (if p95 latency > 300 ms, spinup 5 instances)
  - Auto-rollback (if error rate > 1%, revert to last-known-good)
  - Dead-letter queue auto-processing (retry at off-peak hours)

- **Observability first:**
  - Every service logs: `timestamp`, `service`, `trace_id`, `error`, `severity`
  - Trace the full path: client → API Gateway → microservice → DB
  - Grafana dashboards per service (CPU, errors, latency, requests)

- **Runbooks for top 5 incidents:**
  1. Kafka consumer lag growing → `kubectl scale deployment search-worker --replicas=20`
  2. Database connection pool exhausted → Check slow queries, kill long-running
  3. Redis out of memory → Increase node size or enable LRU eviction
  4. SFU box overloaded → Spin new SFU instance, rebalance rooms
  5. Cross-region replication lag → Check network, increase DCS bandwidth

---

## Final Recommendations

### Short Term (Next 3 Months)
1. **Enable P3 (scale-out):** Turn on `REDIS_ADAPTER=1`, deploy Redis Sentinel
2. **Test with load:** Run load tests at 100K concurrent, identify bottlenecks
3. **Add observability:** Prometheus + Grafana dashboards for every service
4. **Plan P4 (microservices):** Design interfaces between services (gRPC)

### Medium Term (Months 4–12)
1. **Extract services incrementally:** Auth → Chat → Presence → Upload
2. **Add database sharding:** 8 shards, hash-based routing, verify latency
3. **Enable Kafka:** Workers for fanout, search, notifications
4. **Deploy Elasticsearch:** Full-text search, analytics pipeline

### Long Term (Months 13–24)
1. **Geo-distribute:** Multi-region PostgreSQL, Kafka, S3 replication
2. **SFU deployment:** LiveKit or mediasoup for 50+ group calls
3. **CDN integration:** Signed URLs, edge caching
4. **Optimize costs:** Right-size instances, use reserved capacity, auto-scale aggressively

### Technical Debt to Avoid
- **Don't:** Shard by user_id (causes 1:1 imbalance; celebrity users overload one shard)
- **Do:** Shard by chat_id (even distribution; scale horizontally with chat count)
- **Don't:** Use strong consistency everywhere (kills latency at scale)
- **Do:** Embrace eventual consistency with versioning + conflict resolution
- **Don't:** Build custom distributed consensus (use Kafka for ordering, Postgres for truth)
- **Do:** Leverage existing infrastructure (Redis, Kafka) for distribution

---

## Summary

**Current state:** Go monolith + single instance, 3K msg/s sustainable  
**Target:** 100M–1B users, 100K–1M concurrent, <300 ms p95 latency  
**Cost:** ~$1.4M/month at 100M concurrent (comparable to WhatsApp)  
**Timeline:** 18–24 months to full production-ready global scale  
**Key enablers:** Microservices, database sharding, Kafka async, geo-distribution  
**Biggest risks:** Operational complexity, cross-region conflicts, cost runaway  
**Biggest wins:** Independent service scaling, fault isolation, geographic resilience

---

*Document: Phase 2–3 transition roadmap for VaultChat  
Last updated: August 2026  
Next review: After P3 completion (target: +10M concurrent reached)*
