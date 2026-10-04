// lib/chatBubbleTick.selftest.ts — run: npx tsx lib/chatBubbleTick.selftest.ts
//
// On your own filled bubble the tick sits in the meta line (bubbleMetaOut, or
// bubbleOutText under Vision Comfort high contrast — lib/theme.tsx). "Delivered"
// draws in that ink; "read" draws in tickRead (components/chat/BubbleParts.tsx
// BubbleMetaLine). When tickRead was white the two looked identical, so:
//   * tickRead must be a non-text graphic with >= 3:1 against the bubble fill;
//   * it must not be any of the meta inks it has to be told apart from;
//   * it must carry a real hue (chroma), because every colour that clears 3:1
//     on this mid-blue fill is light, so luminance alone cannot separate it
//     from the white-ish meta line — the hue does.
// A custom bubble colour (lib/chatBubbleTheme BUBBLE_THEMES) gets its own inks
// (components/chat/bubbleFillInk): checked here for EVERY preset, in normal and
// high contrast — body and meta text >= 4.5:1, read tick >= 3:1 with a hue
// apart from the meta ink the sent / delivered ticks use.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PALETTES } from '../constants/theme';
import { fillInks, contrastOn, chroma } from '../components/chat/bubbleFillInk';

function rgba(v: string): [number, number, number, number] {
  if (v.startsWith('#')) {
    const h = v.slice(1);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const p = v.replace(/^rgba?\(|\)$/g, '').split(',').map(Number);
  return [p[0], p[1], p[2], p[3] ?? 1];
}
function over(fg: string, bg: string): number[] {
  const f = rgba(fg), b = rgba(bg);
  return [0, 1, 2].map(i => f[i] * f[3] + b[i] * (1 - f[3]));
}
function lum(rgb: number[]): number {
  const [r, g, b] = rgb.map(x => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg: string, bg: string): number {
  const a = lum(over(fg, bg)), b = lum(over(bg, bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

for (const [scheme, p] of Object.entries(PALETTES)) {
  const fill = p.bubbleOut;
  const onFill = contrast(p.tickRead, fill);
  assert.ok(onFill >= 3, `${scheme}: read tick on the sent fill is ${onFill.toFixed(2)}:1 (< 3:1)`);
  for (const [name, ink] of [['bubbleMetaOut', p.bubbleMetaOut], ['bubbleOutText (high contrast)', p.bubbleOutText]] as const) {
    assert.notEqual(p.tickRead.toLowerCase(), ink.toLowerCase(), `${scheme}: read tick equals ${name}`);
  }
  const [r, g, b] = over(p.tickRead, fill);
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  assert.ok(chroma >= 100, `${scheme}: read tick has no clear hue (chroma ${chroma.toFixed(0)}) — it would read as the white meta line`);
  console.log(`${scheme}: tickRead ${p.tickRead} on ${fill} = ${onFill.toFixed(2)}:1; delivered ink ${p.bubbleMetaOut} = ${contrast(p.bubbleMetaOut, fill).toFixed(2)}:1; high-contrast ink ${p.bubbleOutText} = ${contrast(p.bubbleOutText, fill).toFixed(2)}:1`);
}
// Presets read from source: lib/chatBubbleTheme.ts imports AsyncStorage.
const themeSrc = readFileSync('lib/chatBubbleTheme.ts', 'utf8');
const presets = [...themeSrc.matchAll(/id: '(\w+)',\s*name: '[^']+',\s*color: '(#[0-9A-Fa-f]{6})'/g)].map(m => [m[1], m[2]] as const);
assert.ok(presets.length >= 11, `found ${presets.length} bubble presets in lib/chatBubbleTheme.ts`);
for (const [id, fill] of presets) {
  for (const hc of [false, true]) {
    const ink = fillInks(fill, hc);
    const text = contrastOn(ink.text, fill);
    const meta = contrast(ink.meta, fill);
    const read = contrastOn(ink.tickRead, fill);
    const tag = `${id} ${fill}${hc ? ' (high contrast)' : ''}`;
    assert.ok(text >= 4.5, `${tag}: body text ${ink.text} is ${text.toFixed(2)}:1 (< 4.5:1)`);
    assert.ok(meta >= 4.5, `${tag}: time/meta ink ${ink.meta} is ${meta.toFixed(2)}:1 (< 4.5:1)`);
    assert.ok(read >= 3, `${tag}: read tick ${ink.tickRead} is ${read.toFixed(2)}:1 (< 3:1)`);
    assert.ok(chroma(ink.tickRead) >= 100, `${tag}: read tick ${ink.tickRead} has no clear hue`);
    assert.ok(chroma(ink.text) < 40, `${tag}: meta ink is neutral, so the read tick's hue sets it apart`);
    if (!hc) console.log(`${tag}: text ${text.toFixed(2)}:1, meta ${ink.meta} ${meta.toFixed(2)}:1, read ${ink.tickRead} ${read.toFixed(2)}:1`);
  }
}
console.log('chatBubbleTick: ok');
