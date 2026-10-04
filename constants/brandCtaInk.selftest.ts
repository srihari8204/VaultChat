// constants/brandCtaInk.selftest.ts — run: npx tsx constants/brandCtaInk.selftest.ts
//
// BRAND_CTA_INK is text on a gradient, so it has to pass AA (4.5:1, the labels
// are 16 pt — not "large") against EVERY stop, not the average: a gradient is
// only as legible as its worst end. Both constants are pure (no imports), so
// they are read directly.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND_CTA_INK } from './brandCtaInk';
import { BRAND_GRADIENT_CTA } from './theme';

function lum(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  assert.match(full, /^[0-9a-fA-F]{6}$/, `unparseable colour ${hex}`);
  const ch = [0, 2, 4].map((i) => {
    const s = parseInt(full.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

console.log('brandCtaInk.selftest');
assert.ok(BRAND_GRADIENT_CTA.length >= 2, 'the CTA gradient has stops');
for (const stop of BRAND_GRADIENT_CTA) {
  const r = ratio(BRAND_CTA_INK, stop);
  assert.ok(r >= 4.5, `BRAND_CTA_INK on ${stop} is ${r.toFixed(2)}:1, under AA 4.5:1`);
  console.log(`  ✓ ${BRAND_CTA_INK} on ${stop}: ${r.toFixed(2)}:1`);
}

// The screens that paint this gradient behind a label take their ink from here,
// not from a literal (the uiDebtRatchet counts literals; this names the pairing).
const ROOT = join(__dirname, '..');
for (const f of ['app/onboard.tsx', 'app/onboard-profile.tsx', 'app/onboard-security.tsx', 'app/onboard-success.tsx', 'app/mpin-recover.tsx']) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  assert.ok(/BRAND_GRADIENT_CTA/.test(src) && /BRAND_CTA_INK/.test(src), `${f} pairs the CTA gradient with BRAND_CTA_INK`);
  assert.ok(!/['"`]#(?:fff|FFF|ffffff|FFFFFF)['"`]/.test(src), `${f} has no white literal left`);
  console.log(`  ✓ ${f} uses BRAND_CTA_INK`);
}
console.log('brandCtaInk.selftest: all passed');
