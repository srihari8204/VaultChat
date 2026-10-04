// constants/notesPalette.selftest.ts — run: npx tsx constants/notesPalette.selftest.ts
//
// The notes hues are fixed (a note stores its tag colour), and label text in a
// hue sits on a chip tinted with it. This holds that text to WCAG AA (4.5:1)
// on every ground noteHueInk models, in both themes, and checks the ink keeps
// the hue's identity (it is the raw hue when that already passes, and two
// different hues never collapse into one ink).

import assert from 'node:assert/strict';
import { contrastOn } from '../components/chat/bubbleFillInk';
import { chipGrounds, noteHueInk } from '../components/notes/noteHueInk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_NOTE_TAG_COLOR, NOTE_CATEGORY_HUE, NOTE_CHIP_TINT, NOTE_TAG_COLORS } from './notesPalette';
import { PALETTES, type ColorScheme } from './theme';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };
const AA = 4.5;
const HEX6 = /^#[0-9A-F]{6}$/i;
const SCHEMES: ColorScheme[] = ['light', 'dark'];
/** `hue` at the chip tint (0x20 / 255) over the opaque `ground`, as an opaque hex. */
const tint = (ground: string, hue: string) => {
  const ch = (c: string, i: number) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  const a = parseInt(NOTE_CHIP_TINT, 16) / 255;
  return '#' + [0, 1, 2].map((i) => Math.round(ch(ground, i) * (1 - a) + ch(hue, i) * a).toString(16).padStart(2, '0')).join('');
};

const hues = [...new Set([...Object.values(NOTE_CATEGORY_HUE), ...NOTE_TAG_COLORS, DEFAULT_NOTE_TAG_COLOR])];
for (const h of hues) ok(`${h} is a 6-digit hex (chips append the '${NOTE_CHIP_TINT}' alpha to it)`, HEX6.test(h));
ok('the default tag colour is one the picker offers', (NOTE_TAG_COLORS as readonly string[]).includes(DEFAULT_NOTE_TAG_COLOR));
ok('tag colours are distinct', new Set(NOTE_TAG_COLORS).size === NOTE_TAG_COLORS.length);

// The model reads the palette: no second copy of the hexes (it imports React
// Native through notesCrypto, so its source is read rather than loaded).
const model = readFileSync(join(__dirname, '..', 'components', 'notes', 'notesModel.ts'), 'utf8');
ok('notesModel holds no hex colour of its own', !/['"`]#[0-9a-f]{3,8}['"`]/i.test(model));
for (const key of Object.keys(NOTE_CATEGORY_HUE)) ok(`notesModel category ${key} reads NOTE_CATEGORY_HUE`, model.includes(`color: NOTE_CATEGORY_HUE.${key} `));
ok('notesModel tag colours are NOTE_TAG_COLORS', /TAG_COLORS: readonly string\[\] = NOTE_TAG_COLORS;/.test(model) && /DEFAULT_TAG_COLOR: string = DEFAULT_NOTE_TAG_COLOR;/.test(model));

for (const scheme of SCHEMES) {
  const grounds = chipGrounds(scheme);
  ok(`${scheme}: three opaque grounds`, grounds.length === 3 && grounds.every((g) => HEX6.test(g)));
  const inks = new Map<string, string>();
  for (const h of hues) {
    const ink = noteHueInk(h, scheme);
    // Each ground plain, and with the chip's hue tint laid over it.
    const all = grounds.flatMap((g) => [g, tint(g, h)]);
    for (const g of all) {
      const r = contrastOn(ink, g);
      ok(`${scheme}: ${h} label ink ${ink} on ${g}: ${r.toFixed(2)}:1 >= ${AA}`, r >= AA);
    }
    // When the hue already passes on every ground, it is used as is.
    const rawPasses = all.every((g) => contrastOn(h, g) >= AA);
    if (rawPasses) ok(`${scheme}: ${h} already passes, so it is its own ink`, ink.toUpperCase() === h.toUpperCase());
    ok(`${scheme}: ${h} ink is not plain black or white (the hue survives)`, !['#000000', '#FFFFFF'].includes(ink));
    if (inks.has(ink)) ok(`${scheme}: ${h} and ${inks.get(ink)} share an ink only if they are the same hue`, inks.get(ink)!.toUpperCase() === h.toUpperCase());
    inks.set(ink, h);
  }
  ok(`${scheme}: an unreadable stored colour falls back to the theme text`, noteHueInk('blue', scheme) === PALETTES[scheme].text);
}

// The case that motivated this: amber label text on the light chip.
ok('raw amber on the light chip is below AA', contrastOn('#F59E0B', chipGrounds('light')[1]) < AA);

console.log(`notesPalette.selftest: ${n} checks passed`);
