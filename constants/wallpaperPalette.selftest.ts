// constants/wallpaperPalette.selftest.ts — run: npx tsx constants/wallpaperPalette.selftest.ts
//
// The wallpaper presets are fixed colours (see the header of wallpaperPalette.ts).
// The one thing the picker draws ON them is the selected tile's check mark in
// wallpaperInk(); it must reach AA text contrast (4.5:1) on every stop of every
// preset, in both app themes (the presets and the ink ignore the theme).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrastOn } from '../components/chat/bubbleFillInk';
import { GRADIENT_WALLPAPERS, SOLID_WALLPAPERS, wallpaperInk } from './wallpaperPalette';

const HEX = /^#[0-9a-fA-F]{6}$/;
let n = 0;

for (const { hex, name } of SOLID_WALLPAPERS) {
  assert.ok(HEX.test(hex), `${name}: ${hex} is #rrggbb`);
  const ink = wallpaperInk([hex]);
  const c = contrastOn(ink, hex);
  assert.ok(c >= 4.5, `${name}: check ink ${ink} on ${hex} is ${c.toFixed(2)}:1, under 4.5:1`);
  n++;
}
for (const g of GRADIENT_WALLPAPERS) {
  const ink = wallpaperInk(g.colors);
  for (const stop of g.colors) {
    assert.ok(HEX.test(stop), `${g.name}: ${stop} is #rrggbb`);
    const c = contrastOn(ink, stop);
    assert.ok(c >= 4.5, `${g.name}: check ink ${ink} on stop ${stop} is ${c.toFixed(2)}:1, under 4.5:1`);
    n++;
  }
}

// Names are what a screen reader announces and how a saved choice is named back.
const uniq = (xs: string[]) => new Set(xs).size === xs.length;
assert.ok(uniq(SOLID_WALLPAPERS.map(s => s.name)) && uniq(SOLID_WALLPAPERS.map(s => s.hex.toLowerCase())), 'solid names and colours are unique');
assert.ok(uniq(GRADIENT_WALLPAPERS.map(g => g.id)) && uniq(GRADIENT_WALLPAPERS.map(g => g.name)), 'gradient ids and names are unique');

// The screen paints the check mark with this ink, and keeps no preset hex of its own.
const screen = readFileSync('app/chat-wallpaper.tsx', 'utf8');
assert.ok(/wallpaperInk\(/.test(screen), 'chat-wallpaper draws the check mark in wallpaperInk');
assert.equal((screen.match(/['"`]#[0-9a-fA-F]{3,8}['"`]/g) ?? []).length, 0, 'chat-wallpaper has no hex literals');

console.log(`wallpaperPalette selftest: ok (${n} preset stops checked at >= 4.5:1)`);
