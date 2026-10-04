// lib/groups/mediaPageCache.ts — group-info's shared-media strip reads one
// server page (200 messages) to find media this phone has not synced. Doing
// that on EVERY visit to Group info cost a 200-message request each time; the
// strip only needs it now and then. The media rows of the last page are kept
// in memory per chat for MEDIA_PAGE_TTL_MS and merged with local history on a
// revisit, so deletions the server reported still win over local copies.
//
// ponytail: memory only, per process, at most MAX_CHATS chats. A revisit within
// the TTL can miss media another device sent since; replace with a server
// "recent media" query if that matters.

export const MEDIA_PAGE_TTL_MS = 5 * 60_000;
const MAX_CHATS = 20;

type Row = { type?: string | null };
const pages = new Map<string, { at: number; rows: Row[] }>();

/**
 * The image/video rows of `chatId`'s latest server page: from memory when read
 * within the TTL, otherwise via `fetchPage`. A failed fetch returns null and is
 * not cached, so the next visit tries again.
 */
export async function recentServerMedia<M extends Row>(
  chatId: string,
  fetchPage: () => Promise<M[]>,
  now: number = Date.now(),
): Promise<M[] | null> {
  const hit = pages.get(chatId);
  if (hit && now - hit.at < MEDIA_PAGE_TTL_MS) return hit.rows as M[];
  const page = await fetchPage().catch(() => null);
  if (!page) return null;
  const rows = page.filter(m => m.type === 'image' || m.type === 'video');
  pages.delete(chatId);
  pages.set(chatId, { at: now, rows });
  if (pages.size > MAX_CHATS) pages.delete(pages.keys().next().value as string);
  return rows;
}
