// lib/chatReceipts.ts — per-member delivered/read times for Message Info.
//
// GET /chats/:id/messages/:msgId/receipts (sender only). WRITTEN ON THE
// SERVER, NOT DEPLOYED (scratchpad fixes/R4BE.md, contract C3). Until it is,
// the route answers 404 and getMessageReceipts returns null: Message Info keeps
// its pointer-based sections (who has delivered/read, from GET /chats/:id),
// with no times. A 404 is also how the server says "not your message" or "not a
// member" — the fallback is right for those too, since the pointers are what
// the screen already shows.
//
// The pure half (receiptSections, receiptTime) is import-free so
// lib/chatReceipts.selftest.ts runs under plain tsx; `api` is imported lazily
// for the same reason.

export interface MemberReceipt {
  userId: string;
  delivered: boolean;
  read: boolean;
  /** Null when delivered before the server started logging times (or kept 30 days). */
  deliveredAt: string | null;
  readAt: string | null;
}

export interface MessageReceipts {
  messageId: string;
  /** Direct chat where either side has read receipts off: every `read` is false. */
  readReceiptsHidden: boolean;
  members: MemberReceipt[];
}

/** Null = endpoint not deployed (404/405) or not answerable: use the pointers. */
export async function getMessageReceipts(chatId: string, msgId: number): Promise<MessageReceipts | null> {
  const { api } = await import('./api');
  try {
    const r = await api<MessageReceipts>(
      `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(String(msgId))}/receipts`,
    );
    return r && Array.isArray(r.members) ? r : null;
  } catch (e: any) {
    if (e?.status === 404 || e?.status === 405) return null;
    throw e;
  }
}

export interface ReceiptSections {
  read: MemberReceipt[];
  /** Delivered and not (known to be) read. */
  delivered: MemberReceipt[];
  /** Not delivered yet. */
  sent: MemberReceipt[];
  readReceiptsHidden: boolean;
}

/** Split the server's answer the way Message Info shows it. Read implies delivered. */
export function receiptSections(r: MessageReceipts): ReceiptSections {
  const hidden = !!r.readReceiptsHidden;
  const isRead = (m: MemberReceipt) => !hidden && m.read;
  const isDelivered = (m: MemberReceipt) => m.delivered || m.read;
  return {
    read: r.members.filter(isRead),
    delivered: r.members.filter(m => !isRead(m) && isDelivered(m)),
    sent: r.members.filter(m => !isDelivered(m)),
    readReceiptsHidden: hidden,
  };
}

/** "14:05" today, "Yesterday 14:05", else "3 Oct 14:05". '' for null/invalid. */
export function receiptTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (day(d) === day(y)) return `Yesterday ${hm}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hm}`;
}
