// utils/currencyMinor.selftest.ts — run: npx tsx utils/currencyMinor.selftest.ts
//
// A HARD-CODED 2 IS THE BUG, AND FOR INR IT LOOKS CORRECT.
//
// That is why it survived: every shop shopbook_country seeds (INR USD GBP AUD
// CAD SGD, migration 069) has exponent 2, so ×100 was right in production and
// wrong in principle. The first JPY shop would have been charged ¥129,900 for a
// ¥1,299 order, and the first KWD shop would have had its third decimal
// silently rounded away by NUMERIC(12,2) before anyone read it back.
//
// Every assertion under "THE ONES THAT BITE" fails if exponentOf is reverted to
// `return 2`. The INR and compatibility sections are the other half of the
// contract: nothing an existing shop already has may move by one paisa.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CURRENCY_EXPONENTS, exponentOf, minorPerUnit, toMinor, fromMinor, sumMinor,
  readMoney, UnknownCurrencyError,
} from './currencyMinor';
import { formatMoney } from './shopbook';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };
const eq = (label: string, actual: unknown, expected: unknown) => {
  assert.deepStrictEqual(actual, expected, `${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  n++; console.log('  ok  ' + label);
};

// ── THE ONES THAT BITE ────────────────────────────────────────────

console.log('\nexponent 0 — JPY has no minor unit:');
eq('JPY exponent is 0, not 2', exponentOf('JPY'), 0);
eq('one yen is one minor unit', minorPerUnit('JPY'), 1);
// The headline: 129900 minor units of JPY is ¥129,900. It is NOT ¥1,299.00.
eq('129900 JPY minor units == 129900 yen, NOT 1299.00', fromMinor(129900, 'JPY'), 129900);
eq('¥1299 is 1299 minor units', toMinor(1299, 'JPY'), 1299);
eq('a yen price round-trips', fromMinor(toMinor(1299, 'JPY'), 'JPY'), 1299);
// The whole 0dp set, since one missing entry is one currency silently x100'd.
for (const c of ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'PYG', 'RWF', 'UGX', 'VUV',
                 'XAF', 'XOF', 'XPF', 'KMF', 'DJF', 'GNF']) {
  eq(`${c} is exponent 0`, exponentOf(c), 0);
}

console.log('\nexponent 3 — KWD carries three decimals:');
eq('KWD exponent is 3', exponentOf('KWD'), 3);
eq('one dinar is 1000 minor units', minorPerUnit('KWD'), 1000);
eq('1.234 KD is 1234 minor units', toMinor(1.234, 'KWD'), 1234);
eq('...and reads back exactly', fromMinor(1234, 'KWD'), 1.234);
// The third decimal is REAL money at exponent 3. At a hard-coded 2 it does not
// exist: 0.001 KD would be toMinor -> 0, i.e. free.
ok('the smallest KWD unit is not zero', toMinor(0.001, 'KWD') === 1);
for (const c of ['BHD', 'KWD', 'JOD', 'TND', 'OMR', 'LYD', 'IQD']) {
  eq(`${c} is exponent 3`, exponentOf(c), 3);
}

console.log('\nan unknown currency fails LOUDLY:');
for (const bad of ['', 'XYZ', 'IRN', 'rupees', '₹', 'INRR', '   ']) {
  let threw = false;
  try { exponentOf(bad); } catch (e) { threw = e instanceof UnknownCurrencyError; }
  ok(`exponentOf(${JSON.stringify(bad)}) throws rather than assuming 2`, threw);
}
ok('the error names the code, so the log says which shop', (() => {
  try { exponentOf('XYZ'); return false; } catch (e) { return String(e).includes('XYZ'); }
})());
// null/undefined are the shapes a missing column actually arrives as.
for (const bad of [null, undefined]) {
  let threw = false;
  try { exponentOf(bad as unknown as string); } catch { threw = true; }
  ok(`a ${String(bad)} currency throws`, threw);
}

// ── NOTHING AN EXISTING SHOP HAS MAY MOVE ─────────────────────────

console.log('\nINR 2dp round-trip is exactly what it always was:');
eq('INR exponent is 2', exponentOf('INR'), 2);
for (const v of [0, 0.05, 1, 45, 125.5, 283.2, 680, 99.99, 1299.99, 99999.99]) {
  eq(`₹${v} round-trips`, fromMinor(toMinor(v, 'INR'), 'INR'), v);
  // ...and the legacy hard-coded ×100 agrees, value for value.
  eq(`₹${v} matches the legacy x100`, toMinor(v, 'INR'), Math.round(v * 100));
}
eq('negatives round half away from zero, as divRound() does', toMinor(-25.995, 'INR'), -2600);
eq('positives too', toMinor(25.995, 'INR'), 2600);
// This is the vector utils/shopbook.selftest.ts already pins on formatMoney.
// Half-even would make it 1000, and '£10.00' on a bill that used to say £10.01.
eq('10.005 rounds UP, matching formatMoney (NOT half-even)', toMinor(10.005, 'GBP'), 1001);

console.log('\na sum of 1000 entries has no float drift:');
const thousand = Array.from({ length: 1000 }, () => toMinor(0.1, 'INR'));
eq('1000 x ₹0.10 is exactly ₹100.00', sumMinor(thousand), 10000);
eq('...and reads back as 100', fromMinor(sumMinor(thousand), 'INR'), 100);
// The same thousand summed as rupee doubles, which is the representation being
// replaced. It is off, and it is off in a direction nobody notices until audit.
const drifted = Array.from({ length: 1000 }, () => 0.1).reduce((a, b) => a + b, 0);
ok(`the double sum really does drift (${drifted})`, drifted !== 100);
// A thousand mixed ledger lines: every one exact, and order-independent.
const lines = Array.from({ length: 1000 }, (_, i) => toMinor((i % 97) + 0.07, 'INR'));
eq('a mixed 1000-line ledger sums exactly',
  sumMinor(lines), sumMinor([...lines].reverse()));
eq('...to the value integer arithmetic says it must',
  sumMinor(lines), lines.reduce((a, b) => a + b, 0));
// And at exponent 0, where a x100 seam would have inflated every entry.
eq('1000 x ¥7 is ¥7000', sumMinor(Array.from({ length: 1000 }, () => toMinor(7, 'JPY'))), 7000);

console.log('\na row written by the OLD representation reads back identically:');
// The old representation is a decimal in the major unit: NUMERIC(12,2) in
// Postgres, REAL in db/financeDb.ts. readMoney() is the read-compatible path —
// it takes the backfilled *_minor column when present and falls back to the
// legacy decimal otherwise. Both must DISPLAY the same.
for (const legacy of [0, 0.05, 45, 283.2, 680, 1299.99, 99999.99]) {
  const fromLegacy = readMoney(null, legacy, 'INR');        // pre-migration row
  const fromMinorCol = readMoney(Math.round(legacy * 100), legacy, 'INR'); // backfilled row
  eq(`legacy ₹${legacy} and its backfilled column agree`, fromLegacy, fromMinorCol);
  eq(`...and display identically`,
    formatMoney(fromMinor(fromMinorCol, 'INR'), '₹'), formatMoney(legacy, '₹'));
}
// A zero minor column is a real zero, not a missing one — the trap in every
// `minor || legacy` fallback ever written.
eq('a backfilled 0 is honoured, not treated as absent', readMoney(0, 999, 'INR'), 0);
eq('an absent column falls back to the legacy decimal', readMoney(null, 999, 'INR'), 99900);
eq('undefined is absent too', readMoney(undefined, 12.5, 'INR'), 1250);

// ── the Go table is the same table ────────────────────────────────
//
// There are two copies because there are two runtimes. A copy that can drift
// silently is worse than no copy: the server would price a KWD order at
// exponent 3 while the client rendered it at 2.
console.log('\nthe Go and TypeScript exponent tables agree:');
const goSrc = fs.readFileSync(
  path.join(__dirname, '..', 'vaultchat-backend-go', 'internal', 'routes', 'shopbook_currency.go'), 'utf8');
const table = goSrc.slice(
  goSrc.indexOf('sbExponentTable = map[string]int{'),
  goSrc.indexOf('\n}', goSrc.indexOf('sbExponentTable = map[string]int{')));
ok('the Go table was found', table.length > 200);
const goTable: Record<string, number> = {};
for (const m of table.matchAll(/"([A-Z]{3})":\s*(\d)/g)) goTable[m[1]] = Number(m[2]);
eq('same number of currencies', Object.keys(goTable).length, Object.keys(CURRENCY_EXPONENTS).length);
const mismatches = Object.keys({ ...goTable, ...CURRENCY_EXPONENTS })
  .filter((c) => goTable[c] !== CURRENCY_EXPONENTS[c]);
eq('every currency has the same exponent in both', mismatches, []);
ok('Go refuses an unknown code rather than defaulting',
  /refusing to assume 2 decimal places/.test(goSrc));

// ── the exponent is never hard-coded back in ──────────────────────
// Guarding the file this change exists to create. A `return 2` here would pass
// every INR test in the repo.
ok('exponentOf does not return a constant',
  !/function exponentOf[\s\S]{0,200}return\s+2\s*;/.test(
    fs.readFileSync(path.join(__dirname, 'currencyMinor.ts'), 'utf8')));

console.log(`\ncurrencyMinor.selftest: ${n} assertions passed`);
