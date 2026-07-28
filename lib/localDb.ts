// lib/localDb.ts — local-first message cache (SQLite, the WhatsApp/Signal model).
//
// The device's SQLite DB is the source of truth the UI renders from. Opening a
// chat reads from here instantly (no network), then a background delta-sync
// pulls only messages newer than our cursor. Incoming socket messages are
// written here too, so the list is always served locally.
//
// Requires:  npx expo install expo-sqlite
//
// Wiring (next step): chat.tsx renders getCachedMessages() first, then calls
// syncChat() to fetch GET /chats/:id/messages?after=<cursor> and cacheMessages().

import { open, type DB } from '@op-engineering/op-sqlite';
import type { Message } from './chatService';
import { encField, decField, clearCacheKeyStore } from './cacheCrypto';

// Engine: op-sqlite (JSI) — faster than expo-sqlite, same SQL. A thin shim keeps
// the expo-sqlite-style async API (getAllAsync/runAsync/withTransactionAsync/…)
// so every call site + all logic below stays byte-identical.
export interface LocalDb {
  getAllAsync:          (sql: string, params?: any[]) => Promise<any[]>;
  getFirstAsync:        (sql: string, params?: any[]) => Promise<any>;
  runAsync:             (sql: string, params?: any[]) => Promise<void>;
  execAsync:            (sql: string) => Promise<void>;
  withTransactionAsync: (fn: () => Promise<void>) => Promise<void>;
}

function wrap(db: DB): LocalDb {
  // Serialize TRANSACTIONS on the single op-sqlite connection. Two concurrent
  // withTransactionAsync() would both issue BEGIN → "cannot start a transaction
  // within a transaction" and lose one write. Chaining every transaction on one
  // promise makes them run one-at-a-time. Only transactions are locked (not the
  // inner runAsync calls) — locking those too would deadlock, since a transaction
  // body awaits its own runAsync while holding the lock.
  let txLock: Promise<any> = Promise.resolve();
  return {
    getAllAsync:   async (sql, params = []) => ((await db.execute(sql, params as any)).rows ?? []) as any[],
    getFirstAsync: async (sql, params = []) => (((await db.execute(sql, params as any)).rows ?? []) as any[])[0] ?? null,
    runAsync:      async (sql, params = []) => { await db.execute(sql, params as any); },
    // op-sqlite executes ONE statement per call — split the multi-statement schema.
    execAsync:     async (sql) => { for (const s of sql.split(';')) { const t = s.trim(); if (t) db.executeSync(t); } },
    // Manual BEGIN/COMMIT so the inner runAsync (db.execute) calls stay in-txn on
    // this single connection; ROLLBACK on any throw. Serialized via txLock.
    withTransactionAsync: (fn) => {
      const run = txLock.then(async () => {
        await db.execute('BEGIN');
        try { await fn(); await db.execute('COMMIT'); }
        catch (e) { try { await db.execute('ROLLBACK'); } catch {} throw e; }
      });
      txLock = run.catch(() => {});   // a failed txn must not wedge the queue
      return run;
    },
  };
}

let _dbPromise: Promise<LocalDb> | null = null;

export function getLocalDb(): Promise<LocalDb> {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const db = wrap(open({ name: 'vaultchat.db' }));
      // One-time reconciliation: an earlier build's op-sqlite repo layer may have
      // created `messages`/`chats` in this same file with a DIFFERENT schema.
      // If the messages table isn't ours (no `content` column), drop the pair so
      // this schema is authoritative — it's a rebuildable cache, so it's safe.
      try {
        const cols = (await db.getAllAsync(`PRAGMA table_info(messages)`)).map((c: any) => c.name);
        if (cols.length && !cols.includes('content')) {
          await db.execAsync(`DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS chats;`);
        }
      } catch {}
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS messages (
          id           INTEGER PRIMARY KEY,
          chat_id      TEXT NOT NULL,
          sender_id    TEXT,
          type         TEXT,
          content      TEXT,
          reply_to_id  INTEGER,
          meta         TEXT,
          created_at   TEXT,
          edited_at    TEXT,
          deleted_at   TEXT,
          expires_at   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id DESC);
        CREATE TABLE IF NOT EXISTS chats (
          id               TEXT PRIMARY KEY,
          data             TEXT,
          last_message_at  TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_cursor (
          chat_id  TEXT PRIMARY KEY,
          last_id  INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS vb_transfers (
          transfer_id  TEXT PRIMARY KEY,
          role         TEXT,
          status       TEXT,
          done         INTEGER,
          total        INTEGER,
          bytes        INTEGER,
          total_bytes  INTEGER,
          name         TEXT,
          error        TEXT,
          saved_path   TEXT,
          updated_at   INTEGER
        );
      `);
      return db;
    })();
  }
  return _dbPromise;
}

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    senderId: r.sender_id,
    type: r.type,
    content: decField(r.content),
    replyToId: r.reply_to_id,
    meta: r.meta ? safeParse(decField(r.meta)!) : null,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    expiresAt: r.expires_at,
  } as Message;
}
function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

/** Upsert a batch of messages and advance the per-chat sync cursor. */
export async function cacheMessages(chatId: string, msgs: Message[]): Promise<void> {
  if (!msgs || !msgs.length) return;
  const db = await getLocalDb();
  await db.withTransactionAsync(async () => {
    for (const m of msgs) {
      if (typeof m.id !== 'number' || m.id <= 0) continue; // skip optimistic temp rows
      // Upsert. CRITICAL for delete-on-delivery: if the server has purged the
      // body (content null) but we already hold the plaintext locally, KEEP the
      // local copy — never let a re-sync/back-page wipe cached content. Same for
      // meta. A real edit (non-null content) still overwrites.
      await db.runAsync(
        `INSERT INTO messages
           (id, chat_id, sender_id, type, content, reply_to_id, meta, created_at, edited_at, deleted_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           chat_id     = excluded.chat_id,
           sender_id   = excluded.sender_id,
           type        = excluded.type,
           content     = COALESCE(excluded.content, messages.content),
           reply_to_id = excluded.reply_to_id,
           meta        = COALESCE(excluded.meta, messages.meta),
           created_at  = excluded.created_at,
           edited_at   = excluded.edited_at,
           deleted_at  = excluded.deleted_at,
           expires_at  = excluded.expires_at`,
        [
          m.id, chatId, (m as any).senderId ?? null, m.type ?? null, encField(m.content ?? null),
          m.replyToId ?? null, encField(m.meta != null ? JSON.stringify(m.meta) : null),
          m.createdAt ?? null, m.editedAt ?? null, m.deletedAt ?? null, (m as any).expiresAt ?? null,
        ],
      );
    }
  });
  const maxId = msgs.reduce((a, m) => (typeof m.id === 'number' && m.id > a ? m.id : a), 0);
  if (maxId > 0) {
    await db.runAsync(
      `INSERT INTO sync_cursor (chat_id, last_id) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`,
      [chatId, maxId],
    );
  }
}

/** Newest `limit` messages for a chat, newest-first (matches the inverted list). */
export async function getCachedMessages(chatId: string, limit = 50): Promise<Message[]> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`,
    [chatId, limit],
  );
  return rows.map(rowToMessage);
}

/**
 * The newest cached message for each chat — used by the chat list to render a
 * real last-message preview (WhatsApp-style) from local plaintext, since the
 * server only holds ciphertext. One query, decrypted at-rest on the way out.
 */
export async function getLastMessagePerChat(): Promise<Map<string, { content: string | null; type: string | null; senderId: string | null; id: number }>> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(
    `SELECT m.chat_id, m.id, m.content, m.type, m.sender_id
       FROM messages m
       JOIN (SELECT chat_id, MAX(id) AS mx FROM messages
              WHERE deleted_at IS NULL AND type <> 'reaction'   -- F4: reference messages never preview
              GROUP BY chat_id) t
         ON t.chat_id = m.chat_id AND t.mx = m.id`,
    [],
  );
  const out = new Map<string, { content: string | null; type: string | null; senderId: string | null; id: number }>();
  for (const r of rows as any[]) {
    out.set(r.chat_id, { content: decField(r.content), type: r.type ?? null, senderId: r.sender_id ?? null, id: r.id });
  }
  return out;
}

/**
 * Global message search across ALL chats, on-device (WhatsApp-style, zero-
 * knowledge). Decrypts the at-rest cache in JS and substring-matches plaintext.
 */
export async function searchAllMessages(
  query: string, limit = 40,
): Promise<{ chatId: string; id: number; content: string; senderId: string | null; createdAt: string }[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const db = await getLocalDb();
  const rows = await db.getAllAsync(
    `SELECT chat_id, id, content, sender_id, created_at FROM messages
      WHERE content IS NOT NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 5000`,
    [],
  );
  const out: { chatId: string; id: number; content: string; senderId: string | null; createdAt: string }[] = [];
  for (const r of rows as any[]) {
    const text = decField(r.content);
    // Skip un-decrypted envelopes ({..."v":"dr1"...} / GSK1:) and match plaintext.
    if (!text || text[0] === '{' || text.startsWith('GSK1:')) continue;
    if (text.toLowerCase().includes(q)) {
      out.push({ chatId: r.chat_id, id: r.id, content: text, senderId: r.sender_id, createdAt: r.created_at });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Map every cached attachment id → the chat it belongs to. Used by the storage
 * manager to attribute on-disk media files (named by attachment id) to chats.
 */
export async function getAttachmentChatMap(): Promise<Record<string, string>> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(`SELECT chat_id, meta FROM messages WHERE meta IS NOT NULL`, []);
  const out: Record<string, string> = {};
  for (const r of rows as any[]) {
    try {
      const meta = JSON.parse(decField(r.meta) || '');
      const aid = meta?.attachmentId;
      if (aid) out[String(aid)] = r.chat_id;
    } catch {}
  }
  return out;
}

/** Fetch specific cached messages by id (used to resolve reply quotes for
 *  messages that aren't in the currently-rendered page). */
export async function getCachedMessagesByIds(chatId: string, ids: number[]): Promise<Message[]> {
  const want = ids.filter(n => typeof n === 'number' && n > 0);
  if (!want.length) return [];
  const db = await getLocalDb();
  const ph = want.map(() => '?').join(',');
  const rows = await db.getAllAsync(
    `SELECT * FROM messages WHERE chat_id = ? AND id IN (${ph})`,
    [chatId, ...want],
  );
  return rows.map(rowToMessage);
}

/** Highest message id we've already synced for this chat (the delta cursor). */
export async function getSyncCursor(chatId: string): Promise<number> {
  const db = await getLocalDb();
  const r: any = await db.getFirstAsync(`SELECT last_id FROM sync_cursor WHERE chat_id = ?`, [chatId]);
  return r ? (r.last_id as number) : 0;
}

/** Highest message id cached across ALL chats — the global forward-catch-up
 *  cursor (messages.id is a server-global BIGSERIAL). */
export async function getGlobalSyncCursor(): Promise<number> {
  const db = await getLocalDb();
  const r: any = await db.getFirstAsync(`SELECT MAX(id) AS m FROM messages`);
  return r?.m ? Number(r.m) : 0;
}

/** Apply a single incoming/edited message (from socket) to the cache. */
export async function applyMessage(chatId: string, m: Message): Promise<void> {
  await cacheMessages(chatId, [m]);
}

/** Soft-delete a message locally (tombstone via deleted_at). */
export async function markCachedDeleted(chatId: string, id: number): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(`UPDATE messages SET deleted_at = ? WHERE chat_id = ? AND id = ?`,
    [new Date().toISOString(), chatId, id]);
}

/** Cache the chat-list summaries so the chat list renders instantly too. */
export async function cacheChats(chats: Array<{ id: string; lastMessageAt?: string | null }>): Promise<void> {
  if (!chats?.length) return;
  const db = await getLocalDb();
  await db.withTransactionAsync(async () => {
    for (const c of chats) {
      await db.runAsync(
        `INSERT OR REPLACE INTO chats (id, data, last_message_at) VALUES (?, ?, ?)`,
        [c.id, encField(JSON.stringify(c)), (c as any).lastMessageAt ?? null],
      );
    }
  });
}

export async function getCachedChats(): Promise<any[]> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(
    `SELECT data FROM chats ORDER BY (last_message_at IS NULL), last_message_at DESC`,
  );
  return rows.map((r: any) => safeParse(decField(r.data) || '')).filter(Boolean);
}

// Persist ONE chat's full detail (members, timers, pinned…) so the chat header
// renders offline. Reuses the chats table (ChatDetail is a superset of the
// summary listChats caches), keyed by id → last writer wins.
export async function cacheChatDetail(chatId: string, detail: any): Promise<void> {
  if (!chatId || !detail) return;
  const db = await getLocalDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO chats (id, data, last_message_at) VALUES (?, ?, ?)`,
    [chatId, encField(JSON.stringify(detail)), (detail as any).lastMessageAt ?? null],
  );
}

/** Cached chat (detail if we have it, else the list summary) for offline header render. */
export async function getCachedChat(chatId: string): Promise<any | null> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(`SELECT data FROM chats WHERE id = ? LIMIT 1`, [chatId]);
  const row: any = rows[0];
  return row ? safeParse(decField(row.data) || '') : null;
}

// ── VaultBeam transfer runtime state (P0-2) ─────────────────────────
// Durable mirror of the in-memory transfer store so a bubble's progress/status
// survives a remount, navigation, or app restart. Not sealed — it's non-content
// runtime state (block counts, status), never the file bytes/key/name-of-content.
export async function persistVbTransfer(t: {
  transferId: string; role?: string; status?: string; done?: number; total?: number;
  bytes?: number; totalBytes?: number; name?: string; error?: string; savedPath?: string;
}): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(
    `INSERT INTO vb_transfers (transfer_id, role, status, done, total, bytes, total_bytes, name, error, saved_path, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(transfer_id) DO UPDATE SET
       role=excluded.role, status=excluded.status, done=excluded.done, total=excluded.total,
       bytes=excluded.bytes, total_bytes=excluded.total_bytes, name=excluded.name,
       error=excluded.error, saved_path=excluded.saved_path, updated_at=excluded.updated_at`,
    [t.transferId, t.role ?? null, t.status ?? null, t.done | 0, t.total | 0, t.bytes | 0,
     t.totalBytes | 0, t.name ?? null, t.error ?? null, t.savedPath ?? null, Date.now()]);
}
export async function loadVbTransfers(limit = 200): Promise<any[]> {
  const db = await getLocalDb();
  return db.getAllAsync(`SELECT * FROM vb_transfers ORDER BY updated_at DESC LIMIT ?`, [limit]);
}
export async function deleteVbTransfer(transferId: string): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(`DELETE FROM vb_transfers WHERE transfer_id = ?`, [transferId]);
}
/** Keep the table bounded — drop all but the most recent `keep` transfers. */
export async function pruneVbTransfers(keep = 200): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync(
    `DELETE FROM vb_transfers WHERE transfer_id NOT IN
       (SELECT transfer_id FROM vb_transfers ORDER BY updated_at DESC LIMIT ?)`, [keep]);
}

/** Dump all local rows for an encrypted backup. Sealed fields are decrypted here
 *  so the backup is portable across installs (it gets re-sealed under the backup
 *  layer's own key by backupService, and re-encrypted under the local DEK on
 *  importAll). Requires the cache to be unlocked, or sealed rows export as-is. */
export async function exportAll(): Promise<{ messages: any[]; chats: any[] }> {
  const db = await getLocalDb();
  const messages = (await db.getAllAsync(`SELECT * FROM messages`)).map((m: any) => ({
    ...m, content: decField(m.content), meta: decField(m.meta),
  }));
  const chats = (await db.getAllAsync(`SELECT * FROM chats`)).map((c: any) => ({
    ...c, data: decField(c.data),
  }));
  return { messages, chats };
}

/** Re-insert rows from a decrypted backup (idempotent upserts). Returns count. */
export async function importAll(data: { messages?: any[]; chats?: any[] }): Promise<number> {
  const db = await getLocalDb();
  let n = 0;
  await db.withTransactionAsync(async () => {
    for (const m of data.messages || []) {
      await db.runAsync(
        `INSERT OR REPLACE INTO messages (id, chat_id, sender_id, type, content, reply_to_id, meta, created_at, edited_at, deleted_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [m.id, m.chat_id, m.sender_id, m.type, encField(m.content), m.reply_to_id, encField(m.meta), m.created_at, m.edited_at, m.deleted_at, m.expires_at],
      );
      n++;
    }
    for (const c of data.chats || []) {
      await db.runAsync(`INSERT OR REPLACE INTO chats (id, data, last_message_at) VALUES (?,?,?)`, [c.id, encField(c.data), c.last_message_at]);
    }
  });
  return n;
}

/** Wipe everything (e.g. on logout / account switch). */
export async function clearLocalDb(): Promise<void> {
  const db = await getLocalDb();
  await db.execAsync(`DELETE FROM messages; DELETE FROM chats; DELETE FROM sync_cursor;`);
  // #32 Phase B: wipe the sealed DEK envelope too, so no orphaned key survives an
  // account switch (rows are gone, so the key has nothing left to protect).
  try { await clearCacheKeyStore(); } catch {}
}
