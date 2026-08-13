// lib/groups/catalog.ts — the twelve group types, their identity and their
// client-side defaults.
//
// The SERVER owns the authoritative catalogue (group_type_config, migration
// 066). This file is a presentation fallback so the create-group picker can
// render icons and colours before any network call, and so a group whose type
// config has not loaded still draws sensibly.
//
// Member caps are DELIBERATELY ABSENT here. A cap is a server value read off the
// group payload; hardcoding one in the client would mean an operator raising a
// cap needs an app release, which is exactly what migration 070 was shaped to
// avoid. Read `maxMembers` from the group, never from this file.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/groups/catalog.ts

import type { Ionicons } from '@expo/vector-icons';

export type GroupType =
  | 'family' | 'friends' | 'office' | 'colleagues' | 'travel' | 'school'
  | 'college' | 'sports' | 'emergency' | 'neighborhood' | 'business'
  | 'pet_care' | 'riders' | 'custom'
  // Spaces & Operations (migration 084).
  | 'school_transport' | 'office_transport';

export interface GroupTypeInfo {
  type: GroupType;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  /** One line shown under the type in the picker. */
  blurb: string;
}

/**
 * Order matters: this is the order of the create-group picker. Family leads
 * because it is the migration path from Family Space; Custom is last because it
 * is the escape hatch, not a suggestion.
 */
export const GROUP_TYPES: GroupTypeInfo[] = [
  { type: 'family',       label: 'Family',       icon: 'home',           color: '#9D6FD0', blurb: 'Your household' },
  { type: 'friends',      label: 'Friends',      icon: 'people',         color: '#4A9FFF', blurb: 'People you make plans with' },
  { type: 'office',       label: 'Office',       icon: 'briefcase',      color: '#14B8A6', blurb: 'Your team at work' },
  { type: 'office_transport', label: 'Office Transport', icon: 'car',    color: '#14B8A6', blurb: 'Cabs, drivers and pickups' },
  { type: 'colleagues',   label: 'Colleagues',   icon: 'people-circle',  color: '#0EA5E9', blurb: 'Wider work circle' },
  { type: 'travel',       label: 'Travel',       icon: 'airplane',       color: '#F59E0B', blurb: 'A trip you are taking together' },
  { type: 'school',       label: 'School',       icon: 'school',         color: '#A855F7', blurb: 'Class, bus route or parents' },
  { type: 'school_transport', label: 'School Transport', icon: 'bus',    color: '#A855F7', blurb: 'Bus routes, drivers and pickups' },
  { type: 'college',      label: 'College',      icon: 'library',        color: '#8B5CF6', blurb: 'Course mates and hostel' },
  { type: 'sports',       label: 'Sports',       icon: 'football',       color: '#22C55E', blurb: 'A team or a riding club' },
  { type: 'emergency',    label: 'Emergency',    icon: 'medkit',         color: '#EF4444', blurb: 'Who to reach when it matters' },
  { type: 'neighborhood', label: 'Neighborhood', icon: 'business',       color: '#F97316', blurb: 'People nearby' },
  { type: 'business',     label: 'Business',     icon: 'storefront',     color: '#EC4899', blurb: 'Staff, suppliers, deliveries' },
  { type: 'pet_care',     label: 'Pet Care',     icon: 'paw',            color: '#F59E0B', blurb: 'Walkers, sitters and the vet' },
  { type: 'riders',       label: 'Riders',       icon: 'bicycle',        color: '#EF4444', blurb: 'People who ride together' },
  { type: 'custom',       label: 'Custom',       icon: 'ellipse',        color: '#6B7280', blurb: 'Pick your own icon and colour' },
];

const BY_TYPE = new Map<GroupType, GroupTypeInfo>(GROUP_TYPES.map((g) => [g.type, g]));

/** Fallback used for an unknown or missing type — never throws. */
export const UNTYPED: GroupTypeInfo = {
  type: 'custom', label: 'Group', icon: 'people', color: '#6B7280',
  blurb: 'A group created before types existed',
};

/**
 * Look up a type's presentation. Returns UNTYPED for null/unknown, because
 * groups created before migration 070 legitimately carry no type and must still
 * render.
 */
export function groupTypeInfo(type: string | null | undefined): GroupTypeInfo {
  if (!type) return UNTYPED;
  return BY_TYPE.get(type as GroupType) ?? UNTYPED;
}

export function isGroupType(v: string | null | undefined): v is GroupType {
  return !!v && BY_TYPE.has(v as GroupType);
}

/**
 * Resolve a group's display identity, preferring what the group itself stores
 * over the type default. A Custom group supplies its own icon and colour; every
 * other type may still override them.
 */
export function groupIdentity(group: {
  groupType?: string | null;
  icon?: string | null;
  color?: string | null;
  name?: string | null;
}): { icon: keyof typeof Ionicons.glyphMap; color: string; label: string } {
  const info = groupTypeInfo(group.groupType);
  return {
    icon: (group.icon as keyof typeof Ionicons.glyphMap) || info.icon,
    color: group.color || info.color,
    label: group.name || info.label,
  };
}

// ── self-check ──
if (require.main === module) {
  // The client list is checked against the migrations that actually seed
  // group_type_config — but by scripts/check-space-types.ts, NOT here.
  //
  // That check has to read the SQL files, and anything this file requires gets
  // bundled into the app: Metro resolves `require('fs')` statically, even inside
  // a branch that never runs on a device, and fails the build with "Unable to
  // resolve module fs". This self-check therefore stays free of Node built-ins,
  // like every other one in the codebase.
  //
  //   npx tsx scripts/check-space-types.ts
  if (GROUP_TYPES.length < 16) {
    throw new Error(`expected at least 16 types, got ${GROUP_TYPES.length} — run scripts/check-space-types.ts`);
  }

  for (const t of ['pet_care', 'riders', 'school_transport', 'office_transport'] as const) {
    if (!isGroupType(t)) throw new Error(`${t} is seeded server-side and must be in the catalog`);
  }

  // every type unique, and every colour a 6-digit hex
  const seen = new Set<string>();
  for (const g of GROUP_TYPES) {
    if (seen.has(g.type)) throw new Error(`duplicate type ${g.type}`);
    seen.add(g.type);
    if (!/^#[0-9A-Fa-f]{6}$/.test(g.color)) throw new Error(`bad colour on ${g.type}: ${g.color}`);
    if (!g.label || !g.icon || !g.blurb) throw new Error(`incomplete entry ${g.type}`);
  }

  // Family leads the picker, Custom closes it
  if (GROUP_TYPES[0].type !== 'family') throw new Error('family should lead the picker');
  if (GROUP_TYPES[GROUP_TYPES.length - 1].type !== 'custom') throw new Error('custom should close the picker');

  // unknown and null fall back rather than throwing
  if (groupTypeInfo(null) !== UNTYPED) throw new Error('null must fall back');
  if (groupTypeInfo('nonsense') !== UNTYPED) throw new Error('unknown must fall back');
  if (groupTypeInfo('family').label !== 'Family') throw new Error('known type must resolve');

  if (isGroupType('family') !== true) throw new Error('isGroupType(family)');
  if (isGroupType('nope') !== false) throw new Error('isGroupType(nope)');
  if (isGroupType(null) !== false) throw new Error('isGroupType(null)');

  // group-stored identity beats the type default
  const custom = groupIdentity({ groupType: 'family', icon: 'star', color: '#123456', name: 'Balla' });
  if (custom.icon !== 'star' || custom.color !== '#123456' || custom.label !== 'Balla') {
    throw new Error('group values should win over type defaults');
  }
  // …and the type default fills the gaps
  const bare = groupIdentity({ groupType: 'sports' });
  if (bare.icon !== 'football' || bare.color !== '#22C55E' || bare.label !== 'Sports') {
    throw new Error('type default should fill missing identity');
  }
  // a legacy untyped group still renders
  const legacy = groupIdentity({ name: 'Old group' });
  if (legacy.color !== UNTYPED.color || legacy.label !== 'Old group') throw new Error('legacy group must render');

  console.log('groups/catalog self-check OK');
}
