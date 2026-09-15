// lib/cacheCrypto.selftest.ts
//
// Node proof of the at-rest cache field codec (#32 Phase B): a field sealed under
// the DEK round-trips only with that DEK; a wrong DEK or a missing key cannot
// recover the plaintext; legacy plaintext rows stay readable; and the flag-off /
// locked state is a true pass-through. Mirrors encField/decField exactly against
// the pure crypto (vaultKeys) that cacheCrypto layers SecureStore over.
// Run:  npx tsx lib/cacheCrypto.selftest.ts

import { open, seal } from '../services/security/vaultKeys';
import { randomBytes } from '@noble/hashes/utils.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CACHE_SRC = readFileSync(join(HERE, 'cacheCrypto.ts'), 'utf8');
const FLAGS_SRC = readFileSync(join(ROOT, 'constants', 'flags.ts'), 'utf8');

const PREFIX = 'enc:v1:';

// Faithful copies of the codec, parameterised by the in-memory DEK (null = locked).
function encField(dek: Uint8Array | null, value: string | null): string | null {
  if (value == null) return null;
  if (dek == null) return value;
  if (value.startsWith(PREFIX)) return value;
  return PREFIX + seal(dek, value);
}
function decField(dek: Uint8Array | null, value: string | null): string | null {
  if (value == null) return null;
  if (!value.startsWith(PREFIX)) return value;
  if (dek == null) return value;
  const pt = open(dek, value.slice(PREFIX.length));
  return pt == null ? value : pt;
}

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error('  ✗ FAIL:', msg); throw new Error('assertion failed: ' + msg); }
  passed++;
  console.log('  ✓', msg);
}

function main(): void {
  console.log('cacheCrypto self-test\n');

  const dek      = randomBytes(32);
  const wrongDek = randomBytes(32);
  const body     = 'meet me at the safehouse at 0300';

  // 1. Round-trips under the right DEK.
  const sealed = encField(dek, body);
  assert(sealed!.startsWith(PREFIX), 'sealed field carries the enc:v1: marker');
  assert(decField(dek, sealed) === body, 'right DEK recovers the plaintext');

  // 2. The stored value never contains the plaintext.
  assert(!sealed!.includes('safehouse'), 'sealed field leaks no plaintext body');

  // 3. A wrong DEK cannot read it — degrades to the sealed value, not plaintext.
  assert(decField(wrongDek, sealed) === sealed, 'wrong DEK cannot recover the plaintext');

  // 4. Locked / flag-off is a true pass-through (identity both ways).
  assert(encField(null, body) === body, 'no DEK → encField is identity');
  assert(decField(null, body) === body, 'no DEK → decField is identity on plaintext');
  assert(decField(null, sealed) === sealed, 'no DEK → sealed value left untouched (no crash)');

  // 5. Legacy plaintext rows coexist with sealed rows (lazy migration).
  assert(decField(dek, body) === body, 'unprefixed legacy row reads as-is even with a DEK');

  // 6. Idempotent: re-sealing an already-sealed value is a no-op.
  assert(encField(dek, sealed) === sealed, 're-encrypting an already-sealed field is a no-op');

  // 7. Null/undefined fields pass through unchanged.
  assert(encField(dek, null) === null && decField(dek, null) === null, 'null fields stay null');

  // 8. The copies above must still match the real codec, or every check is theatre.
  //    (cacheCrypto.ts can't be imported here — it pulls in expo-secure-store.)
  for (const line of [
    "if (_dek == null) return value;                 // flag off / locked → pass-through",
    "if (value.startsWith(PREFIX)) return value;     // already sealed (idempotent)",
    "if (!value.startsWith(PREFIX)) return value;    // legacy plaintext row",
    "if (_dek == null) return value;                 // locked → leave sealed",
  ]) assert(CACHE_SRC.includes(line), `real cacheCrypto still has: ${line.split('//')[1].trim()}`);

  // 9. THE TWO USER SHAPES, stated as their own checks (#32 opt-in sealing).
  //
  // A user WITHOUT a local PIN never reaches provisionCacheKey/unlockCacheKey
  // (they run only from sealCurrentSession/loadSealedSession, which run only
  // from pinStore.setPin / app-lock), so their DEK is null forever and both
  // codecs are the identity function — byte-identical storage to before.
  const pinless = null;                 // no PIN → no seal key → no DEK, ever
  assert(encField(pinless, body) === body && decField(pinless, body) === body,
    'PIN-LESS user: codecs are pass-through in both directions (zero change)');
  const onDisk = encField(dek, body)!;   // what a PIN'd user's row looks like
  assert(decField(pinless, onDisk) === onDisk,
    'PIN-LESS user: a sealed row is left alone, never decoded or destroyed');
  // A user WITH a PIN gets a DEK, and their values round-trip sealed.
  assert(decField(dek, onDisk) === body,
    "PIN'd user: values round-trip through the sealed form");
  assert(onDisk !== body && onDisk.startsWith(PREFIX),
    "PIN'd user: what lands on disk is ciphertext, not the body");
  // And the install that upgrades mid-life keeps reading its old rows.
  assert(decField(dek, 'legacy row written before sealing') === 'legacy row written before sealing',
    'LEGACY: an unprefixed row still reads after a PIN is set (lazy migration)');

  // 10. WIRING GUARD — what keeps a flag from claiming protection it can't give.
  //
  // encField/decField gate on the in-memory DEK, and the ONLY things that load
  // one are provisionCacheKey/unlockCacheKey, which are called from exactly one
  // place each: api.sealCurrentSession / api.loadSealedSession. If nothing in
  // the app calls THOSE, the DEK is never loaded, the codecs stay identity and
  // VAULT_CACHE_ENCRYPTED seals nothing while claiming to. Fail loudly if a
  // flag is flipped on before the wiring exists.
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // Dot-dirs are skipped wholesale: besides .git/.expo, sibling suites in
      // scripts/test-all create and delete scratch dirs like
      // `.selftest-backupcrypto-<pid>/` while this walk is running, and reading
      // a file that existed a millisecond ago throws ENOENT.
      if (e.name.startsWith('.')) continue;
      if (['node_modules', 'android', 'ios', 'dist'].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p);
    }
  })(ROOT);
  const callers = files.filter(f => {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    if (rel === 'lib/api.ts' || rel.endsWith('.selftest.ts')) return false;   // definition site / this test
    const src = readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');   // ignore prose
    return /\b(sealCurrentSession|loadSealedSession)\s*\(/.test(src);
  });
  const cacheOn   = /^export const VAULT_CACHE_ENCRYPTED = true/m.test(FLAGS_SRC);
  const sessionOn = /^export const VAULT_SESSION_SEALED = true/m.test(FLAGS_SRC);

  // The guard as a pure function, so it can be tested against states that are
  // not the current one — a guard nobody has ever seen fail is a guard nobody
  // knows works.
  function guardViolations(cache: boolean, session: boolean, nCallers: number): string[] {
    const v: string[] = [];
    if (cache && nCallers === 0) v.push('cache flag on with no seal/unseal caller');
    if (cache && !session)       v.push('cache flag on without the session seal that provides the DEK');
    if (session && nCallers === 0) v.push('session flag on with no seal/unseal caller');
    return v;
  }
  assert(guardViolations(cacheOn, sessionOn, callers.length).length === 0,
    `flags match the wiring that exists (cache=${cacheOn} session=${sessionOn} callers=${callers.length})`);
  assert(guardViolations(true, true, 0).length > 0 &&
         guardViolations(false, true, 0).length > 0 &&
         guardViolations(true, false, 9).length > 0,
    'the wiring guard still BITES: a flag on with no caller, or cache without session, is rejected');
  console.log(`  · wiring: ${callers.length} caller(s) of sealCurrentSession/loadSealedSession; ` +
              `flags cache=${cacheOn} session=${sessionOn}`);

  // 11. The opt-in shape itself. Sealing must hang off the PIN, and the unlock
  //     screen must have a real failure path — the two things that make
  //     VAULT_SESSION_SEALED safe to have on. Asserted against source so a
  //     refactor that quietly removes either one fails here.
  const src = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
  const PIN_SRC   = src('services', 'security', 'pinStore.ts');
  const LAYOUT_SRC = src('app', '_layout.tsx');
  const LOCK_SRC  = src('app', 'app-lock.tsx');
  assert(/setPin[\s\S]*?sealCurrentSession\(pin\)/.test(PIN_SRC),
    'setPin() seals the existing session — sealing is PIN-gated, never blanket');
  assert(/clearPin[\s\S]*?unsealCurrentSession\(\)/.test(PIN_SRC),
    'clearPin() unseals back to the plaintext path — removing the PIN never strands a user');
  assert(/session\.sealedLocked/.test(LAYOUT_SRC) && /router\.replace\('\/app-lock'/.test(LAYOUT_SRC),
    'the boot path routes a sealed-but-locked session to the unlock screen');
  assert(/loadSealedSession\(pin\)/.test(LOCK_SRC),
    'the unlock screen actually unseals with the local PIN');
  assert(/Forgotten your PIN\?/.test(LOCK_SRC) && /Alert\.alert/.test(LOCK_SRC),
    'a failed unseal offers an explained re-login, not a silent logout');

  console.log(`\nALL ${passed} CACHE-CRYPTO CHECKS PASSED`);
}

main();
