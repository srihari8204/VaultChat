// npx tsx components/finance/chittiNumber.selftest.ts
import assert from 'node:assert/strict';
import { nextMemberNumber } from './chittiNumber';

assert.equal(nextMemberNumber([]), 1);
assert.equal(nextMemberNumber([{ number: 1 }, { number: 2 }, { number: 3 }]), 4);
// member #2 removed: the next member is #4, not a second #3
assert.equal(nextMemberNumber([{ number: 1 }, { number: 3 }]), 4);
// order does not matter
assert.equal(nextMemberNumber([{ number: 7 }, { number: 2 }]), 8);
// a corrupt row cannot poison the numbering
assert.equal(nextMemberNumber([{ number: NaN }, { number: 2 }]), 3);

console.log('chittiNumber selftest: all passed');
