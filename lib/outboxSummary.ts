// lib/outboxSummary.ts — what the Offline Mode screen says about the outbox.
//
// Reads the same rows lib/messageQueue keeps in the localDb 'msg' queue and
// sorts them into what a person can act on. Pure, so the counting is tested
// without SQLite (outboxSummary.selftest.ts).
//
// Rows the server has ALREADY accepted (serverId set) are kept by the queue
// only as a recovery copy until delivery is confirmed — they are sent messages,
// so they are not counted as waiting (same rule as messageQueue.pendingForChat).

export interface OutboxRow {
  tempId: string;
  chatId: string;
  op?: 'send' | 'edit' | 'delete';
  state?: string;
  serverId?: number;
  createdAt: number;
  lastError?: string | null;
}

export interface OutboxSummary {
  /** Still to be sent; the queue retries these on its own (reconnect, foreground, every 30 s). */
  waiting: number;
  /** Rejected by the server (blocked, removed from the chat, too large…); only a manual retry re-sends them. */
  failed: number;
  /** tempIds of the failed rows, for a retry. */
  failedIds: string[];
  /** Distinct chats with anything waiting or failed. */
  chats: number;
  /** createdAt of the oldest unsent row, or null when nothing is unsent. */
  oldestAt: number | null;
}

export function summarizeOutbox(rows: readonly OutboxRow[]): OutboxSummary {
  let waiting = 0;
  const failedIds: string[] = [];
  const chats = new Set<string>();
  let oldestAt: number | null = null;
  for (const r of rows) {
    if (typeof r.serverId === 'number' && r.serverId > 0) continue;   // accepted, awaiting delivery
    if (r.state === 'FAILED') failedIds.push(r.tempId);
    else waiting++;
    chats.add(r.chatId);
    if (oldestAt === null || r.createdAt < oldestAt) oldestAt = r.createdAt;
  }
  return { waiting, failed: failedIds.length, failedIds, chats: chats.size, oldestAt };
}
