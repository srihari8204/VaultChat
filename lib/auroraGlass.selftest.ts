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
const names = ['Anitha', 'Family Space', 'Kiran Kumar', 'Office Group', 'Priya', 'Dad', 'VaultChat Team', 'Sandeep'];
const distinct = new Set(names.map(x => avatarRing(x).join('/')));
ok('a realistic chat list gets varied rings', distinct.size >= 4);

console.log(`auroraGlass.selftest: ${n} assertions passed`);
