// lib/finance/searchQuery.selftest.ts — run: npx tsx lib/finance/searchQuery.selftest.ts
//
// A number typed the way people write it finds the 10-digit mobile it means.

import assert from 'node:assert/strict';
import { phoneDigits, mobileMatches } from './searchQuery';

let n = 0;
const eq = (label: string, a: unknown, b: unknown) => { assert.deepEqual(a, b, label); n++; };
const stored = '9876543210';

eq('+91 with spaces', mobileMatches(stored, '+91 98765 43210'), true);
eq('+91 partial', mobileMatches(stored, '+91 98765'), true);
eq('91 prefix on a full number', mobileMatches(stored, '919876543210'), true);
eq('trunk 0', mobileMatches(stored, '09876543210'), true);
eq('hyphens', mobileMatches(stored, '98765-43210'), true);
eq('plain prefix still works', mobileMatches(stored, '98765'), true);
eq('a different number does not', mobileMatches(stored, '+91 91234 56789'), false);
eq('a mobile starting 91 is not stripped', mobileMatches('9123456789', '91234'), true);
eq('no stored mobile', mobileMatches(null, '98765'), false);
eq('names are not phone-shaped', phoneDigits('Ramesh'), null);
eq('too short to be a number', phoneDigits('+9'), null);
eq('+91 and two digits is too short (was "98", in most mobiles)', phoneDigits('+9198'), null);
eq('… and matches nothing it should not', mobileMatches('9123498765', '+9198'), false);
eq('+91 and three digits is a search', phoneDigits('+91 987'), '987');
eq('digits out', phoneDigits('(98765) 43210'), '9876543210');

console.log(`searchQuery: ${n} assertions passed`);
