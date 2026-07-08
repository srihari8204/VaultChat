// db/chatRepo.ts — typed data access for the chat list (Task 3).
// The chat-list screen renders from list() immediately on mount; background
// sync updates rows and the list re-renders.

import { getDb } from './database';
import type { ChatRow } from './chatTypes';

function rows(res: { rows: any[] }): ChatRow[] {
  return (res.rows ?? []) as ChatRow[];
}

/** All chats, pinned first, then most-recent activity. Instant, no network. */
export function list(): ChatRow[] {
  const res = getDb().executeSync(
    `SELECT * FROM chats ORDER BY pinned DESC, last_message_at DESC NULLS LAST`);
  return rows(res);
}

export function getById(id: string): ChatRow | null {
  const res = getDb().executeSync(`SELECT * FROM chats WHERE id = ? LIMIT 1`, [id]);
  return (rows(res)[0] ?? null);
}

/** Upsert a chat's identity/metadata (from server sync). Preserves unread_count. */
export function upsert(c: Partial<ChatRow> & { id: string }): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR IGNORE INTO chats (id, type, title, unread_count, pinned, updated_at)
     VALUES (?, ?, ?, 0, 0, ?)`,
    [c.id, c.type ?? null, c.title ?? null, Date.now()]);
  db.executeSync(
    `UPDATE chats
        SET type     = COALESCE(?, type),
            title    = COALESCE(?, title),
            pinned   = COALESCE(?, pinned),
            data     = COALESCE(?, data),
            updated_at = ?
      WHERE id = ?`,
    [c.type ?? null, c.title ?? null, c.pinned ?? null, c.data ?? null, Date.now(), c.id]);
}

/**
 * The full server summaries for the chat list, ordered pinned-first then by
 * activity — parsed from the `data` JSON column. Rows without stored JSON are
 * skipped (they'll appear after the next background sync fills `data`).
 */
export function listSummaries<T = any>(): T[] {
  const out: T[] = [];
  for (const r of list()) {
    if (!r.data) continue;
    try { out.push(JSON.parse(r.data) as T); } catch {}
  }
  return out;
}

/** Update the last-message preview row after send/receive. */
export function touchLastMessage(
  chatId: string, messageId: string, preview: string, atMs: number, bumpUnread = false,
): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR IGNORE INTO chats (id, unread_count, pinned, updated_at) VALUES (?, 0, 0, ?)`,
    [chatId, Date.now()]);
  db.executeSync(
    `UPDATE chats
        SET last_message_id = ?, last_message_preview = ?, last_message_at = ?,
            unread_count = unread_count + ?, updated_at = ?
      WHERE id = ?`,
    [messageId, preview, atMs, bumpUnread ? 1 : 0, Date.now(), chatId]);
}

/**
 * Apply server-summary metadata (last-activity time, unread, id) without
 * touching the locally-derived preview text. Used by background list sync.
 */
export function setServerMeta(
  chatId: string, meta: { lastMessageId?: string | null; lastMessageAt?: number | null; unreadCount?: number },
): void {
  const db = getDb();
  db.executeSync(`INSERT OR IGNORE INTO chats (id, unread_count, pinned, updated_at) VALUES (?, 0, 0, ?)`, [chatId, Date.now()]);
  db.executeSync(
    `UPDATE chats
        SET last_message_id = COALESCE(?, last_message_id),
            last_message_at = COALESCE(?, last_message_at),
            unread_count    = COALESCE(?, unread_count),
            updated_at      = ?
      WHERE id = ?`,
    [meta.lastMessageId ?? null, meta.lastMessageAt ?? null,
     meta.unreadCount ?? null, Date.now(), chatId]);
}

export function clearUnread(chatId: string): void {
  getDb().executeSync(`UPDATE chats SET unread_count = 0 WHERE id = ?`, [chatId]);
}

export function setPinned(chatId: string, pinned: boolean): void {
  getDb().executeSync(`UPDATE chats SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, chatId]);
}

export function remove(chatId: string): void {
  getDb().executeSync(`DELETE FROM chats WHERE id = ?`, [chatId]);
}

export default { list, listSummaries, getById, upsert, touchLastMessage, setServerMeta, clearUnread, setPinned, remove };
