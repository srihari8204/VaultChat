// utils/financeAmount.selftest.ts — run: npx tsx utils/financeAmount.selftest.ts
//
// THE COMMA IS THE BUG.
//
// utils/financeFormat.ts num() stripped every comma and handed the rest to
// Number(). Stripping is deliberate and must stay — Indian users type
// thousands separators, so 1,200 is 1200 and 1,00,000 is one lakh. But the
// same strip turns 12,5 — the decimal comma most of the world outside the
// English-speaking one types — into 125. This is the PRINCIPAL field of a
// lending ledger: a ten times error, silent, ending in a plausible number.
//
// It reached 18 finance screens plus the CSV importer, which had its own third
// copy of the same parser. app/shop-book.tsx had a fourth with a different bug
// (see utils/shopbook.selftest.ts); the two survivors differ on purpose —
// shop-book refuses commas outright, finance groups with them.
//
// The rule: a thousands separator is ALWAYS followed by exactly three digits.
// Western 1,200 and Indian 1,00,000 both end in a three-digit group. One or
// two digits after the final comma is a decimal comma, and is refused rather
// than multiplied by ten.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { num } from './financeFormat';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };

// The ten-times trap, which is the reason this file exists.
ok('a decimal comma is refused, not multiplied by ten', Number.isNaN(num('12,5')));
ok('two digits after the comma is also refused', Number.isNaN(num('12,50')));

// ...without breaking the grouping that is genuinely wanted.
ok('Western thousands still group', num('1,200') === 1200);
ok('Indian lakh grouping still works', num('1,00,000') === 100000);
ok('multiple Western groups still work', num('12,345,678') === 12345678);
ok('a decimal point after grouping still works', num('1,200.50') === 1200.5);

// Forms Number() accepts that a money field never means.
ok('hex is not sixteen', Number.isNaN(num('0x10')));
ok('exponent is not a thousand', Number.isNaN(num('1e3')));
ok('Infinity is not an amount', Number.isNaN(num('Infinity')));
ok('letters are not an amount', Number.isNaN(num('abc')));
ok('a lone minus is not an amount', Number.isNaN(num('-')));
ok('a lone point is not an amount', Number.isNaN(num('.')));

// Shapes that must keep working.
ok('plain integers parse', num('42') === 42);
ok('decimals parse', num('12.5') === 12.5);
ok('a leading point parses', num('.5') === 0.5);
ok('a trailing point survives mid-typing', num('12.') === 12);
ok('negatives parse', num('-3') === -3);
ok('surrounding space is trimmed', num(' 42 ') === 42);
ok('blank stays zero, as every caller already assumes', num('') === 0);

// The result is only ever a number or NaN — never a string, never undefined.
for (const v of ['12,5', '0x10', '', 'abc', '1,200']) {
  ok(`num(${JSON.stringify(v)}) returns a number type`, typeof num(v) === 'number');
}

// The CSV importer must not have grown its own copy back. It parses rows from a
// FILE, so a wrong number there is never even seen being typed.
const io = fs.readFileSync('app/finance/io.tsx', 'utf8');
ok('the CSV importer shares the hardened parser', io.includes('parseAmount'));
ok('the CSV importer has no bare comma strip of its own', !/Number\(\(v \?\? ''\)\.replace\(\/,\/g/.test(io));
ok('a row whose principal will not parse is skipped, not imported as zero', io.includes('if (!(principal > 0)) continue;'));

console.log(`\nfinanceAmount.selftest: ${n} assertions passed`);
