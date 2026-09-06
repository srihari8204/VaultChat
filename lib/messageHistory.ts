// lib/messageHistory.ts — the server is NOT the whole history.
//
// THE RULE THIS EXISTS TO NAME
//
// delete-on-delivery sets messages.content = NULL once every recipient has
// acked (DELETE_ON_DELIVERY_GRACE_SEC, default 3h), and the media-retention
// sweep purges attachment bytes. That is deliberate: the device keeps its own
// copy in localDb and under documentDirectory/media/, and the server forgets.
//
// The consequence is easy to miss and was shipped four separate times: any
// screen that builds a view from GET /chats/:id/messages ALONE silently loses
// everything past the retention window. Worse, if it then writes that result to
// a cache, it ERASES a view that was previously correct.
//
// Symptoms this actually caused, all reported as unrelated bugs:
//   * the per-chat media gallery went empty while the chat still showed photos
//   * a chat export produced an archive missing its oldest messages
//   * notes/tasks rebuilt from message ops lost their earliest entries
//
// So: read local first, treat the network as a TOP-UP, never a replacement.
//
// This is the opposite of lib/localCache's useCachedResource, which replaces on
// refresh — correct for server-authoritative lists (communities, contacts),
// wrong for anything retention touches.

import { getCachedMessages } from './localDb';
import type { Message } from './chatService';

/**
 * Merge a server page with the device's own cached history for one chat.
 *
 * The server wins on a given id because it is fresher — EXCEPT when its body
 * has been reclaimed (content NULL) and ours has not. Without that carve-out
 * the union would faithfully overwrite the only surviving copy of a message
 * with the tombstone the server kept.
 *
 * `localLimit` bounds the local read; pass something generous for exports and
 * something modest for a preview strip.
 */
export async function unionWithLocalHistory(
  chatId: string,
  serverMsgs: Message[],
  localLimit = 1000,
): Promise<Message[]> {
  if (!chatId) return [...serverMsgs].sort((a, b) => b.id - a.id);

  const local = await getCachedMessages(chatId, localLimit).catch(() => [] as Message[]);
  const byId = new Map<number, Message>();
  for (const m of local) byId.set(m.id, m);
  for (const m of serverMsgs) {
    const mine = byId.get(m.id);
    byId.set(m.id, (mine && mine.content && !m.content) ? mine : m);
  }
  // Newest first — the order every list surface in the app renders in.
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

/** Same union, oldest-first — for exports and op-replay, where order is meaning. */
export async function unionWithLocalHistoryAsc(
  chatId: string,
  serverMsgs: Message[],
  localLimit = 100000,
): Promise<Message[]> {
  const merged = await unionWithLocalHistory(chatId, serverMsgs, localLimit);
  return merged.sort((a, b) => a.id - b.id);
}

export default { unionWithLocalHistory, unionWithLocalHistoryAsc };
