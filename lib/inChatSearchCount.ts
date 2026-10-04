// lib/inChatSearchCount.ts — match count for the chat screen's inline search bar.
//
// Counts over the rows the thread actually RENDERS (app/chat.tsx renderMessages),
// not the raw message state: reactions, trip markers and live-location plumbing
// are filtered out of the list, so counting them reported matches the user could
// never find. The query is trimmed the same way the bubble highlight trims it.

export interface SearchableRow {
  content?: string | null;
  deletedAt?: string | null;
}

export function countVisibleMatches(rows: readonly SearchableRow[], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let n = 0;
  for (const r of rows) {
    if (!r.deletedAt && typeof r.content === 'string' && r.content.toLowerCase().includes(q)) n++;
  }
  return n;
}
