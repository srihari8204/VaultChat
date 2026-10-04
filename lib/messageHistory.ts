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

import { getCachedMessages, getCachedMessagesAfter } from './localDb';
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
 * something modest for a preview strip. Pass `isCipher` to also prefer our
 * readable copy over a server body that is still an E2EE envelope (exports).
 */
export async function unionWithLocalHistory(
  chatId: string,
  serverMsgs: Message[],
  localLimit = 1000,
  isCipher?: (s: string) => boolean,
): Promise<Message[]> {
  if (!chatId) return [...serverMsgs].sort((a, b) => b.id - a.id);

  const local = await getCachedMessages(chatId, localLimit).catch(() => [] as Message[]);
  const byId = new Map<number, Message>();
  for (const m of local) byId.set(m.id, m);
  for (const m of serverMsgs) byId.set(m.id, pickRow(byId.get(m.id), m, isCipher));
  // Newest first — the order every list surface in the app renders in.
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

/** The server's row for an id, unless our cached copy (`mine`) must win — the rule both unions share. */
function pickRow(mine: Message | undefined, m: Message, isCipher?: (s: string) => boolean): Message {
  const reclaimed = !!(mine && mine.content && !m.content && !m.deletedAt);
  // Exports pass isCipher: our readable copy also beats a server body that is
  // still an E2EE envelope (not reclaimed yet), or the export printed ciphertext.
  const stillSealed = !!(mine && mine.content && m.content && !m.deletedAt
    && isCipher && isCipher(m.content) && !isCipher(mine.content));
  return (reclaimed || stillSealed) ? mine! : m;
}

/** Same union, oldest-first — for exports and op-replay, where order is meaning. */
export async function unionWithLocalHistoryAsc(
  chatId: string,
  serverMsgs: Message[],
  localLimit = 100000,
  isCipher?: (s: string) => boolean,
): Promise<Message[]> {
  const merged = await unionWithLocalHistory(chatId, serverMsgs, localLimit, isCipher);
  return merged.sort((a, b) => a.id - b.id);
}

/**
 * The same union as unionWithLocalHistoryAsc, oldest-first, but STREAMED: it
 * yields chunks of about `page` rows and never holds more than one server page,
 * one local page and one chunk. For exports, where the whole history can be
 * 100k+ rows (app/chat-export.tsx).
 *
 * `serverAfter(cursor)` returns the server rows with id > cursor, ascending
 * (GET /chats/:id/messages?after=). The cache is walked the same way with
 * getCachedMessagesAfter, and the two are merge-joined by id with the same
 * per-id rule as the union (pickRow). A source is finished only when it returns
 * an EMPTY page — a short page is not trusted to mean "the end", since a server
 * may cap `limit` below what was asked. A server page that is not ascending
 * and above the cursor (a server that ignored `after`) throws rather than
 * writing an export in the wrong order or missing rows.
 */
export async function* streamUnionWithLocalHistoryAsc(
  chatId: string,
  serverAfter: (after: number) => Promise<Message[]>,
  opts: { page?: number; isCipher?: (s: string) => boolean } = {},
): AsyncGenerator<Message[]> {
  const page = opts.page ?? 200;
  type Src = { buf: Message[]; at: number; cursor: number; done: boolean; read: (after: number) => Promise<Message[]> };
  const server: Src = { buf: [], at: 0, cursor: -1, done: false, read: serverAfter };
  // Same tolerance as the union: an unreadable cache contributes nothing.
  const local: Src = {
    buf: [], at: 0, cursor: Number.MIN_SAFE_INTEGER, done: !chatId,
    read: (after) => getCachedMessagesAfter(chatId, after, page).catch(() => [] as Message[]),
  };
  const head = async (src: Src): Promise<Message | undefined> => {
    if (src.at < src.buf.length) return src.buf[src.at];
    if (src.done) return undefined;
    const rows = await src.read(src.cursor);
    if (!Array.isArray(rows)) throw new Error('Message history page was not a list');
    let prev = src.cursor;
    for (const r of rows) {
      if (!(r.id > prev)) throw new Error('Message history pages are out of order');
      prev = r.id;
    }
    src.buf = rows; src.at = 0;
    if (!rows.length) { src.done = true; return undefined; }
    src.cursor = prev;
    return rows[0];
  };

  let out: Message[] = [];
  for (;;) {
    const [s, l] = await Promise.all([head(server), head(local)]);
    if (!s && !l) break;
    if (s && l && s.id === l.id) { out.push(pickRow(l, s, opts.isCipher)); server.at++; local.at++; }
    else if (s && (!l || s.id < l.id)) { out.push(s); server.at++; }
    else { out.push(l!); local.at++; }
    if (out.length >= page) { yield out; out = []; }
  }
  if (out.length) yield out;
}

export default { unionWithLocalHistory, unionWithLocalHistoryAsc, streamUnionWithLocalHistoryAsc };
