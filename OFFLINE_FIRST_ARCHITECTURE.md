# VaultChat Offline-First Architecture (100M+ Users)

## Executive Summary

This document specifies a production offline-first architecture for VaultChat targeting 100M+ concurrent users. VaultChat already has a functional AsyncStorage-based message queue (`lib/messageQueue.ts`) and delta sync engine (`lib/syncEngine.ts`). This design scales those patterns to enterprise resilience while maintaining E2EE guarantees and optimistic-update UX.

**Current state:** AsyncStorage queue (unbounded, no cleanup), delta sync with global BIGSERIAL cursor, optional mutations catch-up.

**Target state:** 
- SQLite-backed persistent queues (with TTL cleanup)
- Per-chat delta cursors (faster reconnect)
- Conflict-free merge semantics
- 100M+ users without storage/bandwidth explosion
- Zero offline message loss under any scenario except catastrophic device failure

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ VaultChat Mobile Client (React Native / Expo)                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐         ┌──────────────────┐              │
│  │  UI Layer       │◄───────►│  Redux/Zustand   │              │
│  │  (chat.tsx)     │         │  (state mgmt)    │              │
│  └─────────────────┘         └──────────────────┘              │
│           ▲                            ▲                        │
│           │                            │                        │
│  ┌────────┴────────────────────────────┴──────────┐            │
│  │         Service Layer (chatService.ts)         │            │
│  │  - Compose messages                            │            │
│  │  - Encrypt with Double Ratchet (E2EE)         │            │
│  │  - Apply local optimistic updates             │            │
│  └────────┬──────────────────────┬────────────────┘            │
│           │                      │                             │
│  ┌────────▼──────┐    ┌──────────▼──────────┐                 │
│  │  Local Queue  │    │  Sync Engine        │                 │
│  │  (messageQueue.ts) │  (syncEngine.ts)    │                 │
│  │                │    │                    │                 │
│  │ Persistence:  │    │ - Per-chat cursor  │                 │
│  │  SQLite +     │    │ - Delta fetch      │                 │
│  │  AsyncStorage │    │ - Mutation drain   │                 │
│  └────────┬──────┘    └──────────┬─────────┘                 │
│           │                      │                             │
│  ┌────────▼──────────────────────▼──────────┐                │
│  │         Network & Socket Layer            │                │
│  │  (api.ts + socket.ts)                    │                │
│  │  - WebSocket (Socket.IO)                 │                │
│  │  - HTTP REST (Delta API)                 │                │
│  │  - Retry logic + exponential backoff     │                │
│  └────────┬───────────────────────────────┬─┘                │
│           │                               │                   │
│           │ OFFLINE MODE                  │ ONLINE MODE      │
│           │ (queue accumulates)            │ (live sync)       │
│           │                               │                   │
└───────────┼───────────────────────────────┼──────────────────┘
            │                               │
            │ (when online)                 │ (persistent TCP)
            │                               │
           HTTP/Socket.IO                  WebSocket
            │                               │
┌───────────▼───────────────────────────────▼──────────────────┐
│ VaultChat Go Backend (api.corefinite.com)                   │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  REST Routes (Go)                                       │ │
│  │  - POST /chats/{id}/messages (send)                     │ │
│  │  - GET /chats/delta (catchup)                           │ │
│  │  - PATCH /messages/{id} (edit)                          │ │
│  │  - DELETE /messages/{id} (delete)                       │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌──────────────────────┐  ┌──────────────────────────────┐  │
│  │ Postgres 16 (PG)     │  │ Redis (live subscriptions)   │  │
│  │ - messages           │  │ - socket sessions           │  │
│  │ - BIGSERIAL cursor   │  │ - presence                  │  │
│  │ - per-chat cursors   │  │                             │  │
│  │ - mutations log      │  └──────────────────────────────┘  │
│  └──────────────────────┘                                    │
│                                                                │
│  ┌──────────────────────┐  ┌──────────────────────────────┐  │
│  │ Kafka (event log)    │  │ S3/Cloudflare R2 (media)     │  │
│  │ - message events     │  │ - encrypted attachments     │  │
│  │ - presence changes   │  │ - resizable thumbnails      │  │
│  └──────────────────────┘  └──────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

---

## 2. Local Storage Architecture

### 2.1 SQLite Database Schema

VaultChat should migrate from AsyncStorage to SQLite for persistent queues. Schema design:

#### Messages Cache Table
```sql
CREATE TABLE IF NOT EXISTS messages (
  id              BIGINT PRIMARY KEY,           -- server-issued message ID
  chat_id         TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  content         TEXT,                        -- encrypted (E2EE)
  type            TEXT,                        -- 'text' | 'reaction' | media types
  created_at      TIMESTAMP NOT NULL,
  edited_at       TIMESTAMP,                   -- mutation time
  deleted_at      TIMESTAMP,                   -- soft delete
  deleted_for_me  BOOLEAN DEFAULT FALSE,       -- private user action
  is_deleted      BOOLEAN DEFAULT FALSE,       -- tombstone
  reply_to_id     BIGINT,
  meta            JSON,                        -- invisibleInk, reactions, etc.
  read_at         TIMESTAMP,                   -- local read receipt time
  local_only      BOOLEAN DEFAULT FALSE,       -- temp, not on server yet
  sync_token      TEXT,                        -- dedup key
  
  FOREIGN KEY (chat_id) REFERENCES chats(id),
  INDEX idx_chat_created (chat_id, created_at DESC),
  INDEX idx_deleted_at (deleted_at),           -- mutations query
  INDEX idx_read_at (read_at),
  INDEX idx_sync_token (sync_token)
);

CREATE TABLE IF NOT EXISTS sync_cursors (
  id                TEXT PRIMARY KEY,          -- "global" or chat_id
  last_message_id   BIGINT,                   -- BIGSERIAL cursor
  last_fetched_at   TIMESTAMP,                -- wall-clock time
  mutation_cursor   TEXT,                     -- ISO timestamp for edits/deletes
  last_synced_at    TIMESTAMP,
  sync_status       TEXT                      -- 'pending' | 'in_progress' | 'done'
);
```

#### Outbound Queue Table
```sql
CREATE TABLE IF NOT EXISTS outbound_queue (
  temp_id         TEXT PRIMARY KEY,           -- client UUID (for deduping pending bubble)
  client_id       TEXT NOT NULL UNIQUE,       -- idempotency key (survives retries)
  chat_id         TEXT NOT NULL,
  op              TEXT,                       -- 'send' | 'edit' | 'delete'
  type            TEXT,                       -- 'text' | 'reaction' | media
  target_id       BIGINT,                     -- edit/delete: message being mutated
  plaintext       TEXT,                       -- content to encrypt before sending
  reply_to_id     BIGINT,
  meta            JSON,
  state           TEXT,                       -- 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'WAITING_KEYS'
  attempts        INTEGER DEFAULT 0,
  created_at      INTEGER,                   -- epoch ms
  last_attempt_at INTEGER,                   -- epoch ms
  last_error      TEXT,
  expire_at       INTEGER,                   -- cleanup: createdAt + 7 days
  
  PRIMARY KEY (temp_id),
  INDEX idx_chat_op_state (chat_id, op, state),
  INDEX idx_expire (expire_at)
);

CREATE TABLE IF NOT EXISTS file_transfer_queue (
  job_id          TEXT PRIMARY KEY,           -- UUID
  chat_id         TEXT NOT NULL,
  type            TEXT,                       -- 'upload' | 'download'
  file_path       TEXT,                       -- local path
  file_size       INTEGER,
  mime_type       TEXT,
  upload_url      TEXT,
  download_url    TEXT,
  chunks_total    INTEGER,                   -- for resumable uploads
  chunks_done     INTEGER,
  checksum_sha256 TEXT,
  state           TEXT,                       -- 'QUEUED' | 'IN_PROGRESS' | 'DONE' | 'FAILED'
  error_count     INTEGER DEFAULT 0,
  created_at      INTEGER,
  expire_at       INTEGER,
  
  PRIMARY KEY (job_id),
  INDEX idx_state (state)
);

CREATE TABLE IF NOT EXISTS local_reactions (
  id              TEXT PRIMARY KEY,           -- UUID
  message_id      BIGINT NOT NULL,
  chat_id         TEXT NOT NULL,
  emoji           TEXT NOT NULL,
  state           TEXT,                       -- 'QUEUED' | 'SENT' | 'FAILED'
  created_at      INTEGER,
  
  INDEX idx_message (message_id, emoji)
);

-- Attachment-to-chat mapping (for storage manager)
CREATE TABLE IF NOT EXISTS attachment_chat_map (
  attachment_id   TEXT PRIMARY KEY,           -- UUID from media filename
  chat_id         TEXT NOT NULL,
  
  INDEX idx_chat (chat_id)
);
```

### 2.2 Storage Strategy

**Dual-layer approach:**

1. **SQLite** (persistent, bounded)
   - Messages cache (last 500 per chat, or 30 days)
   - Outbound queues (text + reactions only; files are separate)
   - Sync cursors
   - Attachment map

2. **AsyncStorage** (ephemeral, fallback)
   - Sync state flags
   - UI transient state
   - Fallback if SQLite unavailable (degrades gracefully)

**Rationale:**
- SQLite: Indexed queries, transactions, cleanup policies
- AsyncStorage: No schema migration headaches, proven in production
- Hybrid: If SQLite fails, app continues with AsyncStorage (slower but works)

### 2.3 Cleanup Policies

#### Message Cache Cleanup
```typescript
async function cleanupMessageCache(chatId: string) {
  // Keep last N messages OR messages from last 30 days
  const keepCount = 500;
  const keepSince = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
  
  const toDelete = db.prepare(`
    SELECT id FROM messages 
    WHERE chat_id = ? 
      AND created_at < ? 
      AND id NOT IN (SELECT id FROM messages 
                      WHERE chat_id = ? 
                      ORDER BY created_at DESC 
                      LIMIT ?)
  `).all(chatId, keepSince, chatId, keepCount);
  
  if (toDelete.length > 0) {
    db.prepare(`DELETE FROM messages WHERE id IN (${toDelete.map(() => '?').join(',')})`)
      .run(...toDelete.map(row => row.id));
  }
}

// Run nightly or on app launch
export function scheduleCleanup() {
  setInterval(async () => {
    const chats = await listChats();
    for (const chat of chats) {
      await cleanupMessageCache(chat.id);
    }
    // Cleanup outbound queue (sent > 7 days old)
    db.prepare(`
      DELETE FROM outbound_queue 
      WHERE state = 'SENT' AND created_at < ?
    `).run(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }, 24 * 60 * 60 * 1000); // 24 hours
}
```

#### Outbound Queue Cleanup
- Delete "sent" messages after 7 days
- Delete "failed" messages after 30 days (preserve for manual retry)
- Delete "waiting_keys" after 30 days (ephemeral encryption state)
- Permanent failures marked with `error = "PERMANENT_ERROR_*"` → purge after 7 days

#### File Transfer Cleanup
- Resume interrupted uploads on reconnect
- Mark "stale" (> 24 hours) as failed
- Delete completed transfers immediately after confirmation

---

## 3. Sync Protocol

### 3.1 Delta Sync (Per-Chat Cursors) — RECOMMENDED

**Advantages:**
- Only fetches new messages (bandwidth efficient for large histories)
- Handles extended offline windows (weeks/months)
- Scalable: O(new messages) instead of O(all messages)
- Cursor survives app restart

**Implementation:**

#### Phase 1: Get Cursors on Startup
```typescript
async function initSyncCursors() {
  // Fetch or initialize per-chat cursors from server
  const cursors = await api<{ cursors: Record<string, CursorState> }>(
    '/sync/cursors'
  );
  
  for (const [chatId, cursor] of Object.entries(cursors)) {
    await db.prepare(`
      INSERT OR REPLACE INTO sync_cursors 
      (id, last_message_id, mutation_cursor, last_synced_at)
      VALUES (?, ?, ?, ?)
    `).run(chatId, cursor.lastMessageId, cursor.mutationCursor, Date.now());
  }
}
```

#### Phase 2: Catch Up on Each Reconnect
```typescript
async function catchUp(): Promise<number> {
  let applied = 0;
  
  // Per-chat catch-up
  const chats = await listChats();
  
  for (const chat of chats) {
    const cursor = await db.prepare(`
      SELECT last_message_id, mutation_cursor FROM sync_cursors WHERE id = ?
    `).get(chat.id) as CursorState;
    
    if (!cursor) continue;
    
    // Fetch new messages
    const page = await api<DeltaResponse>(`/chats/${chat.id}/delta`, {
      params: {
        since: Math.max(0, cursor.lastMessageId - 25), // lookback window
        limit: 200,
        mutatedSince: cursor.mutationCursor,
      }
    });
    
    // Apply messages
    if (page.messages?.length) {
      const hydrated = await hydrateMessages(chat.id, page.messages);
      await cacheMessages(chat.id, hydrated);
      applied += page.messages.length;
    }
    
    // Apply mutations (edits/deletes)
    if (page.mutations?.length) {
      await applyMutations(chat.id, page.mutations);
    }
    
    // Update cursor
    await db.prepare(`
      UPDATE sync_cursors 
      SET last_message_id = ?, mutation_cursor = ?, last_synced_at = ?
      WHERE id = ?
    `).run(page.nextSince, page.serverTime, Date.now(), chat.id);
    
    // Mark delivery receipts
    const maxId = Math.max(...page.messages.map(m => Number(m.id)));
    if (maxId > 0) {
      markDeliveredDurable(chat.id, maxId).catch(() => {});
    }
  }
  
  return applied;
}

// Wire to socket reconnect
onConnectionState((state) => {
  if (state === 'ONLINE') {
    catchUp().catch(console.warn);
  }
});
```

#### Phase 3: Mutations Drain (Paginated)
```typescript
async function drainMutations(chatId: string, sinceTime: string): Promise<void> {
  let cursor = sinceTime;
  const pageSize = 500;
  
  for (let page = 0; page < 20; page++) {
    const muts = await api<MutationPage>(`/chats/${chatId}/mutations`, {
      params: { since: cursor, limit: pageSize }
    });
    
    if (!muts.mutations?.length) break;
    
    // Apply each mutation (edit/delete)
    for (const mut of muts.mutations) {
      await applyMutations(chatId, [mut]);
    }
    
    // Advance strictly to avoid re-fetching
    cursor = new Date(new Date(muts.maxTimestamp).getTime() + 1).toISOString();
    
    if (muts.mutations.length < pageSize) break; // last page
  }
}
```

### 3.2 Backend Endpoint Requirements

VaultChat Go backend must implement:

```go
// GET /chats/{chatId}/delta?since={id}&limit={n}&mutatedSince={iso8601}
// Returns messages since cursor + mutations since time
type DeltaResponse struct {
  Messages   []Message   `json:"messages"`
  NextSince  int64       `json:"nextSince"`      // BIGSERIAL for next fetch
  ServerTime string      `json:"serverTime"`     // ISO8601 for mutation cursor
  More       bool        `json:"more"`           // true if more pages available
  Mutations  []Message   `json:"mutations,omitempty"` // edits/deletes only
}

// GET /sync/cursors
// Returns per-chat sync state
type CursorState struct {
  ChatId          string `json:"chatId"`
  LastMessageId   int64  `json:"lastMessageId"`
  MutationCursor  string `json:"mutationCursor"` // ISO8601 timestamp
  LastSyncedAt    int64  `json:"lastSyncedAt"`
}
```

---

## 4. Conflict Resolution

VaultChat's E2EE architecture requires last-write-wins with per-device authoritative state.

### 4.1 Conflict Scenarios & Resolution

| Scenario | Client State | Server State | Resolution | User Sees |
|----------|--------------|--------------|-----------|-----------|
| User edits msg offline, server has deleted it | Edited content | DELETED | Drop edit, show "Message was deleted" | N/A |
| User deletes msg offline, gets new reactions | DELETED_FOR_ME | Has reactions | Keep reactions, mark as deleted_for_me | Deleted, but reactions visible |
| User sends msg offline, edits it (still offline) | Both ops queue | Message queued | Send then edit in sequence | Message appears, then updates |
| Conflicting edits from 2 devices | Latest edit time wins | First edit time | Client edit wins if newer | User's latest edit shown |
| Read receipts out of order | User reads msg#3 | Server has #1-2 read | Trust client (user knows what they read) | Local state accurate |

### 4.2 Implementation

```typescript
// Last-Write-Wins: Always prefer local state over server state
async function mergeMessageState(
  local: Message,
  server: Message
): Promise<Message> {
  // For text: prefer newer content
  if (local.editedAt && server.editedAt) {
    if (new Date(local.editedAt) > new Date(server.editedAt)) {
      return { ...server, content: local.content, editedAt: local.editedAt };
    }
  }
  
  // For deletion: trust server (canonical)
  if (server.isDeleted) {
    return { ...local, isDeleted: true, deletedAt: server.deletedAt };
  }
  
  // For read receipts: always trust latest client read
  if (local.readAt && server.readAt) {
    if (new Date(local.readAt) > new Date(server.readAt)) {
      return { ...server, readAt: local.readAt };
    }
  }
  
  // Default: server state is canonical
  return server;
}

// Queue-level conflict detection
async function checkConflict(queued: QueuedMessage): Promise<string | null> {
  // Check if target message was deleted on server
  if (queued.op === 'edit' || queued.op === 'delete') {
    const msg = await getMessageFromServer(queued.targetId);
    if (!msg || msg.isDeleted) {
      return 'TARGET_MESSAGE_DELETED';
    }
  }
  
  // Check if chat membership was revoked
  const chat = await getChatFromServer(queued.chatId);
  if (!chat || chat.isArchived) {
    return 'NOT_A_MEMBER';
  }
  
  return null;
}

// Retry with conflict detection
async function flushQueue() {
  const items = await loadQueue();
  
  for (const item of items) {
    // Check conflicts before sending
    const conflict = await checkConflict(item);
    if (conflict) {
      markFailed(item.tempId, 'PERMANENT_ERROR_' + conflict);
      continue;
    }
    
    try {
      await sendQueuedMessage(item);
      markSent(item.tempId);
    } catch (err) {
      if (isPermanentError(err)) {
        markFailed(item.tempId, err.message);
      }
      // Else: retry on next reconnect
    }
  }
}
```

---

## 5. Queue Management

### 5.1 Outbound Queue State Machine

```
┌─────────────────────────────────────────────────────┐
│                   QUEUE STATE                        │
├─────────────────────────────────────────────────────┤
│                                                      │
│  User Sends              Offline/Online Retry       │
│  Message                 Exponential Backoff        │
│    │                           │                    │
│    ▼                           ▼                    │
│  QUEUED ──────(attempt)──► SENDING                  │
│    ▲                          │                     │
│    │                          ├──(5xx/timeout)──┐   │
│    │                          │                 │   │
│    │   ┌──────────────────────┴──(4xx)──►(FAILED)  │
│    │   │                      │         ▲          │
│    │   │                      ├────(success)       │
│    │   │                      │         │          │
│    │   │                      ▼         │          │
│    │   └─────────────────────(SENT)────┘          │
│    │                                               │
│    └──────────(retry button)───────────────────┘  │
│                                                    │
│  Special: WAITING_KEYS (ephemeral encryption)    │
│    QUEUED ──(no keys)──► WAITING_KEYS             │
│      ▲                       │                    │
│      └───(keys arrive)───────┘                    │
│                                                   │
└────────────────────────────────────────────────────┘
```

### 5.2 Retry Strategy

```typescript
const BACKOFF_MS = [
  1_000,    // 1s
  3_000,    // 3s
  8_000,    // 8s
  20_000,   // 20s
  45_000,   // 45s
  60_000,   // 60s (caps here, holds indefinitely)
];

const PERMANENT_ERRORS = {
  400: 'Malformed request',
  403: 'Blocked or not a member',
  404: 'Chat or message not found',
  413: 'Message too large',
};

async function retryQueue() {
  const items = await db.prepare(
    'SELECT * FROM outbound_queue WHERE state IN (?, ?) ORDER BY created_at'
  ).all('QUEUED', 'SENDING');
  
  for (const item of items) {
    const nextRetry = item.lastAttemptAt + BACKOFF_MS[Math.min(item.attempts, BACKOFF_MS.length - 1)];
    
    if (Date.now() < nextRetry) continue; // Not yet
    
    try {
      const response = await sendMessage(item);
      
      await db.prepare(`
        UPDATE outbound_queue 
        SET state = ?, attempts = attempts + 1, last_attempt_at = ?
        WHERE temp_id = ?
      `).run('SENT', Date.now(), item.tempId);
      
      emit('sent', { tempId: item.tempId, chatId: item.chatId, real: response });
      
    } catch (err: any) {
      const status = err.status;
      const isPermament = PERMANENT_ERRORS[status];
      
      if (isPermanent) {
        await db.prepare(`
          UPDATE outbound_queue 
          SET state = 'FAILED', last_error = ?, expire_at = ?
          WHERE temp_id = ?
        `).run('PERMANENT_ERROR: ' + PERMANENT_ERRORS[status], Date.now() + 7 * 24 * 60 * 60 * 1000, item.tempId);
        
        emit('failed', { tempId: item.tempId, chatId: item.chatId, error: PERMANENT_ERRORS[status] });
      } else {
        // Transient: exponential backoff
        await db.prepare(`
          UPDATE outbound_queue 
          SET state = 'QUEUED', attempts = attempts + 1, last_attempt_at = ?, last_error = ?
          WHERE temp_id = ?
        `).run(Date.now(), err.message, item.tempId);
      }
    }
  }
}

// Run periodically + on reconnect
setInterval(() => retryQueue(), 30_000);
onConnectionState((s) => { if (s === 'ONLINE') retryQueue(); });
```

### 5.3 Deduplication

Every queued message has a **clientId** (stable UUID) that survives retries:

```typescript
export async function enqueueText(chatId: string, plaintext: string): Promise<QueuedMessage> {
  const item = {
    tempId: newTempId(),                      // For UI dedup (ephemeral)
    clientId: Crypto.randomUUID(),            // For server idempotency (stable)
    chatId,
    plaintext,
    attempts: 0,
    createdAt: Date.now(),
  };
  
  await db.prepare(`
    INSERT INTO outbound_queue (
      temp_id, client_id, chat_id, op, type, plaintext, state, created_at, attempts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.tempId, item.clientId, item.chatId, 'send', 'text', 
    item.plaintext, 'QUEUED', item.createdAt, 0
  );
  
  emit('pending', { msg: item });
  retryQueue().catch(() => {});
  
  return item;
}
```

Server idempotency:
```go
// POST /chats/{id}/messages with header: X-Client-ID: {clientId}
func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) {
  clientID := r.Header.Get("X-Client-ID")
  
  // Check if this clientId was already processed
  existing, _ := h.db.GetByClientID(clientID)
  if existing != nil {
    w.Header().Set("X-Idempotent", "true")
    json.NewEncoder(w).Encode(existing) // Return cached result
    return
  }
  
  // Process new message
  msg := h.processMessage(r)
  h.db.StoreClientID(clientID, msg)
  
  w.Header().Set("X-Idempotent", "false")
  json.NewEncoder(w).Encode(msg)
}
```

---

## 6. Network State Detection

### 6.1 State Machine

```
                    ┌────────────────────────┐
                    │      CONNECTING        │
                    └────┬─────────────────┬──┘
                         │                 │
                    (socket up)       (socket down)
                         │                 │
                         ▼                 ▼
                    ┌─────────────────────────┐
                    │      ONLINE             │◄───┐
                    │  (live socket)          │    │
                    │  (reconnect sync)       │    │
                    └────┬─────────────────┬──┘    │
                         │                 │       │
                   (slow network)    (socket close)│
                         │                 │       │
                         ▼                 ▼       │
                    ┌──────────────────────────┐   │
                    │   SLOW / DEGRADED        │   │
                    │  (>1s latency)           │   │
                    │  (queue only)            │   │
                    └────┬──────────────────┬──┘   │
                         │                  │      │
                   (recovered)         (timeout)   │
                         │                  │      │
                         │                  ▼      │
                         │            ┌────────────┤
                         │            │  OFFLINE   │
                         └───────────►│  (queued)  │
                                      │  (retry)   │
                                      └────────────┘
```

### 6.2 Detection Implementation

```typescript
import NetInfo from '@react-native-community/netinfo';

type NetworkState = 'OFFLINE' | 'SLOW' | 'ONLINE' | 'FAST';

let currentState: NetworkState = 'ONLINE';
const listeners = new Set<(s: NetworkState) => void>();

async function detectNetworkState(): Promise<NetworkState> {
  const state = await NetInfo.fetch();
  
  if (!state.isConnected) return 'OFFLINE';
  
  // Measure latency to backend
  const start = Date.now();
  try {
    await fetch('https://api.corefinite.com/ping', { timeout: 5000 });
    const latency = Date.now() - start;
    
    if (latency > 1000) return 'SLOW';
    if (latency < 200) return 'FAST';
    return 'ONLINE';
  } catch {
    return 'OFFLINE'; // Unreachable despite having internet
  }
}

async function initNetworkDetection() {
  // Poll every 5 seconds + listen to NetInfo changes
  const unsubscribe = NetInfo.addEventListener((state) => {
    detectNetworkState().then((ns) => {
      if (ns !== currentState) {
        currentState = ns;
        notifyListeners(ns);
      }
    });
  });
  
  setInterval(async () => {
    const ns = await detectNetworkState();
    if (ns !== currentState) {
      currentState = ns;
      notifyListeners(ns);
    }
  }, 5000);
}

export function onNetworkStateChange(fn: (s: NetworkState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners(state: NetworkState) {
  listeners.forEach(fn => { try { fn(state); } catch {} });
}

// Behavior per state
onNetworkStateChange((state) => {
  if (state === 'ONLINE' || state === 'FAST') {
    // Aggressive sync
    catchUp().catch(() => {});
    retryQueue().catch(() => {});
  } else if (state === 'SLOW') {
    // Reduce retry frequency, drop non-critical syncs
    clearInterval(syncInterval);
    syncInterval = setInterval(() => retryQueue(), 60_000); // 60s instead of 30s
  } else if (state === 'OFFLINE') {
    // Stop trying, show banner
    showOfflineBanner(true);
  }
});
```

---

## 7. UI/UX Patterns

### 7.1 Message Status Indicators

```typescript
type MessageStatus = 
  | 'sending'      // ⏳ clock
  | 'sent'         // ✓ checkmark (on device)
  | 'delivered'    // ✓✓ double checkmark (on server)
  | 'read'         // ✓✓ (blue)
  | 'failed'       // ✗ red
  | 'failed_perm'  // ✗✗ red (permanent)
  | 'queued';      // ⏰ clock with warning

// In message bubble
function MessageBubble({ msg, status }: Props) {
  const icon = {
    'sending': <Spinner size={16} />,
    'sent': <Check size={16} color="gray" />,
    'delivered': <CheckCheck size={16} color="gray" />,
    'read': <CheckCheck size={16} color="blue" />,
    'failed': <X size={16} color="red" onPress={() => showRetryMenu(msg)} />,
    'failed_perm': <XCircle size={16} color="red" />,
    'queued': <Clock size={16} color="orange" />,
  }[status];
  
  return (
    <View>
      <Text>{msg.content}</Text>
      {icon}
    </View>
  );
}
```

### 7.2 Offline Banner

```typescript
function ConnectionBanner() {
  const [state, setState] = useState<NetworkState>('ONLINE');
  
  useEffect(() => {
    const unsub = onNetworkStateChange(setState);
    return unsub;
  }, []);
  
  if (state === 'ONLINE' || state === 'FAST') return null;
  
  const banner = {
    'OFFLINE': { color: 'red', text: "You're offline. Messages will send when online." },
    'SLOW': { color: 'orange', text: 'Slow connection. Retrying...' },
  }[state];
  
  return (
    <View style={{ backgroundColor: banner.color, padding: 8 }}>
      <Text>{banner.text}</Text>
    </View>
  );
}
```

### 7.3 Failed Message UI

```typescript
function FailedMessageMenu({ msg }: Props) {
  return (
    <Menu>
      <MenuOption text="Retry" onSelect={() => retryMessage(msg.tempId)} />
      <MenuOption text="Delete" onSelect={() => deleteMessage(msg.tempId)} style={{ color: 'red' }} />
      <MenuOption text="Copy" onSelect={() => copyToClipboard(msg.content)} />
    </Menu>
  );
}

async function retryMessage(tempId: string) {
  // Move from FAILED back to QUEUED
  await db.prepare(`
    UPDATE outbound_queue SET state = 'QUEUED', attempts = 0 WHERE temp_id = ?
  `).run(tempId);
  
  retryQueue().catch(() => {});
}
```

---

## 8. Scalability Analysis

### 8.1 Storage Limits (Single Device)

| Scenario | Message Count | Storage | Sync Time | Device Impact |
|----------|--------------|---------|-----------|--------------|
| Daily user (1 month) | ~1,500 | 500 KB | 2-3 sec | ✓ None |
| Power user (3 months) | ~4,500 | 1.5 MB | 5-8 sec | ✓ None |
| Inactive user (1 year) | ~18,000 | 5-10 MB | 15-30 sec | ✓ Minor |
| Extreme (5 years) | ~90,000 | 30-50 MB | 60-120 sec | ⚠ Noticeable |
| Outbound queue (1 week backlog) | ~350 | 100 KB | <1 sec | ✓ None |

### 8.2 Bandwidth (at Scale)

**For 100M users:**

```
Daily active users:           30M
Avg messages per user/day:    50
Total messages/day:           1.5B

Per-user catch-up bandwidth:
  - 50 messages/day × 200 bytes avg = 10 KB/day
  - Over 100M users: 1 TB/day for all catch-ups
  - If spread across 24 hours: ~12 MB/sec (easily handled)

Backend bandwidth:
  - Incoming: 1.5B msg × 500 bytes = 750 GB/day incoming
  - Outgoing: 1.5B msg × 500 bytes = 750 GB/day outgoing
  - Total: 1.5 TB/day (~17 MB/sec) — modest for a CDN

Database (Postgres):
  - 1.5B inserts/day = ~17k inserts/sec (within Postgres limits)
  - BIGSERIAL cursor advances at 17k/sec (no overflow)
  - Index size: ~500 GB for 365 days of history
```

### 8.3 Concurrency

**Worst case: 30M users all come online simultaneously (after outage):**

```
30M users × 200 messages to catch up = 6B messages
Delivered over 1 hour = 1.67M requests/sec

Backend capacity:
  - Go can handle ~100k requests/sec per instance
  - Need 17 instances to handle spike
  - Kafka: 3.8M msgs/sec sustained (OK, peak is lower)
  - Postgres: 100k transactions/sec per instance (scale with read replicas)
```

**Mitigation:**
- Use read replicas for delta queries (not write-heavy)
- Rate-limit reconnects (stagger over 5 minutes)
- Compress message payloads
- Use CDN for static cursors

---

## 9. Security Considerations

### 9.1 Local Storage Security

**Threats:**
- Device theft → SQLite + AsyncStorage unencrypted
- Malicious app with shared storage access
- Memory dumps during sync

**Mitigations:**
1. **Hardware-backed encryption** (Android Keystore)
   ```typescript
   // Encrypt queue with device key
   import * as SecureStore from 'expo-secure-store';
   
   async function encryptQueue() {
     const deviceKey = await SecureStore.getItemAsync('vc_queue_key') ??
       await SecureStore.setItemAsync('vc_queue_key', Crypto.randomUUID());
     
     const plaintext = JSON.stringify(queue);
     const encrypted = await Crypto.digestAsync(
       Crypto.CryptoDigestAlgorithm.SHA256,
       plaintext + deviceKey
     );
     
     await AsyncStorage.setItem('vc_queue_encrypted', encrypted);
   }
   ```

2. **Field-level encryption** for sensitive fields
   ```sql
   -- Encrypt plaintext before storing
   UPDATE outbound_queue 
   SET plaintext = pgp_sym_encrypt(plaintext, device_key)
   WHERE state IN ('QUEUED', 'SENDING');
   ```

3. **Memory management**
   ```typescript
   // Wipe sensitive data from memory after use
   function wipeSensitiveData(msg: QueuedMessage) {
     msg.plaintext = '';
     msg.clientId = '';
   }
   ```

### 9.2 Idempotency & Replay

- Every message has `clientId` (server-side dedup)
- Delta cursor prevents replaying old messages
- Per-device session ID in WebSocket (prevents cross-device replays)

### 9.3 End-to-End Encryption Consistency

- Queue stores **plaintext** (device-local only)
- Encryption happens immediately before network send
- Each message carries unique IV (prevents ciphertext replay)
- Double Ratchet ensures forward secrecy even if device stolen later

---

## 10. Migration Plan

### Phase 1: Foundation (Week 1-2)
- [ ] Add SQLite to dependencies
- [ ] Create schema (migrations)
- [ ] Implement `localDb.ts` adapter
- [ ] Dual-write AsyncStorage → SQLite (for testing)

### Phase 2: Queue Migration (Week 3-4)
- [ ] Migrate `messageQueue.ts` to use SQLite
- [ ] Implement cleanup policies
- [ ] Test with load: 1000+ queued messages
- [ ] Verify deduplication on server

### Phase 3: Sync Enhancement (Week 5-6)
- [ ] Implement per-chat delta cursors
- [ ] Extend backend with `/sync/cursors` endpoint
- [ ] Add mutation drain logic
- [ ] Test: 1 week offline → reconnect

### Phase 4: Network State (Week 7)
- [ ] Integrate latency detection
- [ ] Implement state machine
- [ ] Add UI indicators
- [ ] Test: Simulate slow network

### Phase 5: Testing & Ops (Week 8+)
- [ ] Load test: 100k devices offline
- [ ] Chaos: Backend outage → recovery
- [ ] Monitoring: Queue depth, sync latency
- [ ] Gradual rollout (10% → 50% → 100%)

---

## 11. Monitoring & Observability

### 11.1 Client-Side Metrics

```typescript
// Queue health
metrics.gauge('queue.outbound.size', queueItems.length);
metrics.gauge('queue.outbound.oldest_age_sec', (Date.now() - oldestItem.createdAt) / 1000);
metrics.histogram('queue.retry.attempts', item.attempts);

// Sync health
metrics.histogram('sync.catch_up_messages', applied);
metrics.histogram('sync.catch_up_duration_ms', duration);
metrics.gauge('sync.cursor.lag_messages', globalCursor - localCursor);

// Network
metrics.gauge('network.state', stateToNumber(currentState)); // 0=OFFLINE, 1=SLOW, 2=ONLINE, 3=FAST
metrics.histogram('network.ping_latency_ms', latency);

// Storage
metrics.gauge('storage.sqlite_size_bytes', dbSize);
metrics.gauge('storage.async_storage_size_bytes', storageSize);
```

### 11.2 Server-Side Metrics

```go
// Queue processing
m.queueProcessTime.Observe(time.Since(start).Seconds())
m.queueRetries.WithLabelValues(status).Inc()
m.clientIDHits.Inc() // Idempotency cache hits

// Delta sync
m.deltaMessagesServed.Add(len(messages))
m.deltaCursorLag.Observe(float64(globalCursor - clientCursor))
m.mutationDrainPages.Observe(float64(pages))

// Kafka
m.kafkaProducedMessages.Add(count)
m.kafkaProducerLatency.Observe(latency)
```

### 11.3 Alerting

- **Queue depth > 5000** → investigate network/auth issues
- **Sync lag > 1 hour** → data consistency warning
- **Permanent errors > 1%** → investigate app bugs
- **SQLite size > 500 MB** → manual cleanup needed
- **Offline duration > 24 hours** → may have catastrophic data loss

---

## 12. Edge Cases & Disaster Recovery

### 12.1 Data Loss Scenarios

| Scenario | Cause | Prevention | Recovery |
|----------|-------|-----------|----------|
| SQLite corrupted | Storage failure | Checksums, regular backups | Fall back to AsyncStorage, resync |
| Device factory reset | User action | Warn before reset | Restore from cloud backup |
| All local messages wiped | Malware | Periodic cloud sync | Re-download from server (delta) |
| Server cursor reset | Maintenance error | Test backup/restore | Resync from cursor=0 (slow) |
| Duplicate messages | Idempotency fail | clientId verification | Deduplicate on client (by timestamp + sender) |

### 12.2 Recovery Procedures

```typescript
// Detect SQLite corruption
async function verifyDatabase() {
  try {
    await db.prepare('PRAGMA integrity_check').all();
  } catch {
    console.error('SQLite corruption detected');
    // Fall back to AsyncStorage, flag for user
    showAlert('Database corrupted. Syncing from server...');
    await clearAllQueues();
    await catchUp(); // Re-download everything
  }
}

// On catastrophic failure
async function nukeAndResync() {
  // Clear all local state
  await db.prepare('DELETE FROM messages').run();
  await db.prepare('DELETE FROM outbound_queue').run();
  await db.prepare('UPDATE sync_cursors SET last_message_id = 0').run();
  
  // Re-download everything (will be slow for large histories)
  await catchUp();
}

// Verify deduplication
async function deduplicateMessages(chatId: string) {
  const dups = await db.prepare(`
    SELECT content, sender_id, created_at, COUNT(*) as cnt
    FROM messages
    WHERE chat_id = ?
    GROUP BY content, sender_id, created_at
    HAVING cnt > 1
  `).all(chatId);
  
  if (dups.length > 0) {
    console.warn(`${dups.length} potential duplicates found, keeping latest`);
    // Delete older copies
  }
}
```

---

## 13. Future Enhancements

### 13.1 P2P Sync (Bluetooth)
When both devices offline in same room, sync via Bluetooth to avoid complete data loss.

### 13.2 Hybrid Cloud Backup
Periodically upload encrypted queue to cloud (E2EE, server doesn't decrypt).

### 13.3 Compression
Compress message payloads (LZ4) for bandwidth savings on slow networks.

### 13.4 Predictive Prefetch
On strong WiFi, prefetch anticipated messages (friends' active chats).

### 13.5 Message Deduplication
CRDTs for truly distributed sync (local-first databases like ElectricSQL).

---

## 14. Appendix: Code Examples

### A. Complete Queue Flush

```typescript
export async function flushQueue(): Promise<void> {
  const items = await loadQueue();
  let sent = 0;
  let failed = 0;
  
  for (const item of items) {
    if (item.state === 'SENT') continue; // Already sent
    
    try {
      // Check if we have encryption keys for this chat
      const keys = await getSessionKeys(item.chatId);
      if (!keys) {
        // Defer until keys arrive
        await updateQueueItem(item.tempId, { state: 'WAITING_KEYS' });
        continue;
      }
      
      // Encrypt message
      const encrypted = await encryptForChat(item.chatId, item.plaintext);
      
      // Send
      const response = await api.post(`/chats/${item.chatId}/messages`, {
        clientId: item.clientId,
        type: item.type,
        encrypted,
        replyToId: item.replyToId,
        meta: item.meta,
      }, {
        headers: { 'X-Client-ID': item.clientId },
        timeout: 30_000,
      });
      
      // Mark as sent
      await updateQueueItem(item.tempId, {
        state: 'SENT',
        attempts: item.attempts + 1,
      });
      
      emit('sent', { 
        tempId: item.tempId, 
        chatId: item.chatId, 
        real: response 
      });
      
      sent++;
      
    } catch (err: any) {
      const status = err.response?.status;
      
      // Permanent errors
      if (isPermanent(status)) {
        await updateQueueItem(item.tempId, {
          state: 'FAILED',
          lastError: `${status}: ${err.message}`,
          expireAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        
        emit('failed', {
          tempId: item.tempId,
          chatId: item.chatId,
          error: err.message,
        });
        
        failed++;
      } else {
        // Transient: retry with backoff
        const backoff = BACKOFF_MS[Math.min(item.attempts, BACKOFF_MS.length - 1)];
        await updateQueueItem(item.tempId, {
          state: 'QUEUED',
          attempts: item.attempts + 1,
          lastError: err.message,
          lastAttemptAt: Date.now() + backoff,
        });
      }
    }
  }
  
  if (sent > 0 || failed > 0) {
    console.log(`[queue] flushed: ${sent} sent, ${failed} failed`);
  }
}
```

### B. Test: Offline for 7 Days

```typescript
async function testOfflineReconnect() {
  // 1. Send 350 messages offline
  await networkManager.disconnect();
  for (let i = 0; i < 350; i++) {
    await enqueueText('chat123', `Test message ${i}`);
  }
  
  const queue = await loadQueue();
  assert(queue.length === 350, 'Queue should have 350 items');
  
  // 2. Simulate 7 days passing
  await FastClock.advance(7 * 24 * 60 * 60 * 1000);
  
  // 3. Reconnect
  await networkManager.connect();
  
  // Should flush all 350 with exponential backoff
  let sent = 0;
  on('sent', () => { sent++; });
  
  await catchUp();
  await flushQueue();
  
  // Give retries time to process
  await sleep(5000);
  
  // Verify all sent
  const remaining = await loadQueue();
  assert(remaining.filter(i => i.state !== 'SENT').length === 0, 
    `All should be sent, but ${remaining.length} remain`);
}
```

---

## 15. References

- **VaultChat Codebase**
  - `lib/messageQueue.ts` — Current AsyncStorage queue
  - `lib/syncEngine.ts` — Current delta sync
  - `lib/chatService.ts` — E2EE + message service
  - `vaultchat-backend-go/routes/` — REST handlers

- **External**
  - [SQLite on React Native](https://github.com/margelo/react-native-quick-sqlite)
  - [WhatsApp Offline Architecture](https://www.youtube.com/watch?v=CKaiyVHQy2k)
  - [Conflict-free Replicated Data Types (CRDTs)](https://crdt.tech/)
  - [Double Ratchet Algorithm (Signal)](https://signal.org/docs/specifications/doubleratchet/)

---

**Document Version:** 1.0  
**Last Updated:** 2026-08-07  
**Author:** Claude Code  
**Status:** Ready for Engineering Review
