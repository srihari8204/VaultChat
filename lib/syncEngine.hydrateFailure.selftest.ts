// lib/syncEngine.hydrateFailure.selftest.ts
// run: npx tsx lib/syncEngine.hydrateFailure.selftest.ts
//
// ONE UNDECRYPTABLE MESSAGE MUST NOT STALL CATCH-UP FOR THE WHOLE ACCOUNT.
//
// Reproduced from production on 2026-09-15: a chat sat at
// last_delivered_message_id = 6 while messages 7 and 8 were retained, not
// deleted, unexpired and still held their ciphertext. A synthetic replay of
// that state through the real Go handler proved the SERVER offers both rows on
// the cold (since=0) and incremental paths, so the loss was on the client.
//
// The mechanism: hydrateMessages is `try { … } finally { … }` with NO catch, so
// a decrypt that throws propagates out of applyByChat — past cacheMessages,
// which then never runs — into catchUp's "offline / transient" catch. The whole
// page is discarded: nothing stored, no delivery ack, cursor unmoved. The same
// page is re-fetched on the next reconnect and fails identically, forever.
//
// The fix keeps the RAW envelopes when hydration throws. That is "stored", not
// "displayable": the ciphertext is persisted, the bubble shows its locked state,
// and the bounded retry in app/chat.tsx can open it later. Storing it is also
// what makes the delivery ack honest — the device really does hold the message.
//
// Uses the SHIPPING syncEngine.ts with only its import block rewritten, the same
// pattern as syncEngine.delta.selftest.ts.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name: string, ok: boolean, why = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${why ? '\n      ' + why : ''}`); }
}

/** Build the real module with a hydrate that throws on one specific id. */
async function load(throwOnId: number) {
  const WORK = mkdtempSync(join(tmpdir(), 'vc-hyd-'));
  writeFileSync(join(WORK, 'stubs.js'), `
export const cached = [];
export const metrics = {};
let cursor = 0;

export async function getAccessToken() { return 'test-owner'; }
export function tokenSubject(token) { return token; }
export async function api(path) {
  // One page: ids 6,7,8 in one chat, then done.
  if (String(path).includes('/chats/delta')) {
    if (cursor > 0) return { messages: [], nextSince: cursor, more: false, serverTime: 'T' };
    cursor = 8;
    return {
      messages: [
        { id: 6, chatId: 'c1', content: 'ok-6', createdAt: 'T' },
        { id: 7, chatId: 'c1', content: 'BAD',  createdAt: 'T' },
        { id: 8, chatId: 'c1', content: 'ok-8', createdAt: 'T' },
      ],
      mutations: [], nextSince: 8, more: false, serverTime: 'T',
    };
  }
  return {};
}
export async function getGlobalSyncCursor() { return 0; }
export async function noteGlobalSyncCursor() {}
export async function cacheMessages(chatId, msgs) { for (const m of msgs) cached.push(m); }
export async function getCachedMessagesByIds() { return []; }
export async function getMeta() { return null; }
export async function setMeta() {}
export function metric(n, v = 1) { metrics[n] = (metrics[n] || 0) + v; }
export function looksEncrypted() { return false; }
export async function hydrateMessages(chatId, msgs) {
  // The real one is try/finally with no catch: a throw escapes the whole batch.
  if (msgs.some((m) => Number(m.id) === ${throwOnId})) {
    throw new Error('aes/gcm: invalid ghash tag');
  }
  return msgs;
}
export async function markDeliveredDurable() {}
export async function notifyBatch() {}
export function onConnectionState() { return () => {}; }
export function addPersistentListener() { return () => {}; }
`);
  const REWRITES: [RegExp, string][] = [
    [/^import \{ api, getAccessToken \} from '\.\/api';$/m, `import { api, getAccessToken } from './stubs.js';`],
  [/^import \{ tokenSubject \} from '\.\/tokenIdentity';$/m, `import { tokenSubject } from './stubs.js';`],
    [/^import \{ getGlobalSyncCursor, noteGlobalSyncCursor, cacheMessages, getCachedMessagesByIds, getMeta, setMeta \} from '\.\/localDb';$/m,
     `import { getGlobalSyncCursor, noteGlobalSyncCursor, cacheMessages, getCachedMessagesByIds, getMeta, setMeta } from './stubs.js';`],
    [/^import \{ metric \} from '\.\/syncMetrics';$/m, `import { metric } from './stubs.js';`],
    [/^import \{ hydrateMessages, looksEncrypted, type Message \} from '\.\/chatService';$/m,
     `import { hydrateMessages, looksEncrypted } from './stubs.js';`],
    [/^import \{ normalizeMsgIds \} from '\.\/msgIds';$/m, `import { normalizeMsgIds } from './msgIds.ts';`],
    [/^import \{ markDeliveredDurable \} from '\.\/receipts';$/m, `import { markDeliveredDurable } from './stubs.js';`],
    [/^import \{ notifyBatch \} from '\.\/messageNotifications';$/m, `import { notifyBatch } from './stubs.js';`],
    [/^import \{ addPersistentListener, onConnectionState \} from '\.\/socket';$/m, `import { addPersistentListener, onConnectionState } from './stubs.js';`],
  ];
  let src = readFileSync(join(HERE, 'syncEngine.ts'), 'utf8');
  for (const [re, to] of REWRITES) {
    if (!re.test(src)) throw new Error(`import block changed, cannot rewrite ${re}`);
    src = src.replace(re, to);
  }
  src = src.replace(/\bMessage\b(?=\s*[&>\]])/g, 'any').replace(/: \(Message & \{ chatId: string \}\)\[\]/g, ': any[]');
  writeFileSync(join(WORK, 'msgIds.ts'), readFileSync(join(HERE, 'msgIds.ts'), 'utf8'));
  const file = join(WORK, 'syncEngine.ts');
  writeFileSync(file, src);
  const mod: any = await import(pathToFileURL(file).href);
  const stubs: any = await import(pathToFileURL(join(WORK, 'stubs.js')).href);
  return { mod, stubs, cleanup: () => rmSync(WORK, { recursive: true, force: true }) };
}

(async () => {
  console.log('\nVaultChat sync: one undecryptable message must not stall catch-up\n' +
              '────────────────────────────────────────────────────────────────');

  // Message 7 cannot be opened — exactly the production shape.
  const { mod, stubs, cleanup } = await load(7);
  const applied = await mod.catchUp();

  check('the catch-up completed instead of aborting the page',
    applied > 0,
    `catchUp() applied ${applied} rows. A thrown hydrate used to escape into the ` +
    `"offline / transient" catch and drop everything.`);

  const ids = stubs.cached.map((m: any) => Number(m.id)).sort((a: number, b: number) => a - b);
  check('every row in the page was persisted, including the readable ones',
    ids.includes(6) && ids.includes(8),
    `cached ids = ${JSON.stringify(ids)}. Before the fix this was [] — messages 6 ` +
    `and 8 were collateral damage of message 7 being unreadable.`);

  check('the UNREADABLE message is stored too, as a raw envelope',
    ids.includes(7),
    `cached ids = ${JSON.stringify(ids)}. It must be stored so the delivery ack is ` +
    `honest and the bounded retry can open it later — stored is not displayable.`);

  check('the failure is counted, not silent',
    (stubs.metrics['delta.hydrate_failed'] || 0) > 0,
    `metrics = ${JSON.stringify(stubs.metrics)}`);

  cleanup();

  // Control: with nothing throwing, behaviour is unchanged.
  const ok = await load(-1);
  await ok.mod.catchUp();
  const okIds = ok.stubs.cached.map((m: any) => Number(m.id)).sort((a: number, b: number) => a - b);
  check('the healthy path is unchanged (all three rows, no failure metric)',
    okIds.length === 3 && !(ok.stubs.metrics['delta.hydrate_failed'] > 0),
    `cached = ${JSON.stringify(okIds)}, metrics = ${JSON.stringify(ok.stubs.metrics)}`);
  ok.cleanup();

  console.log('────────────────────────────────────────────────────────────────');
  if (failures) { console.error(`${failures} FAILED\n`); process.exit(1); }
  console.log('ALL PASSED ✓\n');
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
