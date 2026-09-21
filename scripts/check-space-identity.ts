// scripts/check-space-identity.ts — prove every space TYPE resolves to its OWN
// icon, theme and layout, and that Family can never inherit Business identity.
//
// WHY THIS EXISTS
//
// A Family space rendering the Business icon or the blue-on-navy Business skin
// is the exact regression this pins. The three decisions live in three modules
// (icon: lib/groups/catalog.ts · theme: lib/spaces/layout.ts usesBusinessTheme
// via lib/spaces/theme.ts · sections: lib/spaces/layout.ts), so a per-module
// self-check cannot see a disagreement BETWEEN them. This script asserts the
// whole mapping in one place, in both directions.
//
// This test must FAIL if Family ever resolves to Business, or Business to
// Family.
//
//   npx tsx scripts/check-space-identity.ts

import { groupTypeInfo } from '../lib/groups/catalog';
import { familyOf, sectionsFor, usesBusinessTheme, memberHeading } from '../lib/spaces/layout';
import { BIZ, businessPalette } from '../constants/businessTheme';
import { PALETTES } from '../constants/theme';

const fail = (m: string) => { throw new Error(`space-identity: ${m}`); };

const ALL_PERMS = ['view_space_ops', 'manage_roster', 'manage_runs', 'invite_members'];

// ── the explicit type → identity mapping ────────────────────────────────
// icon/color from the catalog; theme + layout family from lib/spaces/layout.
const EXPECT = [
  { type: 'family',           icon: 'home',       biz: false, fam: 'family' },
  { type: 'business',         icon: 'storefront', biz: true,  fam: 'office' },
  { type: 'office',           icon: 'briefcase',  biz: true,  fam: 'office' },
  { type: 'school',           icon: 'school',     biz: false, fam: 'school' },
  { type: 'school_transport', icon: 'bus',        biz: false, fam: 'school' },
  { type: 'office_transport', icon: 'car',        biz: true,  fam: 'transport' },
] as const;

for (const e of EXPECT) {
  const info = groupTypeInfo(e.type);
  if (info.icon !== e.icon) fail(`${e.type} icon must be '${e.icon}', got '${info.icon}'`);
  if (usesBusinessTheme(e.type) !== e.biz) fail(`${e.type} business-theme must be ${e.biz}`);
  if (familyOf(e.type) !== e.fam) fail(`${e.type} layout family must be '${e.fam}', got '${familyOf(e.type)}'`);
}

// ── FAMILY ≠ BUSINESS, both directions ──────────────────────────────────
const family = groupTypeInfo('family');
const business = groupTypeInfo('business');
const office = groupTypeInfo('office');

if (family.icon === business.icon) fail('family icon equals business icon');
if (family.icon === office.icon) fail('family icon equals office icon');
if (family.color === business.color) fail('family colour equals business colour');
if (business.icon === 'home') fail('business must not take the family icon');

// Theme: family renders the app palette, never BIZ. useSpaceColors() is a
// one-line ternary over usesBusinessTheme(), so pinning the predicate pins the
// hook. The family brand accent must also stay distinct from Business blue.
if (usesBusinessTheme('family')) fail('family resolves to the Business theme');
if (!usesBusinessTheme('business')) fail('business must resolve to the Business theme');
if (family.color.toLowerCase() === BIZ.primary.toLowerCase()) {
  fail('the family brand colour is Business blue');
}
for (const scheme of ['light', 'dark'] as const) {
  const base = PALETTES[scheme];
  const resolved = businessPalette(base, scheme);
  for (const role of ['bg', 'text', 'textDim', 'textFaint', 'glassSoft', 'glassStroke', 'surfaceSolid'] as const) {
    if (resolved[role] !== base[role]) fail(`Business ${scheme} must use the active ${role}`);
  }
  if (resolved.brandOnLight !== BIZ.brandOnLight) fail('Business lost its blue identity');
}

// Layout: no family section may route into an employee-monitoring screen, and
// no business section into a family screen.
const BIZ_SCREENS = new Set([
  '/space-people', '/space-overview', '/space-ops-map',
  '/space-tasks', '/space-leave', '/space-visitors', '/space-attendance',
]);
for (const s of sectionsFor('family', ALL_PERMS)) {
  if (BIZ_SCREENS.has(s.route)) fail(`family section '${s.key}' routes to business screen ${s.route}`);
}
for (const s of sectionsFor('business', ALL_PERMS)) {
  if (s.route.startsWith('/family')) fail(`business section '${s.key}' routes to family screen ${s.route}`);
}
if (sectionsFor('family', []).length === 0) fail('family lost its sections');
if (sectionsFor('business', ALL_PERMS).length === 0) fail('business lost its sections');

// Terminology: the member heading must not cross over.
if (memberHeading('family') !== 'FAMILY MEMBERS') fail('family heading changed');
if (memberHeading('business') === 'FAMILY MEMBERS') fail('business heading claims family');
if (memberHeading('family') === memberHeading('business')) fail('family and business share a heading');

// Fallbacks: an unknown or missing type must degrade to GENERIC — never to
// business, and never to a business icon.
for (const t of [null, undefined, '', 'invented_later'] as const) {
  if (usesBusinessTheme(t)) fail(`unknown type ${String(t)} fell back to the Business theme`);
  if (familyOf(t) !== 'generic') fail(`unknown type ${String(t)} must degrade to generic`);
  const icon = groupTypeInfo(t ?? null).icon;
  if (icon === business.icon || icon === office.icon) fail(`unknown type ${String(t)} fell back to a business icon`);
}

console.log('check-space-identity OK — family is family, business is business');
