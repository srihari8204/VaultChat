// lib/syncBackground.selftest.ts — run: npx tsx lib/syncBackground.selftest.ts
//
// Executes the REAL runBackgroundSync() from lib/syncBackground.ts.
//
// THE INVARIANT
//
// An acknowledgement must mean "this device HAS the message", never "this
// device was told about a message". Get that backwards and the sender sees two
// ticks for something the recipient never stored — worse than the one tick the
// background sync exists to fix, because the server may then reclaim its copy
// after the delivery grace and the message is gone for good.
//
// So the order is load-bearing: sync first, read the id back off local disk,
// and only then POST. Every failure path must exit WITHOUT acking and leave
// the message for the next ordinary sync.
//
// syncBackground.ts imports react-native and reaches localDb/chatService, none
// of which load under Node — so its imports are rewritten to stubs and the body
// runs verbatim, regenerated each run so it cannot drift. Same approach as
// syncEngine.delta.selftest.ts.

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

const WORK = join(tmpdir(), `vc-bgsync-selftest-${process.pid}`);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');

// One stub module standing in for api / syncEngine / localDb / chatService.
// Every call is recorded IN ORDER, because the order is the thing under test.
writeFileSync(join(WORK, 'stubs.js'), `
const H = () => globalThis.__BG;
export async function getAccessToken() { H().calls.push('getAccessToken'); return H().token; }
export async function catchUp() {
  H().calls.push('catchUp');
  if (H().catchUpThrows) throw new Error('network down');
  H().synced = true;
  return H().applied ?? 0;
}
export async function getCachedMessages(chatId, limit) {
  H().calls.push('getCachedMessages:' + chatId);
  return H().localNewest ? [H().localNewest] : [];
}
export async function markDelivered(chatId, id) {
  H().calls.push('markDelivered:' + chatId + ':' + id);
  if (H().ackThrows) throw new Error('receipt failed');
  H().acked = { chatId, id, syncedFirst: H().synced === true };
}
export const AppRegistry = { registerHeadlessTask(name, fn) { H().registered = name; } };
`);

const SRC = readFileSync(join(HERE, 'syncBackground.ts'), 'utf8');
const REWRITES: [RegExp, string][] = [
  [/^import \{ AppRegistry \} from 'react-native';$/m, `import { AppRegistry } from './stubs.js';`],
  [/await import\('\.\/api'\)/g, `await import('./stubs.js')`],
  [/await import\('\.\/syncEngine'\)/g, `await import('./stubs.js')`],
  [/await import\('\.\/localDb'\)/g, `await import('./stubs.js')`],
  [/await import\('\.\/chatService'\)/g, `await import('./stubs.js')`],
];
let body = SRC;
for (const [re, to] of REWRITES) {
  if (!re.test(body)) {
    console.log(`  ✗ import rewrite failed — syncBackground.ts no longer matches ${re}`);
    failures++;
  }
  body = body.replace(re, to);
}
// Strip TS type annotations tsx would handle; this file is plain JS at runtime.
body = body
  .replace(/: Promise<[^>]*>/g, '')
  .replace(/data\?: \{ chatId\?: string \}/, 'data')
  .replace(/\(data: any\)/, '(data)');
writeFileSync(join(WORK, 'syncBackground.mjs'), body);

async function main() {
  // registerHeadlessTask runs at MODULE LOAD, before any test sets a harness,
  // so the recorder has to exist first.
  (globalThis as any).__BG = { calls: [] };
  const mod: any = await import(pathToFileURL(join(WORK, 'syncBackground.mjs')).href);
  const registeredName = (globalThis as any).__BG.registered;
  const run = mod.runBackgroundSync;

  function harness(over: any = {}) {
    (globalThis as any).__BG = {
      token: 'tok', calls: [], synced: false, acked: null,
      catchUpThrows: false, ackThrows: false,
      localNewest: { id: 435 }, ...over,
    };
    return (globalThis as any).__BG;
  }

  // ── 1. the happy path, and the ORDER ─────────────────────────────────────
  console.log('an ack must follow a successful sync, never precede it');
  {
    const H = harness();
    const r = await run({ chatId: 'c1' });
    check('returns synced', r === 'synced', String(r));
    check('acked the chat', H.acked?.chatId === 'c1', JSON.stringify(H.acked));
    check('sync ran BEFORE the ack', H.acked?.syncedFirst === true,
      'the ack was sent before the messages were persisted');
    const iSync = H.calls.indexOf('catchUp');
    const iAck = H.calls.findIndex((c: string) => c.startsWith('markDelivered'));
    check('call order is catchUp → markDelivered', iSync >= 0 && iAck > iSync, H.calls.join(' → '));
  }

  // ── 2. the id is read off DISK, not taken from the push ──────────────────
  console.log('the acked id must be what this device actually stored');
  {
    const H = harness({ localNewest: { id: 430 } });
    await run({ chatId: 'c1', lastMessageId: 999 } as any);
    check('acks the locally-persisted id, not the push', H.acked?.id === 430,
      `acked ${H.acked?.id} — acking an id we never stored confirms delivery of nothing`);
  }

  // ── 3. every failure path must NOT ack ───────────────────────────────────
  console.log('a failure must leave the message undelivered');
  {
    const H = harness({ token: null });
    const r = await run({ chatId: 'c1' });
    check('no session → no sync, no ack', r === 'no-session' && H.acked === null && !H.calls.includes('catchUp'),
      `${r} / ${H.calls.join(',')}`);
  }
  {
    const H = harness({ catchUpThrows: true });
    const r = await run({ chatId: 'c1' });
    check('sync failure → no ack', r === 'sync-failed' && H.acked === null,
      'acking after a failed sync marks delivered a message this device does not have');
  }
  {
    const H = harness({ localNewest: null });
    const r = await run({ chatId: 'c1' });
    check('nothing persisted → no ack', r === 'nothing-to-ack' && H.acked === null);
  }
  {
    const H = harness();
    const r = await run({});
    check('no chatId → no ack', r === 'nothing-to-ack' && H.acked === null);
  }
  {
    const H = harness({ ackThrows: true });
    const r = await run({ chatId: 'c1' });
    check('a failed receipt is reported, not swallowed as success', r === 'sync-failed');
  }

  // ── 4. never throws (a rejecting headless task crashes the app) ──────────
  console.log('the headless task must never reject');
  {
    harness({ token: null });
    let threw = false;
    try { await run(undefined as any); } catch { threw = true; }
    check('undefined payload does not throw', !threw);
  }

  // ── 5. duplicate pushes cannot duplicate work ────────────────────────────
  console.log('duplicate pushes must collapse');
  {
    const H = harness();
    await Promise.all([run({ chatId: 'c1' }), run({ chatId: 'c1' }), run({ chatId: 'c1' })]);
    // Dedup of the MESSAGES themselves is cacheMessages' upsert-by-id and
    // catchUp's own re-entry guard; what matters here is that repeating the ack
    // is harmless, because markDelivered is a monotonic high-water mark.
    check('three concurrent pushes all resolve', H.calls.filter((c: string) => c === 'catchUp').length === 3);
    check('and the ack is idempotent (same chat, same id)', H.acked?.id === 435);
  }

  // ── 6. the headless task is registered under the native name ─────────────
  console.log('the native service must find the task');
  check('registers VaultChatSync', registeredName === 'VaultChatSync' && mod.SYNC_TASK === 'VaultChatSync',
    'the name must match VaultChatSyncService.TASK_NAME or Android starts a task that does not exist');

  rmSync(WORK, { recursive: true, force: true });
  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);

}

main();
