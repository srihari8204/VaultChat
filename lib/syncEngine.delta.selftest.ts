// lib/syncEngine.delta.selftest.ts — run: npx tsx lib/syncEngine.delta.selftest.ts
//
// Executes the REAL catchUp() from lib/syncEngine.ts.
//
// The claims being tested are all invisible on screen — a cached page and a
// downloaded page render identically, and the only difference is whether a
// request went out. So the requests are counted.
//
// Covers, from the acceptance list:
//   E  reconnect syncs forward from the persisted cursor, never from 0
//   F  a message the device already holds is not re-decrypted
//   §6 the stored cursor is never rewound by a reconnect
//   §18 a fresh database cold-syncs once, then switches to delta permanently
//   §21 a slow bulk sync does not block a live message
//
// syncEngine.ts cannot be imported under Node (react-native reaches it through
// chatService/socket), so its IMPORT BLOCK ONLY is rewritten and the body runs
// verbatim, regenerated every run so it cannot drift. Same approach as
// messageQueue.flush.selftest.ts.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateDH, ratchetInitAlice, ratchetInitBob, ratchetEncrypt, ratchetDecrypt } from '../services/crypto/e2ee';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

const WORK = join(tmpdir(), `vc-delta-selftest-${process.pid}`);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');

writeFileSync(join(WORK, 'stubs.js'), `
const H = () => globalThis.__D;
export async function getAccessToken() { return 'test-owner'; }
export function tokenSubject(token) { return token; }
export async function api(path) { return H().api(path); }
export async function getGlobalSyncCursor() { return H().cursor; }
export async function noteGlobalSyncCursor(id) {
  if (H().failCursor) throw new Error('cursor write failed');
  // Monotonic, exactly like the real one: a cursor must never go backwards.
  if (id > H().cursor) H().cursor = id;
  H().cursorWrites.push(id);
}
export async function cacheMessages(chatId, msgs) { if (H().failCache) throw new Error('cache write failed'); H().cached.push(...msgs.map(m => m.id)); }
export async function getCachedMessagesByIds(chatId, ids) {
  return ids.filter(i => H().local.has(i)).map(i => ({ id: i, content: H().local.get(i) }));
}
export async function getMeta(k) { return H().meta.get(k) ?? null; }
export async function setMeta(k, v) { H().meta.set(k, v); }
export function metric(name, n = 1) { H().metrics[name] = (H().metrics[name] ?? 0) + n; }
export async function hydrateMessages(chatId, msgs) {
  if (H().hydrate) return H().hydrate(msgs);
  H().decrypted.push(...msgs.map(m => m.id));
  await new Promise(r => setTimeout(r, H().decryptMs));   // history decrypt is slow
  return msgs.map(m => ({ ...m, content: 'plain-' + m.id }));
}
export function looksEncrypted(s) { return typeof s === 'string' && s.startsWith('{"v":"dr1"'); }
// Both are called as fire-and-forget promises (\`.catch(() => {})\`), so they
// MUST return one — a plain undefined throws a TypeError that the loop's outer
// catch swallows, silently stopping the sync before the cursor advances.
export async function markDeliveredDurable(chatId, id) { H().delivered?.push(id); }
export async function notifyBatch() {}
export function onConnectionState() { return () => {}; }
export function addPersistentListener(event, handler) {
  H().persistent[event] = handler;
  return () => { delete H().persistent[event]; };
}
`);

const REWRITES: [RegExp, string][] = [
  [/^import \{ api, getAccessToken \} from '\.\/api';$/m, `import { api, getAccessToken } from './stubs.js';`],
  [/^import \{ tokenSubject \} from '\.\/tokenIdentity';$/m, `import { tokenSubject } from './stubs.js';`],
  [/^import \{ getGlobalSyncCursor, noteGlobalSyncCursor, cacheMessages, getCachedMessagesByIds, getMeta, setMeta \} from '\.\/localDb';$/m,
   `import { getGlobalSyncCursor, noteGlobalSyncCursor, cacheMessages, getCachedMessagesByIds, getMeta, setMeta } from './stubs.js';`],
  [/^import \{ metric \} from '\.\/syncMetrics';$/m, `import { metric } from './stubs.js';`],
  [/^import \{ hydrateMessages, looksEncrypted, type Message \} from '\.\/chatService';$/m,
   `import { hydrateMessages, looksEncrypted } from './stubs.js';`],
  // msgIds stays REAL. It has no imports, and coercing the delta page's wire
  // ids is the step that decides whether cacheMessages keeps the row at all —
  // stubbing it would hide the bug this suite exists to catch.
  [/^import \{ normalizeMsgIds \} from '\.\/msgIds';$/m,
   `import { normalizeMsgIds } from './msgIds.ts';`],
  [/^import \{ markDeliveredDurable \} from '\.\/receipts';$/m, `import { markDeliveredDurable } from './stubs.js';`],
  [/^import \{ notifyBatch \} from '\.\/messageNotifications';$/m, `import { notifyBatch } from './stubs.js';`],
  [/^import \{ addPersistentListener, onConnectionState \} from '\.\/socket';$/m, `import { addPersistentListener, onConnectionState } from './stubs.js';`],
];

let src = readFileSync(join(HERE, 'syncEngine.ts'), 'utf8');
for (const [re, to] of REWRITES) {
  if (!re.test(src)) { console.log(`  ✗ import block changed, could not rewrite ${re}`); failures++; }
  src = src.replace(re, to);
}
src = src.replace(/\bMessage\b(?=\s*[&>\]])/g, 'any').replace(/: \(Message & \{ chatId: string \}\)\[\]/g, ': any[]');
writeFileSync(join(WORK, 'msgIds.ts'), readFileSync(join(HERE, 'msgIds.ts'), 'utf8'));

const stray = [...src.matchAll(/^import .*from '([^']+)';$/gm)].map(m => m[1])
  .filter(p => p !== './stubs.js' && p !== './msgIds.ts');
check('every syncEngine import is accounted for', stray.length === 0, `unstubbed: ${stray.join(', ')}`);
writeFileSync(join(WORK, 'sync.ts'), src);

const D: any = {
  cursor: 0, cursorWrites: [] as number[], meta: new Map(), metrics: {} as any,
  local: new Map<number, string>(), cached: [] as number[], decrypted: [] as number[],
  requests: [] as string[], decryptMs: 0, server: [] as any[],
  persistent: {} as Record<string, (data: any) => void>,
  api: async (path: string) => {
    D.requests.push(path);
    const since = Number(/since=(\d+)/.exec(path)?.[1] ?? 0);
    const rows = D.server.filter((m: any) => m.id > since).slice(0, 200);
    const nextSince = rows.length ? rows[rows.length - 1].id : since;
    return { messages: rows, nextSince, more: false, mutations: [], serverTime: '2026-01-01T00:00:00.000Z' };
  },
};
(globalThis as any).__D = D;

const reset = () => {
  D.requests.length = 0; D.cached.length = 0; D.decrypted.length = 0;
  D.cursorWrites.length = 0; D.metrics = {};
};
const sinceOf = (p: string) => Number(/since=(\d+)/.exec(p)?.[1] ?? -1);

async function main() {
  const S: any = await import(pathToFileURL(join(WORK, 'sync.ts')).href);

  // 100 messages exist on the server.
  D.server = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, chatId: 'c1', content: '{"v":"dr1"}' }));

  // ── P. fresh database → exactly one cold sync, then delta forever ──────
  console.log('cold sync happens once, then delta takes over');
  reset(); D.cursor = 0;
  await S.catchUp();
  check('a fresh DB cold-syncs from 0', sinceOf(D.requests[0]) === 0, D.requests[0]);
  check('it stored what it received', D.cached.length === 100, `${D.cached.length}`);
  check('and advanced the cursor', D.cursor === 100, `${D.cursor}`);

  // Everything is now local and readable.
  for (const id of D.cached) D.local.set(id, 'plain-' + id);

  // ── E/F. reconnect → delta only, from the persisted cursor ────────────
  console.log('reconnect syncs forward only');
  reset();
  await S.catchUp();
  check('reconnect never asks from 0', D.requests.every(p => sinceOf(p) !== 0), D.requests.join(' '));
  check('it resumes at the persisted cursor minus the lookback',
    sinceOf(D.requests[0]) === 75, `since=${sinceOf(D.requests[0])} (cursor 100, LOOKBACK 25)`);
  check('no full history re-download', D.requests.length <= 2, `${D.requests.length} requests`);
  check('rows the device already holds are NOT re-decrypted',
    D.decrypted.length === 0, `${D.decrypted.length} re-decrypts`);
  check('and they are counted as duplicates', (D.metrics['delta.duplicates'] ?? 0) === 25,
    `${D.metrics['delta.duplicates']}`);
  check('the stored cursor was not rewound', D.cursor === 100, `${D.cursor}`);

  // ── E. many reconnects must stay cheap and monotonic ──────────────────
  reset();
  for (let i = 0; i < 5; i++) await S.catchUp();
  check('5 reconnects re-decrypt nothing', D.decrypted.length === 0, `${D.decrypted.length}`);
  check('the cursor never goes backwards',
    D.cursorWrites.every((v: number) => v >= 100), D.cursorWrites.join(','));

  // ── new traffic still arrives ─────────────────────────────────────────
  console.log('genuinely new messages still sync');
  reset();
  D.server.push({ id: 101, chatId: 'c1', content: '{"v":"dr1"}' });
  await S.catchUp();
  check('the new message is fetched and decrypted', D.decrypted.includes(101));
  check('only the new one is decrypted', D.decrypted.length === 1, `${D.decrypted.join(',')}`);
  check('cursor advanced to it', D.cursor === 101, `${D.cursor}`);
  D.local.set(101, 'plain-101');

  // ── Live socket delivery while no ChatScreen is mounted ───────────────
  console.log('socket delivery wakes the global delta sync');
  reset();
  D.server.push({ id: 102, chatId: 'c1', content: '{"v":"dr1"}' });
  S.initSync();
  D.persistent.new_message?.({ id: '102', chatId: 'c1' });
  await new Promise(r => setTimeout(r, 350));
  await S.catchUp(); // Join the debounced drain before resetting shared fixture state.
  check('a background chat-list socket event fetches the new message', D.decrypted.includes(102));
  check('the listener also arms mutation events', typeof D.persistent.message_deleted === 'function' && typeof D.persistent.message_edited === 'function');
  D.local.set(102, 'plain-102');

  // ── Q. a slow bulk sync must not block a live message ─────────────────
  console.log('bulk sync must not block live traffic');
  reset();
  D.decryptMs = 40;                                   // 40ms per hydrate batch
  D.server.push(...Array.from({ length: 50 }, (_, i) => ({ id: 200 + i, chatId: 'c2', content: '{"v":"dr1"}' })));
  const started = Date.now();
  const bulk = S.catchUp();
  // While that runs, the live path (a plain await, as the socket handler does)
  // must still get a turn on the event loop promptly.
  let liveLatency = -1;
  const live = (async () => {
    const t = Date.now();
    await new Promise(r => setTimeout(r, 0));
    liveLatency = Date.now() - t;
  })();
  await Promise.all([bulk, live]);
  check('a live handler is not starved by a running bulk sync',
    liveLatency >= 0 && liveLatency < 250, `live turn waited ${liveLatency}ms`);
  check('the bulk sync still completed', D.cached.length >= 50,
    `${D.cached.length} cached in ${Date.now() - started}ms`);
  D.decryptMs = 0;

  console.log('push during a stale response waits for one fresh drain');
  reset();
  const originalApi = D.api;
  let releaseSnapshot!: () => void;
  let snapshotReady!: () => void;
  const ready = new Promise<void>(r => { snapshotReady = r; });
  const gate = new Promise<void>(r => { releaseSnapshot = r; });
  let first = true;
  D.api = async (path: string) => {
    const response = await originalApi(path);
    if (first) {
      first = false;
      snapshotReady();
      await gate;
    }
    return response;
  };
  const staleRun = S.catchUp();
  await ready;
  check('ordinary cache reader joins the existing drain', S.catchUp() === staleRun);
  D.server.push({ id: 999, chatId: 'c1', content: '{"v":"dr1"}' });
  const pushRun = S.requestCatchUp();
  check('push joins a shared promise that includes its rerun', pushRun === staleRun);
  // Multiple notifications of the same snapshot collapse to one extra pass.
  S.requestCatchUp();
  S.requestCatchUp();
  releaseSnapshot();
  await pushRun;
  check('new post-snapshot message persisted before push waiter resolves', D.cached.includes(999));
  check('burst causes exactly one follow-up request', D.requests.length === 2, String(D.requests.length));
  D.api = originalApi;

  reset();
  await Promise.all([S.catchUp(), S.catchUp(), S.catchUp()]);
  check('ordinary readers do not schedule dirty reruns', D.requests.length === 1, String(D.requests.length));

  reset();
  first = true;
  let releaseStrict!: () => void;
  let strictSnapshot!: () => void;
  const strictReady = new Promise<void>(resolve => { strictSnapshot = resolve; });
  const strictGate = new Promise<void>(resolve => { releaseStrict = resolve; });
  D.api = async (path: string) => {
    const response = await originalApi(path);
    if (first) { first = false; strictSnapshot(); await strictGate; }
    return response;
  };
  const ordinary = S.catchUp();
  await strictReady;
  D.server.push({ id: 1000, chatId: 'c1', content: '{"v":"dr1"}' });
  const strict = S.resyncRequired();
  releaseStrict();
  await Promise.all([ordinary, strict]);
  check('protocol resync drains a fresh snapshot before resolving', D.cached.includes(1000) && D.requests.length === 2);

  D.api = async () => { throw new Error('HTTP unavailable'); };
  const failedStrict = S.resyncRequired();
  const bestEffort = S.catchUp();
  check('strict HTTP failure rejects while ordinary reader returns count',
    (await Promise.allSettled([failedStrict]))[0].status === 'rejected' && await bestEffort === 0);
  D.api = originalApi;
  for (const flag of ['failCache', 'failCursor']) {
    D[flag] = true;
    const result = await Promise.allSettled([S.resyncRequired()]);
    check('protocol resync rejects ' + flag, result[0].status === 'rejected');
    D[flag] = false;
  }
  check('a later successful resync has no stale failure latch',
    (await Promise.allSettled([S.resyncRequired()]))[0].status === 'fulfilled');

  console.log('an exact 100,000-message boundary continues after yielding');
  reset(); D.cursor = 0; D.local.clear(); D.meta.clear();
  const historyHead = 100_000;
  D.api = async (path: string) => {
    D.requests.push(path);
    const since = sinceOf(path);
    const count = Math.min(200, Math.max(0, historyHead - since));
    const messages = Array.from({ length: count }, (_, i) => ({
      id: since + i + 1, chatId: 'large', content: '{"v":"dr1"}',
    }));
    return {
      messages,
      nextSince: messages.at(-1)?.id ?? since,
      // Older servers conservatively return true for every full page, so an
      // exact multiple needs one fresh bounded pass to prove completion.
      more: messages.length === 200,
      mutations: [], serverTime: '2026-01-01T00:00:00.000Z',
    };
  };
  const boundary = await Promise.allSettled([S.resyncRequired()]);
  check('the 500-page boundary completes instead of rejecting', boundary[0].status === 'fulfilled');
  check('all 100,000 messages are durable before continuation',
    D.cursor === historyHead && D.cached.includes(historyHead), `cursor=${D.cursor}`);
  check('the cap yields into exactly one continuation pass',
    D.metrics['delta.page_cap_yields'] === 1 && D.requests.length === 501,
    `yields=${D.metrics['delta.page_cap_yields'] ?? 0}, requests=${D.requests.length}`);

  reset(); D.cursor = 0;
  D.api = async (path: string) => {
    D.requests.push(path);
    return { messages: [{ id: 1, chatId: 'stalled', content: '{"v":"dr1"}' }], nextSince: 0, more: true, mutations: [] };
  };
  check('a stalled server cursor fails once instead of continuing forever',
    (await Promise.allSettled([S.resyncRequired()]))[0].status === 'rejected' && D.requests.length === 1,
    `${D.requests.length} requests`);
  D.api = originalApi;

  reset(); D.cursor = 0; D.local.clear(); D.delivered = [];
  const secret = new Uint8Array(32).fill(7), signedKey = generateDH();
  const sender = ratchetInitAlice(secret, signedKey.pub);
  const envelopes = Array.from({ length: 1103 }, () => ratchetEncrypt(sender, new Uint8Array([42])));
  const receiver = ratchetInitBob(secret, signedKey);
  const decryptedOrder: number[] = [];
  D.hydrate = async (rows: any[]) => {
    // Shipping hydrateMessages consumes newest-first inputs backwards.
    for (let i = rows.length - 1; i >= 0; i--) {
      ratchetDecrypt(receiver, envelopes[rows[i].id]);
      decryptedOrder.push(rows[i].id);
    }
    return rows.map(m => ({ ...m, content: 'plain-' + m.id }));
  };
  D.server = Array.from({ length: 200 }, (_, i) => ({ id: 900 + i, chatId: 'ordered', content: '{"v":"dr1"}' }));
  await S.resyncRequired();
  check('ASC delta decrypts all 200 messages oldest-first within MAX_SKIP',
    decryptedOrder.length === 200 && decryptedOrder.every((id, i) => id === 900 + i));
  check('sorting hydration leaves delivery high-water and response order intact',
    D.delivered.at(-1) === 1099 && D.server.every((m: any, i: number) => m.id === 900 + i));
  const mutations = [1102, 1100, 1101].map(id => ({ id, chatId: 'ordered', content: '{"v":"dr1"}' }));
  D.api = async () => ({ messages: [], mutations, nextSince: 1099, more: false, serverTime: '2026-01-01T00:00:00.000Z' });
  await S.resyncRequired();
  check('timestamp-ordered mutations hydrate by ascending message id',
    decryptedOrder.slice(-3).join(',') === '1100,1101,1102' && mutations.map(m => m.id).join(',') === '1102,1100,1101');
  D.hydrate = null; D.api = originalApi;
}

main().then(() => {
  rmSync(WORK, { recursive: true, force: true });
  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.log('  ✗ harness threw:', err?.message ?? err);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
