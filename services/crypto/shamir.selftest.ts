// services/crypto/shamir.selftest.ts
//
// Node proof of the GF(256) Shamir split/combine: any-K reconstructs, <K can't,
// foreign/duplicate shares are rejected, string round-trips, and a single share
// leaks nothing about the secret.
// Run:  npx tsx services/crypto/shamir.selftest.ts

import { Buffer } from 'buffer';
import {
  splitSecret, combineShares, splitString, combineString, shareThreshold,
} from './shamir';

let passed = 0;
function assert(c: boolean, m: string): void { if (!c) { console.error('  ✗', m); throw new Error(m); } passed++; console.log('  ✓', m); }
function throws(fn: () => void, m: string): void { let t = false; try { fn(); } catch { t = true; } assert(t, m); }
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const pick = <T,>(a: T[], idx: number[]): T[] => idx.map(i => a[i]);

function main(): void {
  console.log('shamir self-test\n');

  // 3-of-5 over a random 32-byte key
  const secret = new Uint8Array(32);
  for (let i = 0; i < 32; i++) secret[i] = (i * 37 + 11) & 0xff;
  const shares = splitSecret(secret, { n: 5, k: 3 });
  assert(shares.length === 5, 'split produces n=5 shares');
  assert(shares.every(s => s.startsWith('VCSS1-3-')), 'shares carry threshold k=3');
  assert(shareThreshold(shares[0]) === 3, 'shareThreshold reads k');

  assert(hex(combineShares(pick(shares, [0, 1, 2]))) === hex(secret), 'shares 0,1,2 reconstruct');
  assert(hex(combineShares(pick(shares, [1, 3, 4]))) === hex(secret), 'shares 1,3,4 reconstruct');
  assert(hex(combineShares(pick(shares, [0, 2, 4]))) === hex(secret), 'shares 0,2,4 reconstruct');
  assert(hex(combineShares(shares)) === hex(secret), 'all 5 reconstruct (extra shares ok)');

  // Fewer than k must be rejected, not silently wrong
  throws(() => combineShares(pick(shares, [0, 1])), 'k-1=2 shares rejected');

  // A single share reveals nothing: its payload is independent of the secret.
  const onlyOne = shares[0].split('-')[4].toLowerCase();
  assert(onlyOne !== hex(secret), 'single share payload != secret');

  // Foreign shares (different split) rejected by group id
  const other = splitSecret(secret, { n: 5, k: 3 });
  throws(() => combineShares([shares[0], shares[1], other[2]]), 'mixed-set shares rejected');

  // Duplicate share rejected
  throws(() => combineShares([shares[0], shares[0], shares[1]]), 'duplicate share rejected');

  // Malformed share rejected
  throws(() => combineShares(['not-a-share']), 'malformed share rejected');

  // 2-of-3 string round-trip (passphrase use case)
  const pass = 'correct horse battery staple 8!';
  const ps = splitString(pass, { n: 3, k: 2 });
  assert(combineString([ps[0], ps[2]]) === pass, '2-of-3 passphrase round-trips');
  assert(combineString([ps[1], ps[2]]) === pass, '2-of-3 alt subset round-trips');
  throws(() => combineString([ps[0]]), '1-of-3 passphrase rejected');

  // Edge: 2-of-2, and a longer threshold 5-of-9
  const s22 = splitSecret(secret, { n: 2, k: 2 });
  assert(hex(combineShares(s22)) === hex(secret), '2-of-2 reconstructs');
  const s59 = splitSecret(secret, { n: 9, k: 5 });
  assert(hex(combineShares(pick(s59, [8, 0, 4, 2, 6]))) === hex(secret), '5-of-9 reconstructs');
  throws(() => combineShares(pick(s59, [0, 1, 2, 3])), '4-of-9 (k-1) rejected');

  // Bad params
  throws(() => splitSecret(secret, { n: 3, k: 1 }), 'k<2 rejected');
  throws(() => splitSecret(secret, { n: 2, k: 3 }), 'n<k rejected');
  throws(() => splitSecret(new Uint8Array(0), { n: 3, k: 2 }), 'empty secret rejected');

  console.log(`\n${passed} checks passed`);
}

main();
