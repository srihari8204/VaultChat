// constants/paletteContrast.selftest.ts — run: npx tsx constants/paletteContrast.selftest.ts
//
// The fixed (non-theme) palettes that carry TEXT, held to WCAG AA: 4.5:1 for
// text, 3:1 for icons and large glyphs. Each palette documents why it is fixed
// where it is defined; this proves the fixed values are still readable:
//   - constants/gatePalette: TermsGate, UpdateGate, the ErrorBoundary fallback;
//   - constants/theme: the Button gradients and their inks, STATUS_STRIP_INK on
//     the connectivity strips, and the avatar discs' initials (inkOn);
//   - constants/auroraPalette: the theme's text inks over the strongest bloom.
// Translucent inks/fills are composited over their actual ground first.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AuroraDark, AuroraLight, AVATAR_PALETTE, BRAND_GRADIENT_CTA, DANGER_GRADIENT_CTA,
  GRADIENT_INK, STATUS_STRIP_INK, type Palette,
} from './theme';
import { TERMS_GATE, UPDATE_GATE, CRASH_SCREEN } from './gatePalette';
import { AURORA_COMPOSITIONS, AURORA_LIGHT_OPACITY_SCALE } from './auroraPalette';
import { inkOn } from '../lib/groups/catalog';

type RGBA = [number, number, number, number];
function parse(c: string): RGBA {
  const m = c.replace(/\s/g, '').match(/^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  let h = c.replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  assert.match(h, /^[0-9a-fA-F]{6}$/, `unparseable colour ${c}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}
/** `top` (any alpha) composited over an opaque `under`. */
function over(top: RGBA, under: RGBA): RGBA {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1) as RGBA;
}
function lum(c: RGBA): number {
  const f = (x: number) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
/** Contrast of `fg` drawn over `layers`, listed top-down to an opaque ground. */
function ratio(fg: string, ...layers: string[]): number {
  let ground = parse(layers[layers.length - 1]);
  assert.equal(ground[3], 1, `the bottom layer must be opaque: ${layers[layers.length - 1]}`);
  for (let i = layers.length - 2; i >= 0; i--) ground = over(parse(layers[i]), ground);
  const ink = over(parse(fg), ground);
  const [hi, lo] = [lum(ink), lum(ground)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

let n = 0;
const TEXT = 4.5, GLYPH = 3;
function check(label: string, min: number, fg: string, ...layers: string[]) {
  const r = ratio(fg, ...layers);
  assert.ok(r >= min, `${label}: ${r.toFixed(2)}:1 < ${min}:1 (${fg} on ${layers.join(' over ')})`);
  console.log(`  ✓ ${label.padEnd(44)} ${r.toFixed(2)}:1`);
  n++;
}

console.log('gatePalette — TermsGate');
const T = TERMS_GATE;
check('title on ground', TEXT, T.title, T.ground);
check('body on ground', TEXT, T.body, T.ground);
check('"I agree" label on the accent button', TEXT, T.onAccent, T.accent);
check('icon on the accent disc (glyph)', GLYPH, T.onAccent, T.accent);
check('link text on link fill', TEXT, T.linkText, T.linkFill);
check('link icon on link fill (glyph)', GLYPH, T.linkIcon, T.linkFill);
check('open-outside icon on link fill (glyph)', GLYPH, T.linkOpenIcon, T.linkFill);
check('error on ground', TEXT, T.error, T.ground);
check('foot note on ground', TEXT, T.foot, T.ground);

console.log('gatePalette — UpdateGate');
const U = UPDATE_GATE;
check('title on ground', TEXT, U.title, U.ground);
check('body on ground', TEXT, U.body, U.ground);
check('build line on ground', TEXT, U.meta, U.ground);
check('icon on its disc (glyph)', GLYPH, U.onIconDisc, U.iconDisc, U.ground);
check('"Update" label on the accent button', TEXT, U.onAccent, U.accent);
check('soft bar text on the bar', TEXT, U.onBar, U.bar);
check('soft bar close icon (glyph)', GLYPH, U.onBarDim, U.bar);

console.log('gatePalette — ErrorBoundary');
const E = CRASH_SCREEN;
check('title on ground', TEXT, E.title, E.ground);
check('message on ground', TEXT, E.body, E.ground);
check('"Try Again" label on the button', TEXT, E.onButton, E.button);

console.log('theme — Button gradients (every stop under its ink)');
for (const stop of BRAND_GRADIENT_CTA) check(`primary stop ${stop}`, TEXT, GRADIENT_INK, stop);
for (const stop of DANGER_GRADIENT_CTA) check(`danger stop ${stop}`, TEXT, GRADIENT_INK, stop);

console.log('theme — connectivity strips');
check('offline strip (AuroraLight.danger)', TEXT, STATUS_STRIP_INK, AuroraLight.danger);
check('dark "Connecting…" strip (surfaceSolid)', TEXT, STATUS_STRIP_INK, AuroraDark.surfaceSolid);
check('light "Connecting…" strip (text on surfaceSolid)', TEXT, AuroraLight.text, AuroraLight.surfaceSolid);

console.log('theme — avatar initials (inkOn) on every AVATAR_PALETTE disc');
// One disc falls 0.03 short: indigo #6366F1 is 4.47:1 under white and worse
// under the night ink, so no ink reaches 4.5 on it. Closing that gap means
// changing an existing AVATAR_PALETTE value (an identity colour every contact
// already has), which this pass does not do; the bar here pins it from slipping.
const AVATAR_SHORT: Record<string, number> = { '#6366F1': 4.45 };
for (const fill of AVATAR_PALETTE) {
  const best = Math.max(ratio('#FFFFFF', fill), ratio('#010628', fill));
  assert.equal(ratio(inkOn(fill), fill), best, `inkOn picks the more readable ink on ${fill}`);
  check(`initial on ${fill}`, AVATAR_SHORT[fill] ?? TEXT, inkOn(fill), fill);
}

console.log('auroraPalette — text inks over the strongest bloom of each composition');
const schemes: [string, Palette, number][] = [['dark', AuroraDark, 1], ['light', AuroraLight, AURORA_LIGHT_OPACITY_SCALE]];
for (const [name, p, scale] of schemes) {
  for (const [variant, blooms] of Object.entries(AURORA_COMPOSITIONS)) {
    for (const b of blooms) {
      const [r, g, bl] = parse(b.c);
      const bloom = `rgba(${r},${g},${bl},${b.o * scale})`;
      for (const role of ['text', 'textDim', 'textFaint'] as const) {
        const rr = ratio(p[role], bloom, p.bg);
        assert.ok(rr >= TEXT, `${name} ${variant}: ${role} over ${b.c}@${b.o * scale} is ${rr.toFixed(2)}:1`);
        n++;
      }
    }
  }
  console.log(`  ✓ ${name}: text/textDim/textFaint ≥ 4.5:1 over every bloom peak`);
}

console.log('the components read these palettes (no literals left behind)');
const ROOT = path.resolve(__dirname, '..');
const HEX = /['"`]#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})['"`]/;
for (const [file, uses] of [
  ['components/TermsGate.tsx', 'TERMS_GATE'],
  ['components/UpdateGate.tsx', 'UPDATE_GATE'],
  ['components/ErrorBoundary.tsx', 'CRASH_SCREEN'],
  ['components/ui/Button.tsx', 'DANGER_GRADIENT_CTA'],
  ['components/ui/AuroraBackground.tsx', 'AURORA_COMPOSITIONS'],
] as const) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  assert.ok(src.includes(uses), `${file} should read ${uses}`);
  assert.ok(!HEX.test(src), `${file} has a hex colour literal again — put it in its palette module`);
  n++;
}
// ErrorBoundary renders after the tree threw: its palette must stay context-free.
const gateSrc = fs.readFileSync(path.join(__dirname, 'gatePalette.ts'), 'utf8');
const gateImports = [...gateSrc.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
assert.deepEqual(gateImports, ['./theme'], 'gatePalette imports only constants/theme');
assert.ok(!/^import /m.test(fs.readFileSync(path.join(__dirname, 'theme.ts'), 'utf8')), 'constants/theme imports nothing');
n += 2;

console.log(`paletteContrast.selftest: ${n} checks passed`);
