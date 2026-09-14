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
export async function api(path) { return H().api(path); }
export async function getGlobalSyncCursor() { return H().cursor; }
export async function noteGlobalSyncCursor(id) {
  // Monotonic, exactly like the real one: a cursor must never go backwards.
  if (id > H().cursor) H().cursor = id;
  H().cursorWrites.push(id);
}
export async function cacheMessages(chatId, msgs) { H().cached.push(...msgs.map(m => m.id)); }
export async function getCachedMessagesByIds(chatId, ids) {
  return ids.filter(i => H().local.has(i)).map(i => ({ id: i, content: H().local.get(i) }));
}
export async function getMeta(k) { return H().meta.get(k) ?? null; }
export async function setMeta(k, v) { H().meta.set(k, v); }
export function metric(name, n = 1) { H().metrics[name] = (H().metrics[name] ?? 0) + n; }
export async function hydrateMessages(chatId, msgs) {
  H().decrypted.push(...msgs.map(m => m.id));
  await new Promise(r => setTimeout(r, H().decryptMs));   // history decrypt is slow
  return msgs.map(m => ({ ...m, content: 'plain-' + m.id }));
}
export function looksEncrypted(s) { return typeof s === 'string' && s.startsWith('{"v":"dr1"'); }
// Both are called as fire-and-forget promises (\`.catch(() => {})\`), so they
// MUST return one — a plain undefined throws a TypeError that the loop's outer
// catch swallows, silently stopping the sync before the cursor advances.
export async function markDeliveredDurable() {}
export async function notifyBatch() {}
export function onConnectionState() { return () => {}; }
`);

const REWRITES: [RegExp, string][] = [
  [/^import \{ api \} from '\.\/api';$/m, `import { api } from './stubs.js';`],
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
  [/^import \{ onConnectionState \} from '\.\/socket';$/m, `import { onConnectionState } from './stubs.js';`],
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
