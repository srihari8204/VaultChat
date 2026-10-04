// constants/sosPalette.selftest.ts — "SOS" stays readable on its fixed red.
//
// The label is 48 sp, weight 900 (components/sos/sosStyles.ts), i.e. WCAG large
// text: at least 3:1 against every gradient stop.
//
//   npx tsx constants/sosPalette.selftest.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOS_BUTTON } from './sosPalette';

function lum(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `not #rrggbb: ${hex}`);
  const f = (i: number) => { const v = parseInt(m[1].slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
}
const ratio = (a: string, b: string) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

for (const stop of SOS_BUTTON.gradient) {
  const r = ratio(SOS_BUTTON.ink, stop);
  assert.ok(r >= 3, `SOS ink ${SOS_BUTTON.ink} on ${stop} is ${r.toFixed(2)}:1 (< 3, large text)`);
}

// The size that makes 3:1 enough, and the ink, are what the button really uses.
const styles = readFileSync(join(__dirname, '..', 'components', 'sos', 'sosStyles.ts'), 'utf8');
assert.match(styles, /sosText: \{ color: SOS_BUTTON\.ink, fontSize: 48, fontWeight: '900'/, 'sosText is 48/900 on SOS_BUTTON.ink');
const screen = readFileSync(join(__dirname, '..', 'app', 'emergency-sos.tsx'), 'utf8');
assert.match(screen, /<LinearGradient colors=\{SOS_BUTTON\.gradient\}/, 'the SOS button draws SOS_BUTTON.gradient');

console.log('sosPalette self-check: OK');
