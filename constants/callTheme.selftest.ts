// constants/callTheme.selftest.ts — run: npx tsx constants/callTheme.selftest.ts
//
// The call palette is fixed (always dark, not the app theme), so nothing else
// checks that the ink on it stays readable. Every pair below is TEXT that sits
// on a CALL surface; each must hold WCAG AA (4.5:1) for its size. Translucent
// colours are composited over what is actually under them on screen.

import assert from 'node:assert/strict';
import { CALL } from './callTheme';

type RGB = [number, number, number];
const parse = (c: string): { rgb: RGB; a: number } => {
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b, a = '1'] = m[1].split(',').map(x => x.trim());
    return { rgb: [+r, +g, +b], a: +a };
  }
  const h = c.replace('#', '');
  return { rgb: [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB, a: 1 };
};
const over = (fg: string, bg: RGB): RGB => {
  const { rgb, a } = parse(fg);
  return rgb.map((c, i) => c * a + bg[i] * (1 - a)) as RGB;
};
const lum = (rgb: RGB) => {
  const l = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
};
const ratio = (a: RGB, b: RGB) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const BLACK = parse(CALL.video).rgb;
let n = 0;
function aa(what: string, ink: string, ground: RGB, min = 4.5) {
  const r = ratio(over(ink, ground), ground);
  assert.ok(r >= min, `${what}: ${r.toFixed(2)}:1 < ${min}:1`);
  n++; console.log(`  ok  ${what} ${r.toFixed(2)}:1`);
}

const bg = parse(CALL.bg).rgb;
aa('title on the voice-call ground', CALL.text, bg);
aa('status line on the voice-call ground', CALL.textDim, bg);
aa('error copy on the voice-call ground', CALL.errorText, bg);

const bar = parse(CALL.bar).rgb;
aa('call-bar name', CALL.text, bar);
aa('call-bar "Tap to return" hint', CALL.barHint, bar);

const sheet = parse(CALL.sheet).rgb;
aa('chat sheet title', CALL.text, sheet);
aa('my chat bubble text', CALL.text, parse(CALL.chatMine).rgb);

const strip = over(CALL.stripScrim, BLACK);
aa('Tint strip label over a black frame', CALL.textDim, strip);
aa('Tint strip note over a black frame', CALL.textDim, strip);

aa('screen-share banner text over a black frame', CALL.text, over(CALL.shareBanner, BLACK));

console.log(`\ncallTheme.selftest: ${n} pairs hold AA`);
