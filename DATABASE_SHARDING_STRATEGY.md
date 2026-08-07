# Database Sharding Strategy for VaultChat
## Phase 5: Scaling from 100M to 500M Concurrent Users

**Problem:** Single PostgreSQL instance reaches throughput ceiling (~30K msg/s) around 100M users.  
**Solution:** Hash-based sharding by `chat_id`, time-based partitioning, read replicas per shard.

---

## Sharding Model Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Chat Service (write router)                                 │
│                                                              │
│  chat_id = 12345                                           │
│  shard_id = hash(chat_id) % 8 = 1                          │
│  shard_db = shards[1]                                      │
└──────────────────────┬──────────────────────────────────────┘
                       │
            ┌──────────┴────────────┐
            │                       │
            ▼                       ▼
        Write: PRIMARY          Read: REPLICA
     (Shard 1 Master)      (Shard 1 Slave 1/2/3)
            │                       │
            ▼                       ▼
        ┌─────────┐            ┌─────────┐
        │ Primary │            │ Replica │
        │ 8-core  │            │ 8-core  │
        │ 256 GB  │            │ 256 GB  │
        └─────────┘            └─────────┘
             │                       │
          Writes              Reads (RR)
          (30K/s)          (200K/s ÷ 3)
```

**Key properties:**
- **Sharding key:** `chat_id` (not `user_id` → avoids hotkeys)
- **Shard count:** 8 (powers of 2 for clean splitting)
- **Write model:** All writes to primary, always consistent
- **Read model:** Round-robin across replicas, eventually consistent
- **Time partitioning:** Messages table partitioned by month + chat_id shard
- **Archival:** Messages > 3 months → S3 Glacier (restore on demand)

---

## Phase 5 Implementation Roadmap

### Stage 5.1: Single-Shard Foundation (Weeks 1–2)

**Goal:** Implement sharding logic on a SINGLE shard, zero behavioral changes.

**Architecture (before sharding):**
```
go-api (Chat Service)
    │
    └─► Postgres (single instance)
        ├─ messages (1 table)
        ├─ chats
        ├─ users
        └─ ...

Routing:
  conn := postgres.Open()  // Direct
```

**Architecture (after Stage 5.1):**
```
go-api (Chat Service)
    │
    ├─ ShardRouter (new)
    │  └─ hash(chat_id) % 1 = 0  (always route to shard 0)
    │
    └─► Postgres Shard 0 (physically same as before)
        ├─ messages_202601
        ├─ messages_202602
        ├─ chats
        ├─ users
        └─ ...

Routing:
  shard_id := hashChatID(chat_id) % shardCount  // always 0
  conn := shards[shard_id].primary.Open()
  result := conn.Exec(query)
```

**Code changes:**

```go
// internal/sharding/shard.go (new file)
package sharding

import (
  "github.com/jackc/pgx/v5/pgxpool"
)

type ShardCluster struct {
  shards []*Shard
}

type Shard struct {
  id       int
  primary  *pgxpool.Pool
  replicas []*pgxpool.Pool
}

func (sc *ShardCluster) GetShard(chatID int64) *Shard {
  shardID := chatID % int64(len(sc.shards))
  return sc.shards[shardID]
}

func (s *Shard) QueryRow(ctx context.Context, query string, args ...interface{}) {
  replica := s.replicas[rand.Intn(len(s.replicas))]
  return replica.QueryRow(ctx, query, args...)
}

func (s *Shard) Exec(ctx context.Context, query string, args ...interface{}) {
  return s.primary.Exec(ctx, query, args...)
}

// Initialization
func New(count int) (*ShardCluster, error) {
  sc := &ShardCluster{
    shards: make([]*Shard, count),
  }
  
  for i := 0; i < count; i++ {
    sc.shards[i] = &Shard{
      id: i,
      primary: pgxpool.New(ctx, dsn(i, "primary")),
      replicas: []*pgxpool.Pool{
        pgxpool.New(ctx, dsn(i, "replica-1")),
        pgxpool.New(ctx, dsn(i, "replica-2")),
        pgxpool.New(ctx, dsn(i, "replica-3")),
      },
    }
  }
  
  return sc, nil
}
```

**Integration into existing routes:**

```go
// Before:
func getMessages(w http.ResponseWriter, r *http.Request) {
  chatID := parseChatID(r)
  rows, err := db.Query(ctx, "SELECT * FROM messages WHERE chat_id = $1", chatID)
  // ...
}

// After:
func getMessages(w http.ResponseWriter, r *http.Request) {
  chatID := parseChatID(r)
  shard := shardCluster.GetShard(chatID)
  rows, err := shard.QueryRow(ctx, "SELECT * FROM messages_202608 WHERE chat_id = $1", chatID)
  // ...
}
```

**Deployment:**
- Database: Still single Postgres instance (no changes to infra yet)
- Go API: Use ShardCluster with 1 shard
- Behavior: Identical to current (all chats → shard 0)
- Testing: All existing tests pass unchanged

**Acceptance:** All routes work via ShardRouter; tests pass; latency ±5%.

---

### Stage 5.2: Multi-Shard Rollout (Weeks 3–6)

**Goal:** Deploy 8 physical shards, route new chats to shards in round-robin.

**Timeline:**
- Week 3: Provision Postgres instances (8× primary + 3× replicas each)
- Week 4: Gradual traffic shift (10% chats → new shards)
- Week 5: Monitor and optimize (watch for hotshards)
- Week 6: Complete migration (100% traffic on 8 shards)

**Hardware requirements:**

```
Per shard:
  Primary:  8-core, 256 GB RAM, 4 TB SSD
  Replica1: 8-core, 256 GB RAM, 4 TB SSD
  Replica2: 8-core, 256 GB RAM, 4 TB SSD
  Replica3: 8-core, 256 GB RAM, 4 TB SSD

Total:
  8 shards × 4 instances = 32 instances
  Cost: 32 × $2,000/month = $64,000/month
```

**Deployment phases:**

1. **Week 3: Provision all 8 shards**
   ```yaml
   # docker-compose.prod.yml (simplified)
   postgres-shard-0-primary:
     image: postgres:16
     volumes:
       - shard-0-data:/var/lib/postgresql/data
     environment:
       POSTGRES_DB: vaultchat_shard_0
       # ... replicated to 3 replicas

   postgres-shard-0-replica-1:
     image: postgres:16
     command: ["postgres", "-c", "hot_standby=on"]
     environment:
       # Standby mode, replicates from primary
   # ... (repeat for shards 1–7)
   ```

2. **Week 4: Gradual traffic shift**
   
   **A. New chats → round-robin across 8 shards**
   ```go
   func CreateChat(ctx context.Context, ...) error {
     // Instead of always using shard 0:
     shard_id := rand.Intn(8)  // Random across 8 shards
     chat.shard_id = shard_id
     
     shard := shardCluster.GetShard(shard_id)
     return shard.primary.Exec(ctx, "INSERT INTO chats ...", chat)
   }
   ```
   
   **B. Existing chats (with old shard_id) → find shard by hash**
   ```go
   func GetMessages(ctx context.Context, chatID int64) {
     // For existing chats, compute shard_id from chat_id
     shard_id := chatID % 8
     shard := shardCluster.GetShard(shard_id)
     return shard.QueryRow(ctx, "SELECT * FROM messages_202608 WHERE chat_id = $1", chatID)
   }
   ```

3. **Week 5: Monitor distribution**
   ```bash
   # Query each shard to verify even distribution
   for i in 0 7; do
     echo "Shard $i:"
     psql postgres://shard-$i-primary "SELECT COUNT(*) FROM chats;"
   done
   
   # Expected output: ~1/8 of total chats on each shard
   ```

4. **Week 6: Validate & cleanup**
   - [ ] No latency regression on p95/p99
   - [ ] Replication lag < 1 second
   - [ ] Backup strategy working (8× parallel backups)
   - [ ] Archival process ready (migrate messages > 3 months to S3)

**Acceptance:** 8 shards live, even distribution, p95 latency stable or better.

---

### Stage 5.3: Cross-Shard Queries (Weeks 7–9)

**Problem:** Some queries span multiple chats (e.g., user's top 10 chats).
```
Query: "Get all chats for user_id = 123"
Issue: User 123 may have chats in ALL 8 shards
Solution: Scatter-gather (query all shards, merge results)
```

**Implementation:**

```go
// internal/sharding/scatter_gather.go

// ScatterGather executes query on all shards, merges results
func (sc *ShardCluster) ScatterGather(
  ctx context.Context,
  query string,
  merger func([]interface{}) interface{},
  args ...interface{},
) (interface{}, error) {
  
  results := make([]interface{}, len(sc.shards))
  errChan := make(chan error, len(sc.shards))
  
  // Query all shards in parallel
  for i, shard := range sc.shards {
    go func(idx int, s *Shard) {
      rows, err := s.QueryRow(ctx, query, args...)
      if err != nil {
        errChan <- err
        return
      }
      results[idx] = rows
      errChan <- nil
    }(i, shard)
  }
  
  // Wait for all to complete
  for range sc.shards {
    if err := <-errChan; err != nil {
      return nil, err  // 1 shard failure = query fails
    }
  }
  
  // Merge results (sorting, deduplication, etc.)
  return merger(results), nil
}

// Usage: Get all chats for a user
func GetUserChats(ctx context.Context, userID int64) ([]Chat, error) {
  merger := func(results []interface{}) interface{} {
    allChats := make([]Chat, 0)
    for _, result := range results {
      if rows := result.(pgx.Rows); rows != nil {
        for rows.Next() {
          var chat Chat
          rows.Scan(&chat)
          allChats = append(allChats, chat)
        }
      }
    }
    // Sort by user_chat_order
    sort.Slice(allChats, func(i, j int) bool {
      return allChats[i].user_chat_order > allChats[j].user_chat_order
    })
    return allChats[:min(10, len(allChats))]
  }
  
  result, err := shardCluster.ScatterGather(
    ctx,
    "SELECT * FROM chats WHERE user_id = $1 ORDER BY user_chat_order DESC",
    merger,
    userID,
  )
  return result.([]Chat), err
}
```

**Latency impact:**
```
Single-shard query:   10 ms (direct)
Scatter-gather 8 shards:
  ├─ Network RTT: 1 ms × 8 = 8 ms
  ├─ Query time: 10 ms (max of 8 shards)
  ├─ Merge: 1 ms
  └─ Total: ~20 ms (2× single-shard)

Target: Cache hot queries (user's chats, top friends)
```

**Query caching strategy:**

```go
// Redis cache for user's chats (high-hit-rate query)
func GetUserChatsCached(ctx context.Context, userID int64) ([]Chat, error) {
  cacheKey := fmt.Sprintf("user:chats:%d", userID)
  
  // Try cache first
  if cached, err := redis.Get(ctx, cacheKey); err == nil {
    return unmarshal(cached), nil
  }
  
  // Cache miss: query all shards
  chats, err := GetUserChats(ctx, userID)
  if err == nil {
    // Cache for 5 minutes (or until chat list changes)
    redis.Set(ctx, cacheKey, marshal(chats), 5*time.Minute)
  }
  return chats, err
}

// Invalidate cache on mutation
func DeleteChat(ctx context.Context, chatID int64) error {
  shard := shardCluster.GetShard(chatID)
  
  // Get all members before delete
  members, _ := getMembers(ctx, chatID)
  
  // Delete
  err := shard.primary.Exec(ctx, "DELETE FROM chats WHERE id = $1", chatID)
  
  // Invalidate cache for all members
  for _, member := range members {
    redis.Del(ctx, fmt.Sprintf("user:chats:%d", member.user_id))
  }
  
  return err
}
```

**Acceptance:** Cross-shard queries working, cached queries < 50 ms p95.

---

### Stage 5.4: Hotkey Detection & Dynamic Splitting (Weeks 10–12)

**Problem:** Celebrity user gets 1M messages in a day → one shard overloaded.

```
Normal distribution:      Celebrity chat:
Shard 0: 100K msg         Shard 5: 1M msg (OVERLOADED!)
Shard 1: 100K msg         Other shards: 100K msg
... (even)                p95 latency spikes on shard 5
```

**Solution: Monitor per-shard load, split hot shards dynamically.**

**Implementation:**

```go
// internal/sharding/hotkey.go

type ShardMetrics struct {
  MessageCount  int64
  AvgLatency    float64  // p95 latency
  MemoryUsage   int64
  ConnectionCnt int
}

func (sc *ShardCluster) MonitorShards(ctx context.Context) {
  ticker := time.NewTicker(1 * time.Minute)
  
  for range ticker.C {
    for i, shard := range sc.shards {
      metrics := shard.GetMetrics(ctx)
      
      // Threshold: if shard p95 > 200 ms AND msg count > 100M
      if metrics.AvgLatency > 200 && metrics.MessageCount > 100_000_000 {
        log.Warn("Hotkey detected", "shard", i, "latency", metrics.AvgLatency)
        go sc.SplitShard(ctx, i)
      }
    }
  }
}

func (sc *ShardCluster) SplitShard(ctx context.Context, shardID int) error {
  // Step 1: Create new shard pair (16 shards total, split shard ID)
  //   Old: chat_id % 8
  //   New: chat_id % 16
  //   Split: shards 0–7 stay, shards 8–15 get subset of data
  
  // Step 2: Dual-write to both old and new shard
  //   New messages: write to both (consistency)
  //   Old messages: in old shard only
  
  // Step 3: Backfill
  //   Scan old shard, copy messages where (chat_id % 16) >= 8
  //   to new shard
  
  // Step 4: Flip routing
  //   Update ShardRouter: 16 shards instead of 8
  //   Reads now use new modulo
  
  // Step 5: Cleanup
  //   Delete backfilled messages from old shard (those < 8)
  
  return nil
}
```

**Example walkthrough:**

```
Before split (8 shards):
  Chat 0: shard_id = 0 % 8 = 0
  Chat 8: shard_id = 8 % 8 = 0
  Chat 16: shard_id = 16 % 8 = 0
  → All go to Shard 0

After split (16 shards):
  Chat 0: shard_id = 0 % 16 = 0  (unchanged)
  Chat 8: shard_id = 8 % 16 = 8  (MOVED to new Shard 8)
  Chat 16: shard_id = 16 % 16 = 0  (unchanged)
  → Shard 0 load halves, new Shard 8 created with half the data
```

**Risks:**
- Split takes time (~1 hour for large shards)
- During split, latency is higher (dual-writes)
- Rollback: flip back to 8 shards (keep new data)

**Acceptance:** Hotkey detection working, auto-split tested on staging.

---

## Partition Strategy

### Time-Based Partitioning

```sql
-- Automatic partitioning (PostgreSQL 10+)

CREATE TABLE messages (
  id BIGSERIAL,
  chat_id BIGINT,
  sender_id BIGINT,
  content BYTEA,
  created_at TIMESTAMP,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at));

CREATE TABLE messages_202601 PARTITION OF messages
  FOR VALUES FROM (2026, 1) TO (2026, 2);

CREATE TABLE messages_202602 PARTITION OF messages
  FOR VALUES FROM (2026, 2) TO (2026, 3);
-- ... auto-create new partition on month boundary

CREATE INDEX idx_messages_202601_chat ON messages_202601 (chat_id, created_at DESC);
```

**Benefits:**
- Old partitions (messages_202501) auto-drop after 3 months
- Query planner prunes old partitions automatically
- Fast DELETE on old messages (just drop partition)
- Parallel queries possible (each partition is separate)

### Archival to S3 Glacier

```go
// Nightly job (async worker, Node.js)

const archivalWorker = async () => {
  // Find messages older than 3 months
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 3);
  
  const messages = await db.query(
    "SELECT * FROM messages WHERE created_at < $1 LIMIT 1000000",
    [cutoff]
  );
  
  // Upload to S3 Glacier (cold storage)
  const key = `archive/messages/2026-01.parquet`;
  await s3.putObject({
    Bucket: 'vaultchat-archive',
    Key: key,
    Body: parquet.encode(messages),
    StorageClass: 'GLACIER',  // $4/TB/month (vs $250/TB hot)
  });
  
  // Delete from hot DB
  await db.query(
    "DELETE FROM messages_202601 WHERE created_at < $1",
    [cutoff]
  );
};
```

**Cost comparison:**
```
Hot storage (PostgreSQL):  1 TB × $250/month = $250
Glacier storage:           1 TB × $4/month = $4
Savings:                   98.4%

Restore latency:           < 5 minutes (standard retrieval)
Use case:                  Old-message search, compliance, audit
```

---

## Migration from Single to 8 Shards (Live)

**Safest approach: Shadow writes + gradual migration**

```
Phase 1: Shadow Writes (1 week)
  ├─ Prod: All writes to Shard 0 (old)
  ├─ Shadow: Duplicate writes to Shards 1–7
  └─ Verify: Shadow data is identical

Phase 2: Read Testing (1 week)
  ├─ 10% of reads from new shards
  ├─ Compare results (should be identical)
  ├─ Ramp to 50%

Phase 3: Dual-Master (1 week)
  ├─ Both old & new can accept writes
  ├─ Run conflict resolver (if same message written twice)
  ├─ Monitor replication lag

Phase 4: Flip (< 1 hour)
  ├─ Stop writes to old shard
  ├─ Verify replication caught up
  ├─ Flip routing to new shards
  ├─ Rollback: Flip back if issues
```

---

## Monitoring & Alerts

### Per-Shard Metrics (Prometheus)

```
# Query latency
vaultchat_query_latency_ms{shard="0",percentile="p95"}
vaultchat_query_latency_ms{shard="1",percentile="p99"}

# Message throughput
vaultchat_messages_inserted_total{shard="0"} (counter)
rate(vaultchat_messages_inserted_total{shard="0"}[5m])  # msg/s

# Replication lag
vaultchat_replication_lag_bytes{shard="0",replica="1"}

# Hotkey detection
vaultchat_shard_hotkey_detected{shard="5"}  # bool, 1 if hot
```

### Dashboards

**Shard Health Dashboard:**

```
Row 1: Throughput by shard (stacked bar chart)
  ├─ X-axis: Shards 0–7
  ├─ Y-axis: msg/s
  └─ Alert: Any shard > 100K msg/s (hotkey)

Row 2: Latency by shard (line chart)
  ├─ X-axis: Time
  ├─ Y-axis: p95 latency (ms)
  └─ Alert: Any shard > 200 ms

Row 3: Replication lag (heatmap)
  ├─ X-axis: Shards
  ├─ Y-axis: Replicas
  └─ Alert: Any lag > 5 s

Row 4: Distribution (pie chart)
  ├─ Message count per shard
  └─ Target: Each shard ~12.5%
```

---

## Operational Runbook

### Adding a New Shard

**Scenario:** Dynamically expand from 8 to 16 shards.

```bash
# 1. Provision new Postgres instances
terraform apply -target=aws_db_instance.shard_8

# 2. Replicate schema
pg_dump --schema-only shard-0 | psql shard-8

# 3. Enable dual-write (app code change)
# Set SHARD_COUNT = 16 in app config
docker compose up -d go-api  # Restarts with new shard count

# 4. Monitor shadow writes
SELECT COUNT(*) FROM shard_8.messages;  # Should grow

# 5. After 1 week, flip reads
# Update routing to read from new shard

# 6. Verify
npm test -- --grep="cross-shard-query"
```

### Shard Failover (Primary Dies)

```bash
# 1. Detect failure (Prometheus alert)
Alert: vaultchat_shard_primary_down{shard="3"}

# 2. Promote replica to primary
# Option A: Manual promotion
pg_ctl promote /var/lib/postgresql/

# Option B: Kubernetes (if using Percona operator)
kubectl set env deployment/postgres-shard-3 PROMOTE_REPLICA=true

# 3. Verify
psql shard-3 -c "SELECT pg_is_in_recovery();"  # Should return false

# 4. Spin new replica
# Re-run from "Provision new Postgres instances"

# 5. Update DSN
go-api env: DB_SHARD_3_PRIMARY = new-primary.domain
docker compose restart go-api
```

---

## Cost & Performance Summary

### Performance Gains

| Metric | Before (1 shard) | After (8 shards) | Gain |
|---|---|---|---|
| Write throughput | 30K msg/s | 240K msg/s | 8× |
| Read throughput | 30K msg/s | 1.6M msg/s | 53× |
| Database instances | 1 | 32 | Horizontal |
| Availability | 99% | 99.95% | Replica redundancy |

### Cost Structure

```
Compute (per shard primary + 3 replicas):
  Primary: $2,000/month
  Replica ×3: $2,000/month each
  Subtotal per shard: $8,000/month
  
Total (8 shards):
  8 × $8,000 = $64,000/month

Backup & Disaster Recovery:
  Snapshots (daily): $5,000/month
  Standby region (hot): $64,000/month (if 99.99% uptime required)
  
Total for Phase 5:
  $64K (shards) + $5K (backups) = $69K/month
  (or $133K if hot standby in another region)
```

---

## FAQs

**Q: Why shard by chat_id instead of user_id?**
A: User has many chats (1:many). Sharding by user_id causes hot shards when user is active in many chats. Shard by chat_id instead: evenly distributes because each chat is independent.

**Q: What if I need to query across chats (e.g., user's message count)?**
A: Use scatter-gather + caching. For hot queries (user stats), pre-compute and store in Redis.

**Q: How do I avoid "split-brain" during migration?**
A: Use version numbers. Every write increments version. On conflict, higher version wins. Audit trail shows both versions.

**Q: Can I shard a running system without downtime?**
A: Yes, with shadow writes:
1. Duplicate all writes to new shard for 1 week
2. Verify data is identical (checksum comparison)
3. Flip reads (10% → 100%) gradually
4. Flip writes when confident

**Q: What's the max scalable shard count?**
A: Practically, 64–256 shards. Beyond that, routing overhead matters. At 1B users, 64 shards = 16M users per shard.

---

## Next Steps After Sharding

1. **P6 (Async workers):** Kafka consumers for fanout, search, notifications
2. **P7 (Search):** Elasticsearch indexing, cross-shard full-text search
3. **P8 (Geo-distribution):** Replicate shards to other regions

Each phase unlocks another 5–10× throughput.
