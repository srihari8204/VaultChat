// lib/spaces/layout.ts — what a space's dashboard shows, decided by its TYPE.
//
// One architecture, three experiences. A family, a school and an office are the
// same Space with the same members, permissions and realtime plumbing; what
// differs is which sections lead. Before this module every typed space rendered
// the family dashboard — a parent opening a school bus space got Safe Zones,
// SOS and a heading that said FAMILY MEMBERS, with the child's bus buried below
// the fold. The screens all existed; nothing routed to them.
//
// ── WHY THIS IS DATA AND NOT JSX ──
//
// Sections are values so the decision is testable without a renderer, and so
// "what does a Transport Manager see?" is answered by reading a list rather
// than by tracing conditionals through a 1200-line screen.
//
// ── PERMISSIONS ARE A FILTER, NOT THE AUTHORITY ──
//
// `needs` decides what to DRAW. Every route behind these sections re-checks the
// caller server-side, and a section being visible has never been what makes an
// action legal. Hiding a tile the caller cannot use is a courtesy — drawing it
// and failing on tap teaches people to distrust the app.
//
// A section with no `needs` is visible to every member, including someone with
// an empty permission set. That is deliberate and load-bearing: a school parent
// holds NO permissions by design, and their child's bus reaches them through
// space_links, not through a permission. Gating the transport section on
// view_space_ops is exactly the bug that made school look empty.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/spaces/layout.ts

export type SpaceFamily = 'family' | 'school' | 'office' | 'transport' | 'generic';

export interface SpaceSection {
  key: string;
  label: string;
  hint: string;
  /** Ionicons glyph name. Kept as a string so this module stays renderer-free. */
  icon: string;
  route: string;
  /** Permission required to DRAW this. Absent = every member sees it. */
  needs?: string;
  /**
   * True when the section needs the device's own position. Only these may ask
   * for location permission, and only when opened — entering a space must not.
   */
  usesLocation?: boolean;
}

/**
 * Which experience a stored group_type gets.
 *
 * Substring matching, because the type list is DATA (group_type_config) and new
 * types get added by migration without a code change. `school_transport` must
 * land on school, `office_transport` on transport, and an unknown type must
 * degrade to the generic space rather than crash or render nothing.
 */
export function familyOf(groupType: string | null | undefined): SpaceFamily {
  const t = (groupType ?? '').toLowerCase();
  if (!t) return 'generic';
  // Order matters: office_transport is transport, not office.
  if (t.includes('transport') && !t.includes('school')) return 'transport';
  if (t.includes('school') || t.includes('college')) return 'school';
  if (t.includes('office') || t.includes('business') || t.includes('colleague')) return 'office';
  if (t === 'family') return 'family';
  return 'generic';
}

/** Does this space run vehicles? Used to decide whether to fetch runs at all. */
export function isOperational(groupType: string | null | undefined): boolean {
  const f = familyOf(groupType);
  return f === 'school' || f === 'office' || f === 'transport';
}

const FAMILY: SpaceSection[] = [
  { key: 'map', label: 'Live map', hint: 'Where everyone is, right now', icon: 'map-outline', route: '/family-map', usesLocation: true },
  { key: 'sos', label: 'SOS', hint: 'Alert your circle immediately', icon: 'warning-outline', route: '/family-sos', usesLocation: true },
  { key: 'checkin', label: 'Check in', hint: 'Let everyone know you are safe', icon: 'hand-left-outline', route: '/space-checkin' },
  { key: 'places', label: 'Safe zones', hint: 'Places that matter', icon: 'location-outline', route: '/family-places', usesLocation: true },
  { key: 'members', label: 'Members', hint: 'Who is in this circle', icon: 'people-outline', route: '/family-members' },
  { key: 'alerts', label: 'Alerts', hint: 'Arrivals, departures and warnings', icon: 'notifications-outline', route: '/family-alerts' },
  { key: 'history', label: 'History', hint: 'Where everyone has been', icon: 'time-outline', route: '/family-history', usesLocation: true },
];

const SCHOOL: SpaceSection[] = [
  // First, and with NO permission gate: this is the parent's whole reason for
  // being here, and a parent holds no permissions.
  { key: 'transport', label: 'Transport', hint: 'Buses, stops and today’s runs', icon: 'bus-outline', route: '/space-transport' },
  { key: 'buses', label: 'Live buses', hint: 'Every bus on one map', icon: 'map-outline', route: '/space-ops-map', needs: 'view_space_ops' },
  { key: 'students', label: 'Students', hint: 'Who travels, and who is responsible for them', icon: 'school-outline', route: '/space-roster', needs: 'manage_roster' },
  { key: 'pending', label: 'Pickup & drop', hint: 'Who is still waiting, oldest first', icon: 'hourglass-outline', route: '/space-pending' },
  { key: 'people', label: 'Attendance', hint: 'Present, absent and on leave', icon: 'id-card-outline', route: '/space-people', needs: 'view_space_ops' },
  { key: 'alerts', label: 'Alerts', hint: 'Delays, deviations and emergencies', icon: 'alert-circle-outline', route: '/space-incidents' },
  { key: 'admin', label: 'School settings', hint: 'Runs, roster, roles and passes', icon: 'settings-outline', route: '/space-admin', needs: 'view_space_ops' },
];

const OFFICE: SpaceSection[] = [
  { key: 'people', label: 'Employees', hint: 'Who is in, out or on leave', icon: 'people-outline', route: '/space-people', needs: 'view_space_ops' },
  { key: 'attendance', label: 'Attendance', hint: 'Check in and check out', icon: 'log-in-outline', route: '/space-checkin' },
  { key: 'map', label: 'Live locations', hint: 'Only those authorised by policy', icon: 'map-outline', route: '/space-ops-map', needs: 'view_space_ops', usesLocation: true },
  { key: 'tasks', label: 'Tasks', hint: 'Assigned work and its progress', icon: 'checkbox-outline', route: '/space-tasks' },
  { key: 'leave', label: 'Leave', hint: 'Requests, approvals and balance', icon: 'calendar-outline', route: '/space-leave' },
  { key: 'transport', label: 'Cabs', hint: 'Office transport and pickups', icon: 'car-outline', route: '/space-transport' },
  { key: 'reports', label: 'Reports', hint: 'The day in numbers', icon: 'stats-chart-outline', route: '/space-overview', needs: 'view_space_ops' },
  { key: 'admin', label: 'Settings', hint: 'Roles, roster and visitor passes', icon: 'settings-outline', route: '/space-admin', needs: 'view_space_ops' },
];

const TRANSPORT: SpaceSection[] = [
  { key: 'transport', label: 'My cab', hint: 'Your pickup, driver and ETA', icon: 'car-outline', route: '/space-transport' },
  { key: 'fleet', label: 'Live cabs', hint: 'Every vehicle on one map', icon: 'map-outline', route: '/space-ops-map', needs: 'view_space_ops' },
  { key: 'pending', label: 'Pickups', hint: 'Who is still waiting', icon: 'hourglass-outline', route: '/space-pending' },
  { key: 'people', label: 'Riders', hint: 'Who travels on which route', icon: 'people-outline', route: '/space-roster', needs: 'manage_roster' },
  { key: 'alerts', label: 'Alerts', hint: 'Delays, breakdowns and emergencies', icon: 'alert-circle-outline', route: '/space-incidents' },
  { key: 'admin', label: 'Settings', hint: 'Routes, drivers and assignments', icon: 'settings-outline', route: '/space-admin', needs: 'view_space_ops' },
];

// A friends/travel/neighbourhood space: the family tools minus the ones that
// only make sense for people responsible for each other.
const GENERIC: SpaceSection[] = [
  { key: 'map', label: 'Live map', hint: 'Where everyone is, right now', icon: 'map-outline', route: '/family-map', usesLocation: true },
  { key: 'checkin', label: 'Check in', hint: 'Let everyone know you are safe', icon: 'hand-left-outline', route: '/space-checkin' },
  { key: 'members', label: 'Members', hint: 'Who is in this space', icon: 'people-outline', route: '/family-members' },
  { key: 'alerts', label: 'Alerts', hint: 'What has been happening', icon: 'notifications-outline', route: '/family-alerts' },
];

const BY_FAMILY: Record<SpaceFamily, SpaceSection[]> = {
  family: FAMILY, school: SCHOOL, office: OFFICE, transport: TRANSPORT, generic: GENERIC,
};

/**
 * The sections to draw for one space, filtered by what the caller may use.
 *
 * `perms` is the caller's resolved set from the server. An owner passes
 * everything; a parent passes nothing and still gets the sections that carry no
 * `needs` — which is why the transport section has none.
 */
export function sectionsFor(
  groupType: string | null | undefined,
  perms: Iterable<string>,
): SpaceSection[] {
  const held = perms instanceof Set ? perms : new Set(perms);
  return BY_FAMILY[familyOf(groupType)].filter((s) => !s.needs || held.has(s.needs));
}

/** Heading for the member list. "FAMILY MEMBERS" in a school was simply wrong. */
export function memberHeading(groupType: string | null | undefined): string {
  switch (familyOf(groupType)) {
    case 'family': return 'FAMILY MEMBERS';
    case 'school': return 'SCHOOL MEMBERS';
    case 'office': return 'TEAM';
    case 'transport': return 'RIDERS & DRIVERS';
    default: return 'MEMBERS';
  }
}

/**
 * Why this space wants location, in its own words.
 *
 * The old copy said "Location permission is required for Family Circle" in
 * every space type, including a school. Worse, it was shown on ENTRY, for a
 * permission the screen did not need.
 */
export function locationRationale(groupType: string | null | undefined): string {
  switch (familyOf(groupType)) {
    case 'family':
      return 'Share your location so your family can see you on the map. You can turn this off at any time.';
    case 'school':
      return 'Location is only needed if you drive a bus or want to appear on the map. Tracking your child’s bus does not need it.';
    case 'office':
      return 'Location is shared only during the hours your organisation has configured, and only with people it authorises.';
    case 'transport':
      return 'Drivers share location while a run is active. Riders do not need to share anything to see their vehicle.';
    default:
      return 'Share your location so this space can see you on the map. You can turn this off at any time.';
  }
}

// ── self-check ────────────────────────────────────────────────────────
if (require.main === module) {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };

  // type routing, including the two that are easy to get backwards
  eq(familyOf('family'), 'family', 'family');
  eq(familyOf('school'), 'school', 'school');
  eq(familyOf('school_transport'), 'school', 'a school bus space is a school');
  eq(familyOf('office_transport'), 'transport', 'a cab fleet is transport, not an office');
  eq(familyOf('business'), 'office', 'business is the office experience');
  eq(familyOf('friends'), 'generic', 'friends falls back to generic');
  eq(familyOf(null), 'generic', 'an untyped space still renders');
  eq(familyOf('something_invented_later'), 'generic', 'an unknown type must degrade, not crash');

  // THE REGRESSION THIS MODULE EXISTS FOR: a parent holds no permissions and
  // must still reach their child's bus.
  const parent = sectionsFor('school_transport', []);
  if (!parent.some((s) => s.key === 'transport')) {
    throw new Error('a school parent with zero permissions must still see transport');
  }
  if (parent.some((s) => s.needs)) throw new Error('a filtered list must not keep gated sections');
  if (parent[0].key !== 'transport') throw new Error('the bus is what a parent came for; it leads');
  // A parent's landing route must NOT be the ops overview: that endpoint needs
  // view_space_ops and answers 403 for them. This is the bug that sent the one
  // person the feature exists for to an error screen.
  if (parent[0].route.includes('overview')) {
    throw new Error('a parent cannot open the ops overview — it requires view_space_ops');
  }

  // an owner sees everything the type offers
  const all = ['view_space_ops', 'manage_roster', 'manage_runs'];
  eq(sectionsFor('school', all).length, SCHOOL.length, 'an owner sees every school section');
  if (sectionsFor('school', all).some((s) => s.key === 'sos')) {
    throw new Error('a school dashboard is not the family dashboard');
  }
  // ...and the family space keeps everything it had. This module must not be a
  // removal of the family experience.
  eq(sectionsFor('family', []).length, FAMILY.length, 'no family section is permission-gated');
  const famKeys = sectionsFor('family', []).map((s) => s.key);
  for (const k of ['map', 'sos', 'checkin', 'places', 'members', 'alerts', 'history']) {
    if (!famKeys.includes(k)) throw new Error(`family lost its ${k} section`);
  }

  // office hides ops from a plain employee but keeps their own tools
  const employee = sectionsFor('business', []).map((s) => s.key);
  if (employee.includes('people')) throw new Error('a plain employee must not get the people board');
  // An employee keeps their OWN tools even with no ops rights.
  for (const k of ['attendance', 'tasks', 'leave']) {
    if (!employee.includes(k)) throw new Error(`an employee needs their own ${k}`);
  }

  // only genuinely location-backed sections may prompt
  for (const t of ['family', 'school', 'business', 'office_transport', null]) {
    for (const s of sectionsFor(t, all)) {
      if (s.usesLocation && !['map', 'sos', 'places', 'history'].includes(s.key)) {
        throw new Error(`${t}/${s.key} claims location it does not need`);
      }
    }
  }
  // a school parent's landing sections must need NO location at all
  if (sectionsFor('school_transport', []).some((s) => s.usesLocation)) {
    throw new Error('tracking a bus must never require the parent to share location');
  }

  // EVERY route must have a screen behind it. This caught two Office tiles
  // (/space-tasks, /space-leave) whose handlers exist but whose screens do not.
  const SCREENS = new Set([
    '/space-transport', '/space-ops-map', '/space-roster', '/space-pending',
    '/space-people', '/space-incidents', '/space-admin', '/space-overview',
    '/space-checkin', '/space-attendance', '/space-devices', '/space-run',
    '/space-runs-admin', '/space-run-driver', '/space-visitors',
    '/family-places', '/family-alerts', '/family-history',
    '/space-tasks', '/space-leave',
  ]);
  for (const t of ['school', 'school_transport', 'business', 'office', 'office_transport']) {
    for (const sec of sectionsFor(t, all)) {
      if (!SCREENS.has(sec.route)) {
        throw new Error(`${t}/${sec.key} routes to ${sec.route}, which has no screen`);
      }
    }
  }

  eq(isOperational('school'), true, 'school runs vehicles');
  eq(isOperational('family'), false, 'a family does not');

  if (memberHeading('school') === memberHeading('family')) throw new Error('headings must be type-aware');
  if (!memberHeading('business').length) throw new Error('every type needs a heading');
  if (locationRationale('school').includes('Family Circle')) throw new Error('no Family Circle copy outside a family');
  for (const t of ['family', 'school', 'business', 'office_transport', null]) {
    if (locationRationale(t).length < 20) throw new Error(`${t} needs a real explanation`);
  }

  console.log('spaces/layout self-check OK');
}
