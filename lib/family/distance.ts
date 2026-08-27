// lib/family/distance.ts — the Family distance layer. Pure, no RN imports, so
// the self-check runs under tsx:  npx tsx lib/family/distance.ts
//
// TWO SIDES, AND THE SPLIT IS THE WHOLE PRIVACY DESIGN:
//
//   PUBLISHER  refDistancesFor() runs on the device that OWNS the places. It
//              turns "my Home is at 17.38,78.48" into "1.2 km from Home" and
//              only that derived number is ever published. No place coordinate
//              leaves the device, no place is synced, nothing is stored
//              server-side, and the existing E2EE path is untouched — the refs
//              simply ride the FamilyPing that already goes out.
//
//   VIEWER     everything else. Distance from ME to a member is computed here,
//              from positions this device has already decrypted. That is
//              deliberately NOT server-side (against the usual thin-client
//              rule): on the sealed relay the server cannot see a coordinate,
//              so it could not compute this even if we wanted it to.
//
// Straight-line only. Road distance and ETA come from Valhalla via /nav/route
// and are never mixed with these values — see formatStraight vs formatRoute.

import { haversine, type LatLng } from '../nav/geo';
import { type Geofence } from './geofence';
import { type RefDistance } from './types';

/** Most reference distances one ping will carry. Keeps the sealed blob small. */
export const MAX_REFS = 8;

/**
 * Derive "how far am I from each of my own places", for publishing.
 *
 * MUST be called with the position that is actually being published — i.e.
 * AFTER applyPrivacy has reduced it. Computing from the precise fix and
 * publishing that alongside a grid-snapped coordinate would leak the precision
 * that "approximate" exists to withhold: the blurred dot says "somewhere in
 * this 550 m cell" while an exact "1.243 km from Home" narrows it back down.
 *
 * Every place counts as a reference, including ones whose ALERTS are off or
 * asleep on a schedule. `enabled: false` means "don't notify me about this
 * fence", not "this is no longer a location".
 *
 * The default reference is emitted FIRST so a viewer can render one line
 * without knowing which name was chosen.
 */
export function refDistancesFor(
  pos: LatLng,
  places: Geofence[],
  defaultName?: string | null,
  max = MAX_REFS,
): RefDistance[] {
  if (!places?.length) return [];
  const ordered = defaultName
    ? [...places.filter((p) => p.name === defaultName), ...places.filter((p) => p.name !== defaultName)]
    : places;
  const out: RefDistance[] = [];
  const seen = new Set<string>();
  for (const p of ordered) {
    if (out.length >= max) break;
    // Two places named the same would render as two identical lines; the first
    // (which may be the chosen default) wins.
    if (!p?.name || seen.has(p.name) || !p.center) continue;
    const d = haversine(pos, p.center);
    if (!Number.isFinite(d)) continue;
    seen.add(p.name);
    out.push({ n: p.name, d: Math.round(d) });
  }
  return out;
}

/** The reference a member chose to lead with, or null if they published none. */
export function defaultRef(refs?: RefDistance[] | null): RefDistance | null {
  return refs?.length ? refs[0] : null;
}

/** Look up one named reference from what a member published. */
export function refByName(refs: RefDistance[] | null | undefined, name: string): RefDistance | null {
  return refs?.find((r) => r.n === name) ?? null;
}

// ── formatting ────────────────────────────────────────────────────────────
//
// Straight-line and road distance are formatted by DIFFERENT functions on
// purpose. The spec's §8 rule — never show a road distance as straight-line,
// never the reverse — is easy to break by accident when one formatter serves
// both, because the call site is where the meaning lives and it is one edit
// away from being wrong.

/** Metres → a short human distance: "850 m", "1.2 km", "12 km". */
export function formatMetres(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '—';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** Straight-line phrasing. Always says so when it might be mistaken for a route. */
export function formatStraight(m: number, qualify = false): string {
  const base = formatMetres(m);
  return qualify ? `${base} straight-line` : base;
}

/** Road distance + duration from a real route. Never used for haversine values. */
export function formatRoute(metres: number, seconds?: number): string {
  const d = formatMetres(metres);
  if (seconds == null || !Number.isFinite(seconds)) return `${d} by road`;
  const min = Math.max(1, Math.round(seconds / 60));
  return min < 60 ? `${d} • ${min} min` : `${d} • ${Math.floor(min / 60)} h ${min % 60} min`;
}

// ── the viewer's per-member row ───────────────────────────────────────────

/** One member reduced to what the list and the summary need. */
export interface MemberDistance {
  id: string;
  name: string;
  /** Metres from ME. Null when either side has no usable fix.
   *  Straight-line as computed here; `byRoad` says whether a road figure has
   *  since replaced it (see mergeRoadDistances). */
  fromMe: number | null;
  /** True once `fromMe` carries a ROAD distance rather than a straight line. */
  byRoad?: boolean;
  /** What THEY published: how far they are from their own chosen reference. */
  ref: RefDistance | null;
  /** Every reference they published, for the "Distance from ▾" picker. */
  refs: RefDistance[];
  ts?: number;
  self?: boolean;
  /** No usable position: silent, sharing off, or never seen. */
  unavailable?: boolean;
}

export interface MemberInput {
  id: string;
  name: string;
  pos?: LatLng | null;
  refs?: RefDistance[] | null;
  ts?: number;
  self?: boolean;
  unavailable?: boolean;
}

/** Build the distance row for every member, relative to my own position. */
export function memberDistances(members: MemberInput[], mine?: LatLng | null): MemberDistance[] {
  return members.map((m) => ({
    id: m.id,
    name: m.name,
    fromMe: m.pos && mine && !m.unavailable ? Math.round(haversine(mine, m.pos)) : null,
    ref: defaultRef(m.refs),
    refs: m.refs ?? [],
    ts: m.ts,
    self: m.self,
    unavailable: m.unavailable,
  }));
}

/**
 * Distance from an ARBITRARY point (a searched destination, a place of mine) to
 * each member. This is what Near Home / Near Office / Meet Here all run on:
 * one origin, every member, straight-line.
 */
export function distancesFrom(members: MemberInput[], origin: LatLng): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of members) {
    if (m.pos && !m.unavailable) out.set(m.id, Math.round(haversine(origin, m.pos)));
  }
  return out;
}

// ── sorting ───────────────────────────────────────────────────────────────

export type SortMode = 'nearest' | 'farthest' | 'alpha' | 'recent';

/**
 * Order the member list. Members with no distance always sink to the BOTTOM
 * regardless of direction — under 'farthest' a member we cannot locate is not
 * "the farthest away", they are simply unknown, and floating them to the top
 * would read as a false answer to "who is furthest".
 */
export function sortMembers(rows: MemberDistance[], mode: SortMode): MemberDistance[] {
  const out = [...rows];
  const byName = (a: MemberDistance, b: MemberDistance) => a.name.localeCompare(b.name);
  out.sort((a, b) => {
    if (mode === 'alpha') return byName(a, b);
    if (mode === 'recent') {
      const at = a.ts ?? -Infinity, bt = b.ts ?? -Infinity;
      return at === bt ? byName(a, b) : bt - at;
    }
    const av = a.fromMe, bv = b.fromMe;
    if (av == null && bv == null) return byName(a, b);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av === bv) return byName(a, b);
    return mode === 'nearest' ? av - bv : bv - av;
  });
  return out;
}

// ── the family summary card ───────────────────────────────────────────────

export interface FamilySummary {
  nearest: MemberDistance | null;
  farthest: MemberDistance | null;
  /** Mean of the members we can actually locate, metres. Null if none. */
  averageM: number | null;
  /** Members with a usable position. */
  available: number;
  /** Everyone in the circle, including me and the unlocatable. */
  total: number;
}

/**
 * Summarise the circle.
 *
 * SELF IS EXCLUDED from nearest/farthest/average: "nearest member: You, 0 km"
 * is noise, and a zero would drag the average toward the door you are standing
 * at. `total` still counts everyone, because "9 / 10 available" is a statement
 * about the circle, not about the people we could measure.
 *
 * An unavailable member is never counted as distance zero — the bug that makes
 * a summary claim the family is closer together than it is.
 */
export function summarize(rows: MemberDistance[]): FamilySummary {
  const others = rows.filter((r) => !r.self);
  const located = others.filter((r) => r.fromMe != null) as (MemberDistance & { fromMe: number })[];
  if (!located.length) {
    return { nearest: null, farthest: null, averageM: null, available: 0, total: rows.length };
  }
  let nearest = located[0], farthest = located[0], sum = 0;
  for (const r of located) {
    if (r.fromMe < nearest.fromMe!) nearest = r;
    if (r.fromMe > farthest.fromMe!) farthest = r;
    sum += r.fromMe;
  }
  return {
    nearest,
    farthest,
    averageM: Math.round(sum / located.length),
    available: located.length,
    total: rows.length,
  };
}

// ── self-check: `npx tsx lib/family/distance.ts` ───────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('distance: ' + m); };
  const H: LatLng = { lat: 17.385, lng: 78.4867 };            // "Home"
  // ~1.11 km north / ~2.22 km north, close enough for assertions with tolerance.
  const p = (dLat: number): LatLng => ({ lat: H.lat + dLat, lng: H.lng });
  const fence = (name: string, c: LatLng, enabled?: boolean): Geofence =>
    ({ id: name, name, center: c, radiusM: 150, ...(enabled === undefined ? {} : { enabled }) });

  // 1. publisher: the default reference leads, and only NAMES + metres come out
  const places = [fence('Office', p(0.02)), fence('Home', H), fence('School', p(0.01), false)];
  const refs = refDistancesFor(p(0.01), places, 'Home');
  A(refs[0].n === 'Home', 'default reference must be published first');
  A(Math.abs(refs[0].d - 1110) < 60, `Home distance off: ${refs[0].d}`);
  A(refs.some((r) => r.n === 'School'), 'a place with alerts OFF is still a reference');
  A(refs.every((r) => Object.keys(r).length === 2), 'a ref must carry name + metres and nothing else');
  A(JSON.stringify(refs).indexOf('78.4') === -1, 'NO COORDINATE MAY APPEAR IN A PUBLISHED REF');

  // 2. cap, dedupe, and the no-places case
  A(refDistancesFor(H, [], 'Home').length === 0, 'no places → no refs');
  const many = Array.from({ length: 20 }, (_, i) => fence('P' + i, p(i / 1000)));
  A(refDistancesFor(H, many).length === MAX_REFS, 'refs must be capped');
  A(refDistancesFor(H, [fence('Home', H), fence('Home', p(0.05))]).length === 1, 'duplicate names collapse');

  // 3. viewer: distance from me, and unavailable stays NULL not zero
  const rows = memberDistances([
    { id: 'me', name: 'You', pos: H, self: true },
    { id: 'mom', name: 'Mother', pos: p(0.01), refs, ts: 100 },
    { id: 'dad', name: 'Father', pos: p(0.02), ts: 200 },
    { id: 'gone', name: 'Uncle', pos: null, unavailable: true, ts: 50 },
  ], H);
  A(rows[3].fromMe === null, 'an unavailable member must have NO distance, not zero');
  A(Math.abs(rows[1].fromMe! - 1110) < 60, 'from-me distance wrong');
  A(rows[1].ref!.n === 'Home', 'member ref should surface their default');

  // 4. the summary excludes self and never counts the missing as zero
  const s = summarize(rows);
  A(s.nearest!.id === 'mom' && s.farthest!.id === 'dad', 'nearest/farthest wrong');
  A(s.available === 2 && s.total === 4, `available/total wrong: ${s.available}/${s.total}`);
  A(Math.abs(s.averageM! - 1665) < 90, `average wrong: ${s.averageM}`);
  A(summarize([{ id: 'me', name: 'You', fromMe: null, ref: null, refs: [], self: true }]).averageM === null,
    'a circle of one has no average');

  // 5. sorting — unlocatable members sink under BOTH directions
  A(sortMembers(rows, 'nearest').map((r) => r.id).join() === 'me,mom,dad,gone', 'nearest order');
  const far = sortMembers(rows, 'farthest').map((r) => r.id);
  A(far[far.length - 1] === 'gone', 'unlocatable must sink under farthest too');
  A(far[0] === 'dad', 'farthest should lead with the furthest located member');
  A(sortMembers(rows, 'recent')[0].id === 'dad', 'recent = newest timestamp first');
  A(sortMembers(rows, 'alpha')[0].name === 'Father', 'alpha order');

  // 6. TEN MEMBERS (spec §82): the UI must never assume three or five. Every
  //    member gets a distance, every sort keeps all ten, and nobody is dropped.
  const TEN = ['You', 'Mother', 'Father', 'Brother', 'Sister', 'Child', 'Uncle', 'Aunt', 'Grandfather', 'Grandmother'];
  const ten = memberDistances(TEN.map((n, i) => ({
    id: 'u' + i, name: n, pos: i === 0 ? H : p(i * 0.005), ts: 1000 + i, self: i === 0,
  })), H);
  A(ten.length === 10, 'ten members in, ten rows out');
  A(ten.filter((r) => r.self || r.fromMe != null).length === 10, 'every one of ten needs a distance');
  for (const mode of ['nearest', 'farthest', 'alpha', 'recent'] as SortMode[]) {
    const sorted = sortMembers(ten, mode);
    A(sorted.length === 10, `${mode} must keep all ten members`);
    A(new Set(sorted.map((r) => r.id)).size === 10, `${mode} must not duplicate or drop a member`);
  }
  const tenSum = summarize(ten);
  A(tenSum.available === 9 && tenSum.total === 10, `ten-member summary: ${tenSum.available}/${tenSum.total}`);
  A(tenSum.nearest!.name === 'Mother' && tenSum.farthest!.name === 'Grandmother', 'ten-member extremes');

  // …and with one member dark it must say 8 of 9, not silently count them as 0.
  const nine = memberDistances(TEN.map((n, i) => ({
    id: 'u' + i, name: n, pos: i === 6 ? null : (i === 0 ? H : p(i * 0.005)),
    ts: 1000 + i, self: i === 0, unavailable: i === 6,
  })), H);
  const nineSum = summarize(nine);
  A(nineSum.available === 8 && nineSum.total === 10, `one dark member: ${nineSum.available}/${nineSum.total}`);
  A(nineSum.nearest!.name === 'Mother', 'a dark member must not become the nearest');
  // The average is the mean of the members we could MEASURE — the dark one is
  // absent from it, not present as a zero. Both are asserted, because counting
  // the unlocatable as "0 km away" is the exact bug that makes a summary claim
  // the family is closer together than it is.
  const located = nine.filter((r) => !r.self && r.fromMe != null).map((r) => r.fromMe!);
  A(located.length === 8, 'eight measurable members expected');
  const meanOfMeasured = Math.round(located.reduce((a, b) => a + b, 0) / 8);
  const meanWithZero = Math.round(located.reduce((a, b) => a + b, 0) / 9);
  A(nineSum.averageM === meanOfMeasured, `average must be the mean of the measured: ${nineSum.averageM} vs ${meanOfMeasured}`);
  A(nineSum.averageM !== meanWithZero, 'the unlocatable member must not be averaged in as zero');

  // 7. formatting keeps straight-line and road distinguishable
  A(formatMetres(850) === '850 m' && formatMetres(1234) === '1.2 km' && formatMetres(12345) === '12 km', 'format');
  A(formatStraight(1234, true).endsWith('straight-line'), 'qualified straight-line must say so');
  A(formatRoute(2400, 420) === '2.4 km • 7 min', `route format: ${formatRoute(2400, 420)}`);
  A(formatRoute(2400) === '2.4 km by road', 'route without a duration still says by road');
  A(formatMetres(-1) === '—', 'nonsense formats as unknown');

  console.log('family/distance self-check: OK');
}

export default {};


/**
 * Replace straight-line distances with ROAD distances where we have them.
 *
 * WHY THIS IS A SEPARATE LAYER, AND WHAT IT MUST NOT TOUCH
 * -------------------------------------------------------
 * "4 km away" meaning four kilometres of driving is a different, and more
 * useful, claim than four kilometres of open air — a member across a river
 * reads as close and is not. So the DISPLAYED distance becomes road distance
 * when the router can answer.
 *
 * But two things deliberately keep the straight line, and converting them
 * would be a bug, not an improvement:
 *
 *   GEOFENCES. A fence is {center, radiusM} — a circle. Someone standing 50m
 *   from home whose road access loops 2km around a block is INSIDE the fence,
 *   and must be, or arrival alerts fire late and leave alerts fire early.
 *   lib/family/geofence.ts is untouched by this.
 *
 *   PUBLISHED REFERENCE DISTANCES (`ref`/`refs`, "1.2 km from Home"). Those
 *   are computed on the OTHER member's device from places this device has
 *   never seen, and only the derived number is transmitted — by owner
 *   directive, place coordinates never leave the device that owns them. There
 *   is no coordinate here to route from, and acquiring one would break that
 *   design rather than improve it.
 *
 * A missing entry means the router had no answer for that member — engine
 * down, unreachable, or simply not asked yet. Those keep their straight line
 * rather than becoming null: a slightly wrong number beats a blank row.
 */
export function mergeRoadDistances(
  rows: MemberDistance[],
  roadM: Record<string, number>,
): MemberDistance[] {
  let changed = false;
  const out = rows.map((r) => {
    const m = roadM[r.id];
    // Only upgrade a row that already had a usable straight line: if fromMe is
    // null the member is unlocatable, and a road distance to a position we do
    // not trust would invent a precision we never had.
    if (r.fromMe == null || !Number.isFinite(m) || m < 0) return r;
    changed = true;
    return { ...r, fromMe: Math.round(m), byRoad: true };
  });
  return changed ? out : rows;   // preserve identity so memo consumers do not re-render for nothing
}
