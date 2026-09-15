// tombstonePolicy.selftest.ts — run: npx tsx services/crypto/tombstonePolicy.selftest.ts
//
// THE BUG THIS PINS
//
// e2eeDecrypt caches an UNDECRYPTABLE tombstone under (chatId, messageId) so a
// hopeless message is never re-attempted. That tombstone is IRREVERSIBLE:
// MessageStore has no delete, and the cache read at the top of e2eeDecrypt
// short-circuits every later attempt — including the "retry the ones that never
// decrypted" pass in app/chat.tsx.
//
// It used to be written for EVERY error except one hardcoded string, so a
// transient failure — SecureStore throwing while the device is locked, a torn
// JSON blob, a missing one-time prekey, a concurrent re-key — destroyed the
// message permanently. The policy is now an allow-list of genuinely permanent
// crypto failures.
//
// This runs the REAL e2eeSession.rn.ts body (import block rewritten against
// stubs, as lib/twoUserConversation.selftest.ts does) over the REAL
// messageStore + chunkedKV, with only the session core faked so each error can
// be injected. The assertion is behavioural: fail once, then make the session
// healthy and ask again — a tombstoned message stays dead, a retryable one
// decrypts.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CRYPTO = pathToFileURL(HERE).href;

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

// ── build the real module against stubs ──────────────────────────────────────
const WORK = join(tmpdir(), 'vc-tombstone-' + process.pid);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const REWRITES: [RegExp, string][] = [
  [/^import \* as SecureStore from 'expo-secure-store';$/m, `import * as SecureStore from './stubs.ts';`],
  [/^import \{ api \} from '\.\.\/\.\.\/lib\/api';$/m, `import { api } from './stubs.ts';`],
  [/^import \{ createE2EESession \} from '\.\/e2eeSession';$/m, `import { createE2EESession } from './stubs.ts';`],
  [/^import type \{ KVStore, KeyBundleTransport, PublishBundle, FetchedBundle \} from '\.\/e2eeSession';$/m,
   `import type { KVStore, KeyBundleTransport, PublishBundle, FetchedBundle } from '${CRYPTO}/e2eeSession';`],
  [/^import \{ chunkedKV \} from '\.\/e2eeStorage';$/m, `import { chunkedKV } from '${CRYPTO}/e2eeStorage';`],
  [/^import \{ sqliteKV \} from '\.\/plaintextStore\.rn';$/m, `import { sqliteKV } from './stubs.ts';`],
  [/^import \{ createMessageStore, createKeyedLock \} from '\.\/messageStore';$/m,
   `import { createMessageStore, createKeyedLock } from '${CRYPTO}/messageStore';`],
];

let src = readFileSync(join(HERE, 'e2eeSession.rn.ts'), 'utf8');
for (const [re, to] of REWRITES) {
  check(`rewrite ${String(re).slice(0, 44)}…`, re.test(src), 'e2eeSession.rn.ts changed its import block');
  src = src.replace(re, to);
}
const stray = [...src.matchAll(/^import (?!type )[^\n]*from '([^']+)';$/gm)].map((m) => m[1])
  .filter((p) => !p.startsWith('./stubs') && !p.startsWith('file:'));
check('every import is accounted for', stray.length === 0, `unstubbed: ${stray.join(', ')}`);
writeFileSync(join(WORK, 'rn.ts'), src);

// The session core, faked so an arbitrary decrypt failure can be injected.
// Everything else below it (messageStore, chunkedKV, the keyed lock) is real.
writeFileSync(join(WORK, 'stubs.ts'), `
const mem = new Map<string, string>();
export async function getItemAsync(k: string) { return mem.has(k) ? mem.get(k)! : null; }
export async function setItemAsync(k: string, v: string) { mem.set(k, v); }
export async function deleteItemAsync(k: string) { mem.delete(k); }
export async function api() { throw new Error('no network in this suite'); }
export function sqliteKV(legacy: any) { return legacy; }   // real store is SQLite; KV is enough here
export const _fail = { err: null as string | null };
export function createE2EESession(_cfg: any) {
  return {
    isEnvelope: () => true,
    async decryptFromPeer(_p: string, _w: string) {
      if (_fail.err) throw new Error(_fail.err);
      return 'hello';
    },
    async encryptForPeer(_p: string, t: string) { return t; },
    async resetSession() {}, async peerIdentityKey() { return null; },
    async hasSession() { return true; }, async ensurePublished() {},
  };
}
`);

async function main() {
  const stubs: any = await import(pathToFileURL(join(WORK, 'stubs.ts')).href);
  const rn: any = await import(pathToFileURL(join(WORK, 'rn.ts')).href);

  let nextId = 1;
  /** Fail once with `err`, then heal. Returns true if the message is still readable. */
  async function survives(err: string): Promise<boolean> {
    const id = nextId++;
    stubs._fail.err = err;
    try { await rn.e2eeDecrypt('c1', 'peer1', id, 'wire' + id); } catch { /* expected */ }
    stubs._fail.err = null;                       // the session is healthy again
    try { return (await rn.e2eeDecrypt('c1', 'peer1', id, 'wire' + id)) === 'hello'; }
    catch { return false; }                       // tombstoned: never retried
  }

  console.log('\nUndecryptable tombstone is written ONLY for permanent crypto failures\n');

  // PERMANENT — the key for this ciphertext is gone. Tombstone is correct and
  // is what keeps a scrolled-up chat from re-attempting forever.
  for (const err of [
    'aes/gcm: invalid ghash tag',                              // @noble backend
    'aes-gcm: authentication failed',                          // Rust backend
    'ratchet: cannot skip messages without a receiving chain',
    'ratchet: too many skipped messages',
  ]) check(`PERMANENT → tombstoned: ${err}`, !(await survives(err)));

  // TRANSIENT — every one of these used to tombstone, losing the message for good.
  for (const err of [
    'e2ee: no session and no X3DH header to bootstrap responder',
    'Could not decrypt the value for key vc_e2ee_session_peer1',  // SecureStore, device locked
    'Unexpected end of JSON input',                              // torn blob
    'e2ee: missing requested one-time prekey',                   // MISSING_OPK
    'e2ee: concurrent re-key — keeping our session',             // CONCURRENT_REKEY
    'Network request failed',
  ]) check(`TRANSIENT → retryable: ${err}`, await survives(err));

  // The healthy path is untouched: a first-try success still caches plaintext.
  stubs._fail.err = null;
  const ok = await rn.e2eeDecrypt('c1', 'peer1', 999, 'wireOK');
  check('a successful decrypt still returns and caches its plaintext',
    ok === 'hello' && (await rn.e2eeGetCached('c1', 999)) === 'hello');

  rmSync(WORK, { recursive: true, force: true });
  console.log(failures
    ? `\n  ${failures} FAILED — the tombstone policy is wrong\n`
    : '\n  only permanent crypto failures are tombstoned\n');
  process.exit(failures ? 1 : 0);
}

main();
