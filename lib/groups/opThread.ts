// lib/groups/opThread.ts — read a group's encrypted op log (shared notes and
// shared tasks).
//
// Both screens store each change as one encrypted message in the group thread
// and show the fold of every op. Reading that log was copied in both screens;
// this is the one copy. The fold itself stays with each type (notes.ts,
// tasks.ts), because the two folds really are different.
//
// PAGED. The server returns at most OP_PAGE messages per request (chatsMaxPage
// in vaultchat-backend-go/internal/routes/chats.go), so the old single
// `limit: 400` request actually read only the newest 200 messages. A busy group
// pushed older notes and tasks out of view. This reads back page by page with
// `before=`, up to OP_MAX_PAGES, then adds this device's own history, which
// still holds ops the server has since cleared.
//
// Pure apart from `readGroupOps`, which loads the real I/O lazily, so the
// self-test runs under tsx without react-native.

import type { Message } from '../chatService';

/** Server page cap (chatsMaxPage). Asking for more returns this many. */
export const OP_PAGE = 200;
/**
 * ponytail: a hard stop at 10 pages (2,000 server messages) per open. Each
 * message is a decrypt-cache read, so reading a very long thread in full on
 * every focus would be slow. Ops older than that are still read from this
 * device's own history. `complete: false` tells the screen it stopped early.
 * Replace with a server-side op index (or a local snapshot of the fold) if
 * groups routinely bury their notes under more than 2,000 messages.
 */
export const OP_MAX_PAGES = 10;
/** How many messages of this device's own history are merged in. */
export const OP_LOCAL_LIMIT = 2000;
/** What decryptFromChat returns for a group message it cannot open (lib/chatService.ts). */
export const UNREADABLE_BODY = '🔒 unable to decrypt';

export interface OpThreadIO {
  /** One server page, newest first, of at most OP_PAGE messages older than `before`. */
  page(before?: number): Promise<Message[]>;
  /** Merge with this device's history; oldest first. */
  withLocal(server: Message[]): Promise<Message[]>;
  decrypt(m: Message): Promise<string>;
}

export interface OpThreadResult<Op> {
  ops: Op[];
  /** Messages this phone could not decrypt. Some of them may have been ops. */
  unreadable: number;
  /** False when paging stopped before the start of the thread. */
  complete: boolean;
}

export async function collectOps<Op extends { by: string }>(
  io: OpThreadIO,
  decode: (body: string) => Op | null,
  maxPages: number = OP_MAX_PAGES,
): Promise<OpThreadResult<Op>> {
  const server: Message[] = [];
  let before: number | undefined;
  let complete = false;
  for (let i = 0; i < maxPages; i++) {
    let page: Message[];
    if (i === 0) {
      page = await io.page();          // the first page failing IS the load failing
    } else {
      // A later page failing keeps what was read; the screen says it is partial.
      try { page = await io.page(before); } catch { break; }
    }
    server.push(...page);
    if (page.length < OP_PAGE) { complete = true; break; }
    const oldest = Math.min(...page.map((m) => m.id));
    // No progress means a server that ignores `before`; stop rather than loop.
    if (!Number.isFinite(oldest) || (before != null && oldest >= before)) break;
    before = oldest;
  }

  const ops: Op[] = [];
  let unreadable = 0;
  for (const m of await io.withLocal(server)) {
    if (m.deletedAt || !m.content) continue;
    let body: string;
    try { body = await io.decrypt(m); } catch { unreadable++; continue; }
    if (body === UNREADABLE_BODY) { unreadable++; continue; }
    const op = decode(body);
    // `by` travels inside the encrypted body and any member could write
    // someone else's id there. The transport sender is authenticated, so an op
    // whose claimed author is not its sender is a forgery and is dropped.
    if (op && op.by === String(m.senderId)) ops.push(op);
  }
  return { ops, unreadable, complete };
}

/** Read every op of one kind from a group's thread. Throws when nothing could be loaded. */
export async function readGroupOps<Op extends { by: string }>(
  groupId: string,
  decode: (body: string) => Op | null,
): Promise<OpThreadResult<Op>> {
  const { getMessages, decryptFromChat } = await import('../chatService');
  const { unionWithLocalHistoryAsc } = await import('../messageHistory');
  return collectOps<Op>({
    page: (before) => getMessages(groupId, { limit: OP_PAGE, before }),
    withLocal: (server) => unionWithLocalHistoryAsc(groupId, server, OP_LOCAL_LIMIT),
    decrypt: (m) => decryptFromChat(groupId, m.senderId, m.content, m.id),
  }, decode);
}
