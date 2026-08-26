/**
 * lib/status/gateKey.selftest.ts — npx tsx lib/status/gateKey.selftest.ts
 *
 * The REAL half of the gated-status feature. If any of these fail, a status is
 * either readable by someone who should not read it, or unreadable by the
 * person who answered correctly.
 *
 * Slow on purpose: scrypt N=2^14 is the point.
 */
import assert from 'node:assert/strict';
import { lockKeyWithAnswer, unlockKeyWithAnswer } from './gateKey';

const KEY: any = { key: 'a'.repeat(64), nonce: 'b'.repeat(24) };
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  console.log('\nThe right answer opens it; a wrong one does not:');

  const locked = await lockKeyWithAnswer(KEY, 'Mumbai');
  assert.ok(locked.salt && locked.envelope, 'must produce a salt and an envelope');
  console.log('  ✓ locked under an answer');

  assert.ok(eq(await unlockKeyWithAnswer(locked, 'Mumbai'), KEY));
  console.log('  ✓ exact answer opens it');

  // If normalising did not reach the crypto, these would fail and the poster
  // would have locked out everyone including themselves.
  assert.ok(eq(await unlockKeyWithAnswer(locked, '  mumbai  '), KEY));
  console.log('  ✓ case and surrounding space forgiven (normalising IS applied)');

  assert.equal(await unlockKeyWithAnswer(locked, 'Delhi'), null);
  console.log('  ✓ wrong answer -> null');
  assert.equal(await unlockKeyWithAnswer(locked, ''), null);
  console.log('  ✓ empty answer -> null');
  assert.equal(await unlockKeyWithAnswer(locked, 'Mumbaii'), null);
  console.log('  ✓ near-miss -> null (no fuzzy matching, ever)');

  console.log('\nThe salt must be per-story:');
  const a = await lockKeyWithAnswer(KEY, 'same answer');
  const b = await lockKeyWithAnswer(KEY, 'same answer');
  assert.notEqual(a.salt, b.salt, 'two stories must not share a salt');
  console.log('  ✓ two locks with the SAME answer get different salts');
  assert.notEqual(a.envelope, b.envelope, 'identical envelopes leak that answers match');
  console.log('  ✓ and different envelopes — equal ciphertexts would leak equal answers');

  // Cross-open: the salt belongs to its own envelope. This catches a wiring bug
  // where the salt is stored globally instead of per story.
  assert.ok(eq(await unlockKeyWithAnswer(b, 'same answer'), KEY));
  console.log('  ✓ each lock opens with its own salt');

  console.log('\nCorrupt input reads as a wrong answer, never a crash:');
  assert.equal(await unlockKeyWithAnswer({ salt: 'zz', envelope: locked.envelope }, 'Mumbai'), null);
  console.log('  ✓ malformed salt -> null');
  assert.equal(await unlockKeyWithAnswer({ salt: locked.salt, envelope: 'not-an-envelope' }, 'Mumbai'), null);
  console.log('  ✓ malformed envelope -> null');
  assert.equal(await unlockKeyWithAnswer({ salt: '', envelope: '' }, 'Mumbai'), null);
  console.log('  ✓ empty everything -> null');

  // A tampered envelope must FAIL rather than yield garbage — this is
  // authenticated decryption, and that property is what makes null a
  // trustworthy "wrong answer" signal.
  const flipped = locked.envelope.slice(0, -2) + (locked.envelope.slice(-2) === 'AA' ? 'BB' : 'AA');
  assert.equal(await unlockKeyWithAnswer({ ...locked, envelope: flipped }, 'Mumbai'), null);
  console.log('  ✓ tampered envelope -> null, not garbage');

  console.log('\nAll answer-gate crypto checks passed.\n');
})().catch((e) => { console.error(e); process.exit(1); });
