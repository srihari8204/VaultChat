// services/crypto/senderKey.selftest.ts
//
// Node proof of the group sender-key ratchet: in-order + out-of-order decryption,
// forgery rejection, cross-chain rejection, and that a rotated sender key
// (membership change) makes the old chain unable to read new messages.
// Run:  npx tsx services/crypto/senderKey.selftest.ts

import { Buffer } from 'buffer';
import {
  createSenderKey, distributionMessage, processDistribution,
  groupEncrypt, groupDecrypt, type OwnSenderKey, type PeerSenderKey,
} from './senderKey';

let passed = 0;
function assert(c: boolean, m: string): void { if (!c) { console.error('  ✗', m); throw new Error(m); } passed++; console.log('  ✓', m); }
function throws(fn: () => void, m: string): void { let t = false; try { fn(); } catch { t = true; } assert(t, m); }
function flipB64(b64: string): string { const buf = Buffer.from(b64, 'base64'); buf[0] ^= 0xff; return buf.toString('base64'); }

function main(): void {
  console.log('senderKey self-test\n');

  // Alice creates a sender key; capture her INITIAL distribution (iteration 0)
  // before sending anything. In production the SKDM travels over the pairwise
  // Double Ratchet to each member; here we hand it over directly.
  let alice: OwnSenderKey = createSenderKey();
  const aliceSkdm0 = distributionMessage(alice);

  let bob: PeerSenderKey = processDistribution(aliceSkdm0);

  // Alice sends three messages.
  const e1 = groupEncrypt(alice, 'msg-1'); alice = e1.next;
  const e2 = groupEncrypt(alice, 'msg-2'); alice = e2.next;
  const e3 = groupEncrypt(alice, 'msg-3'); alice = e3.next;

  // In-order: Bob decrypts 1 then 2.
  const d1 = groupDecrypt(bob, e1.cipher); bob = d1.next;
  assert(d1.plaintext === 'msg-1', 'in-order: decrypts msg-1');
  const d2 = groupDecrypt(bob, e2.cipher); bob = d2.next;
  assert(d2.plaintext === 'msg-2', 'in-order: decrypts msg-2');

  // Out-of-order: Carol (fresh from the same SKDM) decrypts msg-3 before msg-1.
  let carol: PeerSenderKey = processDistribution(aliceSkdm0);
  const c3 = groupDecrypt(carol, e3.cipher); carol = c3.next;
  assert(c3.plaintext === 'msg-3', 'out-of-order: decrypts msg-3 first');
  const c1 = groupDecrypt(carol, e1.cipher); carol = c1.next;
  assert(c1.plaintext === 'msg-1', 'out-of-order: serves cached msg-1 after msg-3');

  // Forgery: a tampered ciphertext fails the signature check.
  throws(() => groupDecrypt(bob, { ...e3.cipher, ciphertext: flipB64(e3.cipher.ciphertext) }), 'tampered ciphertext is rejected');

  // Cross-chain: a record for a different signer can't verify Alice's message.
  const mallory = processDistribution(distributionMessage(createSenderKey()));
  throws(() => groupDecrypt(mallory, e1.cipher), 'message from another chain fails verification');

  // The sealed cipher leaks no plaintext.
  assert(!Buffer.from(e1.cipher.ciphertext, 'base64').toString('binary').includes('msg-1'), 'ciphertext leaks no plaintext');

  // Membership change: Alice ROTATES; Bob's OLD record can't read the new chain
  // until re-distribution, after which it works again.
  const aliceRotated = createSenderKey();
  const eR = groupEncrypt(aliceRotated, 'after-rotation');
  throws(() => groupDecrypt(bob, eR.cipher), 'rotated sender key: old record cannot read new messages');
  const bobNew = processDistribution(distributionMessage(aliceRotated));
  const dR = groupDecrypt(bobNew, eR.cipher);
  assert(dR.plaintext === 'after-rotation', 'after re-distribution, new chain decrypts');

  console.log(`\nALL ${passed} SENDER-KEY CHECKS PASSED`);
}

main();
