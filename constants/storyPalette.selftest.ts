// constants/storyPalette.selftest.ts — run: npx tsx constants/storyPalette.selftest.ts
//
// Text statuses are white text on a fixed background the poster picks. Both
// the composer (components/status/TextStatusComposer.tsx, ink = AuroraDark.text,
// 96% white) and the viewer (app/story-viewer.tsx, pure white) draw on these,
// so each swatch must reach AA 4.5:1 for the dimmer of the two inks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastOn } from '../components/chat/bubbleFillInk';
import { AuroraDark } from './theme';
import { TEXT_STORY_SWATCHES } from './storyPalette';

const alpha = Number(/rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/.exec(AuroraDark.text)?.[1] ?? 1);
assert.ok(alpha > 0 && alpha <= 1, `AuroraDark.text is no longer a white rgba (${AuroraDark.text}); update this check`);

let worst = Infinity;
for (const { color, name } of TEXT_STORY_SWATCHES) {
  const r = Math.min(contrastOn('#FFFFFF', color, alpha), contrastOn('#FFFFFF', color));
  worst = Math.min(worst, r);
  assert.ok(r >= 4.5, `${name} ${color}: white text is ${r.toFixed(2)}:1, under 4.5:1`);
}
assert.equal(new Set(TEXT_STORY_SWATCHES.map(s => s.color)).size, TEXT_STORY_SWATCHES.length, 'two swatches share a colour (the radio state is keyed on it)');

const STATUS = readFileSync(join(__dirname, '..', 'app', '(tabs)', 'status.tsx'), 'utf8');
assert.ok(/TEXT_STORY_SWATCHES/.test(STATUS), 'app/(tabs)/status.tsx no longer offers TEXT_STORY_SWATCHES');

console.log(`storyPalette: white text on every swatch is >= 4.5:1 (worst ${worst.toFixed(2)}:1)`);
