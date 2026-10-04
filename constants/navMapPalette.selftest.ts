// constants/navMapPalette.selftest.ts — the map credits stay legible.
//
// OpenStreetMap's licence requires a legible credit. The credit plates in the
// map pages are semi-transparent, so each is composited over the two extremes
// a map can show (white and black) and the credit ink and link must reach
// WCAG AA (4.5:1) on both.
//
//   npx tsx constants/navMapPalette.selftest.ts

import assert from 'node:assert/strict';
import { NAV_MAP, PIN_MAP } from './navMapPalette';

type RGBA = [number, number, number, number];
function parse(c: string): RGBA {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (x) => x + x) : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(c.replace(/\s/g, ''));
  assert.ok(m, `unparseable colour ${c}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}
const over = (c: RGBA, under: readonly number[]) => c.slice(0, 3).map((x, i) => x * c[3] + under[i] * (1 - c[3]));
function lum(rgb: readonly number[]): number {
  const f = (x: number) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
const ratio = (a: readonly number[], b: readonly number[]) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

let n = 0;
for (const [name, p] of [['NavMap (Leaflet)', NAV_MAP], ['LocationMap', PIN_MAP]] as const) {
  for (const [mapName, map] of [['white', [255, 255, 255]], ['black', [0, 0, 0]]] as const) {
    const plate = over(parse(p.creditGround), map);
    for (const [what, ink] of [['credit text', p.creditInk], ['credit link', p.creditLink]] as const) {
      const r = ratio(over(parse(ink), plate), plate);
      assert.ok(r >= 4.5, `${name}: ${what} ${ink} on ${p.creditGround} over a ${mapName} map is ${r.toFixed(2)}:1 (< 4.5)`);
      n++;
    }
  }
}

// Every value is a colour the pages can use as-is in CSS and in JS strings.
for (const p of [NAV_MAP, PIN_MAP]) for (const v of Object.values(p)) { parse(v); n++; }

console.log(`navMapPalette self-check: OK (${n} checks)`);
