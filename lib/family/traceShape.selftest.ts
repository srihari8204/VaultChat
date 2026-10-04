// lib/family/traceShape.selftest.ts — run: npx tsx lib/family/traceShape.selftest.ts
import assert from 'node:assert/strict';
import { traceShape } from './traceShape';

// Rounds to 4 dp.
assert.deepEqual(traceShape([{ lat: 17.123456, lng: 78.987654 }]), [{ lat: 17.1235, lng: 78.9877 }]);
// Consecutive duplicates after rounding collapse; a return visit later is kept.
assert.deepEqual(
  traceShape([
    { lat: 17.12341, lng: 78.1 }, { lat: 17.12344, lng: 78.10001 }, { lat: 17.2, lng: 78.2 }, { lat: 17.12342, lng: 78.1 },
  ]),
  [{ lat: 17.1234, lng: 78.1 }, { lat: 17.2, lng: 78.2 }, { lat: 17.1234, lng: 78.1 }],
);
// Non-finite points are dropped, never sent as NaN.
assert.deepEqual(traceShape([{ lat: NaN, lng: 1 }, { lat: 1, lng: Infinity }, { lat: 1, lng: 2 }]), [{ lat: 1, lng: 2 }]);
// Negative coordinates round symmetrically enough to stay within ~11 m.
const [p] = traceShape([{ lat: -33.868819, lng: 151.209295 }]);
assert.ok(Math.abs(p.lat - -33.868819) <= 5e-5 && Math.abs(p.lng - 151.209295) <= 5e-5);
// Empty in, empty out.
assert.deepEqual(traceShape([]), []);

console.log('traceShape selftest: ok');
