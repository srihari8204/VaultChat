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

import assert from 'node:assert/strict';
import { PALETTES } from '../constants/theme';

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
console.log('chatBubbleTick: ok');
