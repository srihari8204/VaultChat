/**
 * lib/auroraGlass.selftest.ts
 *   run with: npx tsx lib/auroraGlass.selftest.ts
 *
 * Aurora Glass (U6) added seven roles to `Palette`. The failure mode that
 * actually bites is a palette that compiles but is INCOMPLETE at runtime: a
 * `Palette`-shaped object built by spread or by hand that never got the new
 * keys renders `undefined` as a colour, which React Native silently draws as
 * transparent. On a dark ground that means invisible borders and, worse,
 * invisible hairlines — a list with no separators and no error anywhere.
 *
 * So the load-bearing assertion is coverage: every exported palette defines
 * every role, and every value is a real colour string.
 */
import assert from 'node:assert/strict';
import { PALETTES, AuroraDark, AuroraLight, avatarRing, avatarColor, AVATAR_RING_PALETTE, AVATAR_PALETTE, type Palette } from '../constants/theme';
import { BIZ } from '../constants/businessTheme';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

const AURORA_ROLES = [
  'glass', 'glassSoft', 'glassStroke', 'hairline', 'groundDisc', 'accentLight', 'accentDeep',
] as const satisfies readonly (keyof Palette)[];

const isColor = (v: unknown): boolean =>
  typeof v === 'string' && v.length > 0 && (v.startsWith('#') || v.startsWith('rgb'));

// ── Every palette defines every Aurora role, with a usable value ─────
const palettes: [string, Palette][] = [
  ['AuroraDark', AuroraDark],
  ['AuroraLight', AuroraLight],
  ['PALETTES.dark', PALETTES.dark],
  ['PALETTES.light', PALETTES.light],
  ['BIZ', BIZ],
];
for (const [name, p] of palettes) {
  for (const role of AURORA_ROLES) {
    ok(`${name}.${role} is a colour`, isColor(p[role]));
  }
}

// ── The dark ground is the deep aurora base, not the old near-black ──
// If this drifts back the blooms lose their contrast and the whole screen
// reads grey rather than lit.
ok('dark ground is #0A0810', AuroraDark.bg.toLowerCase() === '#0a0810');

// ── Ring colours are deterministic and index-matched ─────────────────
// Rows are recycled while scrolling; a ring that changes colour between
// renders of the same contact is the visible symptom of a non-pure hash.
ok('ring palette matches avatar palette length', AVATAR_RING_PALETTE.length === AVATAR_PALETTE.length);
for (const seed of ['Anitha', 'Kiran Kumar', '', 'ZZ', 'srihari.balla152@gmail.com']) {
  const a = avatarRing(seed);
  const b = avatarRing(seed);
  ok(`avatarRing("${seed}") is stable`, a[0] === b[0] && a[1] === b[1]);
  ok(`avatarRing("${seed}") returns two colours`, isColor(a[0]) && isColor(a[1]));
}
ok('avatarRing handles null like avatarColor does', isColor(avatarRing(null)[0]) && isColor(avatarColor(null)));

// ── Distinct contacts should not all land on one ring ────────────────
const names = ['Anitha', 'Family Space', 'Kiran Kumar', 'Office Group', 'Priya', 'Dad', 'crazzychat Team', 'Sandeep'];
const distinct = new Set(names.map(x => avatarRing(x).join('/')));
ok('a realistic chat list gets varied rings', distinct.size >= 4);


// ── Both themes have to be READABLE, not merely complete ─────────────
// The failure this catches is specific and was live before this pass: the
// accent is a pale lavender chosen against a near-black ground. Copy it into
// the light palette and every active tab, link and timestamp turns into
// low-contrast haze that still "works" — nothing crashes, nothing is
// undefined, it is just unreadable. Contrast is the only assertion that sees it.

/** Parse '#RGB' | '#RRGGBB' | 'rgba(r,g,b,a)' into linear-ish [r,g,b,a] 0-255. */
function parse(v: string): [number, number, number, number] {
  const rgba = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (rgba) return [ +rgba[1], +rgba[2], +rgba[3], rgba[4] === undefined ? 1 : +rgba[4] ];
  let h = v.replace('#', '');
  if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

/** Composite a possibly-translucent foreground over an opaque background. */
function over(fg: string, bg: string): [number, number, number] {
  const [fr, fg2, fb, fa] = parse(fg);
  const [br, bg2, bb] = parse(bg);
  return [fr * fa + br * (1 - fa), fg2 * fa + bg2 * (1 - fa), fb * fa + bb * (1 - fa)];
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(over(fg, bg));
  const b = luminance(over(bg, bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

for (const [name, p] of [['dark', AuroraDark], ['light', AuroraLight]] as [string, Palette][]) {
  const bodyText = contrast(p.text, p.bg);
  ok(`${name}: body text on ground is at least 4.5:1 (got ${bodyText.toFixed(2)})`, bodyText >= 4.5);

  const muted = contrast(p.textDim, p.bg);
  ok(`${name}: muted text on ground is at least 3:1 (got ${muted.toFixed(2)})`, muted >= 3);

  // accentOn is the tab label, the link, the "online" line — UI text, so 3:1.
  const accent = contrast(p.accentOn, p.bg);
  ok(`${name}: accentOn on ground is at least 3:1 (got ${accent.toFixed(2)})`, accent >= 3);

  const onBubble = contrast(p.bubbleOutText, p.bubbleOut);
  ok(`${name}: sent-bubble text on the accent fill is at least 4:1 (got ${onBubble.toFixed(2)})`, onBubble >= 4);
}

// ── The two palettes must actually differ where it matters ───────────
// Guards against a lazy "fill light in with the dark values" regression.
for (const role of ['bg', 'text', 'card', 'accentOn', 'groundDisc'] as (keyof Palette)[]) {
  ok(`light and dark disagree on ${role}`, AuroraDark[role] !== AuroraLight[role]);
}

// ── And neither is inverted ──────────────────────────────────────────
ok('the dark ground is genuinely dark', luminance(over(AuroraDark.bg, AuroraDark.bg)) < 0.08);
ok('the light ground is genuinely light', luminance(over(AuroraLight.bg, AuroraLight.bg)) > 0.6);

console.log(`auroraGlass.selftest: ${n} assertions passed (incl. contrast in both themes)`);
