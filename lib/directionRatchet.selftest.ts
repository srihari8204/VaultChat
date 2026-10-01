// lib/directionRatchet.selftest.ts — run: npx tsx lib/directionRatchet.selftest.ts
//
// A RATCHET on physical-direction style props, not a ban — and deliberately not a
// bug report.
//
// `marginLeft` / `marginRight` / `paddingLeft` / `paddingRight` are PHYSICAL: they
// mean the same side whichever way the text runs. Their logical counterparts
// (`marginStart` / `marginEnd` / `paddingStart` / `paddingEnd`) flip with the
// writing direction, which is what an RTL locale needs.
//
// WHY THIS IS NOT CURRENTLY A BUG, stated plainly so nobody "fixes" 166 sites in a
// panic: no RTL language ships. lib/i18n/index.ts registers exactly three — en, hi,
// te — and all three declare `dir: 'ltr'`, which lib/i18n/i18n.selftest.ts already
// asserts. With no RTL locale reachable, a physical margin and a logical one render
// identically, so every one of these 166 props is currently correct on screen.
//
// WHAT THIS GUARD IS FOR, then: keeping that number from growing, so that adopting
// an RTL locale is a bounded piece of work instead of an open-ended audit. A count
// that only falls is the difference between "a week" and "nobody knows".
//
// AND IT TIGHTENS AUTOMATICALLY. If lib/i18n/index.ts ever registers a language
// with `dir: 'rtl'`, these props stop being cosmetic and start being a visible
// layout defect — so this file FAILS LOUDLY at that moment rather than continuing
// to wave a budget through. Shipping RTL and fixing the layout become the same
// decision, which is the only ordering that works.
//
// openspec: global-device-support task 6.3. lib/i18n/engine.ts remains the single
// source of direction; nothing here duplicates that.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

/**
 * The budget. Measured 2026-10-02 across app/ and components/.
 *
 * LOWER THIS when you convert sites; never raise it. If a new screen genuinely
 * needs a physical side (see EXEMPT_REASONS), it still counts — the budget is a
 * total, not a per-file allowance, because a total is the thing that has to reach
 * zero before RTL can ship.
 */
const BUDGET = 166;

/**
 * Cases where a PHYSICAL side is genuinely correct and converting would be wrong.
 * Kept as documentation rather than as code exemptions, because none of these is
 * common enough to carve a hole in the count for:
 *
 *   * a shadow offset, which is a light direction and does not mirror
 *   * anything mirroring a physical device feature (a notch, a camera cutout)
 *   * a chart or canvas axis whose data is inherently left-to-right
 *
 * If one of these ever makes the budget impossible to reach zero, convert the rest
 * first and then argue about the remainder with a real number in hand.
 */
const EXEMPT_REASONS = ['shadow offsets', 'device-physical features', 'chart/canvas axes'];

const PHYSICAL = /\b(marginLeft|marginRight|paddingLeft|paddingRight)\b/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if ((e.endsWith('.tsx') || e.endsWith('.ts')) && !e.includes('.selftest.')) out.push(p);
  }
  return out;
}

console.log('\ndirection ratchet (physical vs logical layout props)');

let total = 0;
const worst: [number, string][] = [];
for (const abs of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))]) {
  const n = (readFileSync(abs, 'utf8').match(PHYSICAL) ?? []).length;
  if (!n) continue;
  total += n;
  worst.push([n, relative(ROOT, abs).split('\\').join('/')]);
}
worst.sort((a, b) => b[0] - a[0]);

check(`physical-direction props do not exceed the budget (${total} vs ${BUDGET})`,
  total <= BUDGET,
  total > BUDGET
    ? `+${total - BUDGET} new. Use marginStart/marginEnd/paddingStart/paddingEnd, `
      + `or lower the budget in the same commit if you converted sites`
    : '');

if (total < BUDGET) {
  check(`BUDGET is stale — lower it to ${total}`, false,
    `${BUDGET - total} sites were converted without updating this file; a budget `
    + 'above the real count is slack that silently re-admits regressions');
}

// ── the coupling that makes this guard matter ────────────────────────────────
// Read the direction registry rather than restating it. The moment an RTL language
// exists, a non-zero count is a real layout defect and must stop the build.
const i18n = readFileSync(join(ROOT, 'lib', 'i18n', 'index.ts'), 'utf8');
const rtlDeclared = /dir:\s*'rtl'/.test(i18n);
check('no RTL locale ships yet, so the remaining props are cosmetic (not a bug)',
  !rtlDeclared || total === 0,
  rtlDeclared
    ? `lib/i18n/index.ts now declares an RTL language while ${total} physical props remain — `
      + 'these are now VISIBLE layout defects. Convert them, or do not ship that locale'
    : '');

// A guard that cannot fail is decoration.
check('the matcher finds a physical prop', PHYSICAL.test('{ marginLeft: 8 }'));
PHYSICAL.lastIndex = 0;
check('the matcher ignores the logical form', !PHYSICAL.test('{ marginStart: 8 }'));
PHYSICAL.lastIndex = 0;

console.log(`\n  ${total} physical props across ${worst.length} files; densest:`);
for (const [n, f] of worst.slice(0, 5)) console.log(`    ${String(n).padStart(3)}  ${f}`);
console.log(`  exempt-by-reason (documented, still counted): ${EXEMPT_REASONS.join(', ')}`);
console.log(failures === 0 ? '\nALL PASSED ✓\n' : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
