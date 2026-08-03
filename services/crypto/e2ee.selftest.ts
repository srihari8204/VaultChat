/**
 * Node self-test for services/crypto/e2ee.ts — run with:
 *   node --experimental-strip-types services/crypto/e2ee.selftest.ts
 *
 * Proves the REAL crypto core works end-to-end. This file is dev-only and is
 * never imported by the app (Metro only ever resolves ./e2ee, not the test).
 */
import {
  generateDH, generateSigningKey, sign,
  x3dhInitiator, x3dhResponder,
  ratchetInitAlice, ratchetInitBob, ratchetEncrypt, ratchetDecrypt,
  serializeState, deserializeState, encodeEnvelope, decodeEnvelope,
  utf8, fromUtf8, bytesToHex,
  type KeyPair, type PreKeyBundle, type Envelope, type RatchetState,
} from './e2ee';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}
function checkThrows(name: string, fn: () => void): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(name, threw);
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b);

interface User {
  identity: KeyPair; signing: KeyPair; spk: KeyPair; spkSig: Uint8Array; opk: KeyPair;
}
function makeUser(): User {
  const identity = generateDH();
  const signing = generateSigningKey();
  const spk = generateDH();
  const spkSig = sign(spk.pub, signing.priv);
  const opk = generateDH();
  return { identity, signing, spk, spkSig, opk };
}
function bundleOf(u: User, withOpk = true): PreKeyBundle {
  return {
    identityKey: u.identity.pub,
    signingKey: u.signing.pub,
    signedPreKey: u.spk.pub,
    signedPreKeySig: u.spkSig,
    oneTimePreKey: withOpk ? u.opk.pub : null,
    oneTimePreKeyId: withOpk ? 1 : null,
  };
}
function bootstrap(withOpk = true): { a: RatchetState; b: RatchetState; skMatch: boolean } {
  const alice = makeUser();
  const bob = makeUser();
  const init = x3dhInitiator(alice.identity, bundleOf(bob, withOpk));
  const skB = x3dhResponder(bob.identity, bob.spk, withOpk ? bob.opk : null, init.header);
  return {
    a: ratchetInitAlice(init.sk, bob.spk.pub),
    b: ratchetInitBob(skB, bob.spk),
    skMatch: sameBytes(init.sk, skB),
  };
}
const enc = (s: RatchetState, m: string): Envelope => ratchetEncrypt(s, utf8(m));
const dec = (s: RatchetState, e: Envelope): string => fromUtf8(ratchetDecrypt(s, e));

console.log('\nVaultChat E2EE core self-test\n──────────────────────────────');

// 1. X3DH agreement (with and without one-time prekey)
console.log('X3DH key agreement:');
check('Alice & Bob derive identical SK (with OPK)', bootstrap(true).skMatch);
check('Alice & Bob derive identical SK (no OPK)', bootstrap(false).skMatch);

// 2. Bundle authentication
console.log('Bundle authentication:');
checkThrows('forged signed-prekey signature is rejected', () => {
  const alice = makeUser();
  const bob = makeUser();
  const bad = bundleOf(bob);
  bad.signedPreKeySig = sign(bob.spk.pub, makeUser().signing.priv); // wrong signer
  x3dhInitiator(alice.identity, bad);
});

// 3. Basic + bidirectional messaging
console.log('Messaging:');
{
  const { a, b } = bootstrap();
  check('Alice→Bob first message round-trips', dec(b, enc(a, 'hello bob')) === 'hello bob');
  check('Alice→Bob second message round-trips', dec(b, enc(a, 'second')) === 'second');
  // Bob now has a sending chain (after receiving) and can reply → DH ratchet
  check('Bob→Alice reply round-trips', dec(a, enc(b, 'hi alice')) === 'hi alice');
  check('Alice→Bob after ratchet round-trips', dec(b, enc(a, 'still works')) === 'still works');
}

// 4. Distinct per-message keys (forward secrecy sanity)
console.log('Per-message keys:');
{
  const { a } = bootstrap();
  const e1 = enc(a, 'same');
  const e2 = enc(a, 'same');
  check('same plaintext → different ciphertext each send', !sameBytes(e1.ciphertext, e2.ciphertext));
}

// 5. Out-of-order delivery within a chain (skipped-key cache)
console.log('Out-of-order delivery:');
{
  const { a, b } = bootstrap();
  const m1 = enc(a, 'one');
  const m2 = enc(a, 'two');
  const m3 = enc(a, 'three');
  const got3 = dec(b, m3); // arrives first → skips 0,1
  const got1 = dec(b, m1); // from skipped cache
  const got2 = dec(b, m2); // from skipped cache
  check('m3 then m1 then m2 all decrypt correctly', got3 === 'three' && got1 === 'one' && got2 === 'two');
}

// 6. Tamper rejection
console.log('Integrity:');
{
  const { a, b } = bootstrap();
  const e = enc(a, 'tamper me');
  e.ciphertext[0] ^= 0x01;
  checkThrows('flipped ciphertext byte fails authentication', () => ratchetDecrypt(b, e));
}

// 7. Wrong recipient cannot read
console.log('Confidentiality:');
{
  const { a } = bootstrap();
  const eve = bootstrap();
  const e = enc(a, 'secret for bob');
  checkThrows("Eve's ratchet cannot decrypt Alice→Bob envelope", () => ratchetDecrypt(eve.b, e));
}

// 8. State persistence (SecureStore round-trip) mid-session
console.log('State persistence:');
{
  const { a, b } = bootstrap();
  dec(b, enc(a, 'before save'));
  const aResumed = deserializeState(serializeState(a)); // simulate app restart
  check('Alice resumes from serialized state and Bob still decrypts',
    dec(b, enc(aResumed, 'after resume')) === 'after resume');
}

// 9. Wire envelope encode/decode
console.log('Wire format:');
{
  const { a, b } = bootstrap();
  const wire = encodeEnvelope(enc(a, 'over the wire'));
  check('envelope survives JSON encode/decode', dec(b, decodeEnvelope(wire)) === 'over the wire');
}

console.log('──────────────────────────────');
if (failures === 0) {
  console.log('ALL TESTS PASSED ✓\n');
  process.exit(0);
} else {
  console.log(`${failures} TEST(S) FAILED ✗\n`);
  process.exit(1);
}
