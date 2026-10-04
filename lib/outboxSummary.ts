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
  /** Chats holding a failed row, each once, in queue order — to link to them. */
  failedChatIds: string[];
  /** Distinct chats with anything waiting or failed. */
  chats: number;
  /** createdAt of the oldest unsent row, or null when nothing is unsent. */
  oldestAt: number | null;
}

export function summarizeOutbox(rows: readonly OutboxRow[]): OutboxSummary {
  let waiting = 0;
  const failedIds: string[] = [];
  const failedChats = new Set<string>();
  const chats = new Set<string>();
  let oldestAt: number | null = null;
  for (const r of rows) {
    if (typeof r.serverId === 'number' && r.serverId > 0) continue;   // accepted, awaiting delivery
    if (r.state === 'FAILED') { failedIds.push(r.tempId); failedChats.add(r.chatId); }
    else waiting++;
    chats.add(r.chatId);
    if (oldestAt === null || r.createdAt < oldestAt) oldestAt = r.createdAt;
  }
  return { waiting, failed: failedIds.length, failedIds, failedChatIds: [...failedChats], chats: chats.size, oldestAt };
}

/**
 * Rows the read could not open. The queue keeps rows sealed while the vault is
 * locked and queueList skips what it cannot unseal, so `readable` can fall short
 * of the stored count. Only the first `limit` rows were read, so only those are
 * compared.
 */
export function unreadableRows(stored: number, readable: number, limit: number): number {
  return Math.max(0, Math.min(stored, limit) - readable);
}

const msgs = (n: number) => `${n} message${n === 1 ? '' : 's'}`;

/** What a manual retry achieved, from the summaries before and after it. */
export function describeRetry(before: OutboxSummary, after: OutboxSummary): string {
  const unsentBefore = before.waiting + before.failed;
  const unsentAfter = after.waiting + after.failed;
  const sent = Math.max(0, unsentBefore - unsentAfter);
  if (unsentAfter === 0) return sent > 0 ? `${msgs(sent)} sent.` : 'Nothing was waiting to send.';
  const parts: string[] = [];
  if (sent > 0) parts.push(`${sent} sent`);
  if (after.failed > 0) parts.push(`${after.failed} still failing`);
  if (after.waiting > 0) parts.push(`${after.waiting} still waiting`);
  return (sent === 0 ? 'Nothing sent yet: ' : '') + parts.join(', ') + '.';
}
