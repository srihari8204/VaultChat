// lib/historySync.ts — WhatsApp-style background history pre-fetch.
//
// The chat screen caches pages as you scroll, but if you go OFFLINE and scroll
// past what's cached you hit a wall. This pre-downloads a reasonable depth of
// each recent chat's history (decrypted once → plaintext in the local cache),
// so scroll-back works offline and is instant. Runs gently, once per session.

import NetInfo from '@react-native-community/netinfo';
import { getMessages, hydrateMessages } from './chatService';
import { getCachedMessages, cacheMessages } from './localDb';

const PAGE = 50;
let ranThisSession = false;

/**
 * Page backward from the oldest cached message of `chatId`, caching plaintext,
 * until the chat's start is reached or `maxMessages` are cached.
 */
export async function syncChatHistory(chatId: string, maxMessages = 200): Promise<void> {
  try {
    const cached = await getCachedMessages(chatId, maxMessages);
    // Already-received messages are never re-fetched. Once this device holds
    // any history for a chat, that history is authoritative — it was decrypted
    // and cached on arrival, and anything newer comes from the socket or the
    // /chats/delta cursor. Paging BACKWARD through the server re-downloaded
    // messages the device already had, against a backend that purges bodies
    // after delivery, so the work was both wasteful and increasingly futile.
    //
    // The back-fill still runs for a chat this device knows nothing about
    // (fresh install), which is the only case the cache cannot answer.
    if (cached.length) return;
    let oldest = cached.length ? cached[cached.length - 1].id : undefined;
    let total = cached.length;
    let guard = 0;
    while (total < maxMessages && guard < 12) {
      guard++;
      const raw = await getMessages(chatId, oldest ? { before: oldest, limit: PAGE } : { limit: PAGE });
      if (!raw.length) break;
      const hydrated = await hydrateMessages(chatId, raw);
      await cacheMessages(chatId, hydrated);
      oldest = raw[raw.length - 1].id;
      total += raw.length;
      if (raw.length < PAGE) break;   // reached the beginning of the chat
    }
  } catch { /* offline / transient — try again next session */ }
}

/**
 * Background-sync history for the given chats (pass most-recent first). Runs at
 * most once per session, only on Wi-Fi, sequentially with small gaps so it never
 * competes with foreground traffic.
 */
export async function syncAllHistory(chatIds: string[], opts: { maxPerChat?: number; maxChats?: number } = {}): Promise<void> {
  if (ranThisSession) return;
  ranThisSession = true;
  try {
    const net = await NetInfo.fetch();
    if (net.type !== 'wifi') return;   // don't burn cellular data pre-fetching
  } catch { return; }
  const ids = chatIds.slice(0, opts.maxChats ?? 12);
  for (const id of ids) {
    await syncChatHistory(id, opts.maxPerChat ?? 200);
    await new Promise(r => setTimeout(r, 200));
  }
}
