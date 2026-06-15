// services/security/safetyNumber.selftest.ts
//
// Node proof that the safety number is symmetric (both devices compute the same
// value) and binds to the keys (a swapped/MITM key changes it).
// Run:  npx tsx services/security/safetyNumber.selftest.ts

import { computeSafetyNumber, formatSafetyNumber } from './safetyNumber';

let passed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error('  ✗ FAIL:', msg); throw new Error('assertion failed: ' + msg); }
  passed++;
  console.log('  ✓', msg);
}

// Two fake but fixed public identity keys (base64 of 33 bytes each).
const keyA = Buffer.from(new Uint8Array(33).fill(0xa1)).toString('base64');
const keyB = Buffer.from(new Uint8Array(33).fill(0xb2)).toString('base64');
const keyM = Buffer.from(new Uint8Array(33).fill(0xcc)).toString('base64'); // attacker key
const idA = 'user-aaaa-1111';
const idB = 'user-bbbb-2222';

function main(): void {
  console.log('safetyNumber self-test\n');

  // Alice computes (her local, Bob remote); Bob computes (his local, Alice remote).
  const fromAlice = computeSafetyNumber(idA, keyA, idB, keyB);
  const fromBob   = computeSafetyNumber(idB, keyB, idA, keyA);

  assert(fromAlice.length === 60, 'safety number is 60 digits');
  assert(/^[0-9]+$/.test(fromAlice), 'safety number is all digits');
  assert(fromAlice === fromBob, 'both parties compute the SAME number (symmetric)');

  // A man-in-the-middle who substituted their own key for Bob gets a DIFFERENT
  // number → the mismatch is what the users would notice when comparing.
  const mitm = computeSafetyNumber(idA, keyA, idB, keyM);
  assert(mitm !== fromAlice, 'a substituted (MITM) key produces a different number');

  // Changing a stable id also changes it (binds to identity, not just key).
  const otherId = computeSafetyNumber(idA, keyA, 'user-cccc-3333', keyB);
  assert(otherId !== fromAlice, 'a different peer id produces a different number');

  console.log('\n  number:', formatSafetyNumber(fromAlice));
  console.log(`\nALL ${passed} SAFETY-NUMBER CHECKS PASSED`);
}

main();
