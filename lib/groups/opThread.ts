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
// OP INDEX (round 7, migration 145). New ops are sent with a plaintext routing
// tag, `opKind` ('notes' | 'tasks'; sendGroupOp), and a server that has the
// index answers GET /chats/{id}/ops?kind= with only those messages. The tag
// tells the server THAT a message is a notes or tasks op, never what it says:
// the op itself stays inside the ciphertext. It is sent only once a read this
// session has found the index (opTag), so a server without it never learns
// which messages are ops. With the index a visit reads:
//   1. the index, which holds only ops, so only ops are decrypted from the server;
//   2. this device's own history, as before (plaintext, kept current by
//      syncEngine), which also brings in untagged ops from older apps;
//   3. ONE legacy back-scan per thread per app session (today's paging), for
//      ops sent before the tag existed. Its decoded ops stay in MEMORY only
//      (legacyScans below; never written to disk), keyed by viewer, group and
//      kind, and are re-used on every later visit. It is re-run when this
//      device's history no longer reaches back to it (a busy group).
// A server without the route answers 404/405, and the read falls back to the
// unchanged paging read (collectOps); that answer is remembered for the app
// session (opIndex), so later opens do not ask again. A 'legacy done' marker was not used:
// older apps keep sending untagged ops, so legacy ops never end.
//
// Pure apart from `readGroupOps` and `sendGroupOp`, which load the real I/O
// lazily, so the self-test runs under tsx without react-native.

import type { Message } from '../chatService';

/** The op logs that ride a group thread, as the server's `opKind` names them. */
export type OpKind = 'notes' | 'tasks';

/** Server page cap (chatsMaxPage). Asking for more returns this many. */
export const OP_PAGE = 200;
/**
 * ponytail: the legacy scan stops at 10 pages (2,000 server messages). Each
 * message is a decrypt-cache read. With the op index this scan runs once per
 * thread per app session and only finds ops sent before the tag existed; on a
 * server without the index (404/405) it still runs on every open. Untagged ops
 * older than that are read only from this device's own history, and
 * `complete: false` tells the screen it stopped early. Retire it once no app
 * that sends untagged ops is in use and the index is deployed.
 */
export const OP_MAX_PAGES = 10;
/** Index pages read per open (5,000 ops). The index holds nothing but ops. */
export const OP_INDEX_MAX_PAGES = 25;
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

/**
 * Read server pages newest first with `before=`, until a short page (the start
 * of the thread), `enough(page)` says the caller has what it needs, or
 * `maxPages`. The first page failing throws; a later one keeps what was read
 * and reports `complete: false`.
 */
export async function pageBack(
  page: (before?: number) => Promise<Message[]>,
  maxPages: number = OP_MAX_PAGES,
  enough?: (page: Message[]) => boolean,
): Promise<{ messages: Message[]; complete: boolean }> {
  const messages: Message[] = [];
  let before: number | undefined;
  for (let i = 0; i < maxPages; i++) {
    let p: Message[];
    if (i === 0) {
      p = await page();                // the first page failing IS the load failing
    } else {
      try { p = await page(before); } catch { break; }
    }
    messages.push(...p);
    if (p.length < OP_PAGE || enough?.(p)) return { messages, complete: true };
    const oldest = Math.min(...p.map((m) => m.id));
    // No progress means a server that ignores `before`; stop rather than loop.
    if (!Number.isFinite(oldest) || (before != null && oldest >= before)) break;
    before = oldest;
  }
  return { messages, complete: false };
}

const UNREADABLE = Symbol('unreadable');

/** One message: its op, null when it is not one, or UNREADABLE. Skips deleted and empty rows (null). */
async function decodeMessage<Op extends { by: string }>(
  io: Pick<OpThreadIO, 'decrypt'>, m: Message, decode: (body: string) => Op | null,
): Promise<Op | null | typeof UNREADABLE> {
  if (m.deletedAt || !m.content) return null;
  let body: string;
  try { body = await io.decrypt(m); } catch { return UNREADABLE; }
  if (body === UNREADABLE_BODY) return UNREADABLE;
  const op = decode(body);
  // `by` travels inside the encrypted body and any member could write
  // someone else's id there. The transport sender is authenticated, so an op
  // whose claimed author is not its sender is a forgery and is dropped.
  return op && op.by === String(m.senderId) ? op : null;
}

/** The paging read: every server message back to OP_MAX_PAGES, plus local history. */
export async function collectOps<Op extends { by: string }>(
  io: OpThreadIO,
  decode: (body: string) => Op | null,
  maxPages: number = OP_MAX_PAGES,
): Promise<OpThreadResult<Op>> {
  const { messages: server, complete } = await pageBack((before) => io.page(before), maxPages);

  const ops: Op[] = [];
  let unreadable = 0;
  for (const m of await io.withLocal(server)) {
    const r = await decodeMessage(io, m, decode);
    if (r === UNREADABLE) unreadable++;
    else if (r) ops.push(r);
  }
  return { ops, unreadable, complete };
}

export interface IndexedOpThreadIO extends OpThreadIO {
  /** One page of the op index, newest first. Throws (status 404/405) on a server without it. */
  indexPage(before?: number): Promise<Message[]>;
  /**
   * How many of this device's history rows are newer than message `after`,
   * counting no further than OP_LOCAL_LIMIT. Read from local history itself:
   * the merged list cannot tell a local row from an index row with the same id.
   */
  localRowsAfter(after: number): Promise<number>;
}

/** What one legacy back-scan found, kept in memory for the app session. */
export interface LegacyScan<Op> {
  /** Newest message id the scan read. */
  high: number;
  complete: boolean;
  /** Ops by message id, with the message's expiry (ms) so a disappearing op still disappears. */
  ops: Map<number, { op: Op; exp: number | null }>;
  /** Messages that could not be decrypted yet; retried on each visit (a sender key may arrive). */
  unreadable: Map<number, Message>;
}

export interface LegacyScanCache<Op> {
  get(): LegacyScan<Op> | undefined;
  set(scan: LegacyScan<Op>): void;
}

/** True for the error an op-index read gets from a server that has no index. */
export function isNoOpIndex(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 404 || status === 405;
}

/**
 * The indexed read (see the header). The index's first page failing throws, so
 * the caller can tell "no index" (isNoOpIndex) from a load failure. A failed
 * legacy scan is not cached and reports `complete: false`.
 */
export async function collectIndexedOps<Op extends { by: string }>(
  io: IndexedOpThreadIO,
  decode: (body: string) => Op | null,
  cache: LegacyScanCache<Op> | null,
  now: number = Date.now(),
): Promise<OpThreadResult<Op>> {
  const index = await pageBack((before) => io.indexPage(before), OP_INDEX_MAX_PAGES);

  let scan = cache?.get();
  let raw: Message[] = [];   // legacy server messages read on THIS visit
  let merged = scan ? await io.withLocal([...index.messages, ...scan.unreadable.values()]) : [];
  if (!scan || await localGap(io, scan)) {
    const prev = scan;
    let back: { messages: Message[]; complete: boolean } | null = null;
    try { back = await pageBack((before) => io.page(before), OP_MAX_PAGES); } catch { /* reported below */ }
    raw = back?.messages ?? [];
    const ids = raw.map((m) => m.id);
    const reaches = !!prev && ids.length > 0 && Math.min(...ids) <= prev.high;
    scan = {
      high: Math.max(prev?.high ?? 0, ...ids),
      complete: !!back && (back.complete || (reaches && prev!.complete)),
      ops: prev?.ops ?? new Map(),
      unreadable: prev?.unreadable ?? new Map(),
    };
    merged = await io.withLocal([...index.messages, ...raw, ...scan.unreadable.values()]);
    if (back) cache?.set(scan);
  }

  // Message ids are unique across the index, the legacy scan and local
  // history, so keying by id is the dedupe; the fold orders by op time.
  const rawIds = new Set(raw.map((m) => m.id));
  const out = new Map<number, Op>();
  let unreadable = 0;
  for (const m of merged) {
    if (m.deletedAt) scan.ops.delete(m.id);
    const r = await decodeMessage(io, m, decode);
    const legacy = rawIds.has(m.id) || scan.unreadable.has(m.id);
    if (r === UNREADABLE) {
      unreadable++;
      if (legacy) scan.unreadable.set(m.id, m);
      continue;
    }
    if (legacy) scan.unreadable.delete(m.id);
    if (!r) continue;
    out.set(m.id, r);
    if (legacy) scan.ops.set(m.id, { op: r, exp: m.expiresAt ? Date.parse(m.expiresAt) : null });
  }
  for (const [id, e] of scan.ops) {
    if (!out.has(id) && (e.exp == null || !(e.exp <= now))) out.set(id, e.op);
  }
  return { ops: [...out.values()], unreadable, complete: index.complete && scan.complete };
}

/**
 * Whether this server has the op index, as learnt this app session (undefined
 * until a read has asked). `false` stops every later read from asking again,
 * so today's server costs one 404 per session, not one per open; `true` lets
 * sendGroupOp tag ops (opTag).
 * ponytail: remembered for the app session, like communityManagementSupported
 * (serverContracts.ts), so an index deployed while the app is open is used,
 * and ops are tagged, only after a restart. Until then reads take the paging
 * path and untagged ops are found by the legacy scan, as an older app's are.
 * Replace with a server-sent capability list if one is ever added.
 */
export interface OpIndexMemo { known?: boolean }
const opIndex: OpIndexMemo = {};

/** The index read, or the paging read on a server without the index (404/405). */
export async function collectGroupOps<Op extends { by: string }>(
  io: IndexedOpThreadIO,
  decode: (body: string) => Op | null,
  cache: LegacyScanCache<Op> | null,
  memo: OpIndexMemo = opIndex,
): Promise<OpThreadResult<Op>> {
  if (memo.known === false) return collectOps<Op>(io, decode);
  try {
    const r = await collectIndexedOps<Op>(io, decode, cache);
    memo.known = true;
    return r;
  } catch (e) {
    if (!isNoOpIndex(e)) throw e;
    memo.known = false;
    return collectOps<Op>(io, decode);   // today's server: no index route
  }
}

/**
 * The routing tag for one op send: `{ opKind }` only once a read this session
 * has found the index, else nothing. Privacy over coverage: no server learns
 * which messages are notes or tasks ops before it can use that to serve the
 * index (today's server would just receive and drop it), and a send can never
 * reach a server whose code writes the tag before migration 145 added the
 * column. An untagged op stays correct: the legacy scan and local history
 * read it, exactly as they read an older app's ops.
 */
export function opTag(kind: OpKind, memo: OpIndexMemo = opIndex): { opKind?: OpKind } {
  return memo.known === true ? { opKind: kind } : {};
}

/**
 * Whether this device's history (the newest OP_LOCAL_LIMIT rows, what
 * withLocal merges) no longer reaches back to the last legacy scan, so an
 * untagged op could sit between them: a group busier than that since the
 * scan. A failed local read counts as a gap (rescan rather than miss ops).
 */
async function localGap(io: IndexedOpThreadIO, scan: LegacyScan<unknown>): Promise<boolean> {
  const newer = await io.localRowsAfter(scan.high).catch(() => OP_LOCAL_LIMIT);
  return newer >= OP_LOCAL_LIMIT;
}

// Memory only, per process: decoded ops are never written to disk here. Keyed
// by viewer as well, so a different account on this phone starts empty.
const MAX_SCANS = 20;
const legacyScans = new Map<string, LegacyScan<unknown>>();
function legacyScanCache<Op>(key: string): LegacyScanCache<Op> {
  return {
    get: () => {
      // Re-inserted on read too, so the eviction below drops the least recently USED thread.
      const scan = legacyScans.get(key);
      if (scan) { legacyScans.delete(key); legacyScans.set(key, scan); }
      return scan as LegacyScan<Op> | undefined;
    },
    set: (scan) => {
      legacyScans.delete(key);
      legacyScans.set(key, scan as LegacyScan<unknown>);
      if (legacyScans.size > MAX_SCANS) legacyScans.delete(legacyScans.keys().next().value as string);
    },
  };
}

/**
 * Read every op of one kind from a group's thread: through the op index when
 * the server has it, else the paging read. Throws when nothing could be
 * loaded. `viewer` (the signed-in user id) keys the session's legacy-scan
 * memory; null skips it, so the legacy scan runs on every open.
 */
export async function readGroupOps<Op extends { by: string }>(
  groupId: string,
  kind: OpKind,
  decode: (body: string) => Op | null,
  viewer: string | null,
): Promise<OpThreadResult<Op>> {
  const { getMessages, decryptFromChat, normalizeMsgIds } = await import('../chatService');
  const { unionWithLocalHistoryAsc } = await import('../messageHistory');
  const { getCachedMessagesAfter } = await import('../localDb');
  const { api } = await import('../api');
  const chat = encodeURIComponent(groupId);
  const io: IndexedOpThreadIO = {
    page: (before) => getMessages(groupId, { limit: OP_PAGE, before }),
    indexPage: async (before) => {
      const rows = await api<Message[]>(`/chats/${chat}/ops?kind=${kind}&limit=${OP_PAGE}${before ? `&before=${before}` : ''}`);
      return Array.isArray(rows) ? rows.map(normalizeMsgIds) : [];
    },
    withLocal: (server) => unionWithLocalHistoryAsc(groupId, server, OP_LOCAL_LIMIT),
    localRowsAfter: async (after) => (await getCachedMessagesAfter(groupId, after, OP_LOCAL_LIMIT)).length,
    decrypt: (m) => decryptFromChat(groupId, m.senderId, m.content, m.id),
  };
  return collectGroupOps<Op>(io, decode, viewer ? legacyScanCache<Op>(`${viewer}|${groupId}|${kind}`) : null);
}

/**
 * Send one op: encrypted for the group exactly like a message, plus the
 * plaintext routing tag `opKind` once this session has found the index
 * (opTag), which tells the server only THAT this is a notes or tasks op (see
 * the header). Sent over HTTP, the path sendMessage itself falls back to;
 * CC-Wire's frame has no field for the tag.
 */
export async function sendGroupOp(groupId: string, kind: OpKind, plaintext: string): Promise<void> {
  const { encryptForChat, cacheOwnPlaintext, normalizeMsgIds } = await import('../chatService');
  const { api } = await import('../api');
  const Crypto = await import('expo-crypto');
  const content = await encryptForChat(groupId, plaintext);
  const msg = normalizeMsgIds(await api<Message>(`/chats/${encodeURIComponent(groupId)}/messages`, {
    method: 'POST',
    // clientId once per op, so an internal retry (token refresh) is deduped by the server.
    json: { content, type: 'text', replyToId: null, meta: null, clientId: Crypto.randomUUID(), ...opTag(kind) },
  }));
  // The sender cannot open its own ciphertext; keep the readable copy (as sendMessage does).
  if (content !== plaintext) await cacheOwnPlaintext(groupId, msg?.id, plaintext);
}
