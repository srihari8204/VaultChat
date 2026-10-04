// components/notes/noteHueInk.ts — readable label text in a note hue.
//
// Category and tag chips colour their label with the chip's hue
// (constants/notesPalette). Raw, several hues fail AA on the chip: amber on the
// light ground is under 2:1, red on the dark one about 4:1. This keeps the hue
// but mixes it toward black (light theme) or white (dark theme) in 5% steps,
// stopping at the first mix that reaches 4.5:1 on both the plain chip ground
// and the hue-tinted one. Pure; constants/notesPalette.selftest.ts runs it on
// every palette hue in both themes.

import { contrastOn } from '../chat/bubbleFillInk';
import { PALETTES, type ColorScheme } from '../../constants/theme';

const AA = 4.5;
const TINT_ALPHA = 0x20 / 255;

type RGB = [number, number, number];
function parse(c: string): { rgb: RGB; a: number } | null {
  const h = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (h) return { rgb: [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16)) as RGB, a: 1 };
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c.trim());
  return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
}
const mix = (a: RGB, b: RGB, k: number): RGB => a.map((x, i) => x * (1 - k) + b[i] * k) as RGB;
const hex = (c: RGB) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase();

/** The opaque grounds a hue label can sit on: the theme bg (editor), glassSoft
 *  over it (chips, cards) and glassSoft twice (a tag inside a note card). The
 *  aurora blooms behind the list are not modelled (📱). */
export function chipGrounds(scheme: ColorScheme): string[] {
  const p = PALETTES[scheme];
  const bg = parse(p.bg)!.rgb;
  const glass = parse(p.glassSoft);
  const once = glass ? mix(bg, glass.rgb, glass.a) : bg;
  const twice = glass ? mix(once, glass.rgb, glass.a) : bg;
  return [hex(bg), hex(once), hex(twice)];
}

const cache = new Map<string, string>();

/** Label ink for `hue` on a chip in `scheme`: the hue itself when it already passes AA. */
export function noteHueInk(hue: string, scheme: ColorScheme): string {
  const key = `${scheme}|${hue}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const h = parse(hue);
  let ink = hue;
  if (h) {
    // Each ground plain (a count beside an unselected chip) and hue-tinted (the chip itself).
    const grounds = chipGrounds(scheme).flatMap((g) => { const rgb = parse(g)!.rgb; return [g, hex(mix(rgb, h.rgb, TINT_ALPHA))]; });
    const toward: RGB = scheme === 'light' ? [0, 0, 0] : [255, 255, 255];
    for (let k = 0; k <= 1.0001; k += 0.05) {
      const c = hex(mix(h.rgb, toward, Math.min(1, k)));
      if (grounds.every((g) => contrastOn(c, g) >= AA)) { ink = c; break; }
    }
  } else {
    // Not a colour we can measure (damaged stored data): the theme's own text.
    ink = PALETTES[scheme].text;
  }
  cache.set(key, ink);
  return ink;
}
