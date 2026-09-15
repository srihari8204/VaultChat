// lib/outboxRecovery.selftest.ts — run: npx tsx lib/outboxRecovery.selftest.ts
//
// Two permanent-failure paths that used to be dead ends, executed for real:
//
//  1. lib/receipts.ts — the read/delivered pointers are MONOTONIC and PERSISTED.
//     The server now answers 400 for a cursor that is not a message in that
//     chat. A bare `catch {}` made that indistinguishable from being offline, so
//     one foreign id (higher than any real id in the chat, since message ids are
//     one global BIGSERIAL) wedged the chat FOREVER, across restarts: no genuine
//     read could ever raise the pointer past it, the unread badge never cleared,
//     and read receipts never reached the peer.
//
//  2. lib/messageQueue.ts — a permanently-rejected message was marked FAILED and
//     then DELETED, destroying the only copy of the user's plaintext. The red
//     bubble did not survive a remount, and Retry read a row that no longer
//     existed and returned silently: the user tapped it and nothing happened.
//
// Neither module imports under Node (react-native, expo-crypto, AsyncStorage),
// so the IMPORT BLOCK ONLY is rewritten against stubs and the body is used
// verbatim — regenerated every run, so it cannot drift from what ships. Same
// pattern as lib/messageQueue.flush.selftest.ts.
//
// app/chat.tsx cannot load under Node at all (React Native components, expo
// router). The chat-screen fixes are therefore asserted against its SOURCE at
// the bottom of this file — a weaker check than the executed ones above, and
// labelled as such.

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

const WORK = join(tmpdir(), `vc-outbox-recovery-${process.pid}`);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');

// ── stubs ─────────────────────────────────────────────────────────────────
const STUBS = `
const H = () => globalThis.__H;

// --- receipts deps ---
export default {
  async getItem(k) { return H().kv[k] ?? null; },
  async setItem(k, v) { H().kv[k] = v; },
};
export async function markRead(chatId, id) { return H().markRead(chatId, id); }
export async function markDelivered(chatId, id) { return H().markDelivered(chatId, id); }
export function onConnectionState() { return () => {}; }

// --- messageQueue deps ---
export const NetInfo = { addEventListener(cb) { H().netListeners.push(cb); return () => {}; } };
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
  const rows = H().rows;
  const i = rows.findIndex(r => r.q === q && r.id === id);
  // Deep-copy on write, like a real row going through SQLite: a bug that
  // mutates the in-memory object instead of persisting it must not pass.
  const data = JSON.parse(JSON.stringify(item));
  if (i >= 0) { rows[i].data = data; rows[i].tag = tag ?? null; return; }
  rows.push({ q, id, tag: tag ?? null, data, createdAt: createdAt ?? Date.now(), rowid: ++seq });
}
export async function queueList(q, limit = 200, offset = 0) {
  return H().rows.filter(r => r.q === q).sort(ord).slice(offset, offset + limit).map(r => r.data);
}
export async function queueListByTag(q, tag, limit = 500) {
  return H().rows.filter(r => r.q === q && r.tag === tag).sort(ord).slice(0, limit).map(r => r.data);
}
export async function queueGet(q, id) {
  const r = H().rows.find(r => r.q === q && r.id === id);
  return r ? JSON.parse(JSON.stringify(r.data)) : null;
}
export async function queueDelete(q, id) {
  const rows = H().rows;
  const i = rows.findIndex(r => r.q === q && r.id === id);
  if (i >= 0) rows.splice(i, 1);
}
export async function queueMigrate() { return 0; }
export async function cacheMessages() {}
`;
writeFileSync(join(WORK, 'stubs.js'), STUBS);

function rewrite(file: string, out: string, rules: [RegExp, string][]) {
  let src = readFileSync(join(HERE, file), 'utf8');
  for (const [re, to] of rules) {
    if (!re.test(src)) {
      check(`selftest can rewrite ${file}'s imports`, false, `${file} changed its import block (${re})`);
    }
    src = src.replace(re, to);
  }
  const stray = [...src.matchAll(/^import .*from '([^']+)';$/gm)]
    .map(m => m[1]).filter(p => !p.startsWith('./stubs') && !p.endsWith('.ts'));
  check(`every ${file} import is accounted for`, stray.length === 0, `unstubbed: ${stray.join(', ')}`);
  writeFileSync(join(WORK, out), src);
}

rewrite('receipts.ts', 'receipts.ts', [
  [/^import AsyncStorage from '@react-native-async-storage\/async-storage';$/m,
   `import AsyncStorage from './stubs.js';`],
  [/^import \{ markRead, markDelivered \} from '\.\/chatService';$/m,
   `import { markRead, markDelivered } from './stubs.js';`],
  [/^import \{ onConnectionState \} from '\.\/socket';$/m,
   `import { onConnectionState } from './stubs.js';`],
]);

{
  let src = readFileSync(join(HERE, 'messageQueue.ts'), 'utf8');
  const rules: [RegExp, string][] = [
    [/^import NetInfo from '@react-native-community\/netinfo';$/m, `import { NetInfo } from './stubs.js';`],
    [/^import \* as Crypto from 'expo-crypto';$/m, `import * as Crypto from './stubs.js';`],
    [/^import \{ api \} from '\.\/api';$/m, `import { api } from './stubs.js';`],
    [/^import \{ queuePut, queueList, queueListByTag, queueGet, queueDelete, queueMigrate \} from '\.\/localDb';$/m,
     `import { queuePut, queueList, queueListByTag, queueGet, queueDelete, queueMigrate } from './stubs.js';`],
    [/^import \{ encryptForChat, cacheOwnPlaintext, editMessage, deleteMessage, type Message \} from '\.\/chatService';$/m,
     `import { encryptForChat, cacheOwnPlaintext, editMessage, deleteMessage } from './stubs.js';`],
    [/^import \{ splitMeta, wrapEnvelope \} from '\.\/msgEnvelope';$/m,
     `import { splitMeta, wrapEnvelope } from './msgEnvelope.ts';`],
    [/^import \{ normalizeMsgIds \} from '\.\/msgIds';$/m, `import { normalizeMsgIds } from './msgIds.ts';`],
    [/^import \{ type MsgState \} from '\.\/messageState';$/m, ``],
    [/^import perf from '\.\/perf';$/m, `import { perf } from './stubs.js';`],
  ];
  for (const [re, to] of rules) {
    if (!re.test(src)) check('selftest can rewrite messageQueue.ts imports', false, String(re));
    src = src.replace(re, to);
  }
  // The dynamic import of localDb inside postOnce — stubbed too.
  src = src.replace(/await import\('\.\/localDb'\)/g, `await import('./stubs.js')`);
  src = src.replace(/\bMessage\['type'\]/g, 'any').replace(/\bMsgState\b/g, 'any');
  writeFileSync(join(WORK, 'msgEnvelope.ts'),
    readFileSync(join(HERE, 'msgEnvelope.ts'), 'utf8').replace(/^import type .*$/m, ''));
  writeFileSync(join(WORK, 'msgIds.ts'), readFileSync(join(HERE, 'msgIds.ts'), 'utf8'));
  writeFileSync(join(WORK, 'mq.ts'), src);
}

// ── harness state ─────────────────────────────────────────────────────────
// The real chat c1 tops out at message 500. 9000 is a foreign id — perfectly
// valid-looking, from another chat, because message ids are one global sequence.
const NEWEST_IN_CHAT = 500;
const H: any = {
  kv: {} as Record<string, string>,
  rows: [] as any[],
  netListeners: [] as any[],
  readCalls: [] as number[],
  deliveredCalls: [] as number[],
  offline: false,
  apiCalls: [] as string[],
  apiStatus: 0 as number,     // 0 = healthy
  serverSeq: 100,
  markRead: async (_c: string, id: number) => {
    H.readCalls.push(id);
    if (H.offline) throw new Error('Network request failed');   // no .status, like a real offline fetch
    if (id > NEWEST_IN_CHAT) {
      const e: any = new Error('lastReadMessageId is not a message in this chat');
      e.status = 400;
      throw e;
    }
  },
  markDelivered: async (_c: string, id: number) => { H.deliveredCalls.push(id); },
  api: async (path: string, opts: any) => {
    H.apiCalls.push(`${opts?.method ?? 'POST'} ${path}`);
    if (H.apiStatus) {
      const e: any = new Error('rejected');
      e.status = H.apiStatus;
      throw e;
    }
    return { id: ++H.serverSeq, chatId: 'c1', content: 'CT:x', createdAt: new Date().toISOString() };
  },
};
(globalThis as any).__H = H;

async function main() {
  const R: any = await import(pathToFileURL(join(WORK, 'receipts.ts')).href);
  const Q: any = await import(pathToFileURL(join(WORK, 'mq.ts')).href);

  console.log('receipts: a rejected cursor must not wedge the chat forever');
  // The client bug: a foreign id lands in the monotonic pointer.
  await R.markReadDurable('c1', 9000);
  await R.flush();
  check('the bad cursor was attempted once', H.readCalls.length === 1, JSON.stringify(H.readCalls));
  // …and now the user genuinely reads message 500 in this chat.
  await R.markReadDurable('c1', NEWEST_IN_CHAT);
  await R.flush();
  check('a real read after a 400 reaches the server',
    H.readCalls.includes(NEWEST_IN_CHAT),
    `only ${JSON.stringify(H.readCalls)} — the pointer is still stuck above every real id`);
  await R.flush();
  check('and it is not re-sent once acked',
    H.readCalls.filter((x: number) => x === NEWEST_IN_CHAT).length === 1,
    JSON.stringify(H.readCalls));

  console.log('receipts: transient failures still retry unchanged');
  H.readCalls.length = 0;
  H.offline = true;
  await R.markReadDurable('c2', 300);
  await R.flush();
  check('an offline failure is attempted', H.readCalls.length === 1);
  H.offline = false;
  await R.flush();
  check('and the pointer is NOT rolled back — it retries and lands',
    H.readCalls.length === 2 && H.readCalls[1] === 300, JSON.stringify(H.readCalls));

  // persistSoon() is an 800ms debounce; the rolled-back value must reach disk or
  // the wedge simply comes back at the next cold start.
  await new Promise(r => setTimeout(r, 900));
  const stored = JSON.parse(H.kv['vc_receipts_v1'] ?? '{}');
  check('the healed pointer is persisted, so a restart stays healed',
    stored?.c1?.read === NEWEST_IN_CHAT && stored?.c1?.ackedRead === NEWEST_IN_CHAT,
    JSON.stringify(stored?.c1));

  console.log('outbox: a permanently-rejected message keeps its row');
  H.apiStatus = 400;
  const failed: any[] = [];
  Q.on('failed', (e: any) => failed.push(e));
  const item = await Q.enqueueText('c1', 'the only copy of this text');
  // enqueue() starts its own background flush, so an immediate flush() here only
  // sets the coalesce flag and returns. Let the pass it already started finish.
  await new Promise(r => setTimeout(r, 50));
  await Q.flush();
  check('the bubble is told it failed', failed.some(f => f.tempId === item.tempId));
  let pend = await Q.pendingForChat('c1');
  check('the row survives — pendingForChat still returns it, so the red bubble survives a restart',
    pend.length === 1 && pend[0].tempId === item.tempId, `${pend.length} rows`);
  check('…carrying the plaintext and a FAILED state',
    pend[0].plaintext === 'the only copy of this text' && pend[0].state === 'FAILED',
    JSON.stringify({ p: pend[0].plaintext, s: pend[0].state }));

  const postsAfterFail = H.apiCalls.length;
  await Q.flush(); await Q.flush(); await Q.flush();
  check('flush() skips it instead of spinning on a request that can only 400 again',
    H.apiCalls.length === postsAfterFail, `${H.apiCalls.length - postsAfterFail} pointless POSTs`);

  console.log('outbox: Retry actually retries');
  H.apiStatus = 0;
  await Q.retry(item.tempId);
  await new Promise(r => setTimeout(r, 50));
  check('the retried message is POSTed', H.apiCalls.length > postsAfterFail,
    'retry() was a silent no-op — the user taps Retry and nothing happens');
  pend = await Q.pendingForChat('c1');
  check('and it leaves the pending list once accepted', pend.length === 0, `${pend.length} left`);

  // ── SOURCE ASSERTIONS (not executed) ───────────────────────────────────
  // app/chat.tsx cannot be imported under Node. These only prove the guards are
  // PRESENT, not that they fire — weaker than everything above.
  console.log('chat screen (source assertions only — app/chat.tsx cannot run under Node)');
  const CHAT = readFileSync(join(HERE, '..', 'app', 'chat.tsx'), 'utf8');
  const initialLoad = CHAT.slice(CHAT.indexOf('// ── Initial load'), CHAT.indexOf('// ── Queue events'));
  check('initial load is cancellable and chat-checked',
    /let cancelled = false;/.test(initialLoad) &&
    /chatIdRef\.current === cid/.test(initialLoad) &&
    /return \(\) => \{ cancelled = true; \};/.test(initialLoad));
  check('…including the finally that clears the spinner',
    /finally \{\s*if \(alive\(\)\) setLoading\(false\);/.test(initialLoad));
  check('new_message re-checks the chat AFTER the decrypt await',
    /const stillHere = chatIdRef\.current === chatId;/.test(CHAT) &&
    /if \(!ownBlankEcho && stillHere\)/.test(CHAT));
  check('…while the persist + delivery ack still run unconditionally',
    /await applyMessage\(chatId, fin\);[^\n]*\n\s*if \(fin\.senderId !== me\) markDeliveredDurable/.test(CHAT));
  const jump = CHAT.slice(CHAT.indexOf('const jumpToMessage'), CHAT.indexOf('// Consume a pending jump'));
  check('jumpToMessage guards the chat and MERGES instead of replacing',
    /chatIdRef\.current === cid/.test(jump) && !/setMessages\(messagesRef\.current\)/.test(jump));
  const erAt = CHAT.indexOf('const onEndReached');
  const endReached = CHAT.slice(erAt, CHAT.indexOf('resetAlbumCache()', erAt));
  check('the onEndReached slice is real', erAt > 0 && endReached.length > 200, `${endReached.length} chars`);
  check('onEndReached guards the chat', /chatIdRef\.current === cid/.test(endReached));
  check('the failed-bubble state survives a remount',
    /_state: q\.state === 'FAILED' \? 'failed' : 'pending'/.test(CHAT),
    'a kept FAILED row would come back as a clock that never ticks');
}

main().then(() => {
  rmSync(WORK, { recursive: true, force: true });
  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.log('  ✗ harness threw:', err?.stack ?? err);
  rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
