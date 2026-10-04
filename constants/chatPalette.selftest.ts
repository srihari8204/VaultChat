// constants/chatPalette.selftest.ts — run: npx tsx constants/chatPalette.selftest.ts
//
// The chat's fixed colours (constants/chatPalette) against what they sit on:
//   * the media scrims over the WORST picture, pure white: the counter text and
//     the small remove glyph on scrimStrong >= 4.5:1, the large close glyph on
//     scrim >= 3:1 (a non-text graphic);
//   * the send button's ink on accentDeep in both palettes >= 4.5:1;
//   * the chat files take these from here, not inline hex literals.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastOn } from '../components/chat/bubbleFillInk';
import { CHAT_MEDIA_SCRIM, SEND_FAB_INK } from './chatPalette';
import { PALETTES } from './theme';

/** A '#000000AA' scrim laid over `under`: the colour the ink actually sits on. */
function scrimOver(scrim: string, under: string): string {
  const alpha = parseInt(scrim.slice(7, 9), 16) / 255;
  const ch = [1, 3, 5].map(i => Math.round(parseInt(under.slice(i, i + 2), 16) * (1 - alpha)));
  return '#' + ch.map(n => n.toString(16).padStart(2, '0')).join('');
}

const checks: [string, string, string, number][] = [
  ['counter text / remove glyph on scrimStrong over a white photo', CHAT_MEDIA_SCRIM.ink, scrimOver(CHAT_MEDIA_SCRIM.scrimStrong, '#ffffff'), 4.5],
  ['close glyph on scrim over a white photo', CHAT_MEDIA_SCRIM.ink, scrimOver(CHAT_MEDIA_SCRIM.scrim, '#ffffff'), 3],
  ['send glyph on accentDeep (dark)', SEND_FAB_INK, PALETTES.dark.accentDeep, 4.5],
  ['send glyph on accentDeep (light)', SEND_FAB_INK, PALETTES.light.accentDeep, 4.5],
];
for (const [what, fg, bg, min] of checks) {
  const r = contrastOn(fg, bg);
  assert.ok(r >= min, `${what}: ${fg} on ${bg} is ${r.toFixed(2)}:1, under ${min}:1`);
  console.log(`  ${what}: ${r.toFixed(2)}:1 (>= ${min})`);
}

for (const f of ['components/chat/MediaCaptionPreview.tsx', 'components/chat/Composer.tsx']) {
  const src = readFileSync(join(__dirname, '..', f), 'utf8');
  assert.ok(/constants\/chatPalette/.test(src), `${f} no longer reads constants/chatPalette`);
  assert.ok(!/['"`]#[0-9a-fA-F]{3,8}['"`]/.test(src), `${f} has an inline hex colour again`);
}
// The counter is TEXT, so it must use the stronger scrim (the lighter one is 4.48:1 on white).
assert.match(readFileSync(join(__dirname, '..', 'components/chat/MediaCaptionPreview.tsx'), 'utf8'),
  /backgroundColor: CHAT_MEDIA_SCRIM\.scrimStrong, paddingHorizontal: 12/, 'the counter pill uses scrimStrong');

console.log('chatPalette: media scrim and send-button inks clear their contrast floors');
