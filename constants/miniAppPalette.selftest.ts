// constants/miniAppPalette.selftest.ts — run: npx tsx constants/miniAppPalette.selftest.ts
//
// The Mini Apps tiles draw a glyph on a fixed brand gradient. A glyph is a
// graphic, so WCAG 1.4.11 asks for 3:1 against what is behind it — and a
// gradient has two ends, so the glyph must clear 3:1 on BOTH stops.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastOn } from '../components/chat/bubbleFillInk';
import { MINI_TILE_ART, MINI_TILE_GLYPH, MINI_TILE_GLYPH_DARK } from './miniAppPalette';

let worst = Infinity;
for (const [id, { gradient, glyph }] of Object.entries(MINI_TILE_ART)) {
  for (const stop of gradient) {
    const r = contrastOn(glyph, stop);
    worst = Math.min(worst, r);
    assert.ok(r >= 3, `${id}: glyph ${glyph} on ${stop} is ${r.toFixed(2)}:1, under 3:1`);
  }
}

// Notes is the one tile where white fails; it must stay on the dark ink.
assert.ok(contrastOn(MINI_TILE_GLYPH, MINI_TILE_ART.notes.gradient[0]) < 3, 'white on Notes amber now passes — the dark-ink exception can go');
assert.equal(MINI_TILE_ART.notes.glyph, MINI_TILE_GLYPH_DARK);

// The launcher must take its tiles from here, not inline literals.
const MINI = readFileSync(join(__dirname, '..', 'app', '(tabs)', 'mini.tsx'), 'utf8');
assert.ok(/MINI_TILE_ART\./.test(MINI), 'app/(tabs)/mini.tsx no longer reads MINI_TILE_ART');
assert.ok(!/['"`]#[0-9a-fA-F]{3,8}['"`]/.test(MINI), 'app/(tabs)/mini.tsx has an inline hex colour again');

console.log(`miniAppPalette: every tile glyph is >= 3:1 on both stops (worst ${worst.toFixed(2)}:1)`);
