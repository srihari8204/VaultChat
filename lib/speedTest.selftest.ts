// lib/speedTest.selftest.ts — run: npx tsx lib/speedTest.selftest.ts
import assert from 'node:assert/strict';
import { pingStats, throughputMbps } from './speedTest';

let n = 0;
const ok = (label: string, fn: () => void) => { fn(); n++; console.log('  ok  ' + label); };

ok('an offline run (every request failed) has no speed, not an estimated one', () => {
  assert.equal(throughputMbps([
    { ok: false, bytes: 0, ms: 30 }, { ok: false, bytes: 0, ms: 25 }, { ok: false, bytes: 0, ms: 40 },
  ]), null);
});

ok('a failed upload does not count the bytes it tried to send', () => {
  // 1 MB in 1 s succeeded; a 1 MB attempt that failed must not double the figure.
  assert.equal(throughputMbps([
    { ok: true, bytes: 1_000_000, ms: 1000 }, { ok: false, bytes: 1_000_000, ms: 10 },
  ]), 8);
});

ok('speed is total bits over total time of the successful samples', () => {
  assert.equal(throughputMbps([{ ok: true, bytes: 2_500_000, ms: 1000 }, { ok: true, bytes: 2_500_000, ms: 1000 }]), 20);
});

ok('zero-byte or zero-time samples are ignored rather than dividing by zero', () => {
  assert.equal(throughputMbps([{ ok: true, bytes: 0, ms: 100 }, { ok: true, bytes: 100, ms: 0 }]), null);
});

ok('ping ignores failed round trips and reports null when all failed', () => {
  assert.deepEqual(pingStats([null, null]), null);
  assert.deepEqual(pingStats([10, null, 30]), { ping: 20, jitter: 10 });
});

console.log(`\nspeedTest.selftest: ${n} passed`);
