// lib/messageQueue.flush.selftest.ts — run: npx tsx lib/messageQueue.flush.selftest.ts
//
// Executes the REAL flush() from lib/messageQueue.ts.
//
// "Offline messages not working" was four defects at once, and every one of them
// was silent: nothing threw, nothing logged, messages simply never left the
// phone. Asserting on the shape of the source would not have caught them, so
// this runs the actual code and checks what it DOES:
//
//   1. accepted-but-unconfirmed rows were counted as drained, so a page of them
//      looked like progress, reset the offset and re-read the same page forever.
//      They are the OLDEST rows, so they sort to the head of the page — the
//      normal case for an active user, not an edge one.
//   2. recovery (reBodyAwaiting) ran BEFORE the send loop, inside the flushing
//      mutex, one serial PUT per accepted row.
//   3. api() had no fetch deadline, so a connected-but-dead link never settled;
//      the mutex was never released and the outbox died for the process.
//   4. initQueue() was never called at boot, so the NetInfo listener that owns
//      the `online` flag did not exist and the flag stayed stale-true.
//
// Measured against the pre-fix build (189b302), this harness reports: 3 messages
// still queued after 6 flushes, 40 doomed PUTs issued while offline, 0/2 sent,
// and flush() permanently wedged.
//
// messageQueue.ts cannot be imported under Node (react-native, expo-crypto), so
// its IMPORT BLOCK ONLY is rewritten to point at stubs and the body is used
// verbatim — regenerated on every run, so it cannot drift from what ships. Same
// spirit as localDb.queue.selftest.ts lifting DDL out of the source.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { readRootLayout } from '../scripts/rootLayoutSources';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── build a runnable copy: imports rewritten, body untouched ──────────────
const WORK = join(tmpdir(), `vc-flush-selftest-${process.pid}`);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');

const STUBS = `
const H = () => globalThis.__H;
export default { addEventListener(cb) { H().netListeners.push(cb); return () => {}; } };
let _n = 0;
export function randomUUID() { return 'cid-' + (++_n); }
export async function api(path, opts) { return H().api(path, opts); }
export const perf = { mark() {}, recordSend() {}, snapshot() { return { transport: 'test' }; } };
export async function encryptForChat(_c, t) { return 'CT:' + t; }
export async function cacheOwnPlaintext() {}
export async function editMessage() { return { id: 1 }; }
export async function deleteMessage() {}
// Mirrors the queues table's ordering contract: ORDER BY created_at, rowid.
// That ordering is exactly why accepted rows land at the head of the page.
const ord = (a, b) => (a.createdAt - b.createdAt) || (a.rowid - b.rowid);
let seq = 0;
export async function queuePut(q, id, item, createdAt, tag) {
  const rows = H().rows;
  const i = rows.findIndex(r => r.q === q && r.id === id);
  if (i >= 0) { rows[i].data = item; rows[i].tag = tag ?? null; return; }
  rows.push({ q, id, tag: tag ?? null, data: item, createdAt: createdAt ?? Date.now(), rowid: ++seq });
}
export async function queueList(q, limit = 200, offset = 0) {
  H().listCalls++;
  return H().rows.filter(r => r.q === q).sort(ord).slice(offset, offset + limit).map(r => r.data);
}
export async function queueListByTag(q, tag, limit = 500) {
  return H().rows.filter(r => r.q === q && r.tag === tag).sort(ord).slice(0, limit).map(r => r.data);
}
export async function queueGet(q, id) {
  return H().rows.find(r => r.q === q && r.id === id)?.data ?? null;
}
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
  // msgEnvelope is NOT stubbed: it has no runtime imports, so the real module
  // is copied in below and the flush path exercises the actual public/private
  // meta split rather than a stand-in that always agrees with it.
  [/^import \{ splitMeta, wrapEnvelope \} from '\.\/msgEnvelope';$/m,
   `import { splitMeta, wrapEnvelope } from './msgEnvelope.ts';`],
  // msgIds is NOT stubbed either, for the same reason and a sharper one: the
  // POST ack it normalizes is the path that carries replyToId, so stubbing it
  // would stub out the exact behaviour worth asserting here.
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
// Type positions that referenced the removed type-only imports.
src = src.replace(/\bMessage\['type'\]/g, 'any').replace(/\bMsgState\b/g, 'any');

// The real msgEnvelope, minus its type-only import, so `./msgEnvelope.ts`
// resolves inside WORK and the split under test is the shipping one.
writeFileSync(join(WORK, 'msgEnvelope.ts'),
  readFileSync(join(HERE, 'msgEnvelope.ts'), 'utf8')
    .replace(/^import type .*$/m, ''));

// Likewise the real msgIds — it has no imports at all, which is why it is its
// own module rather than living in chatService.
writeFileSync(join(WORK, 'msgIds.ts'), readFileSync(join(HERE, 'msgIds.ts'), 'utf8'));

const stray = [...src.matchAll(/^import .*from '([^']+)';$/gm)]
  .map(m => m[1])
  .filter(p => p !== './stubs.js' && p !== './msgEnvelope.ts' && p !== './msgIds.ts');
check('every messageQueue import is accounted for', stray.length === 0, `unstubbed: ${stray.join(', ')}`);

writeFileSync(join(WORK, 'mq.ts'), src);

// ── harness state ─────────────────────────────────────────────────────────
const H: any = {
  rows: [], netListeners: [], listCalls: 0, online: true,
  apiCalls: [] as string[], hangMethod: null as string | null, serverSeq: 100,
  api: async (path: string, opts: any) => {
    const method = opts?.method ?? 'POST';
    H.apiCalls.push(`${method} ${path}`);
    // A connected-but-dead link: accepted, never answered. This is the shape
    // that wedged the outbox, and it is why api() now carries a deadline.
    if (H.hangMethod && method === H.hangMethod) await new Promise(() => {});
    if (!H.online) throw new Error('Network request failed');  // no .status, like a real offline fetch
    if (method === 'PUT') return {};
    return { id: ++H.serverSeq, chatId: 'c1', content: 'CT:x', createdAt: new Date().toISOString() };
  },
};
(globalThis as any).__H = H;

// Wrapped: this repo compiles as CJS under tsx, so there is no top-level await.
async function main() {
const Q: any = await import(pathToFileURL(join(WORK, 'mq.ts')).href);

// initQueue subscribes the NetInfo listener, which is the ONLY writer of the
// module's `online` flag — and that flag initialises to true. Skip this and the
// offline guard silently never fires. That was the app's real defect: initQueue
// had a single caller, the chat screen's mount effect.
Q.initQueue();

async function setOnline(v: boolean) {
  H.online = v;
  for (const cb of H.netListeners) cb({ isConnected: v, isInternetReachable: v });
  await new Promise(r => setTimeout(r, 50));
}
const reset = () => { H.rows.length = 0; H.apiCalls.length = 0; H.listCalls = 0; H.hangMethod = null; };
const queued = () => H.rows.filter((r: any) => !r.data.serverId).length;
const posts = () => H.apiCalls.filter((c: string) => c.startsWith('POST')).length;
const puts = () => H.apiCalls.filter((c: string) => c.startsWith('PUT')).length;

function seed(n: number, opts: { awaiting?: boolean; base?: number } = {}) {
  const base = opts.base ?? 0;
  for (let i = 0; i < n; i++) {
    const id = `${opts.awaiting ? 'a' : 'q'}${base + i}`;
    H.rows.push({
      q: 'msg', id, tag: 'c1', createdAt: base + i, rowid: H.rows.length + 1,
      data: {
        tempId: id, clientId: id, chatId: 'c1', op: 'send', type: 'text',
        plaintext: opts.awaiting ? '' : 'hello', replyToId: null, meta: null,
        attempts: 0, createdAt: base + i, lastError: null,
        // Accepted 20 min ago: past RE_BODY_AFTER_MS so recovery is genuinely
        // eligible. Seeded as "just now", the 10-minute gate skips it and the
        // recovery checks below pass vacuously.
        ...(opts.awaiting
          ? { serverId: 500 + i, acceptedAt: Date.now() - 20 * 60_000, ciphertext: 'CT:old' }
          : {}),
      },
    });
  }
}

try {
  console.log('offline, then reconnect');
  reset(); await setOnline(false);
  seed(3);
  const t0 = Date.now();
  await Q.flush();
  check('flush() returns promptly while offline', Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  check('queued messages are retained, not dropped', queued() === 3, `${queued()}/3`);
  await setOnline(true);
  await Q.flush();
  check('all three send once back online', posts() >= 3, `${posts()} POSTs`);
  check('the queue drains', queued() === 0, `${queued()} left`);

  console.log('inert rows must not starve real sends');
  reset(); await setOnline(true);
  seed(250, { awaiting: true });          // oldest → head of the page
  seed(3, { base: 1000 });                // sendable, past PAGE=200
  for (let i = 0; i < 6 && queued() > 0; i++) await Q.flush();
  check('sends behind a full page of inert rows are reached',
    queued() === 0, `${queued()} still queued after 6 flushes — starved`);
  check('and it did not spin', H.listCalls < 40, `${H.listCalls} queue reads`);

  console.log('accepted rows stay inert');
  reset(); await setOnline(true);
  seed(5, { awaiting: true });
  await Q.flush();
  check('no accepted row is ever re-POSTed', posts() === 0, `${posts()} duplicate sends`);

  console.log('recovery must never block sending');
  reset(); await setOnline(false);
  seed(40, { awaiting: true });
  seed(2, { base: 1000 });
  await Q.flush();
  check('no recovery PUTs are issued while offline', puts() === 0, `${puts()} doomed PUTs`);
  check('queued messages survive', queued() === 2, `${queued()}/2`);

  reset(); await setOnline(true); H.hangMethod = 'PUT';
  seed(40, { awaiting: true });
  seed(2, { base: 1000 });
  void Q.flush();                          // deliberately not awaited
  await new Promise(r => setTimeout(r, 1500));
  check('sends go out even while recovery hangs', posts() === 2, `${posts()}/2 POSTed`);
  check('the queue drains anyway', queued() === 0, `${queued()} left`);

  // The mutex matters as much as the sends: held, every later flush early-returns
  // and the outbox is dead for the rest of the process.
  H.hangMethod = null;
  reset(); seed(1, { base: 2000 });
  await Q.flush();
  check('the flush mutex was released, so later flushes still work',
    posts() === 1, `${posts()}/1 — flush() is wedged`);

  // ── cross-file wiring the harness stubs out, so assert it directly ──────
  console.log('boot wiring');
  // app/_layout.tsx plus the boot sequence it calls (scripts/rootLayoutSources).
  const LAYOUT = readRootLayout();
  check('the root boot starts the TEXT outbox, not just the media one',
    /initQueue\(\)/.test(LAYOUT),
    'no boot drain, no reconnect flush, no periodic tick until a chat is opened — and `online` stays stale-true');
  const API = readFileSync(join(HERE, 'api.ts'), 'utf8');
  check('api() gives fetch a deadline',
    /AbortController|AbortSignal\.timeout/.test(API),
    'a connected-but-dead link never settles and wedges the flush mutex');
  check('uploads are exempt from that deadline', /instanceof FormData/.test(API));
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
