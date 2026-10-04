// run: npx tsx lib/strokePath.selftest.ts
import assert from 'node:assert/strict';
import { strokeD } from './strokePath';

let n = 0;
const eq = (a: unknown, b: unknown) => { assert.equal(a, b); n++; };

eq(strokeD([]), '');
eq(strokeD([{ x: 1, y: 2 }]), 'M1 2 L1 2');
eq(strokeD([{ x: 1, y: 2 }, { x: 3.456, y: 4 }]), 'M1 2 L3.5 4');
eq(strokeD([{ x: NaN, y: 2 }, { x: 5, y: 6 }, { x: 7, y: Infinity }, { x: 8, y: 9 }]), 'M5 6 L8 9');
eq(strokeD([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]), 'M0 0 L10 0 L10 10');

console.log(`strokePath selftest: ${n} checks passed`);
