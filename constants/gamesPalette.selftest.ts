// constants/gamesPalette.selftest.ts — run: npx tsx constants/gamesPalette.selftest.ts
//
// Every place in constants/gamesPalette.ts where TEXT sits on a fixed colour,
// measured against WCAG AA (4.5:1 — every label here is under 18 pt bold).
// Translucent layers are composited over the ground they really sit on.

import assert from 'node:assert/strict';
import { RED_FILL, GOOD_FILL, ON_FILL, DOCK_DANGER_INK, LIGHT_HUB } from './gamesPalette';
import { AuroraLight } from './theme';
import { CR_LIT } from '../lib/games/chessRoom';

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const s = h.replace('#', '');
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)) as RGB;
};
const over = (fg: RGB, a: number, bg: RGB): RGB => fg.map((c, i) => c * a + bg[i] * (1 - a)) as RGB;
const lum = (rgb: RGB) => {
  const l = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
};
const ratio = (a: RGB, b: RGB) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

let n = 0;
function aa(what: string, ink: RGB, ground: RGB) {
  const r = ratio(ink, ground);
  assert.ok(r >= 4.5, `${what}: ${r.toFixed(2)}:1 < 4.5:1`);
  n++; console.log(`  ok  ${what} ${r.toFixed(2)}:1`);
}

// 1. Painted buttons: a gradient is only as readable as its lightest stop.
for (const s of RED_FILL) aa(`danger button label on ${s}`, hex(ON_FILL), hex(s));
for (const s of GOOD_FILL) aa(`good button label on ${s}`, hex(ON_FILL), hex(s));

// 2. The chess dock's Resign: rose tint at .12, then the white(.09) sheen at
//    its brightest, over the lit chess room (components/games/ui.tsx DockBtn).
const dock = over([255, 255, 255], 0.09, over([255, 125, 134], 0.12, hex(CR_LIT)));
aa('dock danger label on its tile', hex(DOCK_DANGER_INK), dock);

// 3. The light launcher's gold, on the card and the solid surface it uses.
aa('light hub gold on the card', hex(LIGHT_HUB.gold), hex(AuroraLight.card));
aa('light hub gold on the solid surface', hex(LIGHT_HUB.gold), hex(AuroraLight.surfaceSolid));

console.log(`\ngamesPalette.selftest: ${n} pairs hold AA`);
