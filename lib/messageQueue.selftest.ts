// lib/messageQueue.selftest.ts — run: npx tsx lib/messageQueue.selftest.ts
//
// Runs the REAL flush()/enqueue() from lib/messageQueue.ts against the three
// correctness gaps found in the §9 offline audit (docs/OFFLINE_CORRECTNESS.md).
// Same harness trick as messageQueue.flush.selftest.ts — that file owns the
// paging/recovery/mutex behaviour; this one owns loss, duplication and order:
//
//   1. ORDER. A transient failure used to let a LATER message in the same chat
//      overtake the one that failed, and the overtaking message got the lower
//      server id. Both sides sort on that id, so the reordering was permanent.
//   2. ACKED BUT NOT PERSISTED. postOnce's local commit (cacheMessages) could
//      fail while flush() went on to blank item.plaintext regardless, so the
//      sender's only readable copy of their own message was destroyed a few
//      lines after the tick appeared.
//   3. QUEUED BUT NOT PERSISTED. put() swallows its write error, so a failed
//      queuePut returned a pending bubble for a row that was not on disk: a
//      clock forever, and nothing at all after a restart.
//
// Also pins the idempotency key, which is what makes retry-after-ambiguous-
// failure safe and is the reason #1's fix may block a chat without risking a
// duplicate.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

const WORK = join(tmpdir(), `vc-mq-selftest-${process.pid}`);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');

// postOnce reaches for cacheMessages through a DYNAMIC import('./localDb'), so
// that one needs a real module on disk rather than an import rewrite.
writeFileSync(join(WORK, 'localDb.js'), `
const H = () => globalThis.__H2;
export async function cacheMessages(chatId, msgs) {
  if (H().commitFails) throw new Error('disk full');
  H().committed.push(msgs[0]?.id);
  H().committedRows.push(msgs[0]);
}
`);

const STUBS = `
const H = () => globalThis.__H2;
export default { addEventListener(cb) { H().netListeners.push(cb); return () => {}; } };
let _n = 0;
export function randomUUID() { return 'cid-' + (++_n); }
export async function api(path, opts) { return H().api(path, opts); }
export const perf = { mark() {}, recordSend() {}, snapshot() { return { transport: 'test' }; } };
export async function encryptForChat(_c, t) { return 'CT:' + t; }
export async function cacheOwnPlaintext() {}
export async function editMessage() { return { id: 1 }; }
export async function deleteMessage() {}
const ord = (a, b) => (a.createdAt - b.createdAt) || (a.rowid - b.rowid);
let seq = 0;
export async function queuePut(q, id, item, createdAt, tag) {
  if (H().putFails) throw new Error('database is locked');
  const rows = H().rows;
  const i = rows.findIndex(r => r.q === q && r.id === id);
  if (i >= 0) { rows[i].data = { ...item }; rows[i].tag = tag ?? null; return; }
  rows.push({ q, id, tag: tag ?? null, data: { ...item }, createdAt: createdAt ?? Date.now(), rowid: ++seq });
}
export async function queueList(q, limit = 200, offset = 0) {
  return H().rows.filter(r => r.q === q).sort(ord).slice(offset, offset + limit).map(r => r.data);
}
export async function queueListByTag(q, tag, limit = 500) {
  return H().rows.filter(r => r.q === q && r.tag === tag).sort(ord).slice(0, limit).map(r => r.data);
}
export async function queueGet(q, id) { return H().rows.find(r => r.q === q && r.id === id)?.data ?? null; }
export async function queueDelete(q, id) {
  const rows = H().rows;
  const i = rows.findIndex(r => r.q === q && r.id === id);
  if (i >= 0) rows.splice(i, 1);
}
export async function queueMigrate() { return 0; }
`;
writeFileSync(join(WORK, 'stubs.js'), STUBS);

const IMPORT_REWRITES: [RegExp, string][] = [
  [/^import NetInfo from '@react-native-community\/netinfo';$/m, `import NetInfo from './stubs.js';`],
  [/^import \* as Crypto from 'expo-crypto';$/m, `import * as Crypto from './stubs.js';`],
  [/^import \{ api \} from '\.\/api';$/m, `import { api } from './stubs.js';`],
  [/^import \{ queuePut, queueList, queueListByTag, queueGet, queueDelete, queueMigrate \} from '\.\/localDb';$/m,
   `import { queuePut, queueList, queueListByTag, queueGet, queueDelete, queueMigrate } from './stubs.js';`],
  [/^import \{ encryptForChat, cacheOwnPlaintext, editMessage, deleteMessage, type Message \} from '\.\/chatService';$/m,
   `import { encryptForChat, cacheOwnPlaintext, editMessage, deleteMessage } from './stubs.js';`],
  [/^import \{ splitMeta, wrapEnvelope \} from '\.\/msgEnvelope';$/m,
   `import { splitMeta, wrapEnvelope } from './msgEnvelope.ts';`],
  // msgIds is NOT stubbed, matching messageQueue.flush.selftest.ts: it
  // normalizes the POST ack, which is the path carrying replyToId, so stubbing
  // it would stub out behaviour worth asserting. It has no imports of its own,
  // which is why it can be used for real.
  [/^import \{ normalizeMsgIds \} from '\.\/msgIds';$/m,
   `import { normalizeMsgIds } from './msgIds.ts';`],
  [/^import \{ type MsgState \} from '\.\/messageState';$/m, ``],
  [/^import perf from '\.\/perf';$/m, `import { perf } from './stubs.js';`],
];

let src = readFileSync(join(HERE, 'messageQueue.ts'), 'utf8');
for (const [re, to] of IMPORT_REWRITES) {
  if (!re.test(src)) {
    console.log(`  ✗ selftest could not rewrite an import — messageQueue.ts changed its import block (${re})`);
    failures++;
  }
  src = src.replace(re, to);
}
src = src.replace(/\bMessage\['type'\]/g, 'any').replace(/\bMsgState\b/g, 'any');
// ...but NOT the dynamic import('./localDb') inside postOnce — that one resolves
// to the real stub module above, so the local-commit failure is exercised for
// real rather than asserted on the shape of the source.
writeFileSync(join(WORK, 'msgEnvelope.ts'),
  readFileSync(join(HERE, 'msgEnvelope.ts'), 'utf8').replace(/^import type .*$/m, ''));
// Likewise the real msgIds — no imports at all, same as the other harnesses.
writeFileSync(join(WORK, 'msgIds.ts'), readFileSync(join(HERE, 'msgIds.ts'), 'utf8'));
writeFileSync(join(WORK, 'mq.ts'), src);

const H: any = {
  rows: [], netListeners: [], committed: [] as number[], committedRows: [] as any[],
  commitFails: false, putFails: false, online: true,
  posted: [] as any[], serverSeq: 100, failClientIds: new Set<string>(),
  api: async (path: string, opts: any) => {
    const method = opts?.method ?? 'POST';
    if (method === 'PUT') return {};
    if (!H.online) throw new Error('Network request failed');   // no .status — transient
    const cid = opts?.json?.clientId;
    if (H.failClientIds.has(cid)) {
      const e: any = new Error('server busy'); e.status = 503; throw e;  // transient
    }
    H.posted.push({ clientId: cid, content: opts?.json?.content, type: opts?.json?.type, meta: opts?.json?.meta });
    return { id: ++H.serverSeq, chatId: 'c1', content: 'CT:x', createdAt: new Date().toISOString() };
  },
};
(globalThis as any).__H2 = H;

async function main() {
const Q: any = await import(pathToFileURL(join(WORK, 'mq.ts')).href);
Q.initQueue();
// A transient failure arms a backoff timer (scheduleFlush), and a flush() that
// starts while that one is running coalesces instead of re-entering — so a test
// that just calls flush() twice can measure the wrong pass. Settling on an EMPTY
// queue disarms everything: nothing remains, so nothing is rescheduled.
const settle = () => new Promise(r => setTimeout(r, 1400));
const reset = async () => {
  H.rows.length = 0;
  await settle();
  H.posted.length = 0; H.committed.length = 0; H.committedRows.length = 0;
  H.failClientIds.clear(); H.commitFails = false; H.putFails = false; H.online = true;
};
const rowFor = (id: string) => H.rows.find((r: any) => r.id === id)?.data;

// Rows are seeded straight onto the fake table rather than through enqueue():
// enqueue() kicks off a background flush() it does not await, which would race
// every assertion below. enqueue() itself is exercised in section 3, which is
// the only test that is actually about it.
let seedN = 0;
function seed(chatId: string, text: string) {
  const n = ++seedN;
  const item = {
    tempId: `t${n}`, clientId: `cid-seed-${n}`, chatId, op: 'send', type: 'text',
    targetId: null, plaintext: text, replyToId: null, meta: null,
    attempts: 0, createdAt: 1000 + n, lastError: null, state: 'QUEUED',
  };
  H.rows.push({ q: 'msg', id: item.tempId, tag: chatId, data: item, createdAt: item.createdAt, rowid: 1000 + n });
  return item;
}

try {
  // ── 1. ordering across a retry ───────────────────────────────────────────
  console.log('ordering: a retry must not be overtaken inside its own chat');
  await reset();
  const a = seed('c1', 'first');
  const b = seed('c1', 'second');
  const c = seed('c1', 'third');
  const other = seed('c2', 'unrelated');
  H.failClientIds.add(a.clientId);                  // 'first' 503s
  await Q.flush();
  check('the message behind the failed one is held back',
    !H.posted.some((p: any) => p.clientId === b.clientId || p.clientId === c.clientId),
    `sent out of order: ${H.posted.map((p: any) => p.content).join(', ')}`);
  check('a DIFFERENT chat is not blocked by it',
    H.posted.some((p: any) => p.clientId === other.clientId),
    'per-chat blocking leaked into a global stall');
  check('the held-back messages are still queued, not failed',
    !!rowFor(b.tempId) && !!rowFor(c.tempId));
  check('and they took no attempt for another message\'s failure',
    rowFor(b.tempId).attempts === 0 && rowFor(a.tempId).attempts === 1,
    `a=${rowFor(a.tempId).attempts} b=${rowFor(b.tempId).attempts}`);

  // The backoff timer armed by that failure is the retry. Let it run.
  H.failClientIds.clear();
  H.posted.length = 0;
  await settle();
  check('once it clears, the chat drains in order',
    H.posted.map((p: any) => p.content).join('|') === 'CT:first|CT:second|CT:third',
    H.posted.map((p: any) => p.content).join('|'));

  // ── 2. acked to the UI but never persisted ───────────────────────────────
  console.log('local commit failure must not destroy the only readable copy');
  await reset();
  H.commitFails = true;
  const m = seed('c1', 'the only copy');
  await Q.flush();
  const row = rowFor(m.tempId);
  check('the accepted row still exists', !!row);
  check('...and it KEPT the plaintext when the local commit failed',
    row?.plaintext === 'the only copy',
    `plaintext is ${JSON.stringify(row?.plaintext)} — the sender can no longer read their own message`);
  check('...and it is still marked accepted, so it is never re-POSTed',
    row?.serverId > 0 && row?.state === 'SENT',
    `serverId=${row?.serverId} state=${row?.state}`);

  await reset();
  const m2 = seed('c1', 'committed fine');
  await Q.flush();
  check('the normal path still drops the plaintext (no at-rest regression)',
    rowFor(m2.tempId)?.plaintext === '' && H.committed.length === 1,
    `plaintext=${JSON.stringify(rowFor(m2.tempId)?.plaintext)} commits=${H.committed.length}`);

  // ── 3. queued to the UI but never persisted ──────────────────────────────
  console.log('enqueue must not report success for a row that never landed');
  await reset();
  H.putFails = true;
  let threw = false;
  try { await Q.enqueueText('c1', 'lost before it started'); } catch { threw = true; }
  check('enqueueText throws when the outbox write fails', threw,
    'a pending bubble was returned for a row that is not on disk — a clock forever, gone at next launch');
  check('nothing was left behind claiming to be queued', H.rows.length === 0);

  // ── 4. idempotency, which is what makes every retry above safe ───────────
  console.log('idempotency key');
  await reset();
  const k = seed('c1', 'retried');
  H.failClientIds.add(k.clientId);
  await Q.flush();
  const after = rowFor(k.tempId);
  check('the clientId is persisted and unchanged across a retry',
    after.clientId === k.clientId && !!k.clientId);
  H.failClientIds.clear();
  H.posted.length = 0;
  await settle();
  check('the retry POSTs the SAME clientId the first attempt used',
    H.posted.length === 1 && H.posted[0].clientId === k.clientId,
    `${H.posted.length} posts, clientId ${H.posted[0]?.clientId} vs ${k.clientId}`);

  // ── 5. enqueueMessage: GIF cards and forwards ride the outbox too ────────
  console.log('enqueueMessage (GIF / forward)');
  await reset();
  H.online = false;                                 // first attempt fails transiently
  const gif = await Q.enqueueMessage('c1', {
    type: 'image', meta: { gifUrl: 'https://g.example/x.gif', preview: 'https://g.example/p.gif', source: 'klipy' },
  });
  const pend = await Q.pendingForChat('c1');
  check('an offline GIF is kept as a pending row, with its meta (restart restore)',
    pend.length === 1 && pend[0].tempId === gif.tempId && pend[0].meta?.gifUrl === 'https://g.example/x.gif');
  H.online = true;
  await settle();
  const gp = H.posted.find((p: any) => p.clientId === gif.clientId);
  check('it is posted once the network is back, with its own type',
    !!gp && gp.type === 'image', JSON.stringify(gp));
  check('the server receives only the routing subset of meta',
    JSON.stringify(gp?.meta) === JSON.stringify({ gifUrl: 'https://g.example/x.gif' }), JSON.stringify(gp?.meta));
  check('the private meta rides inside the encrypted body',
    typeof gp?.content === 'string' && gp.content.startsWith('CT:') && gp.content.includes('klipy'));
  const local = H.committedRows.find((r: any) => r?.meta?.gifUrl);
  check('the sender\'s local record has an empty body and the FULL meta',
    !!local && local.content === '' && local.meta.source === 'klipy' && local.meta.preview === 'https://g.example/p.gif',
    JSON.stringify(local));
  let refused = false;
  try { await Q.enqueueMessage('c1', { type: 'image', meta: { localUri: 'file:///x.jpg' } }); } catch { refused = true; }
  check('a not-yet-uploaded file (localUri) is refused, never posted', refused);

  // The server half of that contract: ON CONFLICT DO NOTHING + return the
  // original row. Asserted here because the client guarantee is worthless
  // without it, and it lives in a repo this file cannot import.
  const HELPERS = join(HERE, '..', 'vaultchat-backend-go', 'internal', 'routes', 'chats_helpers.go');
  let go = '';
  try { go = readFileSync(HELPERS, 'utf8'); } catch {}
  if (go) {
    check('the server still dedups on (chat_id, sender_id, client_id)',
      /ON CONFLICT \(chat_id, sender_id, client_id\) WHERE client_id IS NOT NULL DO NOTHING/.test(go),
      'without this, every ambiguous retry above creates a duplicate message');
    check('...and returns the ORIGINAL row rather than an error',
      /Retry of the same clientId/.test(go));
  } else {
    console.log('  – backend not present in this checkout; server dedup not re-checked');
  }
} finally {
  rmSync(WORK, { recursive: true, force: true });
}
}

main().then(() => {
  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.log('  ✗ harness threw:', err?.message ?? err);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
