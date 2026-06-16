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

  console.log(`\nALL ${passed} CACHE-CRYPTO CHECKS PASSED`);
}

main();
