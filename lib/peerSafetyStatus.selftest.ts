// lib/peerSafetyStatus.selftest.ts — run: npx tsx lib/peerSafetyStatus.selftest.ts

import assert from 'node:assert/strict';
import { forEachLimited, peerSafetyLabel, type PeerSafetyStatus } from './peerSafetyStatus';

(async () => {
  // Every status has its own words.
  const all: PeerSafetyStatus[] = ['verified', 'unverified', 'changed', 'nokey', 'unknown'];
  assert.equal(new Set(all.map(peerSafetyLabel)).size, all.length);
  assert.equal(peerSafetyLabel('changed'), 'Security code changed');

  // At most `limit` at once, every item once, failures do not stop the rest.
  let running = 0, peak = 0;
  const done: number[] = [];
  await forEachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5 + (n % 3)));
    running--;
    if (n === 4) throw new Error('one contact failed');
    done.push(n);
  });
  assert.equal(peak, 3);
  assert.deepEqual(done.sort(), [1, 2, 3, 5, 6, 7]);

  // Stopping: nothing new starts after the picker closes.
  const started: number[] = [];
  let stop = false;
  await forEachLimited([1, 2, 3, 4, 5], 2, async (n) => {
    started.push(n);
    if (n === 2) stop = true;
    await new Promise((r) => setTimeout(r, 1));
  }, () => stop);
  assert.deepEqual(started, [1, 2]);

  // Empty input and a limit above the count.
  await forEachLimited([], 4, async () => { throw new Error('never'); });
  const seen: string[] = [];
  await forEachLimited(['a'], 10, async (x) => { seen.push(x); });
  assert.deepEqual(seen, ['a']);

  console.log('peerSafetyStatus.selftest: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
