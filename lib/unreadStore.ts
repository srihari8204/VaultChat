
/**
 * Drop the badge on sign-out.
 *
 * _total is module-scope and only ever written from loadList's SUCCESS path, so
 * after a sign-out it keeps the previous account's number until a new list
 * finishes loading. On a shared handset that means user B opens the app and sees
 * user A's unread count on the tab - a small number, but it is A's data on B's
 * screen, and it is the same class as every other leak purgeAccountData closes.
 *
 * Deliberately notifies subscribers rather than just zeroing the variable: a
 * mounted tab bar holds its own useState copy and would otherwise keep painting
 * the stale figure (2026-09-18).
 */
export function resetUnreadTotal(): void {
  setUnreadTotal(0);
}
// lib/unreadStore.ts — the unread module: a tiny observable for the TOTAL
// unread chat count (so the Chats tab can badge it), plus the one rule that
// decides whether a row is unread at all. The chats screen publishes the sum
// whenever it (re)loads or a realtime event lands; the tab subscribes.
//
// Kept free of react-native/AsyncStorage imports on purpose — it is the only
// piece of unread logic that can be executed under Node, which is what
// lib/chatUnreadCursor.selftest.ts leans on.

import { useEffect, useState } from 'react';

let _total = 0;
const subs = new Set<(n: number) => void>();

export function setUnreadTotal(n: number): void {
  const v = Math.max(0, n | 0);
  if (v === _total) return;
  _total = v;
  subs.forEach(f => f(v));
}

/**
 * Clear the badge on any chat this DEVICE has already read (2026-09-18).
 *
 * unreadCount is a denormalized server column (chat_members.unread_count); the
 * only thing that recomputes it is POST /chats/:id/read. Reading a chat does
 * not do that synchronously: app/chat.tsx debounces 800ms, lib/receipts.ts
 * batches another 300ms, then a round trip. Pressing Back re-focuses the Chats
 * tab, which refetches IMMEDIATELY — so the list routinely asks the server
 * before the server has been told, gets the old count back, and has no later
 * trigger (focus already fired, no socket event, no AppState change) to correct
 * itself. Reported as "I opened and read the message and it still shows unread".
 *
 * A failed receipt makes it permanent rather than temporary: the Go handler
 * 400s a cursor above the chat's MAX(id) and flushSession then rewinds the
 * pointer, and the older Node handler's `AND last_read_message_id < $1` guard
 * answers 200 having updated nothing.
 *
 * The device already knows the answer — lib/receipts.ts persists MY read
 * watermark per chat before any of that. So trust it over the server's stale
 * count, and only ever DOWNWARDS: a chat whose newest message is past my
 * watermark is untouched, which is what keeps a genuinely unread chat unread
 * and lets an incoming message raise the badge again.
 */
export function applyLocalReadPointers<
  T extends { id: string; unreadCount: number; lastMessageId?: number | null },
>(rows: T[], read: Record<string, number>): T[] {
  for (const r of rows) {
    const mine = read[r.id] ?? 0;
    // `mine > 0` because "no pointer" and "read nothing" are the same value and
    // must not clear a badge. lastMessageId null = no messages: nothing to read.
    if (r.unreadCount > 0 && mine > 0 && mine >= (r.lastMessageId ?? Infinity)) r.unreadCount = 0;
  }
  return rows;
}

export function useUnreadTotal(): number {
  const [n, setN] = useState(_total);
  useEffect(() => {
    subs.add(setN);
    setN(_total);
    return () => { subs.delete(setN); };
  }, []);
  return n;
}
