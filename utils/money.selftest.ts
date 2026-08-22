// utils/money.selftest.ts — run: npx tsx utils/money.selftest.ts
//
// The invariant this exists to protect: a chit pot split between members must
// add back up to the pot. The old code rounded each share, so ₹1000 across 7
// members produced ₹142.86 each — ₹1000.02 paid out of a ₹1000 pot. Money
// appearing from nowhere in an organizer's book is the worst class of bug this
// app can have, so the property is checked exhaustively rather than by example.

import { toPaise, fromPaise, splitEvenly, sumRupees } from './money';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nMoney / dividend split self-test\n');

// ── paise conversion ──
eq('rupees → paise', toPaise(1234.56), 123456);
eq('paise → rupees', fromPaise(123456), 1234.56);
eq('round-trips exactly', fromPaise(toPaise(0.07)), 0.07);
eq('non-finite is 0', toPaise(NaN), 0);
// 0.1 + 0.2 is the classic float failure; in paise it is exact.
eq('float drift is gone', sumRupees([0.1, 0.2]), 0.3);
eq('many small amounts sum exactly', sumRupees(Array(10).fill(0.1)), 1);

// ── accumulation: what the dashboard and reports totals do ──
// `acc += x` over many rows is exactly how a headline total drifts away from
// the ledger it is summarising.
eq('sumRupees handles negatives (reports does principal - remaining)',
  sumRupees([500.55, 1000, -500.55]), 1000);
eq('empty sum is zero', sumRupees([]), 0);
{
  // 1000 repayments of ₹0.07 — naive float accumulation does NOT land on 70.
  const vals = Array(1000).fill(0.07);
  let naive = 0; for (const v of vals) naive += v;
  eq('exact accumulation of 1000×0.07', sumRupees(vals), 70);
  check('…and the naive float sum really is wrong (so this test earns its place)',
    naive !== 70, `naive=${naive}`);
}

// ── the documented regression ──
const s7 = splitEvenly(1000, 7);
eq('₹1000 ÷ 7 → each', s7.each, 142.85);
eq('₹1000 ÷ 7 → remainder', s7.remainder, 0.05);
check('shares never exceed the pot (the old bug paid out ₹1000.02)',
  s7.each * 7 <= 1000);

// ── THE PROPERTY: each × parts + remainder === total, exactly ──
// Exhaustive over realistic chit pots and member counts.
let worstOver = 0, violations = 0;
for (let rupees = 0; rupees <= 2000; rupees += 0.01) {
  const total = Math.round(rupees * 100) / 100;
  for (const parts of [1, 2, 3, 5, 7, 11, 12, 20, 25, 40, 100]) {
    const { each, remainder } = splitEvenly(total, parts);
    // Compare in paise so the assertion itself cannot drift.
    const reassembled = toPaise(each) * parts + toPaise(remainder);
    if (reassembled !== toPaise(total)) violations++;
    const over = toPaise(each) * parts - toPaise(total);
    if (over > worstOver) worstOver = over;
  }
}
check('shares + remainder reconstruct the pot exactly (2.2M cases)', violations === 0,
  `${violations} mismatches`);
check('no split ever over-distributes', worstOver <= 0, `worst over-payment ${worstOver} paise`);

// ── remainder is always strictly smaller than the member count ──
let badRemainder = 0;
for (const parts of [2, 3, 7, 13, 20, 99]) {
  for (let p = 0; p < 500; p++) {
    const { remainderPaise } = splitEvenly(p / 100, parts);
    if (remainderPaise >= parts || remainderPaise < 0) badRemainder++;
  }
}
check('remainder is always in [0, parts)', badRemainder === 0, `${badRemainder} bad`);

// ── degenerate inputs must not produce NaN/Infinity money ──
eq('zero members treated as one', splitEvenly(100, 0).each, 100);
eq('negative members treated as one', splitEvenly(100, -5).each, 100);
eq('zero pot splits to zero', splitEvenly(0, 20).each, 0);
eq('negative pot clamps to zero', splitEvenly(-500, 20).each, 0);
check('fractional member count is floored, never NaN', Number.isFinite(splitEvenly(100, 7.9).each));

// ── an even split leaves nothing behind ──
const s20 = splitEvenly(1000, 20);
eq('₹1000 ÷ 20 is exact', s20.each, 50);
eq('…with no remainder', s20.remainderPaise, 0);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
