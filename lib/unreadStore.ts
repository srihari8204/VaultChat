// lib/unreadStore.ts — tiny observable for the TOTAL unread chat count, so the
// Chats tab can show a badge. The chats screen publishes the sum whenever it
// (re)loads or a realtime event lands; the tab subscribes.

import { useEffect, useState } from 'react';

let _total = 0;
const subs = new Set<(n: number) => void>();

export function setUnreadTotal(n: number): void {
  const v = Math.max(0, n | 0);
  if (v === _total) return;
  _total = v;
  subs.forEach(f => f(v));
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
