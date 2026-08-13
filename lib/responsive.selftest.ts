// lib/responsive.selftest.ts — run: npx tsx lib/responsive.selftest.ts
//
// These thresholds decide whether a phone offers split view at all. Getting
// clampRatio wrong collapses a pane to nothing mid-drag, which looks like the
// app losing a chat, so the invariant "neither pane ever goes below the minimum"
// is asserted directly against real device sizes.

import {
  DIVIDER_DP, MIN_PANE_DP, TABLET_MIN_DP,
  canSplit, canSplitHorizontally, canSplitVertically, clampRatio, formFactor,
  paneSizes, preferredAxis,
} from './responsive';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nResponsive / split-view self-test\n');

// Real dp sizes. Redmi Note 8 Pro is the device this is being tested on.
const REDMI_P = { w: 393, h: 851 };    // phone portrait
const REDMI_L = { w: 851, h: 393 };    // phone landscape
const TAB_P   = { w: 800, h: 1280 };   // 10" tablet portrait
const TAB_L   = { w: 1280, h: 800 };   // 10" tablet landscape

// ── form factor ────────────────────────────────────────────────────────
eq('phone portrait is a phone', formFactor(REDMI_P.w, REDMI_P.h), 'phone');
eq('phone LANDSCAPE is still a phone', formFactor(REDMI_L.w, REDMI_L.h), 'phone');
eq('tablet portrait is a tablet', formFactor(TAB_P.w, TAB_P.h), 'tablet');
eq('tablet landscape is a tablet', formFactor(TAB_L.w, TAB_L.h), 'tablet');
check('form factor uses the SHORT side, so rotation cannot change it',
  formFactor(TAB_P.w, TAB_P.h) === formFactor(TAB_L.w, TAB_L.h));
eq('exactly at the breakpoint is a tablet', formFactor(TABLET_MIN_DP, 900), 'tablet');
eq('one dp under is a phone', formFactor(TABLET_MIN_DP - 1, 900), 'phone');

// ── can we split? ──────────────────────────────────────────────────────
check('phone portrait cannot split side by side', !canSplitVertically(REDMI_P.w));
check('phone portrait CAN stack (tall enough)', canSplitHorizontally(REDMI_P.h));
check('phone portrait offers split (stacked)', canSplit(REDMI_P.w, REDMI_P.h));
eq('phone portrait stacks', preferredAxis(REDMI_P.w, REDMI_P.h), 'horizontal');

check('phone landscape fits two panes side by side', canSplitVertically(REDMI_L.w));
eq('phone landscape splits side by side', preferredAxis(REDMI_L.w, REDMI_L.h), 'vertical');

eq('tablet portrait prefers side by side', preferredAxis(TAB_P.w, TAB_P.h), 'vertical');
eq('tablet landscape prefers side by side', preferredAxis(TAB_L.w, TAB_L.h), 'vertical');

// A window too small for two usable panes in EITHER direction must refuse.
check('a tiny window cannot split', !canSplit(400, 500));
eq('a tiny window has no axis', preferredAxis(400, 500), null);

// ── THE invariant: a pane never collapses ──────────────────────────────
for (const total of [REDMI_L.w, TAB_P.w, TAB_L.w, MIN_PANE_DP * 2 + DIVIDER_DP]) {
  for (const attempt of [-5, 0, 0.001, 0.2, 0.5, 0.8, 0.999, 1, 42, NaN]) {
    const { a, b } = paneSizes(attempt, total);
    if (a < MIN_PANE_DP || b < MIN_PANE_DP) {
      check(`pane below minimum at total=${total} ratio=${attempt}`, false, `a=${a} b=${b}`);
    }
    if (a + b + DIVIDER_DP !== total) {
      check(`panes+divider must equal the window (total=${total} ratio=${attempt})`, false, `a=${a} b=${b}`);
    }
  }
}
check('no ratio, however absurd, collapses a pane or loses a pixel', true);

eq('a mid drag is respected when it fits', clampRatio(0.5, 1280), 0.5);
check('an extreme drag is pulled back to the minimum', clampRatio(0, 1280) > 0);
check('a NaN ratio falls back to centre', clampRatio(NaN, 1280) === 0.5);
eq('a window that cannot fit two panes reports centre', clampRatio(0.9, 400), 0.5);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all responsive checks passed\n');
process.exit(failures ? 1 : 0);
