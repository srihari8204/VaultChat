// services/security/vaultKeys.selftest.ts
//
// Node-runnable proof that the duress/decoy split is REAL cryptographic
// separation, not a UI flag. Run:  npx tsx services/security/vaultKeys.selftest.ts
//
// Uses only the pure crypto core (no expo-secure-store), so it runs in plain
// Node — same model as services/crypto/e2ee.selftest.ts.

import {
  createVaultHeaders, deriveVaultKey, newSalt, open, seal, tryUnlock,
  makePinRecord, checkPinRecord,
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

  // 9. PIN credential — the replacement for the unsalted SHA-256 and the
  //    stored-in-the-clear PIN. The record must never contain the PIN, and two
  //    users choosing the same PIN must not produce the same record.
  const rec = makePinRecord('4829');
  assert(checkPinRecord(rec, '4829'), 'the right PIN verifies');
  assert(!checkPinRecord(rec, '4828'), 'a wrong PIN does not');
  assert(!checkPinRecord(rec, ''), 'an empty PIN does not');
  assert(!checkPinRecord(null, '4829'), 'a missing record verifies nothing');
  assert(!JSON.stringify(rec).includes('4829'), 'the record does not contain the PIN');

  const rec2 = makePinRecord('4829');
  assert(rec.verifier !== rec2.verifier && rec.salt !== rec2.salt,
    'the same PIN twice yields different records (per-install salt)');
  assert(!checkPinRecord({ ...rec, salt: rec2.salt }, '4829'),
    'a record with a swapped salt stops verifying');

  // A tampered/truncated record must fail closed, not throw.
  assert(!checkPinRecord({ v: 1, salt: rec.salt, verifier: 'not-base64!!' } as any, '4829'),
    'a corrupt verifier fails closed');
  assert(!checkPinRecord({ v: 2, salt: rec.salt, verifier: rec.verifier } as any, '4829'),
    'an unknown record version fails closed');

  // ── P5: the native-GCM wire-format contract ──────────────────────────
  // On device, seal/open run on quick-crypto (OpenSSL). Node's crypto is the
  // same OpenSSL API, so sealing here with node:crypto and opening with the
  // @noble path (QC is absent under Node) proves the exact byte layout the
  // native branch emits — base64( nonce(12) || ct || tag(16) ) — opens under
  // @noble, and vice versa. If either direction drifts, sealed caches written
  // by one engine would silently stop opening under the other.
  {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('node:crypto');
    const { seal, open } = require('./vaultKeys');
    const key = nodeCrypto.randomBytes(32);
    const msg = 'engine-compat: ఇద్దరూ ఒకటే bytes ✓';

    // native-style seal (OpenSSL) → @noble open
    const nonce = nodeCrypto.randomBytes(12);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([c.update(Buffer.from(msg, 'utf8')), c.final(), c.getAuthTag()]);
    const envelope = Buffer.concat([nonce, ct]).toString('base64');
    assert(open(new Uint8Array(key), envelope) === msg,
      'an OpenSSL-sealed envelope opens under @noble');

    // @noble seal → native-style open (OpenSSL)
    const env2 = Buffer.from(seal(new Uint8Array(key), msg), 'base64');
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, env2.subarray(0, 12));
    d.setAuthTag(env2.subarray(env2.length - 16));
    const back = Buffer.concat([d.update(env2.subarray(12, env2.length - 16)), d.final()]).toString('utf8');
    assert(back === msg, 'a @noble-sealed envelope opens under OpenSSL');

    // empty plaintext stays exactly at the 28-byte floor and round-trips
    assert(open(new Uint8Array(key), seal(new Uint8Array(key), '')) === '',
      'an empty plaintext round-trips (28-byte envelope floor)');
  }

  console.log(`\nALL ${passed} VAULT-SEPARATION CHECKS PASSED`);
}

main();
