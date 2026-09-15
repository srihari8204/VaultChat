// groupSessionRecovery.selftest.ts — run: npx tsx services/crypto/groupSessionRecovery.selftest.ts
//
// THREE BUGS THIS PINS, all in services/crypto/groupSession.rn.ts, all of which
// permanently break group messages while looking healthy to the sender.
//
//  C  A LOST OWN KEY IS NEVER DISTRIBUTED. ensureDistributed ran before
//     ensureOwn and only distributed on a MEMBERSHIP change, but ensureOwn
//     silently mints a fresh chain + fresh Ed25519 signing key when the stored
//     one is gone (SecureStore cleared, restore onto a new device). With stable
//     membership nobody ever received the new key → "signature verification
//     failed" on every later message, forever, with no signal to the sender.
//
//  D  RE-INGESTING A SENDER'S SKDM RESET THEIR CHAIN. processDistribution
//     returns skipped = {} and a head jumped forward, so messages still in
//     flight below that iteration died with "message key unavailable".
//
//  E  CONCURRENT DECRYPTS CLOBBERED EACH OTHER. loadPeer → groupDecrypt →
//     savePeer with no lock, while hydrateMessages runs from several call sites
//     at once: the later write discards the other's skipped keys.
//
// The module is built from the SHIPPING source with only its import block
// rewritten (the pattern in lib/twoUserConversation.selftest.ts), over the REAL
// senderKey crypto through the real facade — so the assertions are about the
// code that ships, not a restatement of it.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createSenderKey, distributionMessage, groupEncrypt, type OwnSenderKey } from './index';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CRYPTO = pathToFileURL(HERE).href;

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

const WORK = join(tmpdir(), 'vc-gsk-' + process.pid);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const REWRITES: [RegExp, string][] = [
  [/^import \* as SecureStore from 'expo-secure-store';$/m, `import * as SecureStore from './stubs.ts';`],
  [/^import \{ api, getCachedUser \} from '\.\.\/\.\.\/lib\/api';$/m, `import { api, getCachedUser } from './stubs.ts';`],
  [/^import \{ chunkedKV \} from '\.\/e2eeStorage';$/m, `import { chunkedKV } from '${CRYPTO}/e2eeStorage';`],
  [/^import \{ e2eeEncrypt, e2eeDecrypt, e2eeCachePlaintext, e2eeGetCached, E2EE_UNDECRYPTABLE \} from '\.\/e2eeSession\.rn';$/m,
   `import { e2eeEncrypt, e2eeDecrypt, e2eeCachePlaintext, e2eeGetCached, E2EE_UNDECRYPTABLE } from './stubs.ts';`],
  [/^import \{ createKeyedLock \} from '\.\/messageStore';$/m, `import { createKeyedLock } from '${CRYPTO}/messageStore';`],
  [/^import \{ redactIds, shortId, warnOnce \} from '\.\.\/\.\.\/lib\/diagLog';$/m,
   `import { redactIds, shortId, warnOnce } from './stubs.ts';`],
  [/from '\.\/index'; \/\/ the facade/, `from '${CRYPTO}/index'; //`],
];

const GROUP_SRC = readFileSync(join(HERE, 'groupSession.rn.ts'), 'utf8');

/** Build the module. `lockDecrypt: false` defeats the fix-E lock, to prove the race is real. */
function build(name: string, lockDecrypt: boolean): string {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  let src = GROUP_SRC;
  for (const [re, to] of REWRITES) {
    if (!re.test(src)) check(`rewrite ${String(re).slice(0, 40)}…`, false, 'groupSession.rn.ts changed its import block');
    src = src.replace(re, to);
  }
  const strayIdx = [...src.matchAll(/^import (?!type )[^\n]*from '([^']+)';$/gm)].map((m) => m[1])
    .filter((p) => !p.startsWith('./stubs') && !p.startsWith('file:'));
  if (strayIdx.length) check('every group import is accounted for', false, `unstubbed: ${strayIdx.join(', ')}`);
  if (!lockDecrypt) {
    const before = src;
    src = src.replace(/^const withGroupDecryptLock = createKeyedLock\(\);$/m,
      `const withGroupDecryptLock = <T,>(_k: string, fn: () => Promise<T>) => fn();`);
    if (src === before) check('the decrypt lock exists to be defeated', false, 'withGroupDecryptLock not found');
  }
  writeFileSync(join(dir, 'group.ts'), src);
  writeFileSync(join(dir, 'stubs.ts'), STUBS);
  return pathToFileURL(join(dir, 'group.ts')).href;
}

// Stubs: in-memory SecureStore (optionally slow, to widen the race window), a
// dumb "server", and an IDENTITY pairwise layer — the 1:1 ratchet is proven
// elsewhere and only obscures what is under test here.
const STUBS = `
import { createMessageStore } from '${CRYPTO}/messageStore';
const mem = new Map<string, string>();
export const _mem = mem;
export const _cfg = { slowMs: 0 };
const nap = () => _cfg.slowMs ? new Promise((r) => setTimeout(r, _cfg.slowMs)) : Promise.resolve();
export async function getItemAsync(k: string) { await nap(); return mem.has(k) ? mem.get(k)! : null; }
export async function setItemAsync(k: string, v: string) { await nap(); mem.set(k, v); }
export async function deleteItemAsync(k: string) { mem.delete(k); }
export const _server = {
  members: [] as string[],
  skdms: [] as { senderId: string; skdm: string }[],   // what a GET returns
  posted: [] as { recipientId: string; skdm: string }[], // what WE published
};
export async function api(path: string, opts?: any) {
  const method = (opts?.method ?? 'GET').toUpperCase();
  if (/\\/sender-keys$/.test(path)) {
    if (method === 'POST') { _server.posted.push(...opts.json.distributions); return {}; }
    return _server.skdms;
  }
  return { members: _server.members.map((userId) => ({ userId })) };
}
export async function getCachedUser() { return { id: 'me' }; }
export const E2EE_UNDECRYPTABLE = ' __e2ee_undecryptable__';
export async function e2eeEncrypt(_c: string, _p: string, t: string) { return t; }
export async function e2eeDecrypt(_c: string, _p: string, _id: number, w: string) { return w; }
const plain = new Map<string, string>();
const store = createMessageStore({ get: async k => plain.get(k) ?? null, set: async (k,v) => { plain.set(k,v); }, del: async k => { plain.delete(k); } });
export async function e2eeCachePlaintext(c: string, id: number, t: string, wire?: string) { if (id > 0) await store.put(c, id, t, wire); }
export async function e2eeGetCached(c: string, id: number, wire?: string, requireBodyTag = false) { return id > 0 ? store.get(c, id, wire, requireBodyTag) : null; }
export function redactIds(s: string) { return s; }
export function shortId(s: string) { return s.slice(0, 8); }
export function warnOnce() {}
`;

const PREFIX = 'GSK1:';
/** A peer sender we control: makes SKDMs and wire messages with the real crypto. */
function peer(): { key: () => OwnSenderKey; skdm: () => string; send: (t: string) => string; rotate: () => void } {
  let own = createSenderKey();
  return {
    key: () => own,
    skdm: () => JSON.stringify(distributionMessage(own)),
    send(t: string) { const { cipher, next } = groupEncrypt(own, t); own = next; return PREFIX + JSON.stringify(cipher); },
    rotate() { own = createSenderKey(); },
  };
}

async function main() {
  console.log('\nGroup sender-key recovery: lost own key, re-ingest, concurrent decrypt\n');

  {
    const g: any = await import(build('edited', true));
    const s: any = await import(pathToFileURL(join(WORK, 'edited', 'stubs.ts')).href);
    const sender = peer();
    s._server.skdms = [{ senderId: 'S', skdm: sender.skdm() }];
    const original = sender.send('original');
    check('first group decrypt populates plaintext cache', await g.groupDecryptMessage('edits', 'S', 42, original) === 'original');
    const edited = sender.send('corrected');
    check('an edit under the same id decrypts the replacement body', await g.groupDecryptMessage('edits', 'S', 42, edited) === 'corrected');
    check('replaying the edited body uses its cached plaintext', await g.groupDecryptMessage('edits', 'S', 42, edited) === 'corrected');
    await s.e2eeCachePlaintext('edits', 43, 'legacy untagged text');
    const replacement = sender.send('legacy corrected');
    check('a known edit bypasses an old untagged cache entry', await g.groupDecryptMessage('edits', 'S', 43, replacement, true) === 'legacy corrected');
    check('the migrated edit is then cacheable', await g.groupDecryptMessage('edits', 'S', 43, replacement, true) === 'legacy corrected');
  }

  // ── C: a freshly minted own key must be distributed ────────────────────────
  {
    const url = build('fixC', true);
    const g: any = await import(url);
    const s: any = await import(pathToFileURL(join(WORK, 'fixC', 'stubs.ts')).href);
    s._server.members = ['me', 'bob'];

    await g.groupEncryptMessage('g1', 'first');
    const firstPub = JSON.parse(s._server.posted[0].skdm).signPubHex;
    check('first send distributes the sender key', s._server.posted.length === 1 && !!firstPub);

    // The key vanishes (SecureStore cleared / restore onto a new device) while
    // membership is UNCHANGED — the case that used to be silently fatal.
    s._mem.delete('vc_gsk_own_g1');
    s._server.posted.length = 0;
    const wire = await g.groupEncryptMessage('g1', 'after key loss');

    check('a re-minted own key is redistributed even with unchanged membership',
      s._server.posted.length === 1, `posted ${s._server.posted.length} distributions`);
    const newPub = s._server.posted.length ? JSON.parse(s._server.posted[0].skdm).signPubHex : '';
    check('the distributed key is the NEW one (recipients can verify the signature)',
      !!newPub && newPub !== firstPub);
    check('the message just sent is signed by the key that was distributed',
      newPub === JSON.parse(s._mem.get('vc_gsk_own_g1')!).signPubHex && wire.startsWith(PREFIX));

    // And no churn on the healthy path: a third send with everything in place
    // must NOT redistribute (that would rewrite MEMBERS every send).
    s._server.posted.length = 0;
    await g.groupEncryptMessage('g1', 'third');
    check('a send with an intact key and stable membership distributes nothing',
      s._server.posted.length === 0);
  }

  // ── D: re-ingesting a known signer must not reset their chain ──────────────
  {
    const url = build('fixD', true);
    const g: any = await import(url);
    const s: any = await import(pathToFileURL(join(WORK, 'fixD', 'stubs.ts')).href);
    s._server.members = ['me', 'S', 'T'];

    const S = peer(), T = peer();
    s._server.skdms = [{ senderId: 'S', skdm: S.skdm() }];
    const sMsgs = [0, 1, 2, 3, 4].map((i) => S.send('s' + i));

    // Newest first (what a hydrate of a scrolled chat does): head jumps to 4 and
    // keys 0..3 are cached as skipped.
    check('first contact ingests and decrypts', await g.groupDecryptMessage('g2', 'S', 0, sMsgs[4]) === 's4');

    // S keeps sending (we have not seen these yet), so its CURRENT iteration is
    // now AHEAD of our head — the case where the old code replaced the record.
    S.send('s5'); S.send('s6'); S.send('s7');
    // S re-publishes its current state — routine: any membership change on S's
    // side reposts. A new sender T then forces a re-ingest.
    s._server.skdms = [{ senderId: 'S', skdm: S.skdm() }, { senderId: 'T', skdm: T.skdm() }];
    check('a new sender still installs on first contact',
      await g.groupDecryptMessage('g2', 'T', 0, T.send('t0')) === 't0');

    // The in-flight message, below the re-published head. This is what used to die.
    let inflight = '';
    try { inflight = await g.groupDecryptMessage('g2', 'S', 0, sMsgs[2]); }
    catch (e: any) { inflight = 'THREW: ' + e.message; }
    check('an in-flight message below a re-published SKDM still decrypts', inflight === 's2', inflight);

    // A real ROTATION (new signing key) must still take effect, or a rotated
    // sender becomes permanently unreadable — the opposite failure.
    S.rotate();
    s._server.skdms = [{ senderId: 'S', skdm: S.skdm() }];
    const rotated = S.send('after rotation');
    let got = '';
    try {
      // Force the re-ingest the way the app does: the record is stale, decrypt
      // fails, and the next ingest (triggered here by a fresh sender) installs it.
      const U = peer();
      s._server.skdms.push({ senderId: 'U', skdm: U.skdm() });
      await g.groupDecryptMessage('g2', 'U', 0, U.send('u0'));
      got = await g.groupDecryptMessage('g2', 'S', 0, rotated);
    } catch (e: any) { got = 'THREW: ' + e.message; }
    check('a genuine key ROTATION still replaces the record', got === 'after rotation', got);
  }

  // ── E: concurrent decrypts of one sender must not clobber each other ───────
  //
  // loadPeer → groupDecrypt → savePeer is last-write-wins. A stale write throws
  // away the other decrypt's advanced head and its cached skipped keys, and
  // resurrects skipped keys that have already been CONSUMED — so the stored
  // record no longer describes the chain. Everything below runs the real
  // module, once with the lock defeated and once as it ships, and compares the
  // persisted record against the same three decrypts run sequentially.
  async function raceRecord(url: string, stubsUrl: string, sequential: boolean): Promise<string> {
    const g: any = await import(url);
    const s: any = await import(stubsUrl);
    s._server.members = ['me', 'S'];
    const S = peer();
    s._server.skdms = [{ senderId: 'S', skdm: S.skdm() }];
    const msgs = [0, 1, 2, 3, 4, 5].map((i) => S.send('m' + i));
    await g.groupDecryptMessage('g3', 'S', 0, msgs[0]);      // install the record
    s._cfg.slowMs = 2;                                       // widen the store round-trips
    const calls = [msgs[5], msgs[1], msgs[3]].map((w) => () => g.groupDecryptMessage('g3', 'S', 0, w));
    if (sequential) { for (const c of calls) await c(); } else { await Promise.all(calls.map((c) => c())); }
    s._cfg.slowMs = 0;
    const rec = JSON.parse(s._mem.get('vc_gsk_peer_g3_S')!);
    return `head=${rec.iteration} skipped=[${Object.keys(rec.skipped).sort().join(',')}]`;
  }

  const seq = await raceRecord(build('raceSeq', true), pathToFileURL(join(WORK, 'raceSeq', 'stubs.ts')).href, true);
  const unlocked = await raceRecord(build('raceOff', false), pathToFileURL(join(WORK, 'raceOff', 'stubs.ts')).href, false);
  const locked = await raceRecord(build('raceOn', true), pathToFileURL(join(WORK, 'raceOn', 'stubs.ts')).href, false);
  check('without the lock, a concurrent decrypt corrupts the stored chain (the bug is real)',
    unlocked !== seq, `unlocked ${unlocked} vs sequential ${seq}`);
  check('with the lock, concurrent decrypts leave exactly the sequential record',
    locked === seq, `locked ${locked} vs sequential ${seq}`);

  // Keyed per (chat, sender): two senders must not serialize behind each other.
  {
    const url = build('keying', true);
    const g: any = await import(url);
    const s: any = await import(pathToFileURL(join(WORK, 'keying', 'stubs.ts')).href);
    s._server.members = ['me', 'A', 'B'];
    const A = peer(), B = peer();
    s._server.skdms = [{ senderId: 'A', skdm: A.skdm() }, { senderId: 'B', skdm: B.skdm() }];
    const both = await Promise.all([
      g.groupDecryptMessage('g4', 'A', 0, A.send('a')),
      g.groupDecryptMessage('g4', 'B', 0, B.send('b')),
    ]);
    check('two different senders decrypt concurrently', both.join(',') === 'a,b');
  }

  // ── B (chatService, not runnable here): assert the guard by shape ──────────
  // searchInChat decrypts up to 1000 cached messages; without the same bulk
  // guard hydrateMessages uses, two permanent failures from old history reset a
  // healthy live session and break the next call with that peer.
  const CHAT = readFileSync(join(ROOT, 'lib', 'chatService.ts'), 'utf8').replace(/\r\n/g, '\n');
  const search = CHAT.slice(CHAT.indexOf('export async function searchInChat'));
  const searchBody = search.slice(0, search.indexOf('\n}\n') + 3);
  check('searchInChat was located', searchBody.length > 100 && searchBody.includes('hits'));
  check('searchInChat raises the bulk-decrypt guard',
    /_bulkDecryptDepth\+\+/.test(searchBody) && /decryptFromChat\(/.test(searchBody));
  check('searchInChat releases it in a finally (an early break must not leak it)',
    /finally\s*\{\s*_bulkDecryptDepth--;/.test(searchBody));

  rmSync(WORK, { recursive: true, force: true });
  console.log(failures ? `\n  ${failures} FAILED\n` : '\n  group sender-key state survives key loss, re-ingest and concurrency\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
