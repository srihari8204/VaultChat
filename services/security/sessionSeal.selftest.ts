// services/security/sessionSeal.selftest.ts
//
// Node proof that a session sealed under the REAL PIN is recoverable only with
// the real PIN — a duress/decoy or wrong PIN cannot unseal it. Exercises the
// pure crypto (vaultKeys) that sessionSeal layers SecureStore over.
// Run:  npx tsx services/security/sessionSeal.selftest.ts

import { deriveVaultKey, newSalt, open, seal } from './vaultKeys';

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error('  ✗ FAIL:', msg); throw new Error('assertion failed: ' + msg); }
  passed++;
  console.log('  ✓', msg);
}

function main(): void {
  console.log('sessionSeal self-test\n');

  const REAL = '481923';
  const DURESS = '000000';
  const salt = newSalt();
  const tokens = { access: 'real.jwt.access', refresh: 'real.jwt.refresh' };

  // Seal the session under the REAL PIN.
  const realKey = deriveVaultKey(REAL, salt);
  const blob = seal(realKey, JSON.stringify(tokens));

  // Real PIN unseals it.
  const ok = open(deriveVaultKey(REAL, salt), blob);
  assert(ok != null && JSON.parse(ok).access === tokens.access, 'real PIN unseals the session');

  // Duress PIN cannot.
  assert(open(deriveVaultKey(DURESS, salt), blob) === null, 'duress PIN cannot unseal the real session');

  // A wrong PIN cannot.
  assert(open(deriveVaultKey('999999', salt), blob) === null, 'a wrong PIN cannot unseal the session');

  // The sealed blob never contains the plaintext token.
  assert(!blob.includes('real.jwt'), 'sealed blob leaks no plaintext token');

  console.log(`\nALL ${passed} SESSION-SEAL CHECKS PASSED`);
}

main();
