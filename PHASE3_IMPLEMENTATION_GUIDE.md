# Phase 3 Implementation Guide
## Horizontal Scale-Out (1M → 10M Concurrent)

**Duration:** 12 weeks  
**Current status:** Go backend complete, P2.1 infrastructure built, ready to enable  
**Key deliverable:** 10+ go-api replicas handling 1M concurrent with <300 ms p95 latency

---

## Checklist: Week-by-Week Execution

### Week 1: Establish Baseline & Tooling

**Goal:** Measure current single-node limits before scaling.

**Tasks:**
- [ ] Run baseline load test (docker-compose.bench.yml)
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.bench.yml up -d --build
  npm run bench:seed  # Generate test dataset
  npm run bench:http  # HTTP latency baseline
  npm run bench:fanout --count=5000  # Message delivery baseline
  npm run bench:sockets --count=5000  # Idle socket baseline
  ```
  Expected: p95 < 100 ms (HTTP), 3,000 msg/s delivery, 5,000 idle sockets

- [ ] Document baseline metrics
  - HTTP endpoints: `/health`, `/chats` (p50/p95/p99)
  - Message delivery: throughput + latency histogram
  - Idle sockets: connection count, memory per socket
  - CPU/memory usage per service (postgres, redis, api)

- [ ] Set up monitoring dashboard (Grafana)
  - Panel 1: API response latency (p50/p95/p99)
  - Panel 2: Message delivery rate (msg/s)
  - Panel 3: Active connections (websocket + HTTP)
  - Panel 4: CPU/memory per service

**Acceptance:** All metrics baseline'ed, dashboards live, able to reproduce P2 report (3K msg/s).

---

### Week 2: Enable Redis Adapter (Single Node)

**Goal:** Activate Redis Socket.IO adapter without changing behavior.

**Changes:**
1. **docker-compose.yml:** Ensure Redis is running
   ```yaml
   redis:
     image: redis:7-alpine
     command: ["redis-server", "--appendonly", "yes"]
     ports:
       - "16379:6379"
   ```

2. **go-api environment:** Set `REDIS_ADAPTER=1`
   ```yaml
   go-api:
     environment:
       REDIS_ADAPTER: 1  # Enable Socket.IO adapter + presence cache
       REDIS_HOST: redis
       REDIS_PORT: 6379
   ```

3. **Verify Redis keys being set** (internal/cluster.go)
   ```
   vc:node:hb:<node-uuid>        ← heartbeat (EX 15 s)
   vc:nodes                       ← set of active nodes
   vc:pres:<user-id>             ← presence map
   vc:pres:online                ← online users (cardinality = OnlineCount)
   vc:roster:<node>              ← users on this node
   vc:members:<chat-id>          ← chat membership (EX 30 s, DEL on mutation)
   ```

4. **Canary soak test** (24 hours)
   ```bash
   npm run bench:fanout --duration=86400s
   # Monitor: are message deliveries still smooth?
   # Check: Redis is being updated, presence is correct
   ```

**Acceptance:** Single node + Redis adapter behaves identically to baseline. Latency ±5%.

---

### Week 3: Deploy Redis Sentinel (High Availability)

**Goal:** Prevent Redis becoming a single point of failure.

**Architecture:**
```
Redis Master (16 GB)
    ├─ Redis Slave 1
    ├─ Redis Slave 2
    │
Sentinel nodes (3)
    └─ Monitors master, promotes slave on failure
```

**Implementation:**

1. **docker-compose.yml update**
   ```yaml
   redis-master:
     image: redis:7-alpine
     ports: ["16379:6379"]
     command: ["redis-server", "--appendonly", "yes", "--maxmemory", "16gb"]

   redis-slave-1:
     image: redis:7-alpine
     command: ["redis-server", "--slaveof", "redis-master", "6379"]
     depends_on: [redis-master]

   redis-slave-2:
     image: redis:7-alpine
     command: ["redis-server", "--slaveof", "redis-master", "6379"]
     depends_on: [redis-master]

   redis-sentinel-1:
     image: redis:7-alpine
     command: |
       redis-sentinel /etc/redis/sentinel.conf
     volumes:
       - ./redis/sentinel.conf:/etc/redis/sentinel.conf
     depends_on: [redis-master, redis-slave-1, redis-slave-2]

   redis-sentinel-2:
     image: redis:7-alpine
     command: |
       redis-sentinel /etc/redis/sentinel.conf
     depends_on: [redis-master, redis-slave-1, redis-slave-2]

   redis-sentinel-3:
     image: redis:7-alpine
     command: |
       redis-sentinel /etc/redis/sentinel.conf
     depends_on: [redis-master, redis-slave-1, redis-slave-2]
   ```

2. **redis/sentinel.conf**
   ```
   port 26379
   sentinel monitor vaultchat-redis redis-master 6379 2
   sentinel down-after-milliseconds vaultchat-redis 5000
   sentinel parallel-syncs vaultchat-redis 1
   sentinel failover-timeout vaultchat-redis 10000
   ```

3. **Go code update** (internal/redisx/redis.go)
   ```go
   // Use Sentinel-aware client
   import "github.com/redis/go-redis/v9"

   var sentinelAddrs = []string{
     "redis-sentinel-1:26379",
     "redis-sentinel-2:26379",
     "redis-sentinel-3:26379",
   }

   rdb := redis.NewSentinelClient(&redis.SentinelOptions{
     SentinelAddrs: sentinelAddrs,
     MasterName:    "vaultchat-redis",
   })

   // On master failure, Sentinel auto-promotes slave
   // Client sees no interruption (failover ~5 s)
   ```

4. **Test failover**
   ```bash
   # While load test is running:
   docker kill vaultchat-redis-master-1
   
   # Expect: ~5 s of degraded latency, then recovery
   # Check logs: "Master demoted", "Promoting slave"
   ```

**Acceptance:** Master death → automatic failover < 5 s, load test continues.

---

### Week 4: Deploy Second go-api Instance

**Goal:** Verify cross-node chat, calls, presence, message delivery.

**Setup:**

1. **docker-compose.yml: add go-api-2**
   ```yaml
   go-api-2:
     build:
       context: ./vaultchat-backend-go
     environment:
       PORT: "4001"  # Different port
       DB_HOST: pgbouncer
       DB_PORT: 6432
       REDIS_ADAPTER: 1
       REDIS_HOST: redis-master  # Sentinel-backed
       NODE_ID: "go-api-2"  # Unique per instance
     ports:
       - "14001:4001"
     depends_on:
       - postgres
       - pgbouncer
       - redis-master
   ```

2. **Caddy: load balance between instances**
   ```caddy
   :80 {
     reverse_proxy localhost:4000 localhost:4001 {
       policy round_robin
       health_uri /health
       health_interval 5s
     }
   }
   ```

3. **Test cross-node communication**
   ```bash
   # User A connects to go-api:4000
   # User B connects to go-api:4001
   # Send message A → B:
   # Expected: B receives via Socket.IO Redis adapter
   
   npm test -- --grep="cross-node"
   ```

4. **Verify presence sync**
   ```bash
   # User A online on api-1, check from api-2
   # Expected: GET /user/presence returns A as online
   # Check Redis: vc:pres:online contains A
   ```

5. **Load test with 2 instances**
   ```bash
   npm run bench:fanout --replicas=2 --duration=3600s
   # Expected: 6,000 msg/s (2× baseline)
   # Check: latency increase is minimal (<10%)
   ```

**Acceptance:** 2 replicas handle 2× throughput, latency stable, presence correct.

---

### Week 5: Scale to 10 Instances

**Goal:** Linear scaling to 100K concurrent.

**Deployment:**

1. **Kubernetes deployment** (if using K8s)
   ```yaml
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: go-api
   spec:
     replicas: 10
     selector:
       matchLabels:
         app: go-api
     template:
       metadata:
         labels:
           app: go-api
       spec:
         containers:
         - name: go-api
           image: vaultchat/go-api:latest
           ports:
           - containerPort: 4000
           env:
           - name: REDIS_ADAPTER
             value: "1"
           resources:
             requests:
               cpu: 2
               memory: 4Gi
   ```
   Or docker-compose with 10 services (api-1 through api-10)

2. **Load balancer configuration**
   ```
   GSLB (Global Server Load Balancer)
        │
        ├─ Health check: GET /health
        ├─ Timeout: 5 seconds
        └─ Circuit breaker: if 3 failures, remove from pool
             │
       ┌─────┴─────┐
       │           │
    [Caddy]     [Caddy]  (multi-node LB)
       │           │
    [10× go-api instances]
   ```

3. **Run full load test**
   ```bash
   npm run bench:fanout \
     --replicas=10 \
     --vus=10000 \  # 10,000 concurrent users
     --duration=3600s
   ```

   Expected results:
   - Message throughput: 10,000–30,000 msg/s
   - Latency p95: 100–200 ms (slightly up due to scale)
   - Errors: < 0.1%
   - CPU per instance: 40–60%

4. **Monitor resource usage**
   - Per-instance: CPU 2 core, Memory 4 GB
   - Database connections: ~400 total (40 per DB/user × 10 instances)
   - Redis memory: ~2 GB (presence + chat members)

**Acceptance:** 10 instances, 100K concurrent, p95 < 200 ms, linear scaling confirmed.

---

### Week 6: Enable Kafka Event Bus (Async Fanout)

**Goal:** Move fanout from in-process to async workers for horizontal scaling beyond 100K.

**Changes:**

1. **Set `EVENT_BUS=kafka` in go-api environment**
   ```yaml
   go-api:
     environment:
       EVENT_BUS: kafka
       KAFKA_BROKERS: kafka-1:9092,kafka-2:9092,kafka-3:9092
   ```

2. **Kafka topics**
   ```bash
   # Create in docker-compose.yml (auto-created on first produce)
   kafka:
     image: apache/kafka:3.8.1
     environment:
       KAFKA_BROKER_ID: 1
       KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
       KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT
   ```

3. **Enable fanout-worker** (internal/workers/fanout.go)
   ```go
   // Subscribe to messages.created topic
   kafka.Subscribe("messages.created", func(ctx context.Context, msg *pb.MessageCreated) {
     // Fanout to Socket.IO room
     hub.To(fmt.Sprintf("chat:%d", msg.ChatId)).Emit("new_message", msg)
   })
   ```

4. **Test end-to-end**
   ```bash
   # Sender: POST /chats/{id}/messages
   # Expected flow:
   # 1. Message saved to DB
   # 2. Published to Kafka (async)
   # 3. fanout-worker consumes
   # 4. Socket.IO emits to room
   # 5. Recipient receives (100–500 ms lag)
   
   npm test -- --grep="async-fanout"
   ```

5. **Monitor Kafka lag**
   ```bash
   # Check consumer lag
   kafka-consumer-groups --bootstrap-server kafka:9092 \
     --group fanout-worker \
     --describe
   
   # Expected: lag < 1 second (at steady state)
   ```

**Acceptance:** Async fanout working, Kafka lag < 1 s, fanout-worker can scale independently.

---

### Week 7–8: Stress Test & Optimization

**Goal:** Find bottlenecks, optimize for 1M concurrent.

**Load profile:**
```
Message throughput:  1K → 10K → 100K msg/s
Concurrent users:    10K → 100K → 1M
Idle sockets:        100K → 1M
Test duration:       15 minutes each, 30 min for 1M
```

**Metrics to track:**
- [ ] Latency (p50/p95/p99) at each tier
- [ ] CPU & memory per instance
- [ ] Database connection pool saturation
- [ ] Redis memory usage & eviction rate
- [ ] Kafka consumer lag
- [ ] Error rate & timeout rate

**Expected bottlenecks & fixes:**

| Bottleneck | Symptoms | Fix |
|---|---|---|
| Database connections exhausted | "too many connections" errors | Increase PgBouncer `DEFAULT_POOL_SIZE` from 40 → 60 |
| Redis memory full | Eviction spikes, cache miss | Increase Redis node size from 16 GB → 32 GB |
| Kafka consumer lag growing | Fanout latency increases | Scale fanout-worker instances (10 → 20) |
| Single go-api instance CPU maxed | Latency spike on one instance | Rebalance load (check Caddy metrics) |

**Optimization checklist:**

1. **Database:**
   - [ ] Enable `REDIS_CACHE=1` (cache hot messages)
   - [ ] Verify indexes on `(chat_id, created_at)` for message queries
   - [ ] Monitor slow-query log (queries > 100 ms)

2. **Redis:**
   - [ ] Enable LRU eviction: `maxmemory-policy allkeys-lru`
   - [ ] Monitor hit rate (target: > 80%)
   - [ ] Pre-warm cache on startup (load top 1000 chats)

3. **Go API:**
   - [ ] Enable HTTP/2 (faster multiplexing for high concurrency)
   - [ ] Tune `GOMAXPROCS` to num_cores
   - [ ] Profile CPU: `pprof` on /debug/pprof

4. **Network:**
   - [ ] Enable TCP fast open (reduces handshake RTT)
   - [ ] Tune `net.ipv4.tcp_tw_reuse` (server socket reuse)
   - [ ] Monitor bandwidth utilization

**Acceptance:** 1M concurrent users, p95 < 300 ms, < 0.1% error rate, all instances < 70% CPU.

---

### Week 9–12: Soak Test & Production Preparation

**Goal:** Stabilize architecture for production rollout.

**Soak test setup (continuous, 24–48 hours):**

```bash
npm run bench:full \
  --replicas=10 \
  --vus=100000 \  # 100K concurrent
  --msg-rate=10000 \  # 10K msg/s
  --duration=172800s  # 48 hours
```

**What to monitor during soak:**

| Metric | Alert threshold | Action |
|---|---|---|
| Memory leak (go-api) | +100 MB over 24 h | Profile heap, find goroutine leak |
| Disk usage (PostgreSQL) | > 80% partition | Archival policy review |
| Redis eviction rate | > 100 keys/s | Increase node size |
| Kafka lag (fanout) | > 10 seconds | Add consumers |
| Error rate | > 0.05% | Root cause analysis |

**Disaster scenarios to test:**

1. **Database failover:**
   - Kill primary Postgres instance
   - Expected: Failover to replica < 10 s, brief latency spike
   - Recovery: Traffic resumes, no data loss

2. **Redis failover:**
   - Kill Redis master
   - Expected: Sentinel promotes slave, presence/cache recovered < 5 s

3. **Broker crash:**
   - Kill 1 Kafka broker (out of 3)
   - Expected: No message loss (replication), latency steady

4. **Instance cascading failure:**
   - Kill 3 go-api instances simultaneously
   - Expected: Load rebalances to 7 healthy instances, errors < 0.1%

**Production checklist:**

- [ ] Runbooks for top 10 operational incidents (auto-scaling, failover, rollback)
- [ ] On-call rotation established (2 engineers, 1 week rotation)
- [ ] Alerting configured (PagerDuty integration)
- [ ] Backup strategy verified (daily snapshots, point-in-time restore works)
- [ ] Incident post-mortems process in place
- [ ] Security audit complete (no hardcoded secrets, secrets in vaults)
- [ ] Compliance (GDPR, CCPA) audit for multi-region data

**Acceptance:** 48-hour soak with zero crashes, no data loss, all alerts working, on-call ready.

---

## Debugging Common Issues

### Issue: Message delivery latency suddenly spikes

**Symptoms:** p95 latency 100 ms → 1000 ms in 5 minutes.

**Diagnosis:**
```bash
# 1. Check if it's a single instance or cluster-wide
curl http://api-1:9090/metrics | grep delivery_latency
curl http://api-2:9090/metrics | grep delivery_latency
# If different, it's load imbalance. If same, it's backend resource issue.

# 2. Check database latency
psql -c "SELECT query, mean_time FROM pg_stat_statements ORDER BY mean_time DESC LIMIT 5;"
# If high, run ANALYZE or check slow-query log

# 3. Check Kafka consumer lag
kafka-consumer-groups --bootstrap-server kafka:9092 --group fanout-worker --describe
# If lag > 5s, scale workers or check broker disk

# 4. Check go-api goroutine count
curl http://api-1:9090/debug/pprof/goroutine?debug=1 | wc -l
# If > 10,000, there's a goroutine leak. Profile with pprof.
```

### Issue: Redis out of memory, eviction spiking

**Symptoms:** Cache hit rate drops from 90% to 40%, latency increases.

**Diagnosis:**
```bash
# 1. Check Redis memory usage
redis-cli INFO memory
# Output: used_memory_human, maxmemory, evicted_keys

# 2. Identify large keys
redis-cli --bigkeys
# Top 10 biggest keys by size

# 3. Check presence size
redis-cli MEMORY STATS keyspace
# If vc:pres:* is > 50% of memory, it's growing unbounded
```

**Fix:**
```
Options:
1. Increase node size (16 GB → 32 GB), cost: +$300/month
2. Enable LRU eviction: CONFIG SET maxmemory-policy allkeys-lru
3. Add dedicated Redis node for presence only (separate from cache)
4. Implement presence TTL (expire after 1 hour of inactivity)
```

### Issue: Database connection pool exhausted

**Symptoms:** New requests get "too many connections" error.

**Diagnosis:**
```bash
# 1. Check current connections
psql -c "SELECT count(*) FROM pg_stat_activity;"
# Expected: 400 (10 instances × 40 default pool size)
# If > 450, pool is saturated

# 2. Check which query is holding connections
psql -c "SELECT query, count(*) FROM pg_stat_activity GROUP BY query ORDER BY count DESC LIMIT 5;"
# Long-running queries are holding connections

# 3. Check PgBouncer stats
redis-cli PUBLISH pgbouncer stats  # or connect to pgbouncer admin port
# Output: total connections, client connections, server connections
```

**Fix:**
```bash
# 1. Kill long-running queries
psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query_start < NOW() - INTERVAL '5 minutes';"

# 2. Increase PgBouncer pool size
# docker-compose.yml: DEFAULT_POOL_SIZE: 60 (from 40)
docker compose restart pgbouncer

# 3. Optimize slow queries
EXPLAIN ANALYZE <slow_query>;
# Add indexes if needed
```

---

## Success Metrics & SLO

**Phase 3 completion criteria:**

| Metric | Target | Current | Status |
|---|---|---|---|
| Concurrent users | 1M | 100K (est.) | ✓ On track |
| Message throughput | 30K msg/s | 3K msg/s (single instance) | ✓ 10× improvement |
| P95 latency | < 300 ms | 129 ms (single instance, 3K msg/s) | ✓ Will increase to 250–280 ms at 30K msg/s |
| Error rate | < 0.1% | 0% (baseline) | ✓ Will maintain |
| Availability | 99.9% | 99%+ (single instance) | ✓ 99.95% with HA |
| Database connections | < 500 (limit) | ~100 (baseline) | ✓ Will scale to 400 |

**SLO (Service Level Objective):**
```
Availability:    99.95% (< 22 minutes downtime/month)
Message delivery: p95 < 300 ms, p99 < 500 ms
Auth latency:    p95 < 100 ms
Error budget:    0.05% per month
```

---

## Rollback Strategy

**If P3 fails and needs rollback to P2 (single instance):**

1. **Immediate (< 5 minutes):**
   - Set `REDIS_ADAPTER=0` (disable distributed mode)
   - Set `EVENT_BUS=off` (disable async fanout)
   - Caddy: remove load balancer, route to single instance
   - Kill extra go-api instances

2. **Cleanup (< 1 hour):**
   - Verify single-node behavior restored
   - Run sanity tests
   - Post-mortem (what went wrong?)

3. **Data safety:**
   - Messages are durable (in Postgres)
   - Presence is ephemeral (rebuilt on reconnect)
   - No data loss, only operational issue

---

## Next Steps After P3

Once P3 is stable (1M concurrent, 30K msg/s):

1. **P4 (Microservices, weeks 13–24):** Extract Chat, Auth, Presence services
2. **P5 (Sharding, weeks 25–36):** Move to 8-way database sharding
3. **P6 (Async workers, weeks 37–48):** Scale workers independently with Kafka

Each phase unlocks the next tier of scale.
