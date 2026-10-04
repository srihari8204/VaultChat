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
// (lib/bubbleFillInk): checked here for EVERY preset, in normal and
// high contrast — body and meta text >= 4.5:1, read tick >= 3:1 with a hue
// apart from the meta ink the sent / delivered ticks use. The theme's own
// bubbleMetaOut (time text on the default fill) is text too: >= 4.5:1.
// The rest of your bubble's content on a custom colour (poll, location, file,
// voice, the "unable to decrypt" / "not available" placeholders) must use those
// inks too — checked by contrast (the voice note's unplayed `track` >= 3:1, a
// graphic) and by pinning the components to them (`fillInk`), so Emerald is no
// longer white at 2.54:1 beside a dark meta line.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PALETTES } from '../constants/theme';
import { fillInks, contrastOn, chroma } from './bubbleFillInk';

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
  // The time / sent / delivered ink is text: 4.5:1 on the fill.
  const meta = contrast(p.bubbleMetaOut, fill);
  assert.ok(meta >= 4.5, `${scheme}: bubbleMetaOut ${p.bubbleMetaOut} on ${fill} is ${meta.toFixed(2)}:1 (< 4.5:1)`);
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
    const track = contrast(ink.track, fill);
    assert.ok(track >= 3, `${tag}: unplayed wave ink ${ink.track} is ${track.toFixed(2)}:1 (< 3:1)`);
    assert.notEqual(ink.track, ink.text, `${tag}: played (text) and unplayed (track) wave bars differ`);
    if (!hc) console.log(`${tag}: text ${text.toFixed(2)}:1, meta ${ink.meta} ${meta.toFixed(2)}:1, read ${ink.tickRead} ${read.toFixed(2)}:1`);
  }
}
// The theme picker (app/chat-themes.tsx) previews with lib/chatBubbleTheme
// idealText: it must pick the same ink as the chat (fillInks), not a
// brightness cut-off that put white on Emerald at 2.54:1.
assert.ok(/export function idealText\(hex: string\): string \{\s*return fillInks\(hex\)\.text;/.test(themeSrc),
  'lib/chatBubbleTheme idealText delegates to fillInks(hex).text');
assert.ok(/const mineMeta = current\.color \? fillInks\(current\.color\)\.meta : colors\.bubbleMetaOut;/
  .test(readFileSync('app/chat-themes.tsx', 'utf8')), 'the picker previews the time text in the chat\'s own meta ink');

// Every own-bubble element drawn on the custom fill takes those inks
// (MessageBubble computes ownFillInk once and passes it down).
const bubble = readFileSync('components/chat/MessageBubble.tsx', 'utf8');
assert.match(bubble, /const ownFillInk = useMemo\(\(\) => \(bubbleBg \? fillInks\(bubbleBg, vision\.highContrast\) : null\)/,
  'MessageBubble derives the content inks from your bubble colour');
for (const part of ['<AudioBubble', '<FileBubble', '<PollBubble', '<LocationBubble', '<TextBody']) {
  const at = bubble.indexOf(part);
  assert.ok(at > 0 && /fillInk=\{ownFillInk\}/.test(bubble.slice(at, bubble.indexOf('/>', at))), `${part} gets fillInk`);
}
const parts = readFileSync('components/chat/BubbleParts.tsx', 'utf8');
const media = readFileSync('components/chat/MediaBubbles.tsx', 'utf8');
const pins: [string, string, RegExp][] = [
  ['poll question', parts, /S\.pollQuestionMine, fillInk && \{ color: fillInk\.text \}/],
  ['poll option mark', parts, /S\.pollOptionMarkOn, fillInk && \{ color: checked \? fillInk\.text : fillInk\.meta \}/],
  ['poll option label', parts, /S\.pollOptionLabelMine, fillInk && \{ color: fillInk\.text \}/],
  ['poll option count', parts, /S\.pollOptionCountMine, fillInk && \{ color: fillInk\.meta \}/],
  ['poll bar', parts, /S\.pollBarFillMine,\s*fillInk && \{ backgroundColor: fillInk\.text \}/],
  ['poll footer', parts, /S\.pollFooterMine, fillInk && \{ color: fillInk\.meta \}/],
  ['location icon', parts, /color=\{fillInk \? fillInk\.text : isMine \? colors\.bubbleOutText/],
  ['location title', parts, /\{ fontWeight: '700' \}, fillInk && \{ color: fillInk\.text \}/],
  ['location address', parts, /opacity: 0\.85 \}, fillInk && \{ color: fillInk\.meta, opacity: 1 \}/],
  ['"Open in Maps"', parts, /color: fillInk \? fillInk\.text : isMine \? colors\.bubbleOutText : colors\.accentOn, fontSize: 12/],
  ['file name (card and row)', media, /S\.fileNameMine, fillInk && \{ color: fillInk\.text \}[\s\S]*S\.fileNameMine, fillInk && \{ color: fillInk\.text \}/],
  ['file size (card and row)', media, /S\.fileSizeMine, fillInk && \{ color: fillInk\.meta \}[\s\S]*S\.fileSizeMine, fillInk && \{ color: fillInk\.meta \}/],
  ['voice wave bars', media, /fillInk && \{ backgroundColor: played \? fillInk\.text : fillInk\.track \}/],
  ['voice progress bar', media, /S\.audioFillMine, fillInk && \{ backgroundColor: fillInk\.text \}/],
  ['voice time', media, /S\.audioTimeMine, fillInk && \{ color: fillInk\.meta \}/],
];
for (const [what, src, re] of pins) assert.match(src, re, `${what} uses the custom-fill ink`);
// Both italic placeholders ("🔒 unable to decrypt", "⧗ Message not available"):
// the meta ink at full opacity (it is already the dimmest ink that keeps 4.5:1).
assert.equal((parts.match(/\{ fontStyle: 'italic', opacity: 0\.7 \}, fillInk && \{ color: fillInk\.meta, opacity: 1 \}/g) ?? []).length, 2,
  'both placeholders use the custom-fill meta ink');
// lib/ must not reach into components/ for the inks.
assert.doesNotMatch(themeSrc, /from '\.\.\/components\//, 'lib/chatBubbleTheme imports nothing from components/');
console.log('chatBubbleTick: ok');
