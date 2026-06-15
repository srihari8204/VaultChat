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

import * as SQLite from 'expo-sqlite';
import type { Message } from './chatService';

let _dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getLocalDb(): Promise<SQLite.SQLiteDatabase> {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('vaultchat.db');
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
    content: r.content,
    replyToId: r.reply_to_id,
    meta: r.meta ? safeParse(r.meta) : null,
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
      await db.runAsync(
        `INSERT OR REPLACE INTO messages
           (id, chat_id, sender_id, type, content, reply_to_id, meta, created_at, edited_at, deleted_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          m.id, chatId, (m as any).senderId ?? null, m.type ?? null, m.content ?? null,
          m.replyToId ?? null, m.meta != null ? JSON.stringify(m.meta) : null,
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

/** Highest message id we've already synced for this chat (the delta cursor). */
export async function getSyncCursor(chatId: string): Promise<number> {
  const db = await getLocalDb();
  const r: any = await db.getFirstAsync(`SELECT last_id FROM sync_cursor WHERE chat_id = ?`, [chatId]);
  return r ? (r.last_id as number) : 0;
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
        [c.id, JSON.stringify(c), (c as any).lastMessageAt ?? null],
      );
    }
  });
}

export async function getCachedChats(): Promise<any[]> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync(
    `SELECT data FROM chats ORDER BY (last_message_at IS NULL), last_message_at DESC`,
  );
  return rows.map((r: any) => safeParse(r.data)).filter(Boolean);
}

/** Wipe everything (e.g. on logout / account switch). */
export async function clearLocalDb(): Promise<void> {
  const db = await getLocalDb();
  await db.execAsync(`DELETE FROM messages; DELETE FROM chats; DELETE FROM sync_cursor;`);
}
