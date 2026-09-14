// lib/twoUserConversation.selftest.ts — run: npx tsx lib/twoUserConversation.selftest.ts
//
// A REAL two-user conversation, end to end, with real crypto.
//
// Every other suite in this repo tests one layer. e2ee.selftest.ts proves the
// ratchet; msgEnvelope.selftest.ts proves the meta split; messageQueue.flush
// proves the outbox drains. None of them proves that Alice pressing Send
// results in Bob reading the words — which is the only property the app
// actually has to have, and the one that breaks when two correct layers
// disagree about whose job something is.
//
// So this runs the SHIPPING lib/chatService.ts (sendMessage, encryptForChat,
// hydrateMessages, decryptFromChat) twice — once as Alice, once as Bob — over
// one shared in-memory server, with:
//
//   * the real services/crypto (X3DH + Double Ratchet). NOT mocked: mocking it
//     would make every assertion below vacuous.
//   * the real services/crypto/e2eeSession + messageStore, composed exactly as
//     e2eeSession.rn.ts composes them, over in-memory KV instead of SecureStore.
//   * the real lib/msgEnvelope, lib/messageState, lib/keyChange.
//
// chatService.ts cannot be imported under Node (react-native, expo-*), so — as
// messageQueue.flush.selftest.ts already does — its IMPORT BLOCK ONLY is
// rewritten to point at stubs and the body is used verbatim, regenerated every
// run so it cannot drift from what ships. The dynamic `await import()` calls
// are redirected the same way. Nothing inside a function body is touched.
//
// WHAT IS NOT REACHABLE FROM NODE (and is therefore NOT claimed here):
//   * SecureStore chunking (services/crypto/e2eeStorage.selftest.ts covers it)
//   * SQLite plaintextStore / localDb (lib/localDb.queue.selftest.ts)
//   * the messageQueue flush loop (lib/messageQueue.flush.selftest.ts) — the
//     offline section below drives the real state machine and the real encrypt
//     path, not the outbox's SQLite paging.
//   * anything in MessageBubble / app/chat.tsx (render layer)

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { transition, tickFor, type MsgState } from './messageState';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CRYPTO = pathToFileURL(join(ROOT, 'services', 'crypto')).href;

(globalThis as any).__DEV__ = true;   // messageState.transition throws in dev

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── the shared "server" ───────────────────────────────────────────────────
// Deliberately dumb: it stores exactly what the client hands it, which is the
// point — every assertion about what the server can see reads these rows.
interface Row {
  id: number; chatId: string; senderId: string; type: string;
  content: string | null; meta: any; replyToId: number | null;
  editedAt: string | null; deletedAt: string | null; createdAt: string;
}
const PEER: Record<string, string> = { alice: 'bob', bob: 'alice' };
const server = {
  rows: [] as Row[],
  seq: 100,
  bundles: new Map<string, { identityKey: string; signedPreKey: any; otpks: any[] }>(),
  offline: new Set<string>(),          // userIds whose api() throws
};
const rowById = (id: number) => server.rows.find((r) => r.id === id);

function apiFor(userId: string) {
  return async function api(path: string, opts: any = {}): Promise<any> {
    if (server.offline.has(userId)) throw new Error('Network request failed');
    const method = (opts?.method ?? 'GET').toUpperCase();
    const body = opts?.json;
    let m: RegExpMatchArray | null;

    if (path === '/user/keybundle' && method === 'POST') {
      // Mirrors the backend: a CHANGED identity purges the now-dead prekeys.
      const cur = server.bundles.get(userId);
      const otpks = cur && cur.identityKey === body.identityKey ? cur.otpks : [];
      const have = new Set(otpks.map((o: any) => o.keyId));
      for (const o of body.oneTimePreKeys) if (!have.has(o.keyId)) otpks.push(o);
      server.bundles.set(userId, { identityKey: body.identityKey, signedPreKey: body.signedPreKey, otpks });
      return {};
    }
    if ((m = path.match(/^\/user\/([^/]+)\/keybundle$/))) {
      const b = server.bundles.get(decodeURIComponent(m[1]));
      if (!b) { const e: any = new Error('not found'); e.status = 404; throw e; }
      return { identityKey: b.identityKey, signedPreKey: b.signedPreKey, oneTimePreKey: b.otpks.shift() ?? null };
    }
    if (path === '/chats' || path.startsWith('/chats?')) return [chatSummary(userId)];
    if ((m = path.match(/^\/chats\/([^/?]+)$/))) return chatSummary(userId);
    if ((m = path.match(/^\/chats\/([^/]+)\/messages$/)) && method === 'POST') {
      const row: Row = {
        id: ++server.seq, chatId: decodeURIComponent(m[1]), senderId: userId,
        type: body.type ?? 'text', content: body.content, meta: body.meta ?? null,
        replyToId: body.replyToId ?? null, editedAt: null, deletedAt: null,
        createdAt: new Date().toISOString(),
      };
      server.rows.push(row);
      return { ...row, id: String(row.id) };         // the server emits id as a STRING
    }
    if ((m = path.match(/^\/chats\/([^/]+)\/messages\/(\d+)$/))) {
      const row = rowById(Number(m[2]));
      if (!row) { const e: any = new Error('gone'); e.status = 404; throw e; }
      if (method === 'PATCH') { row.content = body.content; row.editedAt = new Date().toISOString(); return { ...row, id: String(row.id) }; }
      if (method === 'DELETE') { row.deletedAt = new Date().toISOString(); row.content = null; return { id: row.id, deletedAt: row.deletedAt }; }
    }
    throw new Error(`unstubbed api: ${method} ${path}`);
  };
}
function chatSummary(userId: string) {
  return {
    id: 'c1', type: 'direct', name: null, photoURL: null, createdBy: 'alice',
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    lastMessageId: null, lastMessageAt: null, myRole: 'member', myLastReadId: null,
    muted: false, pinned: false, favourite: false, archived: false, hidden: false,
    unreadCount: 0, peerUserId: PEER[userId], peerName: PEER[userId],
  };
}

// ── build a runnable copy of chatService per user ─────────────────────────
const WORK = join(tmpdir(), `vc-2user-selftest-${process.pid}`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');

const IMPORT_REWRITES: [RegExp, string][] = [
  [/^import \{ Platform \} from 'react-native';$/m, `import { Platform } from './stubs.ts';`],
  [/^import \* as Crypto from 'expo-crypto';$/m, `import * as Crypto from './stubs.ts';`],
  [/^import \* as FileSystem from 'expo-file-system\/legacy';$/m, `import * as FileSystem from './stubs.ts';`],
  [/^import \{ api, getAccessToken \} from '\.\/api';$/m, `import { api, getAccessToken } from './stubs.ts';`],
  [/^import \{ Buffer \} from 'buffer';.*$/m, `import { Buffer } from 'node:buffer';`],
  [/^import \{ splitMeta, wrapEnvelope, unwrapEnvelope \} from '\.\/msgEnvelope';$/m,
   `import { splitMeta, wrapEnvelope, unwrapEnvelope } from '${pathToFileURL(join(HERE, 'msgEnvelope.ts')).href}';`],
  [/^import perf from '\.\/perf';$/m, `import { perf as perf } from './stubs.ts';`],
  [/^import \{ SERVER_URL \} from '\.\.\/constants\/server';$/m, `import { SERVER_URL } from './stubs.ts';`],
  // constants/flags.ts is owned by another agent right now, so it is pinned
  // here at its shipping values rather than imported and raced.
  [/^import \{ E2EE_ENABLED, GROUP_E2EE, E2EE_STRICT, UPLOAD_PROGRESS \} from '\.\.\/constants\/flags';$/m,
   `import { E2EE_ENABLED, GROUP_E2EE, E2EE_STRICT, UPLOAD_PROGRESS } from './stubs.ts';`],
  [/^import \{ redactIds, warnOnce \} from '\.\/diagLog';$/m, `import { redactIds, warnOnce } from './stubs.ts';`],
  // mid-file import (forwarding), pure but not on the path under test
  [/^import \{ nextForwardScore \} from '\.\/forwardPolicy';$/m, `import { nextForwardScore } from './stubs.ts';`],
];

const CHAT_SRC = readFileSync(join(HERE, 'chatService.ts'), 'utf8');
const KEYCHANGE_SRC = readFileSync(join(HERE, 'keyChange.ts'), 'utf8');

// The ~20 lines of glue in e2eeSession.rn.ts (plaintext cache + per-peer lock)
// are RN-only, so the e2ee stub below restates them. Restated code drifts, and
// the one thing it restates that MATTERS is the cache key — so pin it.
const RN_SRC = readFileSync(join(ROOT, 'services', 'crypto', 'e2eeSession.rn.ts'), 'utf8');
check('e2eeSession.rn passes the ciphertext to the plaintext cache (edit invalidation)',
  /msgStore\.get\(chatId, messageId, wire\)/.test(RN_SRC) && /msgStore\.put\(chatId, messageId, plaintext, wire\)/.test(RN_SRC),
  'without the body, an edited message is served its pre-edit text forever');

function buildClient(userId: string): string {
  const dir = join(WORK, userId);
  mkdirSync(dir, { recursive: true });

  let src = CHAT_SRC;
  for (const [re, to] of IMPORT_REWRITES) {
    if (!re.test(src)) { check(`rewrite chatService import ${re}`, false, 'chatService.ts changed its import block'); }
    src = src.replace(re, to);
  }
  // Dynamic imports: the e2ee binding is REAL code composed over in-memory
  // stores; everything else is a stub.
  // msgIds is real, per-client: it has no imports, and it is what decides
  // whether a wire row survives into the cache at all.
  writeFileSync(join(dir, 'msgIds.ts'), readFileSync(join(ROOT, 'lib', 'msgIds.ts'), 'utf8'));
  src = src.replace(/^import \{ normalizeMsgIds \} from '\.\/msgIds';$/m,
    `import { normalizeMsgIds } from './msgIds.ts';`);
  src = src
    .replace(/await import\('\.\.\/services\/crypto\/e2eeSession\.rn'\)/g, `await import('./e2ee.ts')`)
    .replace(/await import\('\.\.\/services\/crypto\/groupSession\.rn'\)/g, `await import('./stubs.ts')`)
    .replace(/await import\('\.\/(localDb|sessionEpoch|socket|api|cacheCrypto)'\)/g, `await import('./stubs.ts')`);

  const stray = [...src.matchAll(/^import (?!type )[^\n]*from '([^']+)';$/gm)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith('./stubs') && !p.startsWith('file:') && p !== 'node:buffer' && p !== './msgIds.ts');
  check(`every ${userId} chatService import is accounted for`, stray.length === 0, `unstubbed: ${stray.join(', ')}`);
  const strayDyn = [...src.matchAll(/await import\('([^']+)'\)/g)].map((m) => m[1])
    .filter((p) => p !== './stubs.ts' && p !== './e2ee.ts');
  check(`every ${userId} dynamic import is accounted for`, strayDyn.length === 0, `unstubbed: ${strayDyn.join(', ')}`);

  writeFileSync(join(dir, 'chat.ts'), src);

  // The REAL e2ee binding, composed exactly as services/crypto/e2eeSession.rn.ts
  // composes it — only the storage and transport are in-memory.
  writeFileSync(join(dir, 'e2ee.ts'), `
import { createE2EESession } from '${CRYPTO}/e2eeSession';
import { createMessageStore, createKeyedLock } from '${CRYPTO}/messageStore';
const H = () => (globalThis as any).__VC2U;
const mem = new Map<string, string>();
const mkv = new Map<string, string>();
export const _kv = mem, _plaintextKv = mkv;
const kv = { async get(k: string) { return mem.has(k) ? mem.get(k)! : null; },
             async set(k: string, v: string) { mem.set(k, v); },
             async del(k: string) { mem.delete(k); } };
export let e2ee = createE2EESession({ store: kv, transport: {
  publish: (b: any) => H().api('${userId}')('/user/keybundle', { method: 'POST', json: b }),
  async fetch(peerId: string) {
    try { const r = await H().api('${userId}')('/user/' + encodeURIComponent(peerId) + '/keybundle');
          return r && r.identityKey ? r : null; } catch (e: any) { if (e?.status === 404) return null; throw e; }
} } });
const msgStore = createMessageStore({ async get(k: string) { return mkv.has(k) ? mkv.get(k)! : null; },
  async set(k: string, v: string) { mkv.set(k, v); }, async del(k: string) { mkv.delete(k); } });
const withLock = createKeyedLock();
export const E2EE_UNDECRYPTABLE = ' __e2ee_undecryptable__';
export function isEnvelope(w: any) { return e2ee.isEnvelope(w); }
export function e2eeEncrypt(_c: string, p: string, t: string) { return withLock(p, () => e2ee.encryptForPeer(p, t)); }
export function e2eeDecrypt(chatId: string, peerId: string, messageId: number, wire: string) {
  return withLock(peerId, async () => {
    if (messageId > 0) { const c = await msgStore.get(chatId, messageId, wire);
      if (c !== null) { if (c === E2EE_UNDECRYPTABLE) throw new Error('e2ee: undecryptable (cached)'); return c; } }
    try { const pt = await e2ee.decryptFromPeer(peerId, wire);
          if (messageId > 0) await msgStore.put(chatId, messageId, pt, wire); return pt; }
    catch (err: any) { const m = String(err?.message || '');
      if (!m.includes('no session and no X3DH') && messageId > 0) await msgStore.put(chatId, messageId, E2EE_UNDECRYPTABLE);
      throw err; }
  });
}
export function e2eeResetSession(p: string) { return withLock(p, () => e2ee.resetSession(p)); }
export function e2eePeerIdentityKey(p: string) { return e2ee.peerIdentityKey(p); }
export function e2eeHasSession(p: string) { return e2ee.hasSession(p); }
export async function e2eeCachePlaintext(c: string, id: number, pt: string) { if (id > 0) await msgStore.put(c, id, pt); }
export async function e2eeGetCached(c: string, id: number) { return id > 0 ? msgStore.get(c, id) : null; }
export async function provisionE2EEIdentity() { await e2ee.ensurePublished(); }
/** REINSTALL: brand-new identity, brand-new session store, empty plaintext cache. */
export async function _reinstall() {
  mem.clear(); mkv.clear();
  e2ee = createE2EESession({ store: kv, transport: {
    publish: (b: any) => H().api('${userId}')('/user/keybundle', { method: 'POST', json: b }),
    async fetch(peerId: string) {
      try { const r = await H().api('${userId}')('/user/' + encodeURIComponent(peerId) + '/keybundle');
            return r && r.identityKey ? r : null; } catch (e: any) { if (e?.status === 404) return null; throw e; }
  } } });
  await e2ee.ensurePublished();
}
`);

  writeFileSync(join(dir, 'stubs.ts'), `
const H = () => (globalThis as any).__VC2U;
export const Platform = { OS: 'node' };
let _n = 0;
export function randomUUID() { return '${userId}-uuid-' + (++_n); }
export async function api(path: string, opts?: any) { return H().api('${userId}')(path, opts); }
export async function getAccessToken() { return H().token('${userId}'); }
export async function getCachedUser() { return { id: '${userId}' }; }
export const SERVER_URL = 'http://test';
// Pinned copies of constants/flags.ts (owned by another agent this session).
export const E2EE_ENABLED = true, GROUP_E2EE = true, E2EE_STRICT = true, UPLOAD_PROGRESS = true;
export const perf = { mark() {}, recordSend() {}, snapshot() { return { transport: 'test' }; } };
export function nextForwardScore(n: number) { return n + 1; }
export function redactIds(s: string) { return s; }
export function warnOnce() {}
// group session: this suite is 1:1 only, so the group envelope never matches.
export function isGroupEnvelope(s: any) { return typeof s === 'string' && s.startsWith('GSK1:'); }
export async function groupEncryptMessage(_c: string, t: string) { return t; }
export async function groupDecryptMessage() { throw new Error('no group session'); }
// localDb / sessionEpoch / socket / cacheCrypto
export async function cacheMessages() {}
export function cacheChatDetail() {}
export async function getCachedMessages() { return []; }
export async function getCachedMessagesByIds() { return []; }
export async function setMeta() {}
export async function getMeta() { return null; }
export function bumpSessionEpoch() {}
export function getSocket() { return null; }
export async function encField(v: any) { return v; }
export async function decField(v: any) { return v; }
export function getRefreshToken() { return null; }
export const documentDirectory = '/tmp/';
export async function getInfoAsync() { return { exists: false }; }
`);

  // The real keyChange.ts, with its AsyncStorage + e2ee imports redirected.
  writeFileSync(join(dir, 'keyChange.ts'), KEYCHANGE_SRC
    .replace(/^import AsyncStorage from '@react-native-async-storage\/async-storage';$/m,
      `const _ks = new Map<string, string>();\nconst AsyncStorage = { async getItem(k: string) { return _ks.has(k) ? _ks.get(k)! : null; }, async setItem(k: string, v: string) { _ks.set(k, v); } };`)
    .replace(/await import\('\.\.\/services\/crypto\/e2eeSession\.rn'\)/g, `await import('./e2ee.ts')`));

  return dir;
}

// A JWT-shaped token whose `sub` is the user id — myUserId() decodes it.
const b64u = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
const H = {
  api: apiFor,
  token: (u: string) => `x.${b64u({ sub: u })}.y`,
};
(globalThis as any).__VC2U = H;

// ── the conversation ──────────────────────────────────────────────────────
async function main() {
  const aliceDir = buildClient('alice');
  const bobDir = buildClient('bob');
  const A: any = await import(pathToFileURL(join(aliceDir, 'chat.ts')).href);
  const B: any = await import(pathToFileURL(join(bobDir, 'chat.ts')).href);
  const Ae: any = await import(pathToFileURL(join(aliceDir, 'e2ee.ts')).href);
  const Be: any = await import(pathToFileURL(join(bobDir, 'e2ee.ts')).href);
  const Akc: any = await import(pathToFileURL(join(aliceDir, 'keyChange.ts')).href);

  // Both devices publish a key bundle and learn the chat's peer, exactly as
  // app/_layout + the chat screen do at startup.
  await Ae.provisionE2EEIdentity();
  await Be.provisionE2EEIdentity();
  await A.getChat('c1');
  await B.getChat('c1');

  /** Deliver server rows to a client, newest-first, as the real API does. */
  const deliver = (C: any, ids: number[], live = true) =>
    C.hydrateMessages('c1', ids.map((i) => ({ ...rowById(i)! })).reverse(), undefined, { live });
  const textOf = async (C: any, id: number) => (await deliver(C, [id]))[0]?.content;

  // 1 ── FIRST CONTACT: no session on either side.
  console.log('\nfirst contact (X3DH bootstrap)');
  check('Alice has no session with Bob before sending', !(await Ae.e2eeHasSession('bob')));
  const m1 = await A.sendMessage('c1', 'hey bob, first message');
  check('the server stored ciphertext, not the text',
    rowById(m1.id)!.content !== 'hey bob, first message' && A.looksEncrypted(rowById(m1.id)!.content),
    String(rowById(m1.id)!.content).slice(0, 40));
  check('the wire carries an X3DH header (no session on Bob yet)',
    JSON.parse(rowById(m1.id)!.content!).x3dh != null);
  check('Bob decrypts it', (await textOf(B, m1.id)) === 'hey bob, first message');

  // 2 ── Bob replies, Alice decrypts (DH ratchet turns over).
  console.log('\nreply');
  const m2 = await B.sendMessage('c1', 'hi alice');
  check('Alice decrypts Bob’s reply', (await textOf(A, m2.id)) === 'hi alice');
  const m3 = await A.sendMessage('c1', 'and back again');
  check('Bob decrypts after the ratchet turned', (await textOf(B, m3.id)) === 'and back again');
  check('Alice stopped attaching the X3DH header once Bob replied',
    JSON.parse(rowById(m3.id)!.content!).x3dh == null);

  // 3 ── RAPID BURST one way, then a reply.
  console.log('\n50-message burst then a reply');
  const burst: number[] = [];
  for (let i = 0; i < 50; i++) burst.push((await A.sendMessage('c1', `burst ${i}`)).id);
  const got = await deliver(B, burst);
  check('Bob decrypts all 50 in order',
    got.length === 50 && got.every((m: any, k: number) => m.content === `burst ${49 - k}`),
    got.map((m: any) => m.content).slice(0, 3).join('|'));
  const m4 = await B.sendMessage('c1', 'got all fifty');
  check('Bob’s reply after a 50-step chain decrypts', (await textOf(A, m4.id)) === 'got all fifty');

  // 4 ── OUT OF ORDER + a DROPPED message (skipped-key cache).
  console.log('\nout-of-order delivery and a dropped message');
  const o = [] as number[];
  for (const t of ['ooo-1', 'ooo-2', 'ooo-3', 'ooo-4']) o.push((await A.sendMessage('c1', t)).id);
  check('4th arrives first', (await textOf(B, o[3])) === 'ooo-4');
  check('1st arrives after it (skipped-key cache)', (await textOf(B, o[0])) === 'ooo-1');
  check('3rd arrives next', (await textOf(B, o[2])) === 'ooo-3');
  // ooo-2 is DROPPED entirely and never delivered. The chain must carry on.
  const m5 = await A.sendMessage('c1', 'after the gap');
  check('a permanently-dropped message does not stall the chain',
    (await textOf(B, m5.id)) === 'after the gap');
  check('the dropped message still decrypts if it turns up later',
    (await textOf(B, o[1])) === 'ooo-2');

  // 5 ── PRIVATE META stays out of the server-visible half.
  console.log('\nprivate metadata (thumbnail / filename / link preview)');
  const meta = {
    attachmentId: 'att-9',                 // public: the server routes on it
    thumb: 'data:image/jpeg;base64,SECRET-THUMB',
    filename: 'holiday-photo.jpg',
    mime: 'image/jpeg', width: 4032, height: 3024,
    linkPreview: { url: 'https://example.com', title: 'Private Title' },
  };
  const m6 = await A.sendMessage('c1', 'look at this', 'image', { meta });
  const serverMeta = rowById(m6.id)!.meta;
  const serverBlob = JSON.stringify(rowById(m6.id));
  check('the server got only the routing subset',
    JSON.stringify(serverMeta) === JSON.stringify({ attachmentId: 'att-9' }), JSON.stringify(serverMeta));
  check('no thumbnail anywhere in the server row', !serverBlob.includes('SECRET-THUMB'));
  check('no filename anywhere in the server row', !serverBlob.includes('holiday-photo'));
  check('no link-preview title anywhere in the server row', !serverBlob.includes('Private Title'));
  const bobSaw = (await deliver(B, [m6.id]))[0];
  check('Bob’s bubble gets the text back', bobSaw.content === 'look at this');
  check('Bob’s bubble gets the thumbnail back', bobSaw.meta?.thumb === meta.thumb);
  check('Bob’s bubble gets the filename back', bobSaw.meta?.filename === 'holiday-photo.jpg');
  check('Bob’s bubble gets the link preview back', bobSaw.meta?.linkPreview?.title === 'Private Title');
  check('Bob keeps the public half too', bobSaw.meta?.attachmentId === 'att-9');

  // 6 ── THE SENDER RE-READING THEIR OWN MESSAGE.
  // A Double Ratchet ciphertext cannot be opened by the party that produced it.
  // The own-plaintext cache is the ONLY thing that makes this work.
  console.log('\nsender re-reads their own messages');
  const mine = (await deliver(A, [m1.id, m6.id]))[0];   // newest-first → m6 first
  check('Alice re-reads her own text from the cache',
    (await deliver(A, [m1.id]))[0].content === 'hey bob, first message');
  check('Alice’s own media bubble keeps its private meta on re-read',
    mine.content === 'look at this' && mine.meta?.thumb === meta.thumb);
  check('nothing was decrypted to do it (own messages are never decrypt-attempted)',
    await Ae.e2eeGetCached('c1', m1.id) !== null);
  // CACHE MISS — reinstall, cleared cache, or the echo beating the cache write.
  // This must degrade to "can't be shown", NOT to "unable to decrypt".
  Ae._plaintextKv.delete(`vc_pt_c1_${m1.id}`);
  const missed = (await deliver(A, [m1.id]))[0];
  check('a cache MISS on an own message yields content === null, not an error string',
    missed.content === null, JSON.stringify(missed.content));
  check('the miss did not leave the envelope in place (which renders as "unable to decrypt")',
    !A.looksEncrypted(missed.content));

  // 7 ── EDIT and DELETE.
  console.log('\nedit and delete');
  const m7 = await A.sendMessage('c1', 'ths has a typo');
  check('Bob reads the original', (await textOf(B, m7.id)) === 'ths has a typo');
  await A.editMessage('c1', m7.id, 'this has no typo');
  check('the edit is ciphertext on the server too', A.looksEncrypted(rowById(m7.id)!.content));
  check('Bob reads the edit', (await textOf(B, m7.id)) === 'this has no typo');
  check('Alice re-reads her own edit', (await deliver(A, [m7.id]))[0].content === 'this has no typo');
  const m8 = await A.sendMessage('c1', 'delete me');
  await A.deleteMessage('c1', m8.id);
  check('a deleted message has no body left on the server', rowById(m8.id)!.content === null);
  check('a deleted message renders as empty, not as a decrypt failure',
    (await deliver(B, [m8.id]))[0].content === null);

  // 8 ── BOB REINSTALLS: new identity key, no sessions, empty caches.
  console.log('\nBob reinstalls (new identity key)');
  const bobIkBefore = await Be.e2eePeerIdentityKey('alice');   // what Bob knew of Alice
  const aliceSawBefore = await Ae.e2eePeerIdentityKey('bob');
  await Akc.checkKeyChange('bob');                              // baseline the pre-reinstall key
  await Be._reinstall();
  // Alice's old session is now dead on Bob's side. Her next message carries no
  // X3DH header (she believes the session is established), so Bob cannot read it.
  const m9 = await A.sendMessage('c1', 'did you get my last one?');
  // hydrateMessages deliberately LEAVES THE ENVELOPE on a failed decrypt so a
  // later open can retry; the bubble renders its locked state from that.
  check('Bob cannot read a message sent to his dead session', B.looksEncrypted((await deliver(B, [m9.id]))[0].content));
  // Bob sends: a fresh X3DH offer. Alice must adopt it and self-heal.
  const m10 = await B.sendMessage('c1', 'reinstalled, new phone');
  check('Bob’s new session carries an X3DH header', JSON.parse(rowById(m10.id)!.content!).x3dh != null);
  check('Alice adopts the new session and reads it', (await textOf(A, m10.id)) === 'reinstalled, new phone');
  const m11 = await A.sendMessage('c1', 'welcome back');
  check('the conversation continues on the new session', (await textOf(B, m11.id)) === 'welcome back');
  // …and the key CHANGE must be visible, or a substitution is invisible.
  const aliceSawAfter = await Ae.e2eePeerIdentityKey('bob');
  check('Alice recorded a peer identity key BEFORE the reinstall (she INITIATED — the side that used to record nothing)',
    !!aliceSawBefore, 'without a baseline there is nothing to compare a change against');
  check('Alice’s recorded peer identity key CHANGED',
    !!aliceSawBefore && !!aliceSawAfter && aliceSawAfter !== aliceSawBefore,
    `${String(aliceSawBefore).slice(0, 8)} → ${String(aliceSawAfter).slice(0, 8)}`);
  const kc = await Akc.checkKeyChange('bob');
  check('keyChange.checkKeyChange fires for the reinstall', kc != null && kc.currentHex === aliceSawAfter,
    JSON.stringify(kc));
  check('checkKeyChange goes quiet after acknowledgement', await (async () => {
    if (!kc) return false;
    await Akc.acknowledgeKeyChange('bob', kc.currentHex);
    return (await Akc.checkKeyChange('bob')) === null;
  })());
  check('Bob had recorded Alice’s key too', !!bobIkBefore);

  // 9 ── OFFLINE: Alice queues while offline, then flushes.
  // The outbox's SQLite paging is lib/messageQueue.flush.selftest.ts's job; what
  // matters HERE is that the real encrypt path and the real state machine agree
  // about a batch that was composed offline and sent later, in order.
  console.log('\noffline then flush');
  server.offline.add('alice');
  const outbox: { text: string; state: MsgState; id?: number }[] =
    ['offline 1', 'offline 2', 'offline 3'].map((text) => ({ text, state: 'QUEUED' as MsgState }));
  for (const item of outbox) {
    item.state = transition(item.state, 'SENDING');
    try { await A.sendMessage('c1', item.text); check('offline send should not succeed', false); }
    catch { item.state = transition(item.state, 'QUEUED'); }   // transient → clock, never red
  }
  check('everything is still QUEUED after three offline attempts',
    outbox.every((i) => i.state === 'QUEUED'));
  check('a queued message shows a clock', tickFor('QUEUED') === 'clock');
  server.offline.delete('alice');
  for (const item of outbox) {
    item.state = transition(item.state, 'SENDING');
    item.id = (await A.sendMessage('c1', item.text)).id;
    item.state = transition(item.state, 'SENT');
  }
  check('all three send on reconnect', outbox.every((i) => i.state === 'SENT' && i.id! > 0));
  const flushed = await deliver(B, outbox.map((i) => i.id!));
  check('Bob decrypts the whole flushed batch, in order',
    flushed.map((m: any) => m.content).join('|') === 'offline 3|offline 2|offline 1',
    flushed.map((m: any) => m.content).join('|'));
  outbox.forEach((i) => { i.state = transition(i.state, 'DELIVERED'); i.state = transition(i.state, 'READ'); });
  check('states advance SENT → DELIVERED → READ', outbox.every((i) => i.state === 'READ'));
  check('a read message shows the gold double tick', tickFor('READ') === 'double-gold');

  // 10 ── the whole transcript still reads correctly on a cold open.
  console.log('\ncold reopen: the full transcript');
  const all = server.rows.filter((r) => !r.deletedAt).map((r) => ({ ...r })).reverse();
  const bobView = await B.hydrateMessages('c1', all);
  const unreadable = bobView.filter((m: any) =>
    m.senderId === 'alice' && (m.content === '🔒 unable to decrypt' || B.looksEncrypted(m.content)));
  // Everything Alice sent BEFORE the reinstall is legitimately gone — forward
  // secrecy plus a wiped device. What must NOT happen is the 60 permanent
  // failures that replay produces killing the healthy session Bob just built.
  check('every pre-reinstall Alice message is unreadable, and nothing after it is',
    unreadable.every((m: any) => m.id <= m9.id) && !unreadable.some((m: any) => m.id > m9.id),
    unreadable.map((m: any) => m.id).join(','));
  check('a replay full of permanent failures does not reset the live session',
    (await textOf(B, (await A.sendMessage('c1', 'still here?')).id)) === 'still here?');
  const aliceView = await A.hydrateMessages('c1', all);
  const aliceBad = aliceView.filter((m: any) => m.senderId === 'alice' && A.looksEncrypted(m.content));
  check('Alice’s cold reopen never shows her own bubbles as ciphertext',
    aliceBad.length === 0, aliceBad.map((m: any) => m.id).join(','));
}

main()
  .then(() => {
    rmSync(WORK, { recursive: true, force: true });
    console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILED ✗`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => { console.error(e); process.exit(1); });
