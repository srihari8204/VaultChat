// db/messageRepo.ts — typed data access for messages (Task 3).
//
// All UI message reads go through here (never a network await to render).
// Writes are idempotent by client-generated id so send-retries and server
// echoes converge to one row.

import { getDb } from './database';
import type { MessageRow, MessageStatus } from './chatTypes';

const PAGE = 50;

function rows(res: { rows: any[] }): MessageRow[] {
  return (res.rows ?? []) as MessageRow[];
}

/** Newest `limit` messages for a chat, returned oldest→newest for the list. */
export function getPage(chatId: string, limit = PAGE, beforeCreatedAt?: number): MessageRow[] {
  const db = getDb();
  const res = beforeCreatedAt == null
    ? db.executeSync(
        `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`,
        [chatId, limit])
    : db.executeSync(
        `SELECT * FROM messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
        [chatId, beforeCreatedAt, limit]);
  return rows(res).reverse();
}

export function getById(id: string): MessageRow | null {
  const res = getDb().executeSync(`SELECT * FROM messages WHERE id = ? LIMIT 1`, [id]);
  return (rows(res)[0] ?? null);
}

/** Insert a locally-composed (optimistic) message. Ignores if id already exists. */
export function insert(m: MessageRow): void {
  getDb().executeSync(
    `INSERT OR IGNORE INTO messages
       (id, chat_id, sender_id, kind, body, media_local_path, media_remote_key, created_at, server_ts, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.chat_id, m.sender_id, m.kind, m.body, m.media_local_path,
     m.media_remote_key, m.created_at, m.server_ts, m.status],
  );
}

/**
 * Merge a server row by id: insert if new, otherwise refresh status/server_ts
 * (never clobber the locally-decrypted body with null). Used by background sync
 * and incoming-socket handling.
 */
export function upsertFromServer(m: Partial<MessageRow> & { id: string; chat_id: string }): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR IGNORE INTO messages
       (id, chat_id, sender_id, kind, body, media_local_path, media_remote_key, created_at, server_ts, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.chat_id, m.sender_id ?? null, m.kind ?? 'text', m.body ?? null,
     m.media_local_path ?? null, m.media_remote_key ?? null,
     m.created_at ?? Date.now(), m.server_ts ?? null, m.status ?? 'sent'],
  );
  db.executeSync(
    `UPDATE messages
        SET status    = COALESCE(?, status),
            server_ts = COALESCE(?, server_ts),
            body      = COALESCE(body, ?)
      WHERE id = ?`,
    [m.status ?? null, m.server_ts ?? null, m.body ?? null, m.id],
  );
}

export function setStatus(id: string, status: MessageStatus, serverTs?: number): void {
  getDb().executeSync(
    `UPDATE messages SET status = ?, server_ts = COALESCE(?, server_ts) WHERE id = ?`,
    [status, serverTs ?? null, id]);
}

export function setMediaLocalPath(id: string, path: string): void {
  getDb().executeSync(`UPDATE messages SET media_local_path = ? WHERE id = ?`, [path, id]);
}

export function remove(id: string): void {
  getDb().executeSync(`DELETE FROM messages WHERE id = ?`, [id]);
}

export default { getPage, getById, insert, upsertFromServer, setStatus, setMediaLocalPath, remove, PAGE };
