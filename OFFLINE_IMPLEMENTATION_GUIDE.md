# VaultChat Offline-First Implementation Guide

## Quick Start for Engineers

This guide provides concrete implementation tasks, code templates, and testing procedures for rolling out the offline-first architecture to production.

---

## Phase 1: SQLite Integration (Week 1-2)

### Task 1.1: Add Dependencies

```bash
# Install SQLite library (React Native)
npm install --save react-native-quick-sqlite expo-sqlite

# Dev dependencies for testing
npm install --save-dev sqlite3 @types/sqlite3
```

**Update `app.json`:**
```json
{
  "plugins": [
    ["expo-sqlite"]
  ]
}
```

### Task 1.2: Create Database Adapter

**File: `lib/db.ts`** (New)

```typescript
import SQLite from 'react-native-quick-sqlite';
import * as FileSystem from 'expo-file-system';

const DB_PATH = FileSystem.documentDirectory + 'vaultchat.db';
let db: SQLite.QuickSQLiteConnection | null = null;

export async function initDB(): Promise<void> {
  try {
    db = await SQLite.open(DB_PATH);
    await runMigrations();
    console.log('[db] initialized at', DB_PATH);
  } catch (err) {
    console.error('[db] initialization failed:', err);
    throw err;
  }
}

export function getDB(): SQLite.QuickSQLiteConnection {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  return db;
}

async function runMigrations(): Promise<void> {
  const migrations = [
    // Migration 001: Initial schema
    {
      id: '001_init',
      sql: `
        CREATE TABLE IF NOT EXISTS messages (
          id BIGINT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          content TEXT,
          type TEXT,
          created_at TIMESTAMP NOT NULL,
          edited_at TIMESTAMP,
          deleted_at TIMESTAMP,
          deleted_for_me BOOLEAN DEFAULT FALSE,
          is_deleted BOOLEAN DEFAULT FALSE,
          reply_to_id BIGINT,
          meta JSON,
          read_at TIMESTAMP,
          local_only BOOLEAN DEFAULT FALSE,
          sync_token TEXT,
          FOREIGN KEY (chat_id) REFERENCES chats(id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_chat_created ON messages (chat_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_deleted_at ON messages (deleted_at);
        CREATE INDEX IF NOT EXISTS idx_sync_token ON messages (sync_token);
        
        CREATE TABLE IF NOT EXISTS sync_cursors (
          id TEXT PRIMARY KEY,
          last_message_id BIGINT,
          last_fetched_at TIMESTAMP,
          mutation_cursor TEXT,
          last_synced_at TIMESTAMP,
          sync_status TEXT
        );
        
        CREATE TABLE IF NOT EXISTS outbound_queue (
          temp_id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL UNIQUE,
          chat_id TEXT NOT NULL,
          op TEXT,
          type TEXT,
          target_id BIGINT,
          plaintext TEXT,
          reply_to_id BIGINT,
          meta JSON,
          state TEXT,
          attempts INTEGER DEFAULT 0,
          created_at INTEGER,
          last_attempt_at INTEGER,
          last_error TEXT,
          expire_at INTEGER,
          FOREIGN KEY (chat_id) REFERENCES chats(id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_queue_state ON outbound_queue (chat_id, op, state);
        CREATE INDEX IF NOT EXISTS idx_queue_expire ON outbound_queue (expire_at);
      `
    }
  ];
  
  const d = getDB();
  
  for (const migration of migrations) {
    const existing = await d.execute(
      'SELECT COUNT(*) as cnt FROM sqlite_master WHERE type=\'table\' AND name=\'_migrations\''
    );
    
    if (!existing.length) {
      await d.execute('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMP)');
    }
    
    const applied = await d.execute(
      'SELECT * FROM _migrations WHERE id = ?',
      [migration.id]
    );
    
    if (!applied.length) {
      await d.execute(migration.sql);
      await d.execute(
        'INSERT INTO _migrations (id, applied_at) VALUES (?, CURRENT_TIMESTAMP)',
        [migration.id]
      );
      console.log(`[db] applied migration ${migration.id}`);
    }
  }
}

export async function query<T = any>(
  sql: string,
  params?: any[]
): Promise<T[]> {
  try {
    const result = await getDB().execute(sql, params);
    return result as T[];
  } catch (err) {
    console.error('[db] query error:', err);
    throw err;
  }
}

export async function run(sql: string, params?: any[]): Promise<void> {
  try {
    await getDB().execute(sql, params);
  } catch (err) {
    console.error('[db] run error:', err);
    throw err;
  }
}

export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const d = getDB();
  try {
    await d.execute('BEGIN TRANSACTION');
    const result = await fn();
    await d.execute('COMMIT');
    return result;
  } catch (err) {
    await d.execute('ROLLBACK');
    throw err;
  }
}

export async function closeDB(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}

export default {};
```

### Task 1.3: Update App Root (bootstrap)

**File: `app/_layout.tsx`** (modify)

```typescript
import { useEffect } from 'react';
import { initDB } from '../lib/db';

export default function RootLayout() {
  useEffect(() => {
    initDB().catch((err) => {
      console.error('Failed to initialize database:', err);
      // Show error to user, allow fallback
    });
  }, []);
  
  // ... rest of layout
}
```

### Task 1.4: Create Database Adapter Layer

**File: `lib/localDb.ts`** (enhance existing)

```typescript
import { query, run, transaction } from './db';
import type { Message, Chat } from './chatService';

export interface QueuedMessage {
  tempId: string;
  clientId: string;
  chatId: string;
  op?: 'send' | 'edit' | 'delete';
  type: string;
  targetId?: number | null;
  plaintext: string;
  replyToId: number | null;
  meta: any | null;
  state: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'WAITING_KEYS';
  attempts: number;
  createdAt: number;
  lastError: string | null;
}

// ─── Messages ──────────────────────────────────────────────

export async function cacheMessages(chatId: string, messages: Message[]): Promise<void> {
  await transaction(async () => {
    for (const msg of messages) {
      await run(`
        INSERT OR REPLACE INTO messages (
          id, chat_id, sender_id, content, type, created_at, 
          edited_at, deleted_at, is_deleted, reply_to_id, meta, sync_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        msg.id,
        chatId,
        msg.senderId,
        msg.content,
        msg.type,
        msg.createdAt,
        msg.editedAt,
        msg.deletedAt,
        msg.isDeleted ? 1 : 0,
        msg.replyToId,
        JSON.stringify(msg.meta),
        msg.syncToken,
      ]);
    }
  });
}

export async function getMessagesForChat(chatId: string, limit = 100): Promise<Message[]> {
  const rows = await query<any>(`
    SELECT * FROM messages 
    WHERE chat_id = ? AND is_deleted = 0
    ORDER BY created_at DESC
    LIMIT ?
  `, [chatId, limit]);
  
  return rows.map(row => ({
    id: row.id,
    senderId: row.sender_id,
    content: row.content,
    type: row.type,
    createdAt: new Date(row.created_at),
    editedAt: row.edited_at ? new Date(row.edited_at) : null,
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    isDeleted: row.is_deleted === 1,
    replyToId: row.reply_to_id,
    meta: row.meta ? JSON.parse(row.meta) : null,
  }));
}

// ─── Queue ──────────────────────────────────────────────

export async function enqueueMessage(msg: QueuedMessage): Promise<void> {
  await run(`
    INSERT INTO outbound_queue (
      temp_id, client_id, chat_id, op, type, target_id,
      plaintext, reply_to_id, meta, state, attempts, created_at, last_error, expire_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    msg.tempId,
    msg.clientId,
    msg.chatId,
    msg.op || 'send',
    msg.type,
    msg.targetId,
    msg.plaintext,
    msg.replyToId,
    msg.meta ? JSON.stringify(msg.meta) : null,
    msg.state,
    msg.attempts,
    msg.createdAt,
    msg.lastError,
    msg.createdAt + 7 * 24 * 60 * 60 * 1000, // 7 days TTL
  ]);
}

export async function getOutboundQueue(): Promise<QueuedMessage[]> {
  const rows = await query<any>(`
    SELECT * FROM outbound_queue 
    WHERE state IN ('QUEUED', 'SENDING', 'WAITING_KEYS')
    ORDER BY created_at ASC
  `);
  
  return rows.map(row => ({
    tempId: row.temp_id,
    clientId: row.client_id,
    chatId: row.chat_id,
    op: row.op,
    type: row.type,
    targetId: row.target_id,
    plaintext: row.plaintext,
    replyToId: row.reply_to_id,
    meta: row.meta ? JSON.parse(row.meta) : null,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.created_at,
    lastError: row.last_error,
  }));
}

export async function updateQueueItem(
  tempId: string,
  updates: Partial<QueuedMessage>
): Promise<void> {
  const setClauses = [];
  const values: any[] = [];
  
  if (updates.state !== undefined) {
    setClauses.push('state = ?');
    values.push(updates.state);
  }
  if (updates.attempts !== undefined) {
    setClauses.push('attempts = ?');
    values.push(updates.attempts);
  }
  if (updates.lastError !== undefined) {
    setClauses.push('last_error = ?');
    values.push(updates.lastError);
  }
  
  values.push(tempId);
  
  await run(
    `UPDATE outbound_queue SET ${setClauses.join(', ')} WHERE temp_id = ?`,
    values
  );
}

export async function deleteQueueItem(tempId: string): Promise<void> {
  await run('DELETE FROM outbound_queue WHERE temp_id = ?', [tempId]);
}

export async function cleanupExpiredQueueItems(): Promise<number> {
  const result = await query<any>(`
    SELECT COUNT(*) as cnt FROM outbound_queue WHERE expire_at < ?
  `, [Date.now()]);
  
  const count = result[0]?.cnt ?? 0;
  
  if (count > 0) {
    await run('DELETE FROM outbound_queue WHERE expire_at < ?', [Date.now()]);
  }
  
  return count;
}

// ─── Sync Cursors ──────────────────────────────────────────────

export async function getCursor(id: string): Promise<CursorState | null> {
  const rows = await query<any>(`
    SELECT * FROM sync_cursors WHERE id = ?
  `, [id]);
  
  return rows[0] ? {
    id: rows[0].id,
    lastMessageId: rows[0].last_message_id,
    mutationCursor: rows[0].mutation_cursor,
    lastSyncedAt: new Date(rows[0].last_synced_at),
  } : null;
}

export async function setCursor(id: string, state: CursorState): Promise<void> {
  await run(`
    INSERT OR REPLACE INTO sync_cursors 
    (id, last_message_id, mutation_cursor, last_synced_at)
    VALUES (?, ?, ?, ?)
  `, [id, state.lastMessageId, state.mutationCursor, state.lastSyncedAt.toISOString()]);
}

export interface CursorState {
  id: string;
  lastMessageId: number;
  mutationCursor: string;
  lastSyncedAt: Date;
}

export default {};
```

### Task 1.5: Test SQLite Setup

**File: `lib/db.selftest.ts`** (New)

```typescript
import { getDB, run, query, transaction, initDB } from './db';

export async function runSQLiteTests(): Promise<void> {
  console.log('[test] SQLite self-tests...');
  
  try {
    // Test 1: Basic INSERT/SELECT
    await run('CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT)');
    await run('INSERT INTO test_table (name) VALUES (?)', ['test']);
    const rows = await query('SELECT * FROM test_table');
    console.assert(rows.length === 1, 'Should have 1 row');
    
    // Test 2: Transaction
    await transaction(async () => {
      await run('INSERT INTO test_table (name) VALUES (?)', ['tx_test']);
      throw new Error('Intentional rollback');
    }).catch(() => {});
    
    const after = await query('SELECT * FROM test_table WHERE name = ?', ['tx_test']);
    console.assert(after.length === 0, 'Transaction should have rolled back');
    
    // Test 3: Cleanup
    await run('DROP TABLE test_table');
    
    console.log('[test] SQLite tests passed');
  } catch (err) {
    console.error('[test] SQLite test failed:', err);
  }
}

// Call on app startup (debug builds only)
if (__DEV__) {
  runSQLiteTests().catch(console.error);
}
```

---

## Phase 2: Queue Migration (Week 3-4)

### Task 2.1: Migrate messageQueue.ts

**File: `lib/messageQueue.ts`** (refactor)

```typescript
import * as Crypto from 'expo-crypto';
import { enqueueMessage, getOutboundQueue, updateQueueItem } from './localDb';
import { api } from './api';
import type { QueuedMessage as DbMessage } from './localDb';

const BACKOFF_MS = [1_000, 3_000, 8_000, 20_000, 45_000, 60_000];

export interface QueuedMessage extends DbMessage {
  // Add UI-specific fields
}

// Tiny event bus
type QueueEvents = {
  pending: { msg: QueuedMessage };
  sent: { tempId: string; chatId: string; real: Message | null };
  failed: { tempId: string; chatId: string; error: string };
};

type Listener<T> = (data: T) => void;
const listeners: { [K in keyof QueueEvents]?: Set<Listener<QueueEvents[K]>> } = {};

function emit<K extends keyof QueueEvents>(event: K, data: QueueEvents[K]) {
  listeners[event]?.forEach(fn => {
    try { (fn as any)(data); } catch {}
  });
}

export function on<K extends keyof QueueEvents>(
  event: K,
  fn: Listener<QueueEvents[K]]>
): () => void {
  if (!listeners[event]) listeners[event] = new Set();
  listeners[event]!.add(fn as any);
  return () => listeners[event]?.delete(fn as any);
}

export async function enqueueText(
  chatId: string,
  plaintext: string,
  opts: { replyToId?: number | null; meta?: any | null } = {},
): Promise<QueuedMessage> {
  const msg: DbMessage = {
    tempId: 'temp_' + Math.random().toString(36).slice(2),
    clientId: Crypto.randomUUID(),
    chatId,
    op: 'send',
    type: 'text',
    plaintext,
    replyToId: opts.replyToId ?? null,
    meta: opts.meta ?? null,
    state: 'QUEUED',
    attempts: 0,
    createdAt: Date.now(),
    lastError: null,
    targetId: null,
  };
  
  await enqueueMessage(msg);
  emit('pending', { msg: msg as QueuedMessage });
  
  // Kick off flush in background
  flush().catch(() => {});
  
  return msg as QueuedMessage;
}

export async function flush(): Promise<void> {
  const items = await getOutboundQueue();
  
  for (const item of items) {
    if (item.state === 'SENT') continue;
    
    // Check backoff
    const backoff = BACKOFF_MS[Math.min(item.attempts, BACKOFF_MS.length - 1)];
    const nextRetry = item.createdAt + (item.attempts * backoff);
    if (Date.now() < nextRetry) continue;
    
    try {
      // Update state to SENDING
      await updateQueueItem(item.tempId, { state: 'SENDING' });
      
      // Encrypt and send
      const encrypted = await encryptForChat(item.chatId, item.plaintext);
      
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
      
      // Mark sent
      await updateQueueItem(item.tempId, { state: 'SENT' });
      emit('sent', { tempId: item.tempId, chatId: item.chatId, real: response });
      
    } catch (err: any) {
      const status = err.response?.status;
      const isPerm = [400, 403, 404, 413].includes(status);
      
      if (isPerm) {
        await updateQueueItem(item.tempId, {
          state: 'FAILED',
          lastError: `${status}: ${err.message}`,
        });
        emit('failed', { tempId: item.tempId, chatId: item.chatId, error: err.message });
      } else {
        // Exponential backoff
        await updateQueueItem(item.tempId, {
          attempts: item.attempts + 1,
          lastError: err.message,
        });
      }
    }
  }
}

// Hook up to network events
import { onConnectionState } from './socket';
onConnectionState((state) => {
  if (state === 'ONLINE') flush().catch(() => {});
});

// Periodic flush
setInterval(() => flush().catch(() => {}), 30_000);

export default {};
```

### Task 2.2: Add Cleanup Scheduler

**File: `lib/queueCleanup.ts`** (New)

```typescript
import { cleanupExpiredQueueItems, query, run } from './localDb';

export async function scheduleQueueCleanup(): Promise<void> {
  // Run cleanup every 24 hours
  setInterval(async () => {
    try {
      const deleted = await cleanupExpiredQueueItems();
      if (deleted > 0) {
        console.log(`[cleanup] removed ${deleted} expired queue items`);
      }
      
      // Also cleanup old messages (keep last 500 per chat)
      const chats = await query<any>('SELECT DISTINCT chat_id FROM messages');
      for (const row of chats) {
        await cleanupChatMessages(row.chat_id);
      }
    } catch (err) {
      console.error('[cleanup] error:', err);
    }
  }, 24 * 60 * 60 * 1000);
}

async function cleanupChatMessages(chatId: string): Promise<void> {
  const toDelete = await query<any>(`
    SELECT id FROM messages
    WHERE chat_id = ? AND id NOT IN (
      SELECT id FROM messages
      WHERE chat_id = ?
      ORDER BY created_at DESC
      LIMIT 500
    )
  `, [chatId, chatId]);
  
  if (toDelete.length > 0) {
    const ids = toDelete.map(r => r.id).join(',');
    await run(`DELETE FROM messages WHERE id IN (${ids})`);
    console.log(`[cleanup] removed ${toDelete.length} old messages from ${chatId}`);
  }
}

export default {};
```

### Task 2.3: Update App Bootstrap

**File: `app/_layout.tsx`** (update)

```typescript
import { initDB } from '../lib/db';
import { scheduleQueueCleanup } from '../lib/queueCleanup';

export default function RootLayout() {
  useEffect(() => {
    (async () => {
      try {
        await initDB();
        await scheduleQueueCleanup();
        console.log('[app] offline infrastructure ready');
      } catch (err) {
        console.error('[app] bootstrap error:', err);
      }
    })();
  }, []);
  
  // ...
}
```

### Task 2.4: Test Queue with Load

**File: `lib/messageQueue.selftest.ts`** (New)

```typescript
import { enqueueText, flush, on } from './messageQueue';
import { getOutboundQueue } from './localDb';

export async function testQueueLoad(): Promise<void> {
  console.log('[test] queue load test (1000 messages)...');
  
  let pendingCount = 0;
  let sentCount = 0;
  
  on('pending', () => { pendingCount++; });
  on('sent', () => { sentCount++; });
  
  // Enqueue 1000 messages
  for (let i = 0; i < 1000; i++) {
    await enqueueText('test_chat', `Message ${i}`);
  }
  
  console.assert(pendingCount === 1000, 'Should have 1000 pending');
  
  // Check storage
  const queue = await getOutboundQueue();
  console.assert(queue.length === 1000, 'Queue should have 1000 items');
  console.log(`[test] queue storage OK: ${queue.length} items`);
  
  // Simulate success
  for (const item of queue) {
    // Mock API
    await updateQueueItem(item.tempId, { state: 'SENT' });
  }
  
  console.log(`[test] queue test passed (${sentCount} sent)`);
}

if (__DEV__) {
  testQueueLoad().catch(console.error);
}
```

---

## Phase 3: Sync Enhancement (Week 5-6)

### Task 3.1: Per-Chat Cursor Implementation

**File: `lib/syncEngine.ts`** (enhance)

```typescript
import { getCursor, setCursor, type CursorState } from './localDb';
import { api } from './api';

interface DeltaResponse {
  messages: (Message & { chatId: string })[];
  nextSince: number;
  serverTime: string;
  more: boolean;
  mutations?: (Message & { chatId: string })[];
}

const LOOKBACK = 25;
const PAGE = 200;
const MAX_PAGES = 500;

export async function catchUp(): Promise<number> {
  let applied = 0;
  const chats = await listChats();
  
  for (const chat of chats) {
    const cursor = await getCursor(chat.id);
    const since = cursor ? Math.max(0, cursor.lastMessageId - LOOKBACK) : 0;
    
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await api<DeltaResponse>(`/chats/${chat.id}/delta`, {
        params: {
          since,
          limit: PAGE,
          mutatedSince: cursor?.mutationCursor,
        }
      });
      
      if (!r?.messages?.length) break;
      
      const hydrated = await hydrateMessages(chat.id, r.messages);
      await cacheMessages(chat.id, hydrated);
      applied += r.messages.length;
      
      // Update cursor
      await setCursor(chat.id, {
        id: chat.id,
        lastMessageId: r.nextSince,
        mutationCursor: r.serverTime || new Date().toISOString(),
        lastSyncedAt: new Date(),
      });
      
      if (!r.more) break;
    }
  }
  
  return applied;
}

export function initSync(): void {
  onConnectionState((s) => {
    if (s === 'ONLINE') catchUp().catch(() => {});
  });
}

export default {};
```

### Task 3.2: Backend Endpoint Check

Verify Go backend implements:

```go
// GET /chats/{chatId}/delta?since={id}&limit={n}&mutatedSince={iso8601}
// Returns new messages + mutations since cursor
```

**File: `vaultchat-backend-go/routes/delta.go`** (verify exists)

If not, create:

```go
package routes

import (
  "net/http"
  "strconv"
  "time"
  
  "database/sql"
)

type DeltaRequest struct {
  ChatID       string `json:"chatId"`
  Since        int64  `json:"since"`
  Limit        int    `json:"limit"`
  MutatedSince string `json:"mutatedSince"`
}

type DeltaResponse struct {
  Messages   []Message `json:"messages"`
  NextSince  int64     `json:"nextSince"`
  ServerTime string    `json:"serverTime"`
  More       bool      `json:"more"`
  Mutations  []Message `json:"mutations,omitempty"`
}

type Message struct {
  ID        int64  `json:"id"`
  ChatID    string `json:"chatId"`
  SenderID  string `json:"senderId"`
  Content   string `json:"content"`
  Type      string `json:"type"`
  CreatedAt string `json:"createdAt"`
  EditedAt  string `json:"editedAt,omitempty"`
  DeletedAt string `json:"deletedAt,omitempty"`
  IsDeleted bool   `json:"isDeleted"`
}

func (h *Handler) GetDelta(w http.ResponseWriter, r *http.Request) {
  chatID := r.PathValue("chatId")
  since := parseInt64(r.URL.Query().Get("since"), 0)
  limit := parseInt(r.URL.Query().Get("limit"), 200)
  mutatedSince := r.URL.Query().Get("mutatedSince")
  
  if limit > 500 {
    limit = 500
  }
  
  // Fetch messages
  const msgQuery = `
    SELECT id, chat_id, sender_id, content, type, created_at, 
           edited_at, deleted_at, is_deleted
    FROM messages
    WHERE chat_id = $1 AND id > $2
    ORDER BY id ASC
    LIMIT $3
  `
  
  rows, _ := h.db.QueryContext(r.Context(), msgQuery, chatID, since, limit)
  defer rows.Close()
  
  var messages []Message
  for rows.Next() {
    var msg Message
    rows.Scan(&msg.ID, &msg.ChatID, &msg.SenderID, &msg.Content,
      &msg.Type, &msg.CreatedAt, &msg.EditedAt, &msg.DeletedAt, &msg.IsDeleted)
    messages = append(messages, msg)
  }
  
  // Fetch mutations (edits/deletes only)
  var mutations []Message
  if mutatedSince != "" && len(messages) > 0 {
    const mutQuery = `
      SELECT id, chat_id, sender_id, content, type, created_at,
             edited_at, deleted_at, is_deleted
      FROM messages
      WHERE chat_id = $1 AND id >= $2 AND 
            (edited_at > $3 OR deleted_at > $3)
      ORDER BY MAX(COALESCE(edited_at, ''), COALESCE(deleted_at, '')) ASC
      LIMIT 500
    `
    
    mutRows, _ := h.db.QueryContext(r.Context(), mutQuery, chatID, since, mutatedSince)
    defer mutRows.Close()
    
    for mutRows.Next() {
      var msg Message
      mutRows.Scan(&msg.ID, &msg.ChatID, &msg.SenderID, &msg.Content,
        &msg.Type, &msg.CreatedAt, &msg.EditedAt, &msg.DeletedAt, &msg.IsDeleted)
      mutations = append(mutations, msg)
    }
  }
  
  // Calculate next cursor
  nextSince := since
  if len(messages) > 0 {
    nextSince = messages[len(messages)-1].ID
  }
  
  resp := DeltaResponse{
    Messages:   messages,
    NextSince:  nextSince,
    ServerTime: time.Now().UTC().Format(time.RFC3339Nano),
    More:       len(messages) >= limit,
    Mutations:  mutations,
  }
  
  w.Header().Set("Content-Type", "application/json")
  json.NewEncoder(w).Encode(resp)
}
```

---

## Phase 4: Testing Checklist

### Test 4.1: Offline Scenarios

```typescript
export async function testOfflineScenarios() {
  describe('Offline-first behavior', () => {
    
    test('Queue persists across app restarts', async () => {
      await enqueueText('chat1', 'Test message');
      // Simulate app kill
      await closeDB();
      await initDB();
      // Verify message still queued
      const queue = await getOutboundQueue();
      expect(queue.length).toBe(1);
    });
    
    test('1000 messages in queue', async () => {
      for (let i = 0; i < 1000; i++) {
        await enqueueText('chat1', `Msg ${i}`);
      }
      const queue = await getOutboundQueue();
      expect(queue.length).toBe(1000);
      expect(queue[0].state).toBe('QUEUED');
    });
    
    test('7-day offline catch-up', async () => {
      // Simulate 7 days offline
      const offset = 7 * 24 * 60 * 60 * 1000;
      jest.setSystemTime(new Date().getTime() + offset);
      
      // Enqueue messages during offline
      for (let i = 0; i < 350; i++) {
        await enqueueText('chat1', `Day ${Math.floor(i/50)} message`);
      }
      
      // Reconnect
      jest.setSystemTime(Date.now());
      const flushed = await flush();
      
      expect(flushed).toBeGreaterThan(0);
    });
    
    test('Deduplication via clientId', async () => {
      const item = await enqueueText('chat1', 'Test');
      const clientId = item.clientId;
      
      // Simulate server not receiving ack, retry
      await retryQueue();
      
      // Server sees same clientId twice
      // Should deduplicate
      expect(await getServerMessageCount(clientId)).toBe(1);
    });
  });
}
```

### Test 4.2: Sync Verification

```typescript
export async function testSyncScenarios() {
  describe('Delta sync', () => {
    
    test('Cursor persists per chat', async () => {
      const cursor = await getCursor('chat1');
      expect(cursor?.lastMessageId).toBeGreaterThan(0);
    });
    
    test('Catch-up fetches only new messages', async () => {
      const before = await getMessageCount('chat1');
      await simulateNewMessagesOnServer('chat1', 50);
      await catchUp();
      const after = await getMessageCount('chat1');
      expect(after - before).toBe(50);
    });
    
    test('Mutations drain completes', async () => {
      await simulateManyEdits('chat1', 1000);
      await catchUp();
      // Should fetch all edits across multiple pages
    });
  });
}
```

---

## Phase 5: Deployment Checklist

### Pre-Release Verification

- [ ] SQLite database initializes without errors
- [ ] Queue persists across 5 app restarts
- [ ] 1000+ queued messages handled without lag
- [ ] Sync cursor updates correctly
- [ ] Network state detection working
- [ ] Cleanup scheduled and running
- [ ] No crashes on offline → online transition
- [ ] No duplicate messages after reconnect
- [ ] UI indicators (checkmark, X, etc.) display correctly

### Release Plan

**Rollout Strategy:**
1. **Internal testing** (1 week) — Full team, all scenarios
2. **Beta (10%)** — Public beta testers, monitor crash rate
3. **Staged (25% → 50% → 100%)** — Gradual production rollout

**Monitoring:**
```
Metrics to watch:
- queue.depth > 10,000 → investigate
- sync.lag > 5 min → alert
- crash_rate increase > 0.5% → rollback
- storage.sqlite > 1 GB → warn user
```

**Rollback Plan:**
If issues detected, disable SQLite fallback to AsyncStorage:
```typescript
// lib/db.ts
export async function initDB() {
  try {
    db = await SQLite.open(DB_PATH);
    // ...
  } catch (err) {
    console.warn('[db] SQLite failed, falling back to AsyncStorage');
    // Use AsyncStorage adapter instead
  }
}
```

---

## Performance Benchmarks (Target)

| Operation | Target | Critical? |
|-----------|--------|-----------|
| Enqueue message | < 50ms | Yes |
| Flush 100 messages | < 5s | Yes |
| Catch-up (1000 msgs) | < 10s | Yes |
| Cleanup (daily) | < 30s | No |
| Database size (1yr) | < 500 MB | Yes |

---

## Debugging Guide

### Common Issues

**SQLite "database is locked"**
```typescript
// Ensure transactions complete:
await transaction(async () => {
  // operations
}); // Must await
```

**Messages not sending**
```typescript
// Check:
1. Queue items have QUEUED state
2. Network state is ONLINE
3. No "WAITING_KEYS" stuck items
4. Retry backoff not exceeded
```

**Sync lag increasing**
```typescript
// Check:
1. Cursor updates (verify in logs)
2. Server delta endpoint responding
3. Message count explosion (chat archived?)
4. Device low on storage
```

**Duplicate messages**
```typescript
// Check:
1. clientId collision (use Crypto.randomUUID())
2. Server dedup logic (verify X-Client-ID header)
3. Re-apply of mutations (idempotency)
```

---

**Status:** Implementation Guide v1.0  
**Last Updated:** 2026-08-07  
**Next Steps:** Begin Phase 1 (SQLite Integration)
