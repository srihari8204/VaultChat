# VaultChat Offline-First Architecture — Quick Reference

## Executive Summary

VaultChat is scaling from AsyncStorage-based message queuing to enterprise-grade offline-first infrastructure for 100M+ users.

**Current:** AsyncStorage queue (unbounded), global BIGSERIAL sync cursor  
**Target:** SQLite queues (bounded + cleanup), per-chat delta cursors  
**Timeline:** 8 weeks (5 phases)  
**Risk Level:** Medium (well-tested patterns from WhatsApp, Signal)

---

## Key Design Decisions

| Decision | Rationale | Alternative |
|----------|-----------|-------------|
| **SQLite** for persistent queue | Indexed queries, transactions, cleanup policies | AsyncStorage (slower, unbounded) |
| **Per-chat cursors** (not global) | Faster reconnect, handles extended offline | Global cursor (simpler, slower) |
| **Last-write-wins** conflict resolution | Fits E2EE model (device is source of truth) | CRDT (complex, overkill) |
| **7-day message queue TTL** | Prevents unbounded growth, users unlikely offline >7 days | 30-day (wastes storage) |
| **Exponential backoff (1s → 60s)** | Balances user perception vs server load | Fixed retry (kills battery) |

---

## Architecture at a Glance

```
User sends message (offline)
    ↓
Message queued in SQLite (optimistic UI update)
    ↓
Network reconnects
    ↓
[2 parallel paths]
  ├→ Delta sync: Fetch new messages (GET /chats/{id}/delta)
  └→ Queue flush: Send queued messages (POST /chats/{id}/messages)
    ↓
Messages merged (last-write-wins)
    ↓
UI updated with server-issued message IDs
```

---

## Core Components

### 1. Local Storage (SQLite)

**File:** `lib/db.ts` (new), `lib/localDb.ts` (enhanced)

**Key Tables:**
- `messages` — cached messages (last 500 per chat)
- `outbound_queue` — pending sends/edits/deletes
- `sync_cursors` — per-chat BIGSERIAL + mutation timestamp
- `file_transfer_queue` — resumable uploads

**Operations:**
- `enqueueMessage()` — Add to queue
- `cacheMessages()` — Store decrypted messages
- `setCursor()` — Update sync position
- `cleanupExpiredQueueItems()` — Remove old entries

### 2. Sync Engine

**File:** `lib/syncEngine.ts` (enhance existing)

**Algorithm:**
```
FOR each chat:
  1. Get cursor: last_message_id, mutation_timestamp
  2. Fetch delta: GET /chats/{id}/delta?since={cursor}&mutatedSince={timestamp}
  3. Apply to cache: INSERT OR REPLACE (dedup by ID)
  4. Apply mutations: Process edits/deletes
  5. Update cursor: Save new position
  6. Mark delivered: Ack to server
```

**Handles:**
- Extended offline (weeks/months)
- Deleted message references
- Reaction updates
- Out-of-order delivery

### 3. Queue Management

**File:** `lib/messageQueue.ts` (refactor)

**State Machine:**
```
QUEUED → (network OK) → SENDING → SENT
  ↓                        ↓
  └← WAITING_KEYS ←───────┘
         ↓
      (keys received)
```

**Deduplication:**
- `clientId` (UUID) — survives retries → server deduplication
- `tempId` (ephemeral) — UI dedup for pending bubble

**Cleanup:**
- Sent: Delete after 7 days
- Failed: Keep 30 days (user may retry)
- Expired: Delete after TTL

### 4. Network Detection

**File:** `lib/socket.ts` + `lib/api.ts` (enhance)

**States:**
- `OFFLINE` — No connectivity
- `SLOW` — >1s latency (reduce retry frequency)
- `ONLINE` — Normal (aggressive sync)
- `FAST` — <200ms latency (prefetch)

**Triggers:**
- Socket connection/disconnection
- Periodic ping to server
- NetInfo state changes

---

## File Structure

```
lib/
├── db.ts                          [NEW] SQLite initialization + schema
├── localDb.ts                     [ENHANCED] DB adapter (messages, queue, cursors)
├── messageQueue.ts                [REFACTOR] Queue logic (migrate to SQLite)
├── syncEngine.ts                  [ENHANCE] Per-chat cursors + mutations drain
├── socket.ts                      [ENHANCE] Network state machine
├── queueCleanup.ts                [NEW] Scheduled cleanup
│
app/
├── _layout.tsx                    [ENHANCE] Init DB + cleanup scheduler
└── (chat)
    └── chat.tsx                   [ENHANCE] Show message status icons
```

---

## Implementation Roadmap

### Phase 1: SQLite Foundation (Week 1-2)
- [ ] Install react-native-quick-sqlite
- [ ] Create schema migration system
- [ ] Test: Basic CRUD operations

### Phase 2: Queue Migration (Week 3-4)
- [ ] Migrate messageQueue to SQLite
- [ ] Implement cleanup scheduler
- [ ] Test: 1000+ queued messages

### Phase 3: Sync Enhancement (Week 5-6)
- [ ] Per-chat delta cursors
- [ ] Mutation drain (paginated)
- [ ] Test: 1-week offline → reconnect

### Phase 4: Network Detection (Week 7)
- [ ] State machine: OFFLINE/SLOW/ONLINE/FAST
- [ ] UI indicators (checkmark, orange warning, red X)
- [ ] Test: Simulate various network conditions

### Phase 5: Testing & Ops (Week 8+)
- [ ] Load testing (100k devices offline)
- [ ] Chaos: Backend outage → recovery
- [ ] Gradual rollout (10% → 50% → 100%)

---

## Key Metrics

### Device-Level Storage

| User Type | Time Offline | Messages | Storage | Sync Time |
|-----------|----------|----------|---------|-----------|
| Daily | 1 day | 50 | 50 KB | 1 sec |
| Power | 3 days | 150 | 150 KB | 2 sec |
| Extended | 7 days | 350 | 350 KB | 5 sec |
| Extreme | 1 year | 18K | 5-10 MB | 30 sec |

### Server-Level (100M Users)

```
Daily active users:     30M
Avg messages/user/day:  50
Total messages/day:     1.5B

Bandwidth:
  - Incoming: 750 GB/day (17 MB/sec) ✓
  - Outgoing: 750 GB/day (17 MB/sec) ✓

Database:
  - Inserts: 17K/sec (Postgres OK) ✓
  - BIGSERIAL cursor: 17K/sec (no overflow) ✓
  - Storage: 500 GB/year (manageable) ✓

Reconnect Spike (30M users, 1 hour):
  - Requests: 1.67M/sec (need 17 instances) ✓
```

---

## Database Schema Essentials

### Messages
```sql
CREATE TABLE messages (
  id BIGINT PRIMARY KEY,                    -- server message ID
  chat_id TEXT NOT NULL,
  content TEXT,                             -- encrypted
  created_at TIMESTAMP NOT NULL,
  edited_at TIMESTAMP,                      -- mutation tracking
  deleted_at TIMESTAMP,                     -- soft delete tracking
  is_deleted BOOLEAN DEFAULT FALSE,
  
  INDEX idx_chat_created (chat_id, created_at DESC),
  INDEX idx_deleted_at (deleted_at)         -- mutations query
);
```

### Outbound Queue
```sql
CREATE TABLE outbound_queue (
  temp_id TEXT PRIMARY KEY,                 -- for UI dedup
  client_id TEXT NOT NULL UNIQUE,           -- for server dedup
  chat_id TEXT NOT NULL,
  op TEXT,                                  -- 'send' | 'edit' | 'delete'
  state TEXT,                               -- 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED'
  plaintext TEXT,                           -- encrypted before send
  attempts INTEGER DEFAULT 0,
  created_at INTEGER,
  expire_at INTEGER,                        -- TTL for cleanup
  
  INDEX idx_state (chat_id, state),
  INDEX idx_expire (expire_at)
);
```

### Sync Cursors
```sql
CREATE TABLE sync_cursors (
  id TEXT PRIMARY KEY,                      -- chat_id or "global"
  last_message_id BIGINT,                   -- BIGSERIAL cursor
  mutation_cursor TEXT,                     -- ISO timestamp
  last_synced_at TIMESTAMP
);
```

---

## Code Snippets

### Enqueue a Message
```typescript
import { enqueueText } from './lib/messageQueue';

// User taps Send
await enqueueText('chat_123', 'Hello, offline world!', {
  replyToId: 456,
  meta: { invisibleInk: true }
});

// Returns immediately (optimistic UI)
// Syncs in background
```

### Subscribe to Queue Events
```typescript
import { on } from './lib/messageQueue';

on('pending', ({ msg }) => {
  // Show ⏳ clock icon
  updateBubbleUI(msg.tempId, 'sending');
});

on('sent', ({ tempId, real }) => {
  // Replace with ✓ and server message ID
  replaceBubble(tempId, real);
});

on('failed', ({ tempId, error }) => {
  // Show ✗ with error + "Retry" button
  showFailedBubble(tempId, error);
});
```

### Sync on Reconnect
```typescript
import { onConnectionState } from './lib/socket';
import { catchUp } from './lib/syncEngine';
import { flush } from './lib/messageQueue';

onConnectionState((state) => {
  if (state === 'ONLINE') {
    // Parallel sync + flush
    Promise.all([
      catchUp(),      // Fetch new messages
      flush()         // Send queued messages
    ]).catch(console.warn);
  }
});
```

### Check Network State
```typescript
import { onNetworkStateChange } from './lib/socket';

onNetworkStateChange((state) => {
  if (state === 'OFFLINE') {
    showBanner("You're offline. Messages will send when online.");
  } else if (state === 'SLOW') {
    showBanner('Slow connection. Retrying...');
  } else {
    hideBanner();
  }
});
```

---

## Testing Strategy

### Unit Tests
```typescript
test('Queue persists across app restart', async () => {
  await enqueueText('chat1', 'Test');
  await closeDB();
  await initDB();
  const queue = await getOutboundQueue();
  expect(queue.length).toBe(1);
});

test('Deduplication via clientId', async () => {
  // Same clientId sent twice → server returns cached response
  const id = 'my-client-id';
  const msg1 = await api.post('/chats/1/messages', { clientId: id });
  const msg2 = await api.post('/chats/1/messages', { clientId: id });
  expect(msg1.id).toBe(msg2.id); // Idempotent
});
```

### Integration Tests
```typescript
test('7-day offline → reconnect', async () => {
  // Enqueue 350 messages (7 days × 50/day)
  for (let i = 0; i < 350; i++) {
    await enqueueText('chat1', `Message ${i}`);
  }
  
  // Simulate reconnect after 7 days
  await simulateReconnect();
  
  // Should sync in < 10 seconds
  const start = Date.now();
  await catchUp();
  const duration = Date.now() - start;
  
  expect(duration).toBeLessThan(10_000);
  expect(await getOutboundQueue()).toHaveLength(0); // All sent
});
```

### Load Tests
```bash
# Send 100k devices offline simultaneously
k6 run load-test.js \
  --vus 100000 \
  --duration 1h \
  --scenario "offline_reconnect"

# Monitor:
# - Queue depth (target: < 5k)
# - Sync latency (target: < 30s)
# - Duplicate rate (target: 0%)
```

---

## Rollout Plan

### Internal (Week 1)
- [ ] Enable SQLite for internal QA team
- [ ] Monitor for crashes, memory leaks
- [ ] Verify no duplicate messages

### Closed Beta (Week 2-3)
- [ ] 1% of production users
- [ ] Monitor: queue depth, sync lag, crashes
- [ ] Collect feedback on UX

### Staged (Week 4-8)
- 10% → 25% → 50% → 100%
- Stop at each stage for 3 days
- Key metrics:
  - Crash rate (should be ≤ baseline)
  - Queue depth (should be < 5k)
  - Sync lag (should be < 5 min)

### Rollback Criteria
If any:
- Crash rate +0.5%
- Queue depth stuck > 10k
- Sync lag > 1 hour
- Out-of-memory errors

**Fallback:** Disable SQLite, revert to AsyncStorage (automatic)

---

## Monitoring & Alerts

### Client-Side Instrumentation
```typescript
// Queue health
metrics.gauge('queue.outbound.size', items.length);
metrics.histogram('queue.retry.attempts', item.attempts);

// Sync health
metrics.histogram('sync.catch_up_messages', applied);
metrics.histogram('sync.cursor.lag', globalCursor - localCursor);

// Storage
metrics.gauge('storage.sqlite_mb', dbSize / 1e6);
metrics.gauge('storage.device_free_gb', freeSpace / 1e9);
```

### Alerts
```
queue.outbound.size > 10,000
  → Manual investigation (network? auth?)

sync.cursor.lag > 100,000 messages
  → Data consistency warning

crash_rate increase > 0.5%
  → Immediate rollback

storage.device_free < 100 MB
  → Cleanup triggered
```

---

## FAQ

### Q: Why SQLite instead of AsyncStorage?
AsyncStorage is unbounded and unindexed. With 1000+ queued messages, lookups are O(n). SQLite is O(log n) with transactions and cleanup policies.

### Q: What if device runs out of storage?
- Cleanup automatically deletes oldest messages (keep 500/chat)
- User shown warning to delete old media
- Offline queue still works (messages are small, ~200 bytes each)

### Q: Can users recover deleted messages?
If deleted locally only: No (device is source of truth in E2EE)  
If deleted on server: Re-download from backup (if exists)

### Q: What about P2P sync (Bluetooth)?
Out of scope for Phase 1. Future enhancement for true local-first sync.

### Q: How do I debug a stuck queue?
```typescript
// Check queue state
const queue = await getOutboundQueue();
console.log('Queue length:', queue.length);
console.log('Oldest:', queue[0]?.createdAt);
console.log('States:', queue.map(q => q.state));

// Manually flush
await flush();

// Nuclear option: clear queue
await db.prepare('DELETE FROM outbound_queue').run();
```

---

## Production Checklist

Before launch:
- [ ] SQLite schema passes integrity_check
- [ ] Queue persists across 10 app restarts
- [ ] No crash with 10k+ queued messages
- [ ] Sync cursor updates with each reconnect
- [ ] Network state transitions smooth
- [ ] Message deduplication verified
- [ ] Cleanup runs daily without error
- [ ] UI indicators display correctly
- [ ] Offline banner appears/disappears correctly
- [ ] Failed message "Retry" button works

Monitoring (first week):
- [ ] Queue depth trend (should be stable)
- [ ] Sync lag trend (should be < 5min)
- [ ] Crash rate (should be ≤ baseline)
- [ ] Storage usage (should be < 100MB median)

---

## Related Documents

- **`OFFLINE_FIRST_ARCHITECTURE.md`** — Complete technical design (200+ pages)
- **`OFFLINE_IMPLEMENTATION_GUIDE.md`** — Code templates and phase breakdowns
- **`ARCHITECTURE.md`** — System overview
- **`lib/messageQueue.ts`** — Current implementation
- **`lib/syncEngine.ts`** — Current sync logic

---

**Last Updated:** 2026-08-07  
**Status:** Ready for Engineering Review  
**Questions?** File an issue in the VaultChat repo or DM @team
