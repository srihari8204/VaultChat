// groupSendLock.selftest.ts — run: npx tsx services/crypto/groupSendLock.selftest.ts
//
// THE BUG THIS PINS
//
// groupEncryptMessage is a read-modify-write over the sending chain:
//   ensureOwn(chatId) → groupEncrypt(own, …) → saveOwn(chatId, next)
//
// and senderKey.ts derives BOTH the AES-256 key and the 12-byte nonce from the
// same message key:
//   const out = hkdf(sha256, mk, new Uint8Array(32), INFO_MSG, 44);
//   return { key: out.slice(0, 32), nonce: out.slice(32, 44) };
//
// So two sends that read the same chain state encrypt different plaintexts under
// an IDENTICAL (key, nonce). Under AES-GCM that is the one prohibited operation:
// it yields P1 XOR P2 and the GHASH subkey. The server holds both ciphertexts.
//
// The 1:1 path was always serialized (e2eeSession.rn.ts: withLock(peerId, …)).
// The group path was not. This file asserts it is now, and — more importantly —
// asserts the PROPERTY rather than the syntax, by running the real lock helper
// against the real interleaving.

import { createKeyedLock } from './messageStore';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, 'groupSession.rn.ts'), 'utf8');
// Strip line comments: this file and that one both DESCRIBE the old code, and a
// raw substring search would match the prose instead of the code.
const code = src.split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; }).join('\n');

console.log('\nGroup sender-key send is serialized (nonce-reuse guard)\n');

// ── the property: an unlocked read-modify-write really does collide ──────────
// Proven, not asserted, so the test fails if createKeyedLock ever stops working.

async function racingSends(useLock: boolean): Promise<number[]> {
  let chain = 0;                       // stands in for the persisted chain state
  const noncesUsed: number[] = [];
  const withLock = createKeyedLock();

  const send = async () => {
    const body = async () => {
      const read = chain;              // ensureOwn
      await new Promise((r) => setTimeout(r, 1));  // ensureDistributed / SecureStore
      noncesUsed.push(read);           // msgKeyMaterial(mk) — key AND nonce
      chain = read + 1;                // saveOwn
    };
    return useLock ? withLock('chat-1', body) : body();
  };

  await Promise.all([send(), send(), send(), send()]);
  return noncesUsed;
}

// Wrapped rather than top-level await: this repo's tsx runner emits CJS, where
// a top-level await is a transform error rather than a runtime one.
async function raceChecks(): Promise<void> {
  const unlocked = await racingSends(false);
  check('without a lock, concurrent sends DO collide (the bug is real)',
    new Set(unlocked).size < unlocked.length,
    `iterations used: ${unlocked.join(',')}`);

  const locked = await racingSends(true);
  check('with the lock, every send gets a distinct chain iteration',
    new Set(locked).size === locked.length,
    `iterations used: ${locked.join(',')}`);
  check('locked sends are strictly sequential',
    locked.every((v, i) => v === i),
    locked.join(','));
}

// ── the wiring: the real module must actually use it ────────────────────────

check('groupSession.rn.ts imports the shared lock helper',
  /import\s*\{[^}]*createKeyedLock[^}]*\}\s*from\s*'\.\/messageStore'/.test(code));

check('a send lock is constructed',
  /createKeyedLock\(\)/.test(code));

check('groupEncryptMessage acquires it, keyed on chatId',
  /export async function groupEncryptMessage[\s\S]{0,200}?withGroupSendLock\(\s*chatId\s*,/.test(code),
  'the exported entry point must be the guarded one');

// The dangerous shape: the read-modify-write must not sit in the exported
// function any more. If saveOwn reappears there, the lock has been bypassed.
const exported = code.slice(code.indexOf('export async function groupEncryptMessage'));
const exportedBody = exported.slice(0, exported.indexOf('\n}') + 2);
check('the exported function no longer performs the read-modify-write itself',
  !/saveOwn\(/.test(exportedBody),
  'saveOwn is back inside the unlocked entry point');

check('the locked worker still does the real work',
  /async function groupEncryptMessageLocked[\s\S]{0,400}?saveOwn\(/.test(code));

// ── the invariant that makes this load-bearing ───────────────────────────────
// If the nonce ever stops being derived from the message key, this whole class
// of bug changes shape — so pin the derivation that makes collisions fatal.
const sk = fs.readFileSync(path.join(HERE, 'senderKey.ts'), 'utf8');
check('nonce is still derived from the message key (so a repeat is fatal)',
  /out\.slice\(\s*32\s*,\s*44\s*\)/.test(sk) && /out\.slice\(\s*0\s*,\s*32\s*\)/.test(sk),
  'if this changed, revisit whether the lock is still the right guard');

raceChecks().then(() => {
  console.log(failures
    ? `\n  ${failures} FAILED — group sends can reuse an AES-GCM nonce\n`
    : '\n  group sends are serialized; no (key, nonce) reuse\n');
  process.exit(failures ? 1 : 0);
});
