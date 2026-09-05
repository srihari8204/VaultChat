// constants/financeTheme.selftest.ts — run: npx tsx constants/financeTheme.selftest.ts
//
// Contrast is the whole reason this file exists. The light palette already had
// two colours replaced (#DC2626 danger, #D97706 amber) because they failed AA
// at the 11-13px sizes they are actually used at — and nothing caught that
// until someone measured. A dark palette picked by eye fails the same way, so
// every dark colour is checked here against the ground it sits on.
//
// PURE — no react-native import.

// financeTheme.ts imports Platform (via ./theme), so it cannot be imported in
// Node. grid.selftest.ts already solves this by reading the file as TEXT; same
// approach here, so the palette is still checked without a react-native shim.
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, 'financeTheme.ts'), 'utf8');

/** Pull one `export const NAME = { ... }` block into a plain object. */
function parsePalette(name: string): Record<string, string> {
  const start = SRC.indexOf('export const ' + name + ' = {');
  if (start < 0) throw new Error('palette not found: ' + name);
  const end = SRC.indexOf('} as const;', start);
  const body = SRC.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*'([^']*)'/gm)) out[m[1]] = m[2];
  // FIN.brand is the identifier BRAND_ACCENT, not a literal, so resolve it from
  // constants/theme.ts. Without this the key-shape check reports a phantom
  // difference between the palettes.
  for (const m of body.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*([A-Z][A-Z0-9_]+),/gm)) {
    const ref = readFileSync(join(__dirname, 'theme.ts'), 'utf8')
      .match(new RegExp('export const ' + m[2] + "\\s*=\\s*'([^']+)'"));
    if (ref) out[m[1]] = ref[1];
  }
  return out;
}
const FIN = parsePalette('FIN');
const FIN_DARK = parsePalette('FIN_DARK');

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
function ok(name: string, cond: boolean) { check(name, cond, true); }

console.log('financeTheme.selftest');

// ── WCAG relative luminance + contrast ratio ──────────────────────
function srgb(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function lum(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function ratio(a: string, b: string): number {
  const la = lum(a), lb = lum(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
const AA = 4.5;      // normal text
const AA_LARGE = 3;  // >=18.66px bold / >=24px

function contrast(label: string, fg: string, bg: string, min = AA) {
  const r = ratio(fg, bg);
  const pass = r >= min;
  if (!pass) failures++;
  console.log(`  ${pass ? '✓' : '✗'} ${label}  ${r.toFixed(2)}:1 (need ${min})`);
}

// ── 1. the two palettes must have the SAME SHAPE ──────────────────
// A screen swaps palettes without knowing which it holds, so a key present in
// one and missing from the other is a crash waiting for a theme toggle.
const lightKeys = Object.keys(FIN).sort();
const darkKeys = Object.keys(FIN_DARK).sort();
check('dark palette has exactly the light palette’s keys', darkKeys, lightKeys);
ok('FIN_PALETTES maps both schemes', /FIN_PALETTES = \{ light: FIN, dark: FIN_DARK \}/.test(SRC));

// ── 2. dark: body text on the ground ──────────────────────────────
// bgMid is the ground a card floats on; bgBottom is the darkest sweep.
contrast('dark text on bgMid',       FIN_DARK.text, FIN_DARK.bgMid);
contrast('dark text on bgTop',       FIN_DARK.text, FIN_DARK.bgTop);
contrast('dark sub on bgMid',        FIN_DARK.sub,  FIN_DARK.bgMid);
// `faint` is the placeholder in every money field and the hint under every form
// label — tertiary, but never decorative, so it is held to AA too.
contrast('dark faint on bgMid',      FIN_DARK.faint, FIN_DARK.bgMid);
contrast('dark text on cardSolid',   FIN_DARK.text, FIN_DARK.cardSolid);
contrast('dark sub on cardSolid',    FIN_DARK.sub,  FIN_DARK.cardSolid);

// ── 3. dark: semantic states must survive the flip ────────────────
// This is where a naive dark mode breaks: reusing the light #05603A on a dark
// ground gives ~1.6:1 and the number is simply unreadable.
contrast('dark good on bgMid',  FIN_DARK.good, FIN_DARK.bgMid);
contrast('dark bad on bgMid',   FIN_DARK.bad,  FIN_DARK.bgMid);
contrast('dark warn on bgMid',  FIN_DARK.warn, FIN_DARK.bgMid);
contrast('dark info on bgMid',  FIN_DARK.info, FIN_DARK.bgMid);
// …and on their own soft fills, which is how pills and banners render.
contrast('dark good on goodSoft', FIN_DARK.good, FIN_DARK.goodSoft);
contrast('dark bad on badSoft',   FIN_DARK.bad,  FIN_DARK.badSoft);
contrast('dark warn on warnSoft', FIN_DARK.warn, FIN_DARK.warnSoft);
contrast('dark info on infoSoft', FIN_DARK.info, FIN_DARK.infoSoft);
// Brand text on the dark brand fill, at heading weight.
contrast('dark brandInk on brandSoft', FIN_DARK.brandInk, FIN_DARK.brandSoft, AA_LARGE);
// Text ON the brand colour (buttons): onBrand is dark ink on a light lavender.
contrast('dark onBrand on brand', FIN_DARK.onBrand, FIN_DARK.brand);

// ── 4. the light palette keeps the contrast fixes it was given ────
contrast('light bad on white',  FIN.bad,  '#FFFFFF');
contrast('light warn on white', FIN.warn, '#FFFFFF');
contrast('light good on white', FIN.good, '#FFFFFF');
contrast('light sub on white',  FIN.sub,  '#FFFFFF');
contrast('light faint on white', FIN.faint, '#FFFFFF');
// The regression guard: these two values were replaced BECAUSE they failed.
ok('light danger is not the old #DC2626', FIN.bad !== '#DC2626');
ok('light warn is not the old #D97706',   FIN.warn !== '#D97706');

// ── 5. structural invariants ──────────────────────────────────────
// bg transparent + card translucent is the mechanism the whole restyle rides
// on: the ground is drawn once and shows through every screen.
check('light bg is transparent', FIN.bg, 'transparent');
check('dark bg is transparent',  FIN_DARK.bg, 'transparent');
ok('light card is translucent', FIN.card.indexOf('rgba') === 0);
ok('dark card is translucent',  FIN_DARK.card.indexOf('rgba') === 0);
ok('light cardSolid is opaque', FIN.cardSolid.indexOf('#') === 0);
ok('dark cardSolid is opaque',  FIN_DARK.cardSolid.indexOf('#') === 0);
// The dark ground must actually be darker than the light one, or the palette
// was copied rather than designed.
ok('dark ground is darker than light ground', lum(FIN_DARK.bgMid) < lum(FIN.bgMid));
ok('dark text is lighter than light text',    lum(FIN_DARK.text) > lum(FIN.text));
// contentMax is numeric, so it is asserted from the source rather than the
// parsed string map.
ok('both palettes cap the reading column at 632',
  (SRC.match(/contentMax:\s*632/g) || []).length === 2);

console.log(failures === 0 ? '\nAll theme checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
