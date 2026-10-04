// run: npx tsx lib/zoomPan.selftest.ts
import assert from 'node:assert/strict';
import { pinchZoom, clampPan, MAX_ZOOM, MIN_ZOOM } from './zoomPan';

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.equal(a, b, m); n++; };

eq(pinchZoom(1, 100, 200), 2, 'fingers apart doubles');
eq(pinchZoom(2, 100, 50), MIN_ZOOM, 'never below 1');
eq(pinchZoom(3, 100, 1000), MAX_ZOOM, 'never above max');
eq(pinchZoom(2, 0, 100), 2, 'zero start distance keeps zoom');
eq(clampPan(500, 1, 400), 0, 'no pan at 1x');
eq(clampPan(500, 2, 400), 200, 'pan limited to the overflow');
eq(clampPan(-500, 2, 400), -200, 'both directions');
eq(clampPan(50, 2, 400), 50, 'inside the limit is kept');
eq(clampPan(NaN, 2, 400), 0, 'NaN → 0');

console.log(`zoomPan selftest: ${n} checks passed`);
