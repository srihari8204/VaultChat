// db/outboxRepo.ts — the send outbox (Task 4 drainer reads this).
//
// One row per not-yet-acked message. Because message ids are client-generated
// and stable, re-emitting an outbox row is idempotent from the client side.
// Exponential backoff: 2s, 4s, 8s, 16s, … capped at 60s; give up after 8 tries.

import { getDb } from './database';
import type { OutboxRow } from './chatTypes';

const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

function rows(res: { rows: any[] }): OutboxRow[] {
  return (res.rows ?? []) as OutboxRow[];
}

/** Queue a message id for sending. */
export function enqueue(messageId: string): void {
  getDb().executeSync(
    `INSERT OR REPLACE INTO outbox (message_id, attempts, next_retry_at, created_at)
     VALUES (?, 0, ?, ?)`,
    [messageId, Date.now(), Date.now()]);
}

/** Rows whose next_retry_at is due, oldest first. */
export function due(now = Date.now()): OutboxRow[] {
  const res = getDb().executeSync(
    `SELECT * FROM outbox WHERE next_retry_at <= ? ORDER BY created_at ASC`, [now]);
  return rows(res);
}

export function hasPending(): boolean {
  const res = getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`);
  return Number((res.rows?.[0] as any)?.n ?? 0) > 0;
}

/** Bump attempts + schedule the next retry with capped exponential backoff. */
export function markAttempt(messageId: string): number {
  const db = getDb();
  const res = db.executeSync(`SELECT attempts FROM outbox WHERE message_id = ?`, [messageId]);
  const attempts = Number((res.rows?.[0] as any)?.attempts ?? 0) + 1;
  const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  db.executeSync(
    `UPDATE outbox SET attempts = ?, next_retry_at = ? WHERE message_id = ?`,
    [attempts, Date.now() + delay, messageId]);
  return attempts;
}

/** Remove on successful send. */
export function remove(messageId: string): void {
  getDb().executeSync(`DELETE FROM outbox WHERE message_id = ?`, [messageId]);
}

/** Reset attempts + re-queue immediately (manual "tap to retry"). */
export function requeue(messageId: string): void {
  getDb().executeSync(
    `UPDATE outbox SET attempts = 0, next_retry_at = ? WHERE message_id = ?`,
    [Date.now(), messageId]);
}

export { MAX_ATTEMPTS };
export default { enqueue, due, hasPending, markAttempt, remove, requeue, MAX_ATTEMPTS };
