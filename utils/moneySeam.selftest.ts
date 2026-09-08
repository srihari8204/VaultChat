// utils/moneySeam.selftest.ts — run: npx tsx utils/moneySeam.selftest.ts
//
// money.ts now chooses its implementation at module load (TS, or rust/vaultcore
// over UniFFI). money.selftest.ts proves the ARITHMETIC; this proves the SEAM,
// which has exactly one job it must never get wrong:
//
//   a build without the native library must keep paying people correctly.
//
// The failure this guards against is a release where EXPO_PUBLIC_MONEY_BACKEND
// is set to 'rust' but the .so did not ship — four ABIs is four chances to miss
// one. If that ever throws instead of falling back, every finance screen breaks
// at once, on the one surface where being wrong costs real money.

import { execFileSync } from 'node:child_process';
import { moneyBackend, splitEvenly, sumRupees, toPaise, fromPaise } from './money';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nMoney seam self-test\n');

console.log('Default backend:');
eq('unset EXPO_PUBLIC_MONEY_BACKEND means TS', moneyBackend(), 'ts');

// The seam must not have changed a single answer. These are the vectors that
// carry the original bug: ₹1000 across 7 members used to pay out ₹1000.02.
console.log('\nThe exported functions still do exact money:');
// 0.125 is exactly representable in binary, so this really does test the
// rounding DIRECTION. 142.855 does not — it is stored just under the half,
// so Math.round gives 14285 and the vector would be asserting float
// representation rather than the rule.
eq('toPaise rounds half-up', toPaise(0.125), 13);
eq('toPaise converts plainly', toPaise(142.86), 14286);
eq('fromPaise is exact to 2dp', fromPaise(14285), 142.85);
const s = splitEvenly(1000, 7);
eq('₹1000 / 7 floors the share', s.each, 142.85);
eq('...and returns the shortfall', s.remainderPaise, 5);
check('each × parts + remainder === total',
  Math.round(s.each * 100) * 7 + s.remainderPaise === toPaise(1000),
  `${Math.round(s.each * 100) * 7} + ${s.remainderPaise} != ${toPaise(1000)}`);
eq('sumRupees has no float drift', sumRupees([0.1, 0.2]), 0.3);

// ── the one that matters ───────────────────────────────────────────────
// Ask for the native backend in a build that has no native module. A child
// process, because the backend is chosen once at module load and this file has
// already loaded it.
console.log('\nAsking for a backend that is not in this build:');
let out = '';
try {
  out = execFileSync(
    process.execPath,
    ['--import', 'tsx', '-e',
      "import('./utils/money.ts').then(m => console.log(JSON.stringify({" +
      "backend: m.moneyBackend(), each: m.splitEvenly(1000, 7).each, sum: m.sumRupees([0.1, 0.2])})))"],
    { env: { ...process.env, EXPO_PUBLIC_MONEY_BACKEND: 'rust' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
} catch (e: any) {
  out = `THREW: ${e?.message ?? e}`;
}
const parsed = (() => { try { return JSON.parse(out.split('\n').pop() || '{}'); } catch { return {}; } })();
check('a missing native module does not throw', !out.startsWith('THREW'), out.slice(0, 160));
eq('it falls back to TS', parsed.backend, 'ts');
eq('...and money is still exact', parsed.each, 142.85);
eq('...for every op, not just the one', parsed.sum, 0.3);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all money-seam checks passed\n');
process.exit(failures ? 1 : 0);
