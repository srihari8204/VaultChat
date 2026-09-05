// constants/spaceTheme.selftest.ts — run: npx tsx constants/spaceTheme.selftest.ts
//
// Contrast is the reason this exists. The whole point of spaceTheme's
// accentText/goodText/dangerText is that the app palette's raw accent and
// success colours fail AA at the 11–13px sizes the Spaces hub uses them at —
// so the replacement tints are proven here against the actual composite a
// reader sees (translucent pane OVER the gradient ground), not against white.
//
// spaceTheme.ts is deliberately pure (no imports), so unlike the finance
// selftest this one imports the palette directly. The app text colours it
// must compose against live in constants/theme.ts, which imports react-native
// — those are read as TEXT, same approach as financeTheme.selftest.ts.

import { readFileSync } from 'fs';
import { join } from 'path';
import { SPACE_GLASS, SPACE_SHADOW } from './spaceTheme';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `  (${detail})`}`);
}

console.log('spaceTheme.selftest');

// ── colour helpers ────────────────────────────────────────────────────
type RGBA = { r: number; g: number; b: number; a: number };
function parse(c: string): RGBA {
  const m = c.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] };
  const h = c.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error('unparseable colour: ' + c);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
}
/** src composited over an opaque dst. */
function over(src: RGBA, dst: RGBA): RGBA {
  const a = src.a;
  return { r: src.r * a + dst.r * (1 - a), g: src.g * a + dst.g * (1 - a), b: src.b * a + dst.b * (1 - a), a: 1 };
}
function srgb(c: number): number { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
function lum(c: RGBA): number { return 0.2126 * srgb(c.r) + 0.7152 * srgb(c.g) + 0.0722 * srgb(c.b); }
function ratio(fg: RGBA, bg: RGBA): number {
  const L1 = lum(fg), L2 = lum(bg);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

// ── the app text colours, read from constants/theme.ts as text ────────
const THEME_SRC = readFileSync(join(__dirname, 'theme.ts'), 'utf8');
function themeColor(palette: 'AuroraLight' | 'AuroraDark', key: string): string {
  const start = THEME_SRC.indexOf(`export const ${palette}: Palette = {`);
  const end = THEME_SRC.indexOf('};', start);
  const m = THEME_SRC.slice(start, end).match(new RegExp(`${key}:\\s*'([^']+)'`));
  if (!m) throw new Error(`${palette}.${key} not found`);
  return m[1];
}

// ── 1. the two schemes share a shape, key for key ─────────────────────
{
  const lk = Object.keys(SPACE_GLASS.light).sort().join(',');
  const dk = Object.keys(SPACE_GLASS.dark).sort().join(',');
  ok('light and dark share the same keys', lk === dk, `${lk} vs ${dk}`);
}

// ── 2. every colour parses; pane alphas are genuinely translucent ─────
for (const scheme of ['light', 'dark'] as const) {
  const G = SPACE_GLASS[scheme];
  for (const [k, v] of Object.entries(G)) {
    if (k === 'auraAlphas') continue;
    try { parse(v as string); } catch { ok(`${scheme}.${k} parses`, false, String(v)); }
  }
  for (const k of ['pane', 'paneStrong', 'paneFaint', 'edge', 'chipEdge', 'press'] as const) {
    const a = parse(G[k]).a;
    ok(`${scheme}.${k} is translucent (0 < a < 1)`, a > 0 && a < 1, `a=${a}`);
  }
  ok(`${scheme}.sheet is opaque`, parse(G.sheet).a === 1);
  ok(`${scheme}.auraAlphas has 3 fading steps`,
    G.auraAlphas.length === 3
    && G.auraAlphas.every((h) => /^[0-9A-Fa-f]{2}$/.test(h))
    && parseInt(G.auraAlphas[0], 16) >= parseInt(G.auraAlphas[1], 16)
    && parseInt(G.auraAlphas[1], 16) >= parseInt(G.auraAlphas[2], 16));
}

// ── 3. the ground darkens top → bottom in both schemes ────────────────
for (const scheme of ['light', 'dark'] as const) {
  const G = SPACE_GLASS[scheme];
  const l = [lum(parse(G.bgTop)), lum(parse(G.bgMid)), lum(parse(G.bgBottom))];
  ok(`${scheme} ground darkens downward`, l[0] >= l[1] && l[1] >= l[2], l.map((x) => x.toFixed(3)).join(' → '));
}

// ── 4. AA on the composites a reader actually sees ────────────────────
// Text sits on pane-over-ground (cards) and paneFaint-over-ground (chips);
// bgMid is the ground tone under most of the content.
const TEXT = {
  light: { text: themeColor('AuroraLight', 'text'), textDim: themeColor('AuroraLight', 'textDim') },
  dark:  { text: themeColor('AuroraDark', 'text'),  textDim: themeColor('AuroraDark', 'textDim') },
};
for (const scheme of ['light', 'dark'] as const) {
  const G = SPACE_GLASS[scheme];
  const ground = parse(G.bgMid);
  for (const surface of ['pane', 'paneFaint', 'paneStrong'] as const) {
    const comp = over(parse(G[surface]), ground);
    const rText = ratio(over(parse(TEXT[scheme].text), comp), comp);
    const rDim = ratio(over(parse(TEXT[scheme].textDim), comp), comp);
    ok(`${scheme} text on ${surface} ≥ 4.5`, rText >= 4.5, rText.toFixed(2));
    ok(`${scheme} textDim on ${surface} ≥ 4.5`, rDim >= 4.5, rDim.toFixed(2));
    for (const k of ['accentText', 'goodText', 'dangerText'] as const) {
      const r = ratio(parse(G[k]), comp);
      ok(`${scheme} ${k} on ${surface} ≥ 4.5`, r >= 4.5, r.toFixed(2));
    }
  }
  // Elevated sheet: title + body text must clear AA on the solid surface.
  const sheet = parse(G.sheet);
  ok(`${scheme} text on sheet ≥ 4.5`, ratio(over(parse(TEXT[scheme].text), sheet), sheet) >= 4.5);
  ok(`${scheme} textDim on sheet ≥ 4.5`, ratio(over(parse(TEXT[scheme].textDim), sheet), sheet) >= 4.5);
}

// ── 5. shadows: Android's `elevation` present, iOS opacity restrained ─
ok('rest shadow carries elevation', SPACE_SHADOW.rest.elevation > 0);
ok('raised shadow carries elevation', SPACE_SHADOW.raised.elevation > SPACE_SHADOW.rest.elevation);
ok('shadow opacities stay soft (≤ 0.2)', SPACE_SHADOW.rest.shadowOpacity <= 0.2 && SPACE_SHADOW.raised.shadowOpacity <= 0.2);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
