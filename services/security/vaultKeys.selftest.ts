// services/security/vaultKeys.selftest.ts
//
// Node-runnable proof that the duress/decoy split is REAL cryptographic
// separation, not a UI flag. Run:  npx tsx services/security/vaultKeys.selftest.ts
//
// Uses only the pure crypto core (no expo-secure-store), so it runs in plain
// Node — same model as services/crypto/e2ee.selftest.ts.

import {
  createVaultHeaders, deriveVaultKey, newSalt, open, seal, tryUnlock,
} from './vaultKeys';

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error('  ✗ FAIL:', msg); throw new Error('assertion failed: ' + msg); }
  passed++;
  console.log('  ✓', msg);
}

function main(): void {
  console.log('vaultKeys separation self-test\n');

  const REAL = '481923';
  const DURESS = '000000';
  const salt = newSalt();

  // 1. seal/open round-trip with the right key.
  const k = deriveVaultKey(REAL, salt);
  const env = seal(k, 'hello-vault');
  assert(open(k, env) === 'hello-vault', 'seal/open round-trips with the correct key');

  // 2. a wrong key cannot open a sealed blob (GCM auth fails → null).
  const wrong = deriveVaultKey(DURESS, salt);
  assert(open(wrong, env) === null, 'a different PIN-derived key cannot open the blob');

  // 3. provision both vaults.
  const { realHeader, decoyHeader } = createVaultHeaders(
    REAL, DURESS, salt,
    { who: 'real-account', secret: 'top-secret-session' },
    { who: 'decoy-account' },
  );

  // 4. the real PIN opens the real vault and its payload.
  const a = tryUnlock(REAL, salt, realHeader, decoyHeader);
  assert(a?.kind === 'real', 'real PIN → real vault');
  assert(a?.payload.secret === 'top-secret-session', 'real vault carries the real secret');

  // 5. the duress PIN opens the decoy — and ONLY the decoy.
  const b = tryUnlock(DURESS, salt, realHeader, decoyHeader);
  assert(b?.kind === 'decoy', 'duress PIN → decoy vault');
  assert((b?.payload as any).secret === undefined, 'decoy vault never exposes the real secret');

  // 6. THE CRUX: the duress key cannot decrypt the real header at all.
  const duressKey = deriveVaultKey(DURESS, salt);
  assert(open(duressKey, realHeader) === null,
    'duress key CANNOT decrypt the real vault header (cryptographically unreachable)');

  // 7. a wrong PIN opens nothing.
  const c = tryUnlock('999999', salt, realHeader, decoyHeader);
  assert(c === null, 'an unknown PIN opens neither vault');

  // 8. salt matters — same PIN + different salt derives a different key.
  const k2 = deriveVaultKey(REAL, newSalt());
  assert(open(k2, env) === null, 'same PIN with a different salt cannot open the blob');

  console.log(`\nALL ${passed} VAULT-SEPARATION CHECKS PASSED`);
}

main();
